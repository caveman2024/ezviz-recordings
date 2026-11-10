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
    live: "Live", liveBadge: "LIVE", openingLive: "Opening the live view…", ended: "End of the recording.",
    liveUnsupported: "This browser cannot show the live view here.",
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
    live: "Diretta", liveBadge: "DIRETTA", openingLive: "Apro la diretta…", ended: "Fine della registrazione.",
    liveUnsupported: "Questo browser non riesce a mostrare la diretta qui.",
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

// codec string of a fragmented MP4 init segment (avcC + optional mp4a)
function mp4Codecs(buf) {
  let video = null;
  let audio = false;
  for (let i = 4; i < buf.length - 8; i++) {
    if (!video && buf[i] === 0x61 && buf[i + 1] === 0x76 && buf[i + 2] === 0x63 && buf[i + 3] === 0x43) {
      const h = (x) => x.toString(16).padStart(2, "0");
      video = `avc1.${h(buf[i + 5])}${h(buf[i + 6])}${h(buf[i + 7])}`;
    }
    if (buf[i] === 0x6d && buf[i + 1] === 0x70 && buf[i + 2] === 0x34 && buf[i + 3] === 0x61) audio = true;
  }
  return video ? video + (audio ? ",mp4a.40.2" : "") : null;
}
function hasBox(buf, name) {
  const c = [...name].map((ch) => ch.charCodeAt(0));
  for (let i = 4; i < buf.length - 3; i++) {
    if (buf[i] === c[0] && buf[i + 1] === c[1] && buf[i + 2] === c[2] && buf[i + 3] === c[3]) return true;
  }
  return false;
}

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
    if (this._liveCard) this._liveCard.hass = hass;
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
    this._removeLiveCard();
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
        .badge.live b { color:#ff5252; }
        .golive { position:absolute; top:8px; right:8px; min-height:34px; padding:0 12px; border-radius:17px; border:none;
                  background:rgba(0,0,0,.6); color:#fff; font-size:14px; cursor:pointer; display:flex; align-items:center; gap:6px; }
        .golive::before { content:""; width:8px; height:8px; border-radius:50%; background:#ff5252; }
        .golive.on { background:#d32f2f; }
        .golive.on::before { background:#fff; }
        .livecard { position:absolute; inset:0; display:block; }
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
              <button class="golive" title="${t.live}">${t.live}</button>
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
    root.querySelector(".golive")?.addEventListener("click", () => this._play(null, 0, true));
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
    this._removeLiveCard();
    this._start = this._position() || this._start;
    this._live = false;
    this.shadowRoot.querySelector(".golive")?.classList.remove("on");
    this._t0 = null;
    this._teardown(true);
    const badge = this.shadowRoot.querySelector(".badge");
    if (badge) badge.hidden = true;
    this._setStatus(this._t.pick, false);
  }

  _position() {
    if (this._live && this._t0 !== null) return nowIn(this._tz);
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
    if (this._abort) { this._abort.abort(); this._abort = null; }
    const video = this.shadowRoot.querySelector("video");
    if (video) {
      if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
      video.removeAttribute("src");
      video.load();
    }
    if (stopRemote && this._playingEntry) {
      this._hass?.callWS({ type: "ezviz_recordings/stop", entry_id: this._playingEntry }).catch(() => {});
      this._playingEntry = null;
    }
  }

  // camera entity of the official EZVIZ integration matching this camera (by device / entity name)
  _liveEntity(camera) {
    const name = camera.name.toLowerCase();
    const entities = Object.values(this._hass?.entities || {});
    const match = entities.find((ent) => {
      if (!ent.entity_id.startsWith("camera.") || (ent.platform && ent.platform !== "ezviz")) return false;
      const device = this._hass.devices?.[ent.device_id];
      const names = [device?.name_by_user, device?.name, this._hass.states[ent.entity_id]?.attributes?.friendly_name]
        .filter(Boolean).map((n) => n.toLowerCase());
      return names.some((n) => n.includes(name));
    });
    return match?.entity_id || null;
  }

  async _loadWebrtcCard() {
    if (customElements.get("webrtc-camera")) return true;
    try {
      await import("/webrtc/webrtc-camera.js");
      await Promise.race([customElements.whenDefined("webrtc-camera"), new Promise((r) => setTimeout(r, 3000))]);
    } catch (err) {
      return false;
    }
    return !!customElements.get("webrtc-camera");
  }

  _removeLiveCard() {
    if (this._liveCard) { this._liveCard.remove(); this._liveCard = null; }
    const video = this.shadowRoot.querySelector("video");
    if (video) video.style.visibility = "";
  }

  async _showLiveCard(request) {
    const entity = this._liveEntity(this._camera);
    if (!entity || !(await this._loadWebrtcCard()) || request !== this._request) return false;
    const card = document.createElement("webrtc-camera");
    try {
      card.setConfig({ entity, muted: true, ui: true });
    } catch (err) {
      return false;
    }
    card.hass = this._hass;
    card.classList.add("livecard");
    this.shadowRoot.querySelector(".player").insertBefore(card, this.shadowRoot.querySelector(".badge"));
    this._liveCard = card;
    this.shadowRoot.querySelector("video").style.visibility = "hidden";
    this._t0 = 0;
    this._setStatus("", false);
    this._dbg("live: webrtc-camera", entity);
    return true;
  }

  async _play(start, attempt = 0, live = false) {
    if (!this._camera) return;
    this._removeLiveCard();
    const t = this._t;
    const request = ++this._request;
    const camera = this._camera;
    if (this._playingEntry && this._playingEntry !== camera.entry_id) this._teardown(true);
    else this._teardown(false);
    this._live = live;
    this._start = live ? nowIn(this._tz) : start;
    this._t0 = null;
    if (!live && dayKey(start) !== dayKey(this._day)) {
      this._day = startOfDay(start);
      this._loadDay();
      this._renderDays();
    } else if (live && dayKey(this._start) !== dayKey(this._day)) {
      this._day = startOfDay(this._start);
      this._loadDay();
      this._renderDays();
    }
    if (this._span === DAY) this._span = 3600000;  // zoom in around the moment being watched
    this._setCenter(this._start.getTime());
    const input = this.shadowRoot.getElementById("when");
    if (input && !live) input.value = toIso(start);
    const badge = this.shadowRoot.querySelector(".badge");
    const pos = this.shadowRoot.querySelector(".pos");
    const video = this.shadowRoot.querySelector("video");
    badge.hidden = false;
    badge.classList.toggle("live", live);
    badge.querySelector("b").textContent = live ? t.liveBadge : t.sd;
    pos.textContent = this._format(this._start);
    this.shadowRoot.querySelector(".golive")?.classList.toggle("on", live);
    this._setStatus(live ? t.openingLive : t.opening, true);
    video.controls = false; // the native controls show a second spinner while loading

    const retry = () => {
      if (request !== this._request || this._t0 !== null) return false;
      if (attempt >= 1) return false;
      this._play(start, attempt + 1, live);
      return true;
    };
    const onPlaying = () => {
      if (request !== this._request) return;
      if (this._t0 === null) this._t0 = video.currentTime;
      clearTimeout(this._watchdog);
      video.controls = true;
      this._setStatus("", false);
    };
    video.addEventListener("playing", onPlaying, { once: true });
    // the native controls already show their own spinner while buffering
    video.onwaiting = () => { if (request === this._request && this._t0 !== null && !video.controls) this._setStatus("", true); };
    video.onplaying = () => { if (request === this._request && this._t0 !== null) this._setStatus("", false); };
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (request === this._request && this._t0 === null && !retry()) this._setStatus(t.failed, false);
    }, 30000);
    this._playingEntry = camera.entry_id;
    this._tick = setInterval(() => {
      const p = this._position();
      if (p) {
        pos.textContent = this._format(p);
        if (!this._dragging) this._setCenter(p.getTime());
      }
    }, 500);

    // live: the WebRTC card of the dashboards (instant), our MP4 stream as a fallback
    if (live && (await this._showLiveCard(request))) {
      clearTimeout(this._watchdog);
      video.controls = false;
      return;
    }
    if (request !== this._request) return;

    // 1) low-latency path: fragmented MP4 streamed straight into Media Source Extensions
    const MS = window.ManagedMediaSource || window.MediaSource;
    if (MS) {
      try {
        const msg = { type: "ezviz_recordings/play", entry_id: camera.entry_id, format: "mp4" };
        if (live) msg.live = true; else msg.start = toIso(start);
        const { url } = await this._hass.callWS(msg);
        if (request !== this._request) return;
        this._dbg("player: mse", live ? "live" : "sd");
        await this._streamMse(url, request, video, live, MS);
        return;
      } catch (err) {
        if (request !== this._request) return;
        this._dbg("mse failed:", err?.message || err);
        if (this._t0 !== null) { this._setStatus(t.ended, false); return; }
        if (this._abort) { this._abort.abort(); this._abort = null; }
      }
    }
    if (live) { this._setStatus(t.liveUnsupported, false); return; }

    // 2) fallback: Home Assistant HLS (slower start)
    let url;
    try {
      url = (await this._hass.callWS({ type: "ezviz_recordings/play", entry_id: camera.entry_id, start: toIso(start) })).url;
    } catch (err) {
      if (request === this._request && !retry()) this._setStatus(t.busy, false);
      return;
    }
    if (request !== this._request) return;
    const startPlayback = () => {
      if (request === this._request) video.play().catch(() => {});
    };
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
      this._hls = new Hls({
        lowLatencyMode: false,
        startPosition: 0,
        backBufferLength: 60,
        manifestLoadingTimeOut: 30000,
        levelLoadingTimeOut: 30000,
        fragLoadingTimeOut: 30000,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 3,
      });
      this._hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
      this._hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal && request === this._request) {
          console.warn("ezviz-recordings: playback error", data.type, data.details);
          if (!retry()) this._setStatus(`${t.failed} (${data.details})`, false);
        }
      });
      this._hls.attachMedia(video);
      this._hls.loadSource(url);
    }
  }

  async _streamMse(url, request, video, live, MS) {
    const ms = new MS();
    if (window.ManagedMediaSource && MS === window.ManagedMediaSource) video.disableRemotePlayback = true;
    video.src = URL.createObjectURL(ms);
    await new Promise((resolve) => ms.addEventListener("sourceopen", resolve, { once: true }));
    this._abort = new AbortController();
    const res = await fetch(url, { signal: this._abort.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    let sb = null;
    let head = new Uint8Array(0);
    const queue = [];
    const pump = () => {
      if (!sb || sb.updating || ms.readyState !== "open") return;
      // keep at most ~90 s behind the playhead in memory
      const b = sb.buffered;
      if (b.length && video.currentTime - b.start(0) > 90) { sb.remove(b.start(0), video.currentTime - 30); return; }
      if (queue.length) sb.appendBuffer(queue.shift());
    };
    while (request === this._request) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!sb) {
        const joined = new Uint8Array(head.length + value.length);
        joined.set(head); joined.set(value, head.length);
        head = joined;
        const codecs = mp4Codecs(head);
        if (!codecs || !hasBox(head, "moof")) continue;  // wait for the init segment and the first fragment
        const type = `video/mp4; codecs="${codecs}"`;
        if (!MS.isTypeSupported(type)) throw new Error(`unsupported ${codecs}`);
        this._dbg("mse codecs", codecs);
        sb = ms.addSourceBuffer(type);
        sb.mode = "segments";
        sb.addEventListener("updateend", pump);
        queue.push(head);
        pump();
        continue;
      }
      queue.push(value);
      pump();
      if (video.paused && video.buffered.length && this._t0 === null) video.play().catch(() => {});
      if (live && video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        if (end - video.currentTime > 3) video.currentTime = end - 0.5;  // stay close to real time
      }
    }
    if (request === this._request && this._t0 === null) throw new Error("stream ended before playback");
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
