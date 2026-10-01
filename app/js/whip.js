/**
 * whip.js — Cliente de publicación WHIP (WebRTC-HTTP Ingestion Protocol).
 *
 * Flujo:
 *  1. createOffer con transceivers audio+video.
 *  2. Munging SDP: prioridad de códec + bitrate.
 *  3. POST del offer (Content-Type: application/sdp) al endpoint WHIP.
 *  4. setRemoteDescription con el answer (application/sdp).
 *  5. Recolección ICE → "connected" = LIVE.
 *  6. DELETE sobre la Location/ETag devueltos para cerrar la sesión.
 *
 * Reconexión: vigila connectionState/iceConnectionState; ante
 * "disconnected"/"failed" reintenta cada 4 s restaurando la sesión completa.
 * @module whip
 */

import { log, toast } from "./utils.js";
import { preferCodec, setBitrate, codecFromSdp, senderParameters } from "./sdp.js";

const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
};

export class WhipPublisher extends EventTarget {
  /**
   * @param {{endpoint:string, token?:string, videoKbps:number, audioKbps:number,
   *          videoCodec?:string, audioCodec?:string,
   *          tracks:{audio:MediaStreamTrack|null, video:MediaStreamTrack|null}}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.pc = null;
    this.eTag = null;
    this.resourceUrl = null;      // Location devuelta por el servidor
    this.state = "idle";          // idle|connecting|connected|reconnecting|closed|failed
    this.retries = 0;
    this.startedAt = null;
    this._reconnectTimer = null;
    this._manualStop = false;
    this.autoReconnect = true;
  }

  _emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _setState(s, msg) {
    this.state = s;
    if (msg) log(msg, s === "failed" ? "err" : s === "connected" ? "ok" : "info");
    this._emit("state", { state: s });
  }

  /** Arranca la primera conexión. */
  async connect() {
    this._manualStop = false;
    await this._negotiate();
  }

  /** Crea PC, ofrece, publica vía HTTP POST y aplica el answer. */
  async _negotiate() {
    this._cleanupPeer();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;

    // --- Transceivers sendonly con nuestras pistas ---------------------------
    const { tracks } = this.opts;
    if (tracks.video) pc.addTransceiver(tracks.video, { direction: "sendonly", streams: [this._streamOf(tracks.video)] });
    if (tracks.audio) pc.addTransceiver(tracks.audio, { direction: "sendonly", streams: [this._streamOf(tracks.audio)] });

    pc.oniceconnectionstatechange = () => this._onIce(pc.iceConnectionState);
    pc.onconnectionstatechange = () => this._onConn(pc.connectionState);
    pc.onicecandidateerror = (e) => log(`Aviso ICE: ${e.errorText ?? e.errorCode}`, "warn");

    // --- Bitrate REAL vía RTCRtpSender.setParameters ---------------------------
    // FIX: los hints SDP (b=AS/x-google-*) no siempre son respetados por el
    // motor de codificación; fijar senderEncodings.maxBitrate sobre el sender
    // del transceiver es lo que garantiza que el cambio se aplique. Se hace
    // aquí (y en cada renegociación/reconexión) leyendo this.opts fresco.
    try {
      for (const tr of pc.getTransceivers()) {
        const kind = tr.sender?.track?.kind;
        if (!kind) continue;
        const kbps = kind === "video" ? this.opts.videoKbps : this.opts.audioKbps;
        if (kbps > 0) await senderParameters(tr.sender, kind, kbps);
      }
    } catch (err) {
      log(`No se pudo fijar maxBitrate en el sender: ${err.message}`, "warn");
    }

    // --- Offer + munging -------------------------------------------------------
    let offer = await pc.createOffer();
    let sdp = offer.sdp;
    if (this.opts.videoCodec) sdp = preferCodec(sdp, "video", this.opts.videoCodec);
    if (this.opts.audioCodec) sdp = preferCodec(sdp, "audio", this.opts.audioCodec);
    sdp = setBitrate(sdp, "video", this.opts.videoKbps);
    sdp = setBitrate(sdp, "audio", this.opts.audioKbps);
    await pc.setLocalDescription({ type: "offer", sdp });

    // Esperar a reunir los candidatos ICE (trickle OFF: WHIP/MediaMTX acepta
    // mejor un offer completo; límite 2.5 s para no bloquear en redes lentas).
    await this._gatherIce(pc, 2500);

    // --- POST del SDP offer ---------------------------------------------------
    this._setState("connecting", `Publicando WHIP → ${this.opts.endpoint}`);
    const headers = { "Content-Type": "application/sdp" };
    if (this.opts.token) headers["Authorization"] = `Bearer ${this.opts.token}`;

    const res = await fetch(this.opts.endpoint, {
      method: "POST",
      headers,
      body: pc.localDescription.sdp,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`WHIP ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
    }

    const answerSdp = await res.text();
    if (!/^(v=0|m=)/m.test(answerSdp.trim())) {
      throw new Error("El servidor no devolvió un SDP answer válido");
    }

    // ETag / Location según RFC 8288 para posterior DELETE
    this.eTag = res.headers.get("ETag");
    const location = res.headers.get("Location");
    this.resourceUrl = location
      ? new URL(location, this.opts.endpoint).href
      : this.opts.endpoint;

    // --- Answer → conexión WebRTC completa ------------------------------------
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.startedAt ??= Date.now();

    const vCodec = codecFromSdp(answerSdp, "video") ?? codecFromSdp(pc.localDescription.sdp, "video");
    const aCodec = codecFromSdp(answerSdp, "audio") ?? codecFromSdp(pc.localDescription.sdp, "audio");
    this._emit("codecs", { video: vCodec, audio: aCodec });

    // Si ya estamos connected (ICE reunido antes), notificar live inmediatamente.
    if (pc.connectionState === "connected") this._markLive();
  }

  _streamOf(track) {
    return new MediaStream([track]);
  }

  _gatherIce(pc, timeoutMs) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const done = () => { clearTimeout(t); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => pc.iceGatheringState === "complete" && done();
      const t = setTimeout(done, timeoutMs);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  _onIce(state) {
    this._emit("ice", { state });
    if (state === "disconnected" || state === "failed") this._handleDrop(`ICE ${state}`);
  }

  _onConn(state) {
    this._emit("conn", { state });
    if (state === "connected") this._markLive();
    if (state === "disconnected" || state === "failed") this._handleDrop(`peer ${state}`);
  }

  _markLive() {
    if (this.state === "connected") return;
    this._setState("connected", "Conexión WebRTC establecida — EN DIRECTO");
    toast("🔴 En directo", "ok");
  }

  /** Programa la reconexión automática (cada 4 s) restaurando la sesión. */
  _handleDrop(reason) {
    if (this._manualStop || !this.autoReconnect) return;
    if (this.state === "reconnecting") return;
    this._setState("reconnecting", `Conexión perdida (${reason}). Reintento automático…`);
    this._scheduleRetry();
  }

  _scheduleRetry() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (this._manualStop) return;
      this.retries++;
      this._emit("retry", { retries: this.retries });
      log(`Reintento de publicación #${this.retries}…`, "warn");
      try {
        await this._negotiate();          // nueva oferta desde cero
      } catch (err) {
        log(`Fallo en reintento: ${err.message}`, "err");
        if (!this._manualStop) this._scheduleRetry();  // sigue reintentando cada 4 s
      }
    }, 4000);
  }

  /**
   * Cambia el bitrate EN CALIENTE (sin renegociar): actualiza opts y aplica
   * RTCRtpSender.setParameters sobre los senders vivos. Si aún no hay PC,
   * solo guarda el valor para la próxima negociación.
   */
  async applyBitrates({ videoKbps, audioKbps } = {}) {
    if (videoKbps != null) this.opts.videoKbps = videoKbps;
    if (audioKbps != null) this.opts.audioKbps = audioKbps;
    if (!this.pc) return false;
    let ok = true;
    try {
      for (const tr of this.pc.getTransceivers()) {
        const kind = tr.sender?.track?.kind;
        if (kind === "video" && this.opts.videoKbps > 0) {
          await senderParameters(tr.sender, "video", this.opts.videoKbps);
        } else if (kind === "audio" && this.opts.audioKbps > 0) {
          await senderParameters(tr.sender, "audio", this.opts.audioKbps);
        }
      }
      log(`Bitrate aplicado en caliente → vídeo ${this.opts.videoKbps} kb/s · audio ${this.opts.audioKbps} kb/s`, "ok");
    } catch (err) {
      ok = false;
      log(`applyBitrates parcial: ${err.message}`, "warn");
    }
    return ok;
  }

  /** Sustituye una pista en caliente sin renegociar (cambio de dispositivo). */
  async replaceTrack(kind, newTrack) {
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === kind);
    if (!sender) return false;
    await sender.replaceTrack(newTrack);
    log(`Pista ${kind} sustituida en caliente (sin cortar el directo)`, "ok");
    this._emit("track-replaced", { kind });
    return true;
  }

  /** Devuelve los RTCStatsReport para el módulo de estadísticas. */
  getStats() {
    return this.pc?.getStats() ?? Promise.resolve(null);
  }

  _cleanupPeer() {
    try { this.pc?.close(); } catch { /* ok */ }
    this.pc = null;
  }

  /** Detención manual: DELETE del recurso WHIP y cierre limpio. */
  async stop() {
    this._manualStop = true;
    clearTimeout(this._reconnectTimer);
    if (this.resourceUrl) {
      try {
        const headers = {};
        if (this.eTag) headers["If-Match"] = this.eTag;
        if (this.opts.token) headers["Authorization"] = `Bearer ${this.opts.token}`;
        await fetch(this.resourceUrl, { method: "DELETE", headers });
        log("Sesión WHIP cerrada correctamente (DELETE)", "info");
      } catch (err) {
        log(`No se pudo enviar DELETE: ${err.message}`, "warn");
      }
    }
    this._cleanupPeer();
    this._setState("closed", "Transmisión detenida");
  }
}
