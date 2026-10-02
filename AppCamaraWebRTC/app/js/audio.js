/**
 * audio.js — Procesamiento y medición de audio (Web Audio API).
 *
 * Cadena: MediaStreamSource → BiquadFilter (HPF OFF/80/100 Hz) →
 *         ChannelSplitter 2× → Analyser per-channel → RMS → dB.
 *
 * Emite eventos "levels" con { l, r, dbL, dbR, peakL, peakR, clip }.
 * @module audio
 */

import { log } from "./utils.js";

const FFT_SIZE = 1024;
const SMOOTH_DB_FLOOR = -60;   // suelo del vúmetro en dB

export class AudioProcessor extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.source = null;
    this.hpf = null;          // BiquadFilter highpass
    this.splitter = null;
    this.analysers = [null, null];
    this.buffers = [null, null];
    this.levels = { l: 0, r: 0, dbL: -Infinity, dbR: -Infinity, peakL: -Infinity, peakR: -Infinity, clip: false };
    this._peakHold = [-Infinity, -Infinity];
    this._peakTimer = [0, 0];
    this._raf = 0;
    this._running = false;
    this.hpfHz = 0;
  }

  /** Crea el grafo y empieza la medición sobre un stream con pista de audio. */
  attach(stream) {
    const track = stream.getAudioTracks()[0];
    if (!track) { log("Sin pista de audio: vúmetro en reposo", "warn"); return; }

    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});

    this.detach(); // reconstruye si cambia el stream

    this.source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.hpf = this.ctx.createBiquadFilter();
    this.hpf.type = "highpass";
    this.hpf.Q.value = 0.707;            // Butterworth orden 2
    this.hpf.frequency.value = this.hpfHz || 20; // OFF ≈ 20 Hz (inaudible)

    this.splitter = this.ctx.createChannelSplitter(2);
    for (let ch = 0; ch < 2; ch++) {
      const an = this.ctx.createAnalyser();
      an.fftSize = FFT_SIZE;
      an.smoothingTimeConstant = 0.5;
      this.analysers[ch] = an;
      this.buffers[ch] = new Float32Array(an.fftSize);
    }

    // El HPF afecta también a la medición (coherente con lo que se emite).
    this.source.connect(this.hpf);
    this.hpf.connect(this.splitter);
    this.splitter.connect(this.analysers[0], 0);
    this.splitter.connect(this.analysers[1], 1);

    this._running = true;
    this._loop();
  }

  detach() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    try { this.source?.disconnect(); } catch { /* ya desconectado */ }
    try { this.hpf?.disconnect(); } catch { /* idem */ }
    try { this.splitter?.disconnect(); } catch { /* idem */ }
    this.source = this.hpf = this.splitter = null;
  }

  /** Configura el filtro paso alto: 0 = OFF, 80 o 100 Hz. */
  setHighPass(hz) {
    this.hpfHz = hz;
    if (this.hpf) {
      const f = hz > 0 ? hz : 20;
      this.hpf.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.02);
      log(`HPF ${hz > 0 ? hz + " Hz" : "OFF"}`, "info");
    }
  }

  /** Convierte amplitud RMS a dBFS con suelo. */
  static toDb(rms) {
    if (rms <= 0) return -Infinity;
    return Math.max(SMOOTH_DB_FLOOR, 20 * Math.log10(rms));
  }

  /** Mapea dB → porcentaje de barra (suelo -60 dB → techo 0 dB). */
  static dbToPct(db) {
    if (!Number.isFinite(db)) return 0;
    return Math.min(100, Math.max(0, ((db - SMOOTH_DB_FLOOR) / -SMOOTH_DB_FLOOR) * 100));
  }

  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();

    for (let ch = 0; ch < 2; ch++) {
      const an = this.analysers[ch];
      if (!an) continue;
      an.getFloatTimeDomainData(this.buffers[ch]);

      // RMS
      let sum = 0, peak = 0;
      const buf = this.buffers[ch];
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        sum += v * v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      const rms = Math.sqrt(sum / buf.length);
      const db = AudioProcessor.toDb(rms);
      const pct = AudioProcessor.dbToPct(db);

      // Peak-hold 1.2 s con caída
      if (db > this._peakHold[ch]) { this._peakHold[ch] = db; this._peakTimer[ch] = now; }
      else if (now - this._peakTimer[ch] > 1200) this._peakHold[ch] = Math.max(SMOOTH_DB_FLOOR, this._peakHold[ch] - 0.6);

      this.levels[ch === 0 ? "l" : "r"] = pct;
      this.levels[ch === 0 ? "dbL" : "dbR"] = db;
      this.levels[ch === 0 ? "peakL" : "peakR"] = this._peakHold[ch];
      this.levels.clip = peak >= 0.99;
    }

    this.dispatchEvent(new CustomEvent("levels", { detail: { ...this.levels } }));
  }

  /** dB más alto de ambos canales (para HUD). */
  get maxDb() {
    return Math.max(this.levels.dbL, this.levels.dbR);
  }
}
