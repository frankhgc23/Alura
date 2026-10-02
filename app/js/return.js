/**
 * return.js — Retorno de audio (N-1) vía HLS, estrictamente bajo demanda.
 * @module return
 *
 * Estrategia:
 *  - Motor principal: hls.js (MSE) → soporta .m3u8 (TS o fMP4, AAC/MP3/MP2T…)
 *    en Chrome/Firefox/Edge/Android WebView.
 *  - Fallback: reproducción HLS nativa (Safari macOS/iOS, donde es más eficiente).
 *  - La fuente NO se toca hasta pulsar Play: el <audio> vive con `src` vacío y
 *    `preload="none"`, por lo que no hay ninguna conexión abierta en reposo.
 *  - Al pulsar Stop se destruye la instancia Hls (aborta todas las peticiones),
 *    se limpia src/load() del elemento y se liberan sockets, decodificador y
 *    búferes: cero consumo de ancho de banda mientras no se escuche.
 *  - Vúmetro opcional vía Web Audio (AnalyserNode). Si el stream no envía
 *    CORS (`crossOrigin` falla), se degrada limpiamente a "sin medición".
 */

import { $, log, toast, hms } from "./utils.js";

const DEFAULT_URL = "http://192.168.0.132:8888/live/index.m3u8";
const MAX_AUTO_RETRIES = 5;      // reintentos automáticos ante errores de red
const STALL_WATCHDOG_MS = 10_000; // si no avanza en 10 s → recarga suave

export class ReturnMonitor {
  /** @param {{els?: Record<string, HTMLElement|string>}} [opts] IDs de elementos UI. */
  constructor(opts = {}) {
    const ids = opts.els || {};
    this.el = {
      url:    $(ids.url    || "#returnUrl"),
      play:   $(ids.play   || "#btnReturnPlay"),
      stop:   $(ids.stop   || "#btnReturnStop"),
      state:  $(ids.state  || "#returnState"),
      time:   $(ids.time   || "#returnTime"),
      vu:     $(ids.vu     || "#returnVu"),
      db:     $(ids.db     || "#returnDb"),
      vol:    $(ids.vol    || "#returnVol"),
      volOut: $(ids.volOut || "#returnVolOut"),
      audio:  $(ids.audio  || "#returnAudio"),
    };

    this.hls = null;          // instancia hls.js activa
    this.ctx = null;          // AudioContext del vúmetro
    this.analyser = null;
    this.gain = null;
    this.srcNode = null;
    this.rafId = 0;
    this.startedAt = 0;
    this.clockId = 0;
    this.watchdogId = 0;
    this.retries = 0;
    this.nativeMode = false;
    this.running = false;

    if (this.el.url && !this.el.url.value) this.el.url.value = DEFAULT_URL;
    this._bind();
    this._setVolume(this.el.vol ? +this.el.vol.value : 100);
  }

  /* ------------------------------- UI base ------------------------------- */

  _setState(text, cls) {
    const s = this.el.state;
    if (!s) return;
    s.textContent = text;
    s.className = `pill-state ${cls}`;
  }

  _bind() {
    this.el.play?.addEventListener("click", () => this.start());
    this.el.stop?.addEventListener("click", () => this.stop());
    this.el.vol?.addEventListener("input", () => this._setVolume(+this.el.vol.value));
    // Pausa inteligente: si el operador oculta la pestaña, corta el retorno.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.running) this.stop();
    });
  }

  _setVolume(pct) {
    const v = Math.min(1, Math.max(0, (pct || 0) / 100));
    if (this.el.volOut) this.el.volOut.textContent = `${Math.round(v * 100)} %`;
    if (this.gain?.gain) this.gain.gain.value = v;         // vía Web Audio
    else if (this.el.audio) this.el.audio.volume = v;      // vía elemento
  }

  /* -------------------------------- Start -------------------------------- */

  async start() {
    if (this.running) return;
    const raw = (this.el.url?.value || "").trim();
    if (!raw) { toast("Introduce la URL .m3u8 del retorno", "warn"); return; }
    let url = raw;
    try { url = new URL(raw, location.href).href; } catch { /* tal cual */ }

    this.running = true;
    this.retries = 0;
    this.el.play.disabled = true;
    if (this.el.stop) this.el.stop.disabled = false;
    this._setState("CONECTANDO…", "warn");
    log(`Retorno: conectando ${url}`, "info");

    const video = this.el.audio;
    video.crossOrigin = null;               // evitar fallos CORS en streams sin ACAO
    this.nativeMode = !(window.Hls && window.Hls.isSupported());

    if (window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({
        lowLatencyMode: true,
        backBufferLength: 30,
        liveSyncDurationCount: 3,
        enableWorker: true,
        manifestLoadingTimeOut: 10_000,
        fragLoadingTimeOut: 20_000,
      });
      this._hookHlsEvents();
      this.hls.loadSource(url);
      this.hls.attachMedia(video);
    } else {
      // Safari / iOS: HLS nativo (también sirve como fallback si hls.js falta)
      this.nativeMode = true;
      video.src = url;
      log("Retorno: usando HLS nativo del navegador", "info");
      this._wireElementEvents();
    }

    // El play() real ocurre cuando hay datos suficientes (MANIFEST_PARSED / canplay)
    this._startClock();
    this._startWatchdog();
  }

  _hookHlsEvents() {
    const Hls = window.Hls;
    const h = this.hls;

    h.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      log(`Retorno: manifiesto OK (${data.levels.length} variante(s))`, "ok");
      this.el.audio.play?.().then(() => this._onPlaying()).catch((err) => {
        // Autoplay bloqueado: un click ya ocurrió sobre Play, pero iOS a veces
        // exige gesto extra → reintento diferido y aviso claro.
        log(`Retorno: play bloqueado (${err.name}). Pulse Play de nuevo.`, "warn");
        this._setState("REQUIERE TOQUE", "warn");
        this.el.play.disabled = false;
      });
    });

    h.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
      // MediaMTX suele exponer una única pista de audio; nada que seleccionar.
    });

    h.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          this._retry(`error de red (${data.details})`, () => h.startLoad());
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          this._retry(`error de medios (${data.details})`, () => h.recoverMediaError());
          break;
        default:
          this._retry(`error fatal (${data.details})`, () => this._softReload());
      }
    });
  }

  _wireElementEvents() {
    const v = this.el.audio;
    v.oncanplay = () => { v.play?.().then(() => this._onPlaying()).catch(() => {}); };
    v.onerror = () => this._retry("fallo de reproducción nativa", () => this._softReload());
    v.onstalled = () => this._retry("señal estancada (stalled)", () => this._softReload());
  }

  _onPlaying() {
    if (!this.running) return;
    this.retries = 0;
    this._setState(this.nativeMode ? "EN AIRE · NATIVO" : "EN AIRE · HLS.JS", "ok");
    this._setupMeter().catch(() => {});   // el vúmetro es best-effort
  }

  _retry(reason, recover) {
    if (!this.running) return;
    if (++this.retries > MAX_AUTO_RETRIES) {
      log(`Retorno: ${MAX_AUTO_RETRIES} reintentos fallidos. Detenido.`, "err");
      this._setState("ERROR", "bad");
      toast("Retorno: no se pudo recuperar la señal HLS", "err", 5000);
      this.stop();
      return;
    }
    const wait = Math.min(8, 2 ** this.retries);
    log(`Retorno: ${reason} → reintento ${this.retries} en ${wait}s`, "warn");
    this._setState(`RECUPERANDO (${this.retries}/${MAX_AUTO_RETRIES})`, "warn");
    setTimeout(() => { if (this.running) recover?.(); }, wait * 1000);
  }

  /** Recarga suave de la misma URL sin recrear toda la cadena de módulos. */
  _softReload() {
    const url = (this.el.url?.value || "").trim();
    if (!url || !this.running) return;
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    const v = this.el.audio;
    v.pause(); v.removeAttribute("src"); v.load();
    if (window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({ lowLatencyMode: true, backBufferLength: 30, liveSyncDurationCount: 3 });
      this._hookHlsEvents();
      this.hls.loadSource(url);
      this.hls.attachMedia(v);
    } else {
      v.src = url;
      this._wireElementEvents();
    }
  }

  /* -------------------------------- Stop --------------------------------- */

  /** Libera TODOS los recursos de red y decodificación (cero ancho de banda). */
  stop() {
    this.running = false;
    clearInterval(this.clockId); this.clockId = 0;
    clearInterval(this.watchdogId); this.watchdogId = 0;
    cancelAnimationFrame(this.rafId); this.rafId = 0;

    try { this.hls?.destroy(); } catch { /* noop */ }
    this.hls = null;

    const v = this.el.audio;
    if (v) {
      v.pause();
      v.oncanplay = v.onerror = v.onstalled = null;
      v.removeAttribute("src");
      try { v.load(); } catch { /* noop */ }   // aborta peticiones pendientes
    }

    // Desmontaje del grafo Web Audio (el nodo del elemento impide GC si queda vivo)
    try { this.srcNode?.disconnect(); } catch { /* noop */ }
    try { this.analyser?.disconnect(); } catch { /* noop */ }
    try { this.gain?.disconnect(); } catch { /* noop */ }
    this.srcNode = this.analyser = this.gain = null;
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close().catch(() => {});
    this.ctx = null;

    if (this.el.vu) this.el.vu.style.width = "0%";
    if (this.el.db) this.el.db.textContent = "-∞ dB";
    if (this.el.time) this.el.time.textContent = "00:00:00";
    this.startedAt = 0;
    if (this.el.play) this.el.play.disabled = false;
    if (this.el.stop) this.el.stop.disabled = true;
    this._setState("DESCONECTADO", "idle");
    log("Retorno: desconectado (recursos liberados)", "info");
  }

  /* ----------------------- Reloj + watchdog de stall ---------------------- */

  _startClock() {
    this.startedAt = Date.now();
    clearInterval(this.clockId);
    this.clockId = setInterval(() => {
      if (this.el.time && this.running)
        this.el.time.textContent = hms((Date.now() - this.startedAt) / 1000);
    }, 1000);
  }

  _startWatchdog() {
    clearInterval(this.watchdogId);
    let lastT = -1;
    this.watchdogId = setInterval(() => {
      if (!this.running) return;
      const t = this.el.audio?.currentTime ?? 0;
      if (t === lastT && t === 0 && this.retries === 0 &&
          Date.now() - this.startedAt > STALL_WATCHDOG_MS) {
        this._retry("sin datos tras 10 s", () => this._softReload());
      }
      lastT = t;
    }, STALL_WATCHDOG_MS);
  }

  /* ------------------------------ Vúmetro R ------------------------------- */

  async _setupMeter() {
    if (this.analyser || !window.AudioContext && !window.webkitAudioContext) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new AC();
      this.srcNode = this.ctx.createMediaElementSource(this.el.audio);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.gain = this.ctx.createGain();
      this.srcNode.connect(this.analyser);
      this.analyser.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this._buf = new Float32Array(this.analyser.fftSize);
      this._setVolume(this.el.vol ? +this.el.vol.value : 100);
      await this.ctx.resume().catch(() => {});
      this._meterLoop();
    } catch (err) {
      // createMediaElementSource lanza si el recurso está tainted (sin CORS):
      // seguimos reproduciendo audio, solo perdemos la medición.
      log(`Retorno: vúmetro no disponible (${err.message}); audio en marcha`, "warn");
      this._destroyGraphQuietly();
    }
  }

  _destroyGraphQuietly() {
    try { this.srcNode?.disconnect(); } catch { /* noop */ }
    this.srcNode = this.analyser = this.gain = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  _meterLoop() {
    const step = () => {
      if (!this.running || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(this._buf);
      let sum = 0;
      for (let i = 0; i < this._buf.length; i++) sum += this._buf[i] * this._buf[i];
      const rms = Math.sqrt(sum / this._buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const pct = Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
      if (this.el.vu) this.el.vu.style.width = `${pct}%`;
      if (this.el.db) this.el.db.textContent =
        Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-∞ dB";
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }
}
