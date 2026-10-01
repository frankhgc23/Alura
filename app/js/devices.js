/**
 * devices.js — Captura multimedia y selección dinámica de dispositivos.
 *
 * - Enumera cámaras (webcams, UVC, capturadoras HDMI-USB) y micrófonos.
 * - Soporta getDisplayMedia (compartir pantalla).
 * - applyConstraints con modo "Estudio" (maintain-resolution) o
 *   "Exteriores" (maintain-framerate).
 * - replaceTrack: cambio de dispositivo sin interrumpir la transmisión.
 * - Zoom por hardware si el dispositivo lo expone (PTZ/UVC), fallback digital.
 *
 * @module devices
 */

import { log } from "./utils.js";

export const RESOLUTIONS = {
  "640x360":    { w: 640,   h: 360,  label: "360p" },
  "854x480":    { w: 854,   h: 480,  label: "480p" },
  "1280x720":   { w: 1280,  h: 720,  label: "720p" },
  "1920x1080":  { w: 1920,  h: 1080, label: "1080p" },
  "3840x2160":  { w: 3840,  h: 2160, label: "4K UHD" },
};

const TARGET_FPS = 30;

export class CaptureManager extends EventTarget {
  constructor() {
    super();
    /** @type {MediaStream|null} stream combinado actual (vídeo + audio) */
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.kind = "camera";            // "camera" | "screen"
    this.audioOnly = false;          // modo SOLO AUDIO (no se abre la cámara)
    this.deviceIds = { video: "", audio: "" };
    this.resolutionKey = "1280x720";
    this.mode = "resolution";        // "resolution" | "framerate"
    /** zoom por hardware soportado por la cámara ({min,max,value}) */
    this.hwZoom = null;
    this._screenStopHdl = null;
  }

  _emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /** Construye las restricciones de vídeo según resolución y modo. */
  videoConstraints(deviceId) {
    const res = RESOLUTIONS[this.resolutionKey] ?? RESOLUTIONS["1280x720"];
    const base = {
      width:  { ideal: res.w },
      height: { ideal: res.h },
      frameRate: { ideal: TARGET_FPS },
    };
    // Modo "Estudio": prioriza mantener resolución aunque caigan los fps.
    // Modo "Exteriores": prioriza fluidez (fps) aunque baje la resolución.
    if (this.mode === "resolution") {
      base.width.exact = res.w;
      base.height.exact = res.h;
      base.frameRate = { min: 1, ideal: TARGET_FPS };
    } else {
      base.frameRate = { min: 24, ideal: TARGET_FPS, max: TARGET_FPS };
    }
    if (deviceId && this.kind === "camera") base.deviceId = { exact: deviceId };
    return base;
  }

  /** Solicita un nuevo stream de vídeo+cámaras/micrófonos seleccionados. */
  async start(opts = {}) {
    const { videoKind = this.kind, videoDeviceId, audioDeviceId } = opts;
    this.kind = videoKind;
    if (videoDeviceId != null) this.deviceIds.video = videoDeviceId;
    if (audioDeviceId != null) this.deviceIds.audio = audioDeviceId;

    const oldVideo = this.videoTrack;
    // En modo SOLO AUDIO no se abre la cámara: ahorra CPU/luz LED/energía en móvil.
    const wantVideo = !opts.audioOnly && !this.audioOnly;
    if (opts.audioOnly != null) this.audioOnly = !!opts.audioOnly;
    const constraints = {
      video: wantVideo ? this.videoConstraints(this.deviceIds.video) : false,
      audio: this.audioConstraints(),
    };

    let newStream;
    if (this.kind === "screen" && wantVideo) {
      newStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: TARGET_FPS } },
        audio: true,
      });
      // El usuario puede rechazar compartir audio de pestaña: asegurar micro.
      if (newStream.getAudioTracks().length === 0 && this.deviceIds.audio !== "none") {
        try {
          const mic = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
          newStream.addTrack(mic.getAudioTracks()[0]);
        } catch { /* sin micro también es válido para pantalla */ }
      }
    } else {
      newStream = await navigator.mediaDevices.getUserMedia(constraints);
    }

    this.videoTrack = newStream.getVideoTracks()[0] ?? null;
    this.audioTrack = newStream.getAudioTracks()[0] ?? null;

    // Si ya existía un stream, sustituye pistas (hot-swap sin cortar nada).
    if (this.stream) {
      if (oldVideo && oldVideo !== this.videoTrack) oldVideo.stop();
      // Detener pistas anteriores que ya no usamos (salvo la compartida de pantalla nueva)
      for (const t of this.stream.getTracks()) {
        if (t !== this.videoTrack && t !== this.audioTrack && t.kind === "audio") t.stop();
      }
      if (this.videoTrack) this.stream.addTrack(this.videoTrack);
      if (this.audioTrack) this.stream.addTrack(this.audioTrack);
    } else {
      this.stream = newStream;
    }

    // La captura de pantalla termina si el usuario pulsa "Dejar de compartir".
    if (this.kind === "screen" && this.videoTrack) {
      this._screenStopHdl = () => {
        log("Compartir pantalla finalizado por el usuario", "warn");
        this.switchToCamera().catch(() => {});
      };
      this.videoTrack.addEventListener("ended", this._screenStopHdl, { once: true });
    }

    await this._detectHardwareZoom();
    this._emit("stream", { stream: this.stream });
    return this.stream;
  }

  audioConstraints() {
    if (this.deviceIds.audio === "none") return false;
    const c = {
      channelCount: { ideal: 2 },
      echoCancellation: false,
      noiseSuppression: false,   // en broadcast se prefiere audio crudo
      autoGainControl: false,
    };
    if (this.deviceIds.audio) c.deviceId = { exact: this.deviceIds.audio };
    return c;
  }

  /** Apaga/enciende la captura de vídeo al alternar el modo solo audio. */
  setAudioOnly(on) {
    this.audioOnly = !!on;
    if (on && this.videoTrack) {          // apagar cámara: ahorra batería/CPU en móvil
      this.videoTrack.stop();
      this.stream?.removeTrack(this.videoTrack);
      this.videoTrack = null;
    } else if (!on && !this.videoTrack) { // reabrir solo la cámara
      return this.start({ videoKind: "camera" }).then(() => true).catch(() => false);
    }
    return Promise.resolve(true);
  }

  /** Vuelve a la última cámara tras finalizar la pantalla compartida. */
  async switchToCamera() {
    this._screenStopHdl && this.videoTrack?.removeEventListener("ended", this._screenStopHdl);
    const screenTrack = this.videoTrack;
    await this.start({ videoKind: "camera", videoDeviceId: this.deviceIds.video || undefined });
    screenTrack?.stop();
  }

  /** Aplica cambios de resolución/modo sobre la pista activa (sin reabrir). */
  async reapplyConstraints() {
    if (!this.videoTrack || this.kind !== "camera") return false;
    try {
      await this.videoTrack.applyConstraints(this.videoConstraints(this.deviceIds.video));
      log(`Restricciones aplicadas (${RESOLUTIONS[this.resolutionKey]?.label}, modo ${this.mode})`, "ok");
      return true;
    } catch (err) {
      log(`No se pudo aplicar in-place (${err.name}); reabriendo captura…`, "warn");
      await this.start({ videoKind: this.kind });
      return false;
    }
  }

  /** Detecta soporte de zoom por hardware (capability "zoom"). */
  async _detectHardwareZoom() {
    this.hwZoom = null;
    const caps = this.videoTrack?.getCapabilities?.();
    if (caps && typeof caps.zoom === "object" && caps.zoom.min != null) {
      this.hwZoom = { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 };
      log(`Zoom por hardware disponible: ${caps.zoom.min}×–${caps.zoom.max}×`, "ok");
      this._emit("hwzoom", { hwZoom: this.hwZoom });
    }
  }

  /**
   * Establece zoom. Devuelve "hardware" si se aplicó vía applyConstraints
   * o "digital" para que el UI aplique transform: scale().
   */
  async setZoom(factor) {
    const settings = this.videoTrack?.getSettings?.() ?? {};
    const base = settings.zoom ?? 1;
    if (this.hwZoom) {
      const target = Math.min(this.hwZoom.max, Math.max(this.hwZoom.min, factor));
      try {
        await this.videoTrack.applyConstraints({ advanced: [{ zoom: target }] });
        return { applied: "hardware", value: target };
      } catch { /* sigue al zoom digital */ }
    }
    return { applied: "digital", value: factor, base };
  }

  /** Enumera dispositivos de entrada reales (sin pseudoidentifiers internos). */
  static async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { video: [], audio: [] };
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      video: all.filter((d) => d.kind === "videoinput"),
      audio: all.filter((d) => d.kind === "audioinput"),
    };
  }

  /** Detiene todas las pistas (fin de sesión / limpieza). */
  stopAll() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = this.videoTrack = this.audioTrack = null;
    this._emit("stopped");
  }
}
