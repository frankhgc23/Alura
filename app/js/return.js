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

/**
 * Normaliza la URL del retorno. Si la app se sirve por HTTPS y el stream es
 * HTTP LAN, el navegador BLOQUEA todo fetch/reproducción (mixed content):
 * avisamos una sola vez con instrucciones claras.
 */
let _mixedWarned = false;
function checkMixedContent(url) {
  if (_mixedWarned || location.protocol !== "https:" || !/^http:/i.test(url)) return true;
  _mixedWarned = true;
  log("Retorno: página HTTPS + stream HTTP = mixed content (el navegador bloquea el audio). " +
      "Sirve WHIP Studio por http://<LAN-IP> o expón HLS tras el mismo dominio HTTPS.", "err");
  toast("Bloqueo de contenido mixto: abre la app por HTTP LAN o sirve HLS por HTTPS", "err", 7000);
  return false;
}

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
    this._playSeq = 0;          // secuencia Play/Stop: invalida plays en cola
    this._meterFailed = false;  // vúmetro ya falló → no reintentar (evita spam)
    this._meterWanted = false;  // usuario activó vúmetro manualmente?
    this.video = null;          // elemento <audio> activo (nuevo en cada Play)

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
    // Stop se gestiona con captura + once: si un Play pendiente quedó en cola,
    // se cancela antes de liberar recursos (evita "resucitar" tras Stop).
    this.el.play?.addEventListener("click", () => { this._playSeq++; this.start(); });
    this.el.stop?.addEventListener("click", () => { this._playSeq++; this.stop(); }, true);
    // Botón VU: activa/desactiva el vúmetro manualmente (solo si CORS OK)
    this.btnMeter = $("#btnReturnMeter");
    this._meterWanted = false;
    this.btnMeter?.addEventListener("click", () => {
      if (!this.running) return toast("Conecta primero el retorno", "warn");
      if (this._meterWanted) {           // OFF → apagar grafo y limpiar UI
        this._meterWanted = false;
        this._destroyGraphQuietly();
        if (this.el.vu) this.el.vu.style.width = "0%";
        if (this.el.db) this.el.db.textContent = "-∞ dB";
        this.btnMeter.classList.remove("active");
        log("Retorno: vúmetro desactivado", "info");
      } else {                            // ON → intentar montar grafo nuevo elemento
        this._meterWanted = true;
        this._setupMeter().catch(() => {});
        this.btnMeter.classList.add("active");
      }
    });
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
    else if (this.video) this.video.volume = v;            // vía elemento activo
  }

  /**
   * Clona un <audio> nuevo sobre el estático del HTML (mismo id visual).
   * Motivo: createMediaElementSource() es IRREVERSIBLE por elemento — reutilizar
   * el mismo nodo tras Stop dejaba el vúmetro roto (InvalidStateError) y a veces
   * silencioso el play. Con elemento NUEVO por sesión, todo grafo funciona.
   */
  _swapAudioElement() {
    const old = this.video || this.el.audio;
    if (!old?.parentElement) return;
    const fresh = document.createElement("audio");
    fresh.id = old.id;
    fresh.preload = "none";
    fresh.playsInline = true;
    fresh.volume = this.el.vol ? Math.min(1, (+this.el.vol.value || 100) / 100) : 1;
    old.replaceWith(fresh);
    this.video = fresh;
    this._meterBound = false;       // vínculo con elemento viejo ya no aplica
    this._meterFailed = false;      // permitir vúmetro en sesión nueva
  }

  /* -------------------------------- Start -------------------------------- */

  async start() {
    if (this.running) return;
    const raw = (this.el.url?.value || "").trim();
    if (!raw) { toast("Introduce la URL .m3u8 del retorno", "warn"); return; }
    let url = raw;
    try { url = new URL(raw, location.href).href; } catch { /* tal cual */ }
    if (!checkMixedContent(url)) { this._setState("BLOQUEADO (HTTPS→HTTP)", "bad"); return; }

    this.running = true;
    this.retries = 0;
    this.el.play.disabled = true;
    if (this.el.stop) this.el.stop.disabled = false;
    this._setState("CONECTANDO…", "warn");
    log(`Retorno: conectando ${url}`, "info");

    // Estrategia anti-InvalidStateError: cada Play usa un <audio> NUEVO.
    // createMediaElementSource es irreversible por elemento → reutilizar el
    // mismo nodo tras Stop dejaba el vúmetro roto (y a veces el propio play).
    this._swapAudioElement();
    const video = this.video;
    video.removeAttribute("crossorigin");     // sin CORS no hay vúmetro, pero suena
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
      const seq = this._playSeq;
      this.video.play?.().then(() => this._onPlaying(seq)).catch(async (err) => {
        if (!this.running || seq !== this._playSeq) return;
        // Un clic ya es user-gesture; en iOS a veces el primer play() falla con
        // el elemento aún sin datos → mini-reintento antes de pedir toque manual.
        if (err.name === "NotAllowedError" || err.name === "AbortError") {
          await new Promise(r => setTimeout(r, 400));
          if (this.running && seq === this._playSeq) {
            try { await this.video.play(); this._onPlaying(seq); return; } catch { /* sigue */ }
          }
        }
        log(`Retorno: play detenido por el navegador (${err.name}). Pulse Play de nuevo.`, "warn");
        this._setState("REQUIERE TOQUE", "warn");
        if (this.el.play) this.el.play.disabled = false;
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
    const v = this.video;
    v.oncanplay = () => { const s = this._playSeq; v.play?.().then(() => this._onPlaying(s)).catch(() => {}); };
    v.onerror = () => this._retry("fallo de reproducción nativa", () => this._softReload());
    v.onstalled = () => this._retry("señal estancada (stalled)", () => this._softReload());
  }

  _onPlaying(seq) {
    if (!this.running || seq !== this._playSeq) return;   // play de una sesión ya cerrada
    this.retries = 0;
    this._setState(this.nativeMode ? "EN AIRE · NATIVO" : "EN AIRE · HLS.JS", "ok");
    // Vúmetro SOLO si el operador lo activa manualmente (botón), para no
    // tocar createMediaElementSource de forma automática y arriesgar silencio.
    if (this._meterWanted) this._setupMeter().catch(() => {});
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
    this._destroyGraphQuietly();          // grafo del elemento viejo, fuera
    this._swapAudioElement();             // elemento NUEVO → sin vínculos previos
    const v = this.video;
    const seq = this._playSeq;
    v.removeAttribute("crossorigin");
    v.volume = this.el.vol ? Math.min(1, (+this.el.vol.value || 100) / 100) : 1;
    v.pause(); v.removeAttribute("src"); v.load();
    if (window.Hls && window.Hls.isSupported()) {
      this.hls = new window.Hls({ lowLatencyMode: true, backBufferLength: 30, liveSyncDurationCount: 3 });
      this._hookHlsEvents();
      // Tras recargar, el navegador ya tiene user-gesture de pila: reintentar
      // play() cuando el manifiesto esté listo (el watchdog no puede crear gesto).
      this.hls.once?.(window.Hls.Events.MANIFEST_PARSED, () => {
        if (this.running && seq === this._playSeq)
          v.play?.().then(() => this._onPlaying(seq)).catch(() => {});
      });
      this.hls.loadSource(url);
      this.hls.attachMedia(v);
    } else {
      v.src = url;
      this._wireElementEvents();   // oncanplay → play() diferido (dentro de gesto pendiente)
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

    const v = this.video || this.el.audio;
    if (v) {
      v.pause();
      v.oncanplay = v.onerror = v.onstalled = null;
      v.removeAttribute("src");
      try { v.load(); } catch { /* noop */ }   // aborta peticiones pendientes
    }

    // Desmontaje del grafo Web Audio (el nodo del elemento impide GC si queda vivo)
    this._meterWanted = false;
    this.btnMeter?.classList.remove("active");
    this._destroyGraphQuietly();

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
    let lastMove = Date.now();
    this.watchdogId = setInterval(() => {
      if (!this.running) return;
      const v = this.video;
      const t = v?.currentTime ?? 0;
      if (t !== lastT) { lastT = t; lastMove = Date.now(); return; }
      // tiempo congelado… ¿está realmente pausado/estancado?
      const stalled = v && !v.paused && v.readyState < 3;
      if ((stalled || t === 0) && Date.now() - lastMove > STALL_WATCHDOG_MS) {
        lastMove = Date.now();   // no martillar mientras se recupera
        this._retry(v && v.paused ? "reproducción pausada inesperadamente"
                                  : "señal estancada (stalled)", () => this._softReload());
      }
    }, 5000);
  }

  /* ------------------------------ Vúmetro R ------------------------------- */

  /**
   * El <audio> es un elemento ESTÁTICO del HTML: si alguna vez se le creó un
   * MediaElementSourceNode, ese vínculo es permanente e irreversible — un
   * segundo createMediaElementSource lanza InvalidStateError. Además, los
   * streams HLS sin cabeceras CORS "taintean" el elemento y Web Audio se
   * niega a medirlos. Estrategia robusta:
   *   1) Solo intentar una vez por sesión de vida del elemento.
   *   2) Antes de crear el nodo, probar fetch(url): si no expone ACAO, no lo
   *      intentamos siquiera (evita el mensaje de error en cada Play).
   *   3) Si algo falla, degradar limpiamente a "sin medición" con volumen por
   *      elemento; nunca se interrumpe el audio.
   */
  async _setupMeter() {
    if (this.analyser || this._meterFailed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    try {
      // createMediaElementSource SIEMPRE enruta el audio del elemento hacia el
      // grafo: si el grafo no llega a destination, el elemento queda mudo.
      // Por eso se construye TODO el grafo dentro del mismo try y, ante error,
      // se destruye completo (el elemento recupera su salida directa).
      this.ctx = new AC();
      this.srcNode = this.ctx.createMediaElementSource(this.video);
      this._meterBound = true;               // vínculo elemento↔nodo: permanente
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
      this._meterFailed = true;              // no reintentar en esta sesión
      this.btnMeter?.classList.remove("active");
      this._meterWanted = false;
      log(`Retorno: vúmetro no disponible (${err.name}); audio por salida directa del sistema`, "warn");
      this._destroyGraphQuietly();
      if (this.video) this.video.volume = this.el.vol ? Math.min(1, (+this.el.vol.value || 100) / 100) : 1;
    }
  }

  _destroyGraphQuietly() {
    cancelAnimationFrame(this.rafId); this.rafId = 0;
    try { this.srcNode?.disconnect(); } catch { /* noop */ }
    try { this.analyser?.disconnect(); } catch { /* noop */ }
    try { this.gain?.disconnect(); } catch { /* noop */ }
    this.srcNode = this.analyser = this.gain = null;
    if (this.ctx && this.ctx.state !== "closed") this.ctx.close().catch(() => {});
    this.ctx = null;
    if (this.el.vu) this.el.vu.style.width = "0%";
    if (this.el.db) this.el.db.textContent = "-∞ dB";
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
