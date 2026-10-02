/**
 * stats.js — Estadísticas en tiempo real a partir de getStats().
 *
 * Muestra: bitrate, FPS, RTT, pérdida de paquetes, resolución activa,
 * códecs negociados, jitter, bytes totales y tiempo en vivo.
 * @module stats
 */

import { hms, bytes } from "./utils.js";

export class StatsCollector extends EventTarget {
  constructor(publisher) {
    super();
    this.pub = publisher;
    this._prev = { ts: 0, sentBytes: 0 };
    this._bitrateEma = null;
    this._lossPct = 0;
    this._rtt = null;
    this._fps = null;
    this._res = "—";
    this._jitter = null;
    this.codecs = { video: null, audio: null };
    this.timer = null;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this._tick().catch(() => {}), 1000);
    this._tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async _tick() {
    const report = await this.pub.getStats();
    if (!report) return;

    let outVideo = null, outAudio = null, candidatePair = null;
    for (const s of report.values()) {
      if (s.type === "outbound-rtp" && !s.isRemote) {
        if (s.kind === "video" || s.mediaType === "video") outVideo = s;
        if (s.kind === "audio" || s.mediaType === "audio") outAudio = s;
      } else if (s.type === "candidate-pair" && s.selected) {
        candidatePair = s;
      }
    }

    const now = performance.now();

    // --- Bitrate (vídeo + audio) por delta de bytes enviados -----------------
    const totalSent = (outVideo?.bytesSent ?? 0) + (outAudio?.bytesSent ?? 0);
    let kbps = this._bitrateEma;
    if (this._prev.ts) {
      const dt = (now - this._prev.ts) / 1000;
      if (dt > 0.25) {
        const inst = ((totalSent - this._prev.sentBytes) * 8) / dt / 1000;
        if (inst >= 0) this._bitrateEma = kbps = kbps == null ? inst : kbps * 0.6 + inst * 0.4;
      }
    }
    this._prev = { ts: now, sentBytes: totalSent };

    // --- RTT ------------------------------------------------------------------
    if (candidatePair?.currentRoundTripTime != null) this._rtt = candidatePair.currentRoundTripTime * 1000;

    // --- Pérdida de paquetes ---------------------------------------------------
    if (outVideo) {
      // En el emisor, la señal más fiable de pérdida de red es la tasa de
      // retransmisión (NACK) y los paquetes descartados por la cola.
      const sent = outVideo.packetsSent ?? 0;
      const lostish = (outVideo.retransmittedPacketsSent ?? 0) + (outVideo.packetsDiscarded ?? 0);
      this._lossPct = sent > 0 ? Math.min(100, (lostish / sent) * 100) : 0;
    }

    // --- FPS y resolución ------------------------------------------------------
    if (outVideo) {
      this._fps = outVideo.framesPerSecond ?? null;
      const w = outVideo.frameWidth, h = outVideo.frameHeight;
      if (w && h) this._res = `${w}×${h}`;
      // Fallback si el navegador omite framesPerSecond: derivar de totalFramesSent
      if (this._fps == null && this._prev.frames != null && this._prev.ts2 != null && outVideo.totalFramesSent != null) {
        const dt = (now - this._prev.ts2) / 1000;
        if (dt > 0.25) this._fps = Math.max(0, (outVideo.totalFramesSent - this._prev.frames) / dt);
      }
      this._prev.frames = outVideo.totalFramesSent ?? this._prev.frames;
      this._prev.ts2 = now;
    }

    // --- Jitter (buffer actual audio) ------------------------------------------
    if (outAudio?.audioLevel != null || outAudio?.jitter != null) {
      this._jitter = outAudio.jitter != null ? outAudio.jitter * 1000 : null;
    }

    // --- Códecs desde la última negociación conocida ---------------------------
    const vCodecName = this.codecs.video ?? outVideo?.codecId?.split("_").pop()?.toUpperCase();
    const aCodecName = this.codecs.audio ?? outAudio?.codecId?.split("_").pop()?.toUpperCase();

    const uptimeS = this.pub.startedAt ? (Date.now() - this.pub.startedAt) / 1000 : 0;

    this._emit({
      kbps,
      fps: this._fps,
      rttMs: this._rtt,
      lossPct: this._lossPct,
      resolution: this._res,
      codecs: [vCodecName, aCodecName].filter(Boolean).join(" / ") || "—",
      jitterMs: this._jitter,
      bytesTotal: totalSent,
      uptime: uptimeS,
      uptimeStr: hms(uptimeS),
      retries: this.pub.retries,
      state: this.pub.state,
    });
  }

  _emit(detail) {
    this.dispatchEvent(new CustomEvent("stats", { detail }));
  }

  /** Registro humano-legible del total emitido. */
  static fmtBytes(b) { return bytes(b); }
}
