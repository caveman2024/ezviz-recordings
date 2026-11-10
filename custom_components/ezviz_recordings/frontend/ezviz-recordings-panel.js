/*
 * EZVIZ Recordings panel (phase 1): pick a camera and a moment, play the SD card from there.
 * Times are camera-local wall-clock values, handled as "naive" timestamps stored in UTC fields
 * so that the browser time zone never shifts them.
 */
const STATIC = "/ezviz_recordings_static";

const TEXT = {
  en: {
    title: "Recordings", loading: "Loading…", noCameras: "No camera configured. Add one in Settings → Devices & services → EZVIZ Recordings.",
    go: "Play", now: "Live minus 5 min", hourAgo: "1 h ago", opening: "Opening the recording… (5–10 s)",
    playing: "Recording", failed: "The camera did not return a recording for this moment.",
    busy: "The camera is busy or not answering. Try again in a few seconds.", sd: "SD",
    when: "Moment",
  },
  it: {
    title: "Registrazioni", loading: "Caricamento…", noCameras: "Nessuna telecamera configurata. Aggiungila da Impostazioni → Dispositivi e servizi → EZVIZ Recordings.",
    go: "Guarda", now: "5 min fa", hourAgo: "1 ora fa", opening: "Apro la registrazione… (5–10 s)",
    playing: "Registrazione", failed: "La telecamera non ha registrazioni per questo momento.",
    busy: "La telecamera è occupata o non risponde. Riprova tra qualche secondo.", sd: "SD",
    when: "Momento",
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
function nowIn(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second));
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
    const wanted = params.get("camera");
    this._camera =
      this._cameras.find((c) => c.entry_id === wanted || c.name.toLowerCase() === (wanted || "").toLowerCase()) ||
      this._cameras[0] || null;
    this._start = fromIso(params.get("t") || "") || new Date(nowIn(this._tz).getTime() - 5 * 60000);
    this._render();
    if (params.get("t") && this._camera) this._play(this._start);
  }

  _render() {
    const t = this._t;
    const cams = this._cameras;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display:block; min-height:100%; background:var(--primary-background-color); color:var(--primary-text-color);
                font-family:var(--paper-font-body1_-_font-family, system-ui, sans-serif); }
        .toolbar { display:flex; align-items:center; gap:4px; height:56px; padding:0 8px; box-sizing:border-box;
                   background:var(--app-header-background-color, var(--primary-color)); color:var(--app-header-text-color, #fff);
                   font-size:20px; position:sticky; top:0; z-index:2; }
        .wrap { max-width:1100px; margin:0 auto; padding:12px 16px 32px; box-sizing:border-box; }
        .player { position:sticky; top:56px; z-index:1; background:#000; border-radius:12px; overflow:hidden;
                  aspect-ratio:16/9; margin:0 -4px 12px; }
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
        .chips { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; margin-bottom:12px; }
        .chip { flex:none; min-height:40px; padding:0 16px; border-radius:20px; border:1px solid var(--divider-color);
                background:var(--card-background-color); color:var(--primary-text-color); font-size:15px; cursor:pointer; }
        .chip[aria-pressed="true"] { background:var(--primary-color); color:var(--text-primary-color, #fff); border-color:transparent; }
        .card { background:var(--card-background-color); border-radius:12px; padding:12px; margin-bottom:12px;
                box-shadow:var(--ha-card-box-shadow, none); }
        label { display:block; font-size:13px; color:var(--secondary-text-color); margin-bottom:6px; }
        .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
        input[type=datetime-local] { flex:1 1 220px; min-height:44px; font-size:16px; padding:0 10px; box-sizing:border-box;
                border-radius:8px; border:1px solid var(--divider-color); background:var(--primary-background-color);
                color:var(--primary-text-color); }
        button.act { min-height:44px; padding:0 18px; border-radius:22px; border:none; font-size:15px; cursor:pointer;
                     background:var(--primary-color); color:var(--text-primary-color, #fff); }
        .jumps { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-top:10px; }
        .jumps button { min-height:44px; border-radius:10px; border:1px solid var(--divider-color);
                        background:var(--primary-background-color); color:var(--primary-text-color); font-size:15px; cursor:pointer;
                        font-variant-numeric:tabular-nums; }
        .quick { margin-top:10px; }
        .quick .chip { min-height:36px; font-size:14px; }
        .empty { padding:24px 4px; color:var(--secondary-text-color); }
        @media (min-width: 900px) {
          .grid { display:grid; grid-template-columns: 1.6fr 1fr; gap:16px; align-items:start; }
          .player { position:relative; top:auto; margin:0; }
        }
      </style>
      <div class="toolbar"><ha-menu-button></ha-menu-button><span>${t.title}</span></div>
      <div class="wrap">
        ${cams === null ? `<div class="empty">${t.loading}</div>` : !cams.length ? `<div class="empty">${t.noCameras}</div>` : `
        <div class="chips" role="group">
          ${cams.map((c) => `<button class="chip" data-cam="${c.entry_id}" aria-pressed="${c.entry_id === this._camera?.entry_id}">${c.name}</button>`).join("")}
        </div>
        <div class="grid">
          <div class="player">
            <img class="poster" alt="">
            <video playsinline muted autoplay></video>
            <div class="badge" hidden><b>${t.sd}</b><span class="pos"></span></div>
            <div class="spinner"></div>
            <div class="status"></div>
          </div>
          <div>
            <div class="card">
              <label for="when">${t.when}</label>
              <div class="row">
                <input id="when" type="datetime-local" step="1" value="${toIso(this._start)}">
                <button class="act go">${t.go}</button>
              </div>
              <div class="jumps">
                <button data-jump="-600">−10 min</button><button data-jump="-60">−1 min</button>
                <button data-jump="60">+1 min</button><button data-jump="600">+10 min</button>
              </div>
              <div class="chips quick">
                <button class="chip" data-ago="300">${t.now}</button>
                <button class="chip" data-ago="3600">${t.hourAgo}</button>
              </div>
            </div>
          </div>
        </div>`}
      </div>`;
    const menu = this.shadowRoot.querySelector("ha-menu-button");
    if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    this.shadowRoot.querySelectorAll("[data-cam]").forEach((el) =>
      el.addEventListener("click", () => {
        this._camera = this._cameras.find((c) => c.entry_id === el.dataset.cam);
        this.shadowRoot.querySelectorAll("[data-cam]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
        this._play(this._position() || this._start);
      }));
    this.shadowRoot.querySelector(".go")?.addEventListener("click", () => {
      const d = fromIso(this.shadowRoot.getElementById("when").value);
      if (d) this._play(d);
    });
    this.shadowRoot.querySelectorAll("[data-jump]").forEach((el) =>
      el.addEventListener("click", () => {
        const base = this._position() || this._start;
        this._play(new Date(base.getTime() + Number(el.dataset.jump) * 1000));
      }));
    this.shadowRoot.querySelectorAll("[data-ago]").forEach((el) =>
      el.addEventListener("click", () => this._play(new Date(nowIn(this._tz).getTime() - Number(el.dataset.ago) * 1000))));
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

  async _play(start) {
    if (!this._camera) return;
    const t = this._t;
    const request = ++this._request;
    const camera = this._camera;
    if (this._playingEntry && this._playingEntry !== camera.entry_id) this._teardown(true);
    else this._teardown(false);
    this._start = start;
    this._t0 = null;
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

    // a still of the chosen moment shows up while the stream opens
    this._hass.callWS({ type: "ezviz_recordings/thumbnail", entry_id: camera.entry_id, at: toIso(start) })
      .then((res) => {
        if (request !== this._request || this._t0 !== null) return;
        poster.src = `data:${res.content_type};base64,${res.data}`;
        poster.style.display = "block";
      }).catch(() => {});

    let url;
    try {
      url = (await this._hass.callWS({ type: "ezviz_recordings/play", entry_id: camera.entry_id, start: toIso(start) })).url;
    } catch (err) {
      if (request === this._request) this._setStatus(t.busy, false);
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
    const startPlayback = () => {
      if (request === this._request) video.play().catch(() => {});
    };
    // Home Assistant needs 10-15 s to publish the first HLS segment of an SD recording
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (request === this._request && this._t0 === null) this._setStatus(t.failed, false);
    }, 45000);

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.addEventListener("loadedmetadata", startPlayback, { once: true });
    } else {
      const Hls = await loadHls();
      if (request !== this._request) return;
      // same loading timeouts the Home Assistant camera player uses
      this._hls = new Hls({
        lowLatencyMode: false,
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
          this._setStatus(`${t.failed} (${data.details})`, false);
        }
      });
      this._hls.attachMedia(video);
      this._hls.loadSource(url);
    }
    this._tick = setInterval(() => {
      const p = this._position();
      if (p) pos.textContent = this._format(p);
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

customElements.define("ezviz-recordings-panel", EzvizRecordingsPanel);
