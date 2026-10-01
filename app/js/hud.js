/**
 * hud.js — Superposición broadcast + Wake Lock + Battery API.
 *
 * Pinta en el monitor: estado, batería, bitrate, FPS, audio dB, códec,
 * resolución, zoom y pérdida de paquetes. Mantiene la pantalla despierta
 * durante el directo con Screen Wake Lock API.
 * @module hud
 */

import { $, hms } from "./utils.js";

export class BroadcastHud {
  constructor() {
    this.el = {
      root: $("#hud"),
      live: $("#hudLive"),
      time: $("#hudTime"),
      battery: $("#hudBattery"),
      bitrate: $("#hudBitrate"),
      fps: $("#hudFps"),
      audio: $("#hudAudio"),
      codec: $("#hudCodec"),
      res: $("#hudRes"),
      zoom: $("#hudZoom"),
      loss: $("#hudLoss"),
      indicator: $("#liveIndicator"),
      stateLabel: $("#liveStateLabel"),
      timer: $("#liveTimer"),
      connPill: $("#connPill"),
    };
    this.zoom = 1;
    this._battery = null;
    this._wakeLock = null;
    this._initBattery();
    this._initWakeLockResume();
  }

  setVisible(v) {
    this.el.root.hidden = !v;
  }

  setZoom(z) {
    this.zoom = z;
    this.el.zoom.textContent = `${z.toFixed(1)}×`;
  }

  /** Estado general de la sesión WHIP. */
  setState(state) {
    const map = {
      idle:          ["idle", "EN ESPERA",   "● STANDBY", ""],
      connecting:    ["connecting", "CONECTANDO", "● CONECTANDO…", "warn"],
      connected:     ["live", "EN DIRECTO",  "● LIVE", "on"],
      reconnecting:  ["reconnecting", "RECONECTANDO", "● RECONECTANDO…", "warn"],
      closed:        ["idle", "DETENIDO",    "● OFF AIR", ""],
      failed:        ["idle", "ERROR",       "● ERROR", ""],
    };
    const [ind, label, hudTxt, cls] = map[state] ?? map.idle;
    this.el.indicator.dataset.state = ind;
    this.el.stateLabel.textContent = label;
    this.el.live.textContent = hudTxt;
    this.el.live.className = `hud-live ${cls}`;
    if (state === "connected") this.requestWakeLock();
    else if (state === "closed" || state === "failed") this.releaseWakeLock();
  }

  setIce(state) {
    this.el.connPill.textContent = `ICE: ${state ?? "—"}`;
  }

  /** Actualiza todos los campos numéricos desde el objeto de stats. */
  update(stats, audioDb) {
    if (stats.kbps != null) this.el.bitrate.textContent = `${Math.round(stats.kbps)} kb/s`;
    if (stats.fps != null) this.el.fps.textContent = `${Math.round(stats.fps)} fps`;
    if (Number.isFinite(audioDb)) this.el.audio.textContent = `${audioDb.toFixed(1)} dB`;
    if (stats.codecs) this.el.codec.textContent = stats.codecs;
    if (stats.resolution) this.el.res.textContent = stats.resolution;
    this.el.loss.textContent = `${(stats.lossPct ?? 0).toFixed(1)} % loss`;
    this.el.time.textContent = stats.uptimeStr;
    this.el.timer.textContent = stats.uptimeStr;
  }

  /* ------------------------------ Batería --------------------------------- */
  async _initBattery() {
    try {
      if (navigator.getBattery) {
        this._battery = await navigator.getBattery();
        const paint = () => {
          const lvl = Math.round(this._battery.level * 100);
          const chg = this._battery.charging ? "⚡" : "";
          this.el.battery.textContent = `🔋 ${lvl}%${chg}`;
          this.el.battery.style.color = lvl <= 15 && !this._battery.charging ? "var(--bad)" : "";
        };
        paint();
        this._battery.addEventListener("levelchange", paint);
        this._battery.addEventListener("chargingchange", paint);
      } else {
        this.el.battery.textContent = "🔋 n/d";
      }
    } catch {
      this.el.battery.textContent = "🔋 n/d";
    }
  }

  /* ----------------------------- Wake Lock -------------------------------- */
  async requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !this._wakeLock) {
        this._wakeLock = await navigator.wakeLock.request("screen");
        this._wakeLock.addEventListener("release", () => { this._wakeLock = null; });
      }
    } catch { /* no soportado / recortado por el sistema */ }
  }

  releaseWakeLock() {
    try { this._wakeLock?.release(); } catch { /* ok */ }
    this._wakeLock = null;
  }

  /** Re-solicita el lock al volver la pestaña (se libera al ocultarse). */
  _initWakeLockResume() {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.el.indicator.dataset.state === "live") {
        this.requestWakeLock();
      }
    });
  }
}
