/*
 * EZVIZ Recordings panel: timeline of detections and armed periods, SD-card playback.
 * Times are camera-local wall-clock values, handled as "naive" timestamps stored in UTC fields
 * so that the browser time zone never shifts them.
 */
const STATIC = "/ezviz_recordings_static";

const TEXT = {
  en: {
    title: "Recordings", loading: "Loading…", noCameras: "No camera configured. Add one in Settings → Devices & services → EZVIZ Recordings.",
    go: "Play", now: "5 min ago", hourAgo: "1 h ago", opening: "Opening the recording… (5–10 s)",
    playing: "Recording", failed: "The camera did not return a recording for this moment.",
    busy: "The camera is busy or not answering. Try again in a few seconds.", sd: "SD",
    when: "Exact moment", pick: "Pick a moment on the timeline or an event below.",
    today: "Today", yesterday: "Yesterday", prevPerson: "person", nextPerson: "person", prevEvent: "event", nextEvent: "event",
    persons: "People only", all: "All events", armedOnly: "Only while armed",
    person: "Person", motion: "Motion", offline: "Camera offline", other: "Event", armed: "armed",
    noEvents: "No events on this day.", noMore: "No more events in this direction on this day.",
    noSource: "Detection events are not available for this camera (set its serial in the integration options).",
    dragHint: "Drag the timeline, pinch or scroll to zoom, release to play.",
  },
  it: {
    title: "Registrazioni", loading: "Caricamento…", noCameras: "Nessuna telecamera configurata. Aggiungila da Impostazioni → Dispositivi e servizi → EZVIZ Recordings.",
    go: "Guarda", now: "5 min fa", hourAgo: "1 ora fa", opening: "Apro la registrazione… (5–10 s)",
    playing: "Registrazione", failed: "La telecamera non ha registrazioni per questo momento.",
    busy: "La telecamera è occupata o non risponde. Riprova tra qualche secondo.", sd: "SD",
    when: "Momento preciso", pick: "Scegli un punto sulla linea del tempo o un evento qui sotto.",
    today: "Oggi", yesterday: "Ieri", prevPerson: "persona", nextPerson: "persona", prevEvent: "evento", nextEvent: "evento",
    persons: "Solo persone", all: "Tutti gli eventi", armedOnly: "Solo ad allarme inserito",
    person: "Persona", motion: "Movimento", offline: "Telecamera offline", other: "Evento", armed: "allarme inserito",
    noEvents: "Nessun evento in questo giorno.", noMore: "Nessun altro evento in questa direzione oggi.",
    noSource: "Gli eventi non sono disponibili per questa telecamera (imposta il numero di serie nelle opzioni dell'integrazione).",
    dragHint: "Trascina la linea del tempo, pizzica o usa la rotella per lo zoom, rilascia per guardare.",
  },
};

const pad = (n) => String(n).padStart(2, "0");
// naive <-> string helpers (UTC fields hold the camera-local wall clock)
const toIso = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const fromIso = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))) : null;
};
const dayKey = (d) => toIso(d).slice(0, 10);
const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const DAY = 86400000;
const SPANS = [DAY, 6 * 3600000, 3600000, 15 * 60000, 3 * 60000];
function nowIn(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second));
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let hlsLoader;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${STATIC}/vendor/hls.light.min.js`;
    script.onload = () => resolve(window.Hls);
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return hlsLoader;
}

class EzvizRecordingsPanel extends HTMLElement {
  _dbg(...args) {
    if (!this._debug) return;
    const line = `${new Date().toISOString().slice(11, 19)} ${args.join(" ")}`;
    this._debugLines = [...(this._debugLines || []).slice(-24), line];
    const box = this.shadowRoot.querySelector(".debug");
    if (box) box.textContent = this._debugLines.join(String.fromCharCode(10));
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._cameras = null;
    this._camera = null;
    this._start = null;      // naive Date of the requested start
    this._t0 = null;         // video.currentTime when playback really started
    this._hls = null;
    this._request = 0;
    this._tick = null;
    this._day = null;        // naive Date at 00:00 of the shown day
    this._center = null;     // naive ms at the timeline playhead
    this._span = DAY;
    this._data = null;       // {events, armed, has_events} of the shown day
    this._counts = {};       // "entry|day" -> person count
    this._onlyPersons = true;
    this._onlyArmed = false;
    this._images = {};
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) { menu.hass = hass; menu.narrow = this._narrow; }
  }

  set narrow(value) {
    this._narrow = value;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) menu.narrow = value;
  }

  get _t() {
    return TEXT[(this._hass?.language || "en").startsWith("it") ? "it" : "en"];
  }

  get _tz() {
    return this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  disconnectedCallback() {
    this._teardown(true);
    this._resize?.disconnect();
  }

  async _init() {
    this._render();
    try {
      const res = await this._hass.callWS({ type: "ezviz_recordings/cameras" });
      this._cameras = res.cameras;
    } catch (err) {
      this._cameras = [];
    }
    const params = new URLSearchParams(location.search);
    this._debug = params.has("debug");
    const wanted = params.get("camera");
    this._camera =
      this._cameras.find((c) => c.entry_id === wanted || c.name.toLowerCase() === (wanted || "").toLowerCase()) ||
      this._cameras[0] || null;
    const linked = fromIso(params.get("t") || "");
    const now = nowIn(this._tz);
    this._start = linked || new Date(now.getTime() - 5 * 60000);
    this._day = startOfDay(this._start);
    this._center = this._start.getTime();
    this._span = linked ? 3600000 : DAY;
    this._render();
    if (!this._camera) return;
    await this._loadDay();
    if (linked) this._play(linked);
    this._loadCounts();
  }

  // ---------------------------------------------------------------- data

  async _loadDay() {
    const camera = this._camera;
    const day = dayKey(this._day);
    this._data = null;
    this._renderEvents();
    this._drawTimeline();
    try {
      const res = await this._hass.callWS({ type: "ezviz_recordings/timeline", entry_id: camera.entry_id, day });
      if (camera !== this._camera || day !== dayKey(this._day)) return;
      this._data = res;
      this._counts[`${camera.entry_id}|${day}`] = res.events.filter((e) => e.kind === "person").length;
    } catch (err) {
      this._data = { events: [], armed: [], has_events: false };
    }
    this._renderDays();
    this._renderEvents();
    this._drawTimeline();
  }

  async _loadCounts() {
    // person counts for the day strip, one day at a time in the background
    const camera = this._camera;
    for (const d of this._days()) {
      const key = `${camera.entry_id}|${dayKey(d)}`;
      if (key in this._counts) continue;
      try {
        const res = await this._hass.callWS({ type: "ezviz_recordings/timeline", entry_id: camera.entry_id, day: dayKey(d) });
        this._counts[key] = res.events.filter((e) => e.kind === "person").length;
        this._counts[`${key}|armed`] = res.armed.length > 0;
      } catch (err) {
        this._counts[key] = null;
      }
      if (camera !== this._camera) return;
      this._renderDays();
    }
  }

  _days() {
    const today = startOfDay(nowIn(this._tz));
    return Array.from({ length: 14 }, (_, i) => new Date(today.getTime() - i * DAY));
  }

  _visibleEvents() {
    const events = this._data?.events || [];
    return events.filter((e) =>
      (this._onlyPersons ? e.kind === "person" : e.kind !== "offline") &&
      (!this._onlyArmed || this._isArmed(fromIso(e.time).getTime())));
  }

  _isArmed(ms) {
    return (this._data?.armed || []).some(([a, b]) => ms >= fromIso(a).getTime() && ms <= fromIso(b).getTime());
  }

  // ---------------------------------------------------------------- rendering

  _render() {
    const t = this._t;
    const cams = this._cameras;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; min-height:100%; background:var(--primary-background-color); color:var(--primary-text-color);
                font-family:var(--paper-font-body1_-_font-family, system-ui, sans-serif); --accent:#ff9800; --armed:rgba(229,57,53,.22); }
        .toolbar { display:flex; align-items:center; gap:4px; height:56px; padding:0 8px; box-sizing:border-box;
                   background:var(--app-header-background-color, var(--primary-color)); color:var(--app-header-text-color, #fff);
                   font-size:20px; position:sticky; top:0; z-index:3; }
        .wrap { max-width:1200px; margin:0 auto; padding:12px 16px 32px; box-sizing:border-box; }
        .sticky { position:sticky; top:56px; z-index:2; background:var(--primary-background-color); padding-bottom:8px; margin:0 -4px; }
        .player { position:relative; background:#000; border-radius:12px; overflow:hidden; aspect-ratio:16/9; }
        video, .poster { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; background:#000; }
        .poster { display:none; }
        .badge { position:absolute; top:8px; left:8px; background:rgba(0,0,0,.6); color:#fff; border-radius:8px;
                 padding:4px 10px; font-size:15px; font-variant-numeric:tabular-nums; pointer-events:none; }
        .badge b { color:#ffb74d; margin-right:6px; }
        .status { position:absolute; inset:auto 0 0 0; padding:10px 12px; background:linear-gradient(transparent, rgba(0,0,0,.75));
                  color:#fff; font-size:14px; display:none; }
        .spinner { position:absolute; top:50%; left:50%; width:40px; height:40px; margin:-20px; border-radius:50%;
                   border:4px solid rgba(255,255,255,.25); border-top-color:#fff; animation:spin 1s linear infinite; display:none; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .tl { position:relative; margin-top:8px; height:76px; border-radius:10px; background:var(--card-background-color);
              touch-action:none; cursor:grab; user-select:none; }
        .tl canvas { width:100%; height:100%; display:block; }
        .tl .now { position:absolute; top:-2px; left:50%; transform:translateX(-50%); background:var(--primary-color);
                   color:var(--text-primary-color, #fff); font-size:12px; padding:1px 8px; border-radius:8px;
                   font-variant-numeric:tabular-nums; pointer-events:none; }
        .jumps { display:grid; grid-template-columns:1.2fr 1fr 1fr 1.2fr; gap:8px; margin-top:8px; }
        .jumps button { min-height:44px; border-radius:10px; border:1px solid var(--divider-color);
                        background:var(--card-background-color); color:var(--primary-text-color); font-size:14px; cursor:pointer;
                        font-variant-numeric:tabular-nums; padding:0 6px; }
        .jumps button.p { color:var(--accent); font-weight:600; }
        .chips { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; margin-bottom:10px; scrollbar-width:none; }
        .chip { flex:none; min-height:40px; padding:0 14px; border-radius:20px; border:1px solid var(--divider-color);
                background:var(--card-background-color); color:var(--primary-text-color); font-size:15px; cursor:pointer; }
        .chip[aria-pressed="true"] { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:transparent; }
        .day { display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:62px; min-height:52px; line-height:1.15; }
        .day small { font-size:12px; opacity:.8; }
        .day .n { font-size:12px; color:var(--accent); font-weight:600; }
        .day.armed { box-shadow:inset 0 -3px 0 #e53935; }
        .card { background:var(--card-background-color); border-radius:12px; padding:12px; margin-bottom:12px;
                box-shadow:var(--ha-card-box-shadow, none); }
        label { display:block; font-size:13px; color:var(--secondary-text-color); margin-bottom:6px; }
        .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
        input[type=datetime-local] { flex:1 1 200px; min-height:44px; font-size:16px; padding:0 10px; box-sizing:border-box;
                border-radius:8px; border:1px solid var(--divider-color); background:var(--primary-background-color);
                color:var(--primary-text-color); }
        button.act { min-height:44px; padding:0 18px; border-radius:22px; border:none; font-size:15px; cursor:pointer;
                     background:var(--primary-color); color:var(--text-primary-color, #fff); }
        .events { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:8px; }
        .ev { display:flex; flex-direction:column; text-align:left; padding:0; border-radius:10px; overflow:hidden; cursor:pointer;
              border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); }
        .ev .img { aspect-ratio:16/9; background:#222 center/cover no-repeat; }
        .ev .meta { padding:6px 8px; font-size:13px; display:flex; flex-direction:column; gap:2px; }
        .ev .meta b { font-size:15px; font-variant-numeric:tabular-nums; }
        .ev .kind.person { color:var(--accent); font-weight:600; }
        .ev .tag { font-size:11px; color:#e53935; }
        .ev.current { outline:2px solid var(--primary-color); }
        .muted { color:var(--secondary-text-color); font-size:14px; padding:8px 2px; }
        .empty { padding:24px 4px; color:var(--secondary-text-color); }
        .debug { font:12px/1.35 monospace; white-space:pre-wrap; word-break:break-all; background:var(--card-background-color);
                 border-radius:12px; padding:8px; margin-top:12px; max-height:340px; overflow:auto; }
        @media (min-width: 960px) {
          .grid { display:grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap:16px; align-items:start; }
          .sticky { top:64px; }
        }
      </style>
      <div class="toolbar"><ha-menu-button></ha-menu-button><span>${t.title}</span></div>
      <div class="wrap">
        ${cams === null ? `<div class="empty">${t.loading}</div>` : !cams.length ? `<div class="empty">${t.noCameras}</div>` : `
        <div class="chips" role="group">
          ${cams.map((c) => `<button class="chip" data-cam="${c.entry_id}" aria-pressed="${c.entry_id === this._camera?.entry_id}">${esc(c.name)}</button>`).join("")}
        </div>
        <div class="grid">
          <div class="sticky">
            <div class="player">
              <img class="poster" alt="">
              <video playsinline muted autoplay></video>
              <div class="badge" hidden><b>${t.sd}</b><span class="pos"></span></div>
              <div class="spinner"></div>
              <div class="status"></div>
            </div>
            <div class="tl" title="${t.dragHint}"><canvas></canvas><div class="now"></div></div>
            <div class="jumps">
              <button class="p" data-ev="-1">|◀ <span class="lp"></span></button>
              <button data-jump="-60">−1 min</button>
              <button data-jump="60">+1 min</button>
              <button class="p" data-ev="1"><span class="lp"></span> ▶|</button>
            </div>
          </div>
          <div>
            <div class="chips days"></div>
            <div class="chips">
              <button class="chip" data-filter="persons" aria-pressed="${this._onlyPersons}">${t.persons}</button>
              <button class="chip" data-filter="all" aria-pressed="${!this._onlyPersons}">${t.all}</button>
              <button class="chip" data-filter="armed" aria-pressed="${this._onlyArmed}">${t.armedOnly}</button>
            </div>
            <div class="eventsbox"></div>
            <div class="card">
              <label for="when">${t.when}</label>
              <div class="row">
                <input id="when" type="datetime-local" step="1" value="${toIso(this._start)}">
                <button class="act go">${t.go}</button>
              </div>
            </div>
          </div>
        </div>
        ${this._debug ? `<pre class="debug"></pre>` : ""}`}
      </div>`;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    if (!cams || !cams.length) return;
    this._bind();
    this._setupTimeline();
    this._renderDays();
    this._renderEvents();
    this._updateJumpLabels();
    this._setStatus(this._t.pick, false);
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll("[data-cam]").forEach((el) =>
      el.addEventListener("click", () => {
        if (el.dataset.cam === this._camera?.entry_id) return;
        this._camera = this._cameras.find((c) => c.entry_id === el.dataset.cam);
        root.querySelectorAll("[data-cam]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
        // switching camera does not start a playback: the user picks the moment first
        this._stopPlayback();
        this._loadDay();
        this._loadCounts();
      }));
    root.querySelector(".go")?.addEventListener("click", () => {
      const d = fromIso(root.getElementById("when").value);
      if (!d) return;
      if (dayKey(d) !== dayKey(this._day)) { this._day = startOfDay(d); this._loadDay(); }
      this._play(d);
    });
    root.querySelectorAll("[data-jump]").forEach((el) =>
      el.addEventListener("click", () => {
        const base = this._position()?.getTime() ?? this._center;
        this._play(new Date(base + Number(el.dataset.jump) * 1000));
      }));
    root.querySelectorAll("[data-ev]").forEach((el) =>
      el.addEventListener("click", () => this._jumpEvent(Number(el.dataset.ev))));
    root.querySelectorAll("[data-filter]").forEach((el) =>
      el.addEventListener("click", () => {
        const f = el.dataset.filter;
        if (f === "armed") this._onlyArmed = !this._onlyArmed;
        else this._onlyPersons = f === "persons";
        root.querySelector('[data-filter="persons"]').setAttribute("aria-pressed", String(this._onlyPersons));
        root.querySelector('[data-filter="all"]').setAttribute("aria-pressed", String(!this._onlyPersons));
        root.querySelector('[data-filter="armed"]').setAttribute("aria-pressed", String(this._onlyArmed));
        this._updateJumpLabels();
        this._renderEvents();
        this._drawTimeline();
      }));
  }

  _updateJumpLabels() {
    const t = this._t;
    this.shadowRoot.querySelectorAll(".lp").forEach((el) => { el.textContent = this._onlyPersons ? t.nextPerson : t.nextEvent; });
  }

  _renderDays() {
    const box = this.shadowRoot.querySelector(".days");
    if (!box || !this._camera) return;
    const t = this._t;
    const lang = (this._hass?.language || "en").startsWith("it") ? "it-IT" : "en-GB";
    const fmt = new Intl.DateTimeFormat(lang, { timeZone: "UTC", weekday: "short", day: "numeric" });
    box.innerHTML = this._days().map((d, i) => {
      const key = `${this._camera.entry_id}|${dayKey(d)}`;
      const n = this._counts[key];
      const label = i === 0 ? t.today : i === 1 ? t.yesterday : fmt.format(d);
      return `<button class="chip day ${this._counts[`${key}|armed`] ? "armed" : ""}" data-day="${dayKey(d)}"
                aria-pressed="${dayKey(d) === dayKey(this._day)}"><span>${esc(label)}</span>
                <span class="n">${n ? `● ${n}` : "&nbsp;"}</span></button>`;
    }).join("");
    box.querySelectorAll("[data-day]").forEach((el) =>
      el.addEventListener("click", () => {
        const d = fromIso(`${el.dataset.day}T00:00:00`);
        if (dayKey(d) === dayKey(this._day)) return;
        this._stopPlayback();
        this._day = d;
        const today = startOfDay(nowIn(this._tz));
        this._center = d.getTime() === today.getTime() ? nowIn(this._tz).getTime() - 5 * 60000 : d.getTime() + 12 * 3600000;
        this._span = DAY;
        this._start = new Date(this._center);
        const input = this.shadowRoot.getElementById("when");
        if (input) input.value = toIso(this._start);
        this._loadDay();
        box.querySelectorAll("[data-day]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
      }));
  }

  _renderEvents() {
    const box = this.shadowRoot.querySelector(".eventsbox");
    if (!box) return;
    const t = this._t;
    if (!this._data) { box.innerHTML = `<div class="muted">${t.loading}</div>`; return; }
    if (!this._data.has_events) { box.innerHTML = `<div class="muted">${t.noSource}</div>`; return; }
    const events = this._visibleEvents().slice().reverse();
    if (!events.length) { box.innerHTML = `<div class="muted">${t.noEvents}</div>`; return; }
    box.innerHTML = `<div class="events">${events.map((e) => `
      <button class="ev" data-evid="${esc(e.id)}" data-time="${esc(e.time)}">
        <div class="img" data-img="${esc(e.id)}"></div>
        <div class="meta"><b>${e.time.slice(11, 19)}</b>
          <span class="kind ${e.kind}">${esc(t[e.kind] || e.title)}</span>
          ${this._isArmed(fromIso(e.time).getTime()) ? `<span class="tag">● ${t.armed}</span>` : ""}
        </div>
      </button>`).join("")}</div>`;
    box.querySelectorAll(".ev").forEach((el) =>
      el.addEventListener("click", () => this._play(new Date(fromIso(el.dataset.time).getTime() - 10000))));
    // event snapshots, loaded only when visible
    const io = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      io.unobserve(entry.target);
      this._loadImage(entry.target);
    }), { rootMargin: "200px" });
    box.querySelectorAll("[data-img]").forEach((el) => io.observe(el));
  }

  async _loadImage(el) {
    const id = el.dataset.img;
    const key = `${this._camera.entry_id}|${id}`;
    if (!(key in this._images)) {
      this._images[key] = this._hass.callWS({ type: "ezviz_recordings/event_image", entry_id: this._camera.entry_id, event_id: id })
        .then((res) => `data:${res.content_type};base64,${res.data}`).catch(() => null);
    }
    const src = await this._images[key];
    if (src) el.style.backgroundImage = `url(${src})`;
  }

  // ---------------------------------------------------------------- timeline

  _setupTimeline() {
    const tl = this.shadowRoot.querySelector(".tl");
    if (!tl) return;
    this._resize?.disconnect();
    this._resize = new ResizeObserver(() => this._drawTimeline());
    this._resize.observe(tl);
    const pointers = new Map();
    let last = null;
    let pinch = null;
    let moved = false;
    const width = () => tl.getBoundingClientRect().width || 1;
    tl.addEventListener("pointerdown", (ev) => {
      tl.setPointerCapture(ev.pointerId);
      pointers.set(ev.pointerId, ev.clientX);
      last = ev.clientX;
      moved = false;
      this._dragging = true;
      clearTimeout(this._seekTimer);
      if (pointers.size === 2) {
        const xs = [...pointers.values()];
        pinch = { dist: Math.abs(xs[0] - xs[1]) || 1, span: this._span };
      }
    });
    tl.addEventListener("pointermove", (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, ev.clientX);
      if (pointers.size === 2 && pinch) {
        const xs = [...pointers.values()];
        const dist = Math.abs(xs[0] - xs[1]) || 1;
        this._setSpan(pinch.span * (pinch.dist / dist));
        moved = true;
      } else if (pointers.size === 1) {
        const dx = ev.clientX - last;
        last = ev.clientX;
        if (Math.abs(dx) > 0) moved = true;
        this._setCenter(this._center - (dx * this._span) / width());
      }
    });
    const end = (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        this._dragging = false;
        if (!moved) {
          // a tap moves the playhead to the tapped point
          const rect = tl.getBoundingClientRect();
          this._setCenter(this._center + ((ev.clientX - rect.left - rect.width / 2) * this._span) / rect.width);
        }
        clearTimeout(this._seekTimer);
        this._seekTimer = setTimeout(() => this._play(new Date(Math.round(this._center / 1000) * 1000)), 450);
      } else {
        last = [...pointers.values()][0];
      }
    };
    tl.addEventListener("pointerup", end);
    tl.addEventListener("pointercancel", end);
    tl.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
        this._setCenter(this._center + (ev.deltaX * this._span) / width());
      } else {
        this._setSpan(this._span * (ev.deltaY > 0 ? 1.25 : 0.8));
      }
      clearTimeout(this._seekTimer);
      this._seekTimer = setTimeout(() => this._play(new Date(Math.round(this._center / 1000) * 1000)), 700);
    }, { passive: false });
  }

  _setSpan(span) {
    this._span = Math.min(DAY, Math.max(SPANS[SPANS.length - 1], span));
    this._setCenter(this._center);
  }

  _setCenter(ms) {
    const day = this._day.getTime();
    this._center = Math.min(day + DAY - 1000, Math.max(day, ms));
    this._drawTimeline();
  }

  _drawTimeline() {
    const tl = this.shadowRoot.querySelector(".tl");
    const canvas = tl?.querySelector("canvas");
    if (!canvas || !this._day) return;
    const rect = tl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(this);
    const text = style.getPropertyValue("--secondary-text-color").trim() || "#888";
    const primary = style.getPropertyValue("--primary-color").trim() || "#03a9f4";
    const divider = style.getPropertyValue("--divider-color").trim() || "rgba(127,127,127,.3)";
    const span = this._span;
    const left = this._center - span / 2;
    const x = (ms) => ((ms - left) / span) * w;
    const day = this._day.getTime();
    const top = 18;
    const bottom = h - 16;
    // outside the selected day
    ctx.fillStyle = "rgba(127,127,127,.12)";
    if (x(day) > 0) ctx.fillRect(0, top, x(day), bottom - top);
    if (x(day + DAY) < w) ctx.fillRect(x(day + DAY), top, w - x(day + DAY), bottom - top);
    // future (no recording yet)
    const now = nowIn(this._tz).getTime();
    if (x(now) < w) {
      ctx.fillStyle = "rgba(127,127,127,.18)";
      ctx.fillRect(Math.max(0, x(now)), top, w - Math.max(0, x(now)), bottom - top);
    }
    // armed periods
    ctx.fillStyle = "rgba(229,57,53,.25)";
    for (const [a, b] of this._data?.armed || []) {
      const xa = x(fromIso(a).getTime());
      const xb = x(fromIso(b).getTime());
      if (xb > 0 && xa < w) ctx.fillRect(Math.max(0, xa), top, Math.min(w, xb) - Math.max(0, xa), bottom - top);
    }
    // hour ticks and labels
    const steps = [60000, 300000, 900000, 1800000, 3600000, 3 * 3600000, 6 * 3600000];
    const step = steps.find((s) => (s / span) * w >= 56) || 6 * 3600000;
    ctx.strokeStyle = divider;
    ctx.fillStyle = text;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    for (let m = Math.ceil(left / step) * step; m <= left + span; m += step) {
      const px = x(m);
      ctx.beginPath(); ctx.moveTo(px, bottom); ctx.lineTo(px, bottom - 6); ctx.stroke();
      const d = new Date(m);
      ctx.fillText(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, px, h - 3);
    }
    // events: motion as thin grey marks, people as orange bars with a dot
    for (const e of this._data?.events || []) {
      if (e.kind === "offline") continue;
      const visible = this._onlyPersons ? e.kind === "person" : true;
      const px = x(fromIso(e.time).getTime());
      if (px < -4 || px > w + 4) continue;
      if (e.kind === "person") {
        ctx.fillStyle = visible ? "#ff9800" : "rgba(255,152,0,.35)";
        ctx.fillRect(px - 1.5, top + 4, 3, bottom - top - 4);
        ctx.beginPath(); ctx.arc(px, top + 4, 4, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = visible ? "rgba(158,158,158,.9)" : "rgba(158,158,158,.35)";
        ctx.fillRect(px - 0.75, top + 14, 1.5, bottom - top - 14);
      }
    }
    // playhead
    ctx.strokeStyle = primary;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w / 2, top - 2); ctx.lineTo(w / 2, bottom + 2); ctx.stroke();
    ctx.lineWidth = 1;
    const label = tl.querySelector(".now");
    const c = new Date(this._center);
    if (label) label.textContent = `${pad(c.getUTCHours())}:${pad(c.getUTCMinutes())}:${pad(c.getUTCSeconds())}`;
  }

  _jumpEvent(direction) {
    const events = this._visibleEvents();
    const from = this._position()?.getTime() ?? this._center;
    // events start ~10 s after the jump target, so look past that margin
    const target = direction > 0
      ? events.find((e) => fromIso(e.time).getTime() > from + 12000)
      : [...events].reverse().find((e) => fromIso(e.time).getTime() < from - 2000);
    if (!target) { this._setStatus(this._t.noMore, false); return; }
    this._play(new Date(fromIso(target.time).getTime() - 10000));
  }

  _stopPlayback() {
    this._request++;
    this._start = this._position() || this._start;
    this._t0 = null;
    this._teardown(true);
    const badge = this.shadowRoot.querySelector(".badge");
    if (badge) badge.hidden = true;
    this._setStatus(this._t.pick, false);
  }

  _position() {
    const video = this.shadowRoot.querySelector("video");
    if (!this._start || this._t0 === null || !video) return null;
    return new Date(this._start.getTime() + Math.max(0, video.currentTime - this._t0) * 1000);
  }

  _setStatus(text, spinning) {
    const status = this.shadowRoot.querySelector(".status");
    const spinner = this.shadowRoot.querySelector(".spinner");
    if (status) { status.textContent = text || ""; status.style.display = text ? "block" : "none"; }
    if (spinner) spinner.style.display = spinning ? "block" : "none";
  }

  _teardown(stopRemote) {
    clearInterval(this._tick);
    clearInterval(this._dbgTick);
    clearTimeout(this._watchdog);
    this._tick = null;
    if (this._hls) { this._hls.destroy(); this._hls = null; }
    const video = this.shadowRoot.querySelector("video");
    if (video) { video.removeAttribute("src"); video.load(); }
    if (stopRemote && this._playingEntry) {
      this._hass?.callWS({ type: "ezviz_recordings/stop", entry_id: this._playingEntry }).catch(() => {});
      this._playingEntry = null;
    }
  }

  async _play(start, attempt = 0) {
    if (!this._camera) return;
    const t = this._t;
    const request = ++this._request;
    const camera = this._camera;
    if (this._playingEntry && this._playingEntry !== camera.entry_id) this._teardown(true);
    else this._teardown(false);
    this._start = start;
    this._t0 = null;
    if (dayKey(start) !== dayKey(this._day)) {
      this._day = startOfDay(start);
      this._loadDay();
      this._renderDays();
    }
    if (this._span === DAY) this._span = 3600000;  // zoom in around the moment being watched
    this._setCenter(start.getTime());
    const input = this.shadowRoot.getElementById("when");
    if (input) input.value = toIso(start);
    const badge = this.shadowRoot.querySelector(".badge");
    const pos = this.shadowRoot.querySelector(".pos");
    const poster = this.shadowRoot.querySelector(".poster");
    const video = this.shadowRoot.querySelector("video");
    badge.hidden = false;
    pos.textContent = this._format(start);
    this._setStatus(t.opening, true);
    poster.style.display = "none";
    video.controls = false; // the native controls show a second spinner while loading

    // no thumbnail here: the camera rejects a second RTSP session while the playback opens
    const retry = () => {
      if (request !== this._request || this._t0 !== null) return false;
      if (attempt >= 1) return false;
      this._play(start, attempt + 1);
      return true;
    };

    let url;
    try {
      url = (await this._hass.callWS({ type: "ezviz_recordings/play", entry_id: camera.entry_id, start: toIso(start) })).url;
    } catch (err) {
      if (request === this._request && !retry()) this._setStatus(t.busy, false);
      return;
    }
    if (request !== this._request) return;
    this._playingEntry = camera.entry_id;

    const onPlaying = () => {
      if (request !== this._request) return;
      if (this._t0 === null) this._t0 = video.currentTime;
      clearTimeout(this._watchdog);
      poster.style.display = "none";
      video.controls = true;
      this._setStatus("", false);
    };
    video.addEventListener("playing", onPlaying, { once: true });
    if (this._debug) {
      const ms = window.MediaSource || window.ManagedMediaSource;
      this._dbg("url ok, native HLS:", video.canPlayType("application/vnd.apple.mpegurl") || "no",
        "| MSE avc1.4d0029:", ms ? ms.isTypeSupported('video/mp4; codecs="avc1.4d0029,mp4a.40.2"') : "no MSE",
        "| avc1.4d0032:", ms ? ms.isTypeSupported('video/mp4; codecs="avc1.4d0032"') : "-");
      ["loadedmetadata", "loadeddata", "canplay", "playing", "waiting", "stalled", "pause", "ended", "error", "seeking", "seeked"]
        .forEach((ev) => video.addEventListener(ev, () => {
          if (request === this._request) this._dbg("video", ev, `t=${video.currentTime.toFixed(2)}`, `rs=${video.readyState}`,
            `${video.videoWidth}x${video.videoHeight}`, video.error ? `err=${video.error.code} ${video.error.message}` : "");
        }));
      clearInterval(this._dbgTick);
      this._dbgTick = setInterval(() => {
        if (request !== this._request) return;
        const b = video.buffered; const ranges = [];
        for (let i = 0; i < b.length; i++) ranges.push(`${b.start(i).toFixed(1)}-${b.end(i).toFixed(1)}`);
        const q = video.getVideoPlaybackQuality ? video.getVideoPlaybackQuality() : null;
        this._dbg("tick", `t=${video.currentTime.toFixed(2)}`, `rs=${video.readyState}`, `paused=${video.paused}`,
          `buf=[${ranges.join(",")}]`, q ? `frames=${q.totalVideoFrames} dropped=${q.droppedVideoFrames}` : "");
      }, 2000);
    }
    // buffering after the start (e.g. waiting for the next HLS segment): show the spinner only
    // the native controls already show their own spinner while buffering
    video.onwaiting = () => { if (request === this._request && this._t0 !== null && !video.controls) this._setStatus("", true); };
    video.onplaying = () => { if (request === this._request && this._t0 !== null) this._setStatus("", false); };
    const startPlayback = () => {
      if (request === this._request) video.play().catch(() => {});
    };
    // Home Assistant needs 10-15 s to publish the first HLS segment of an SD recording
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (request === this._request && this._t0 === null && !retry()) this._setStatus(t.failed, false);
    }, 30000);

    // Prefer hls.js (MSE) like the Home Assistant camera player: recent desktop Chrome claims native HLS
    // support but fails to parse Home Assistant's fMP4 playlists (DEMUXER_ERROR_COULD_NOT_PARSE).
    const Hls = await loadHls().catch(() => null);
    if (request !== this._request) return;
    if (!Hls || !Hls.isSupported()) {
      this._dbg("player: native HLS");
      video.src = url;
      video.addEventListener("loadedmetadata", startPlayback, { once: true });
    } else {
      this._dbg("player: hls.js", Hls.version);
      // same loading timeouts the Home Assistant camera player uses
      this._hls = new Hls({
        lowLatencyMode: false,
        // start at the first segment (the requested moment) instead of the live edge: no stall after
        // the first seconds, and the footage starts exactly where the user asked
        startPosition: 0,
        backBufferLength: 60,
        manifestLoadingTimeOut: 30000,
        levelLoadingTimeOut: 30000,
        fragLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
      });
      this._hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
      if (this._debug) {
        const E = Hls.Events;
        this._hls.on(E.MANIFEST_PARSED, (_e, d) => this._dbg("hls manifest", d.levels.map((l) => `${l.codecSet || l.attrs?.CODECS} ${l.width}x${l.height}`).join(";")));
        this._hls.on(E.LEVEL_LOADED, (_e, d) => this._dbg("hls level", `live=${d.details.live}`, `frags=${d.details.fragments.length}`, `target=${d.details.targetduration}`, `edge=${d.details.edge?.toFixed?.(1)}`));
        this._hls.on(E.BUFFER_CODECS, (_e, d) => this._dbg("hls codecs", Object.entries(d).map(([k, v]) => `${k}:${v.codec || v.levelCodec}`).join(" ")));
        this._hls.on(E.FRAG_BUFFERED, (_e, d) => this._dbg("hls frag", d.frag.sn, d.frag.type, `start=${d.frag.start.toFixed(1)}`));
        this._hls.on(E.ERROR, (_e, d) => this._dbg("hls ERROR", `fatal=${d.fatal}`, d.type, d.details, d.reason || d.error?.message || ""));
      }
      this._hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && request === this._request) {
          console.warn("ezviz-recordings: playback error", data.type, data.details);
          if (!retry()) this._setStatus(`${t.failed} (${data.details})`, false);
        }
      });
      this._hls.attachMedia(video);
      this._hls.loadSource(url);
    }
    this._tick = setInterval(() => {
      const p = this._position();
      if (p) {
        pos.textContent = this._format(p);
        if (!this._dragging) this._setCenter(p.getTime());
      }
    }, 500);
  }

  _format(d) {
    const lang = (this._hass?.language || "en").startsWith("it") ? "it-IT" : "en-GB";
    return new Intl.DateTimeFormat(lang, {
      timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(d);
  }
}

if (!customElements.get("ezviz-recordings-panel")) customElements.define("ezviz-recordings-panel", EzvizRecordingsPanel);
