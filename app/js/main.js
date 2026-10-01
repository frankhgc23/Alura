/**
 * main.js — Orquestador de WHIP Studio.
 * Conecta UI ↔ CaptureManager ↔ AudioProcessor ↔ WhipPublisher ↔ Stats ↔ HUD.
 * @module main
 */

import { $, log, toast, hms, bytes, loadConfig, saveConfig } from "./utils.js";
import { CaptureManager, RESOLUTIONS } from "./devices.js";
import { AudioProcessor } from "./audio.js";
import { WhipPublisher } from "./whip.js";
import { StatsCollector } from "./stats.js";
import { BroadcastHud } from "./hud.js";
import { detectCodecSupport } from "./sdp.js";

/* ------------------------------- Estado ---------------------------------- */
const capture = new CaptureManager();
const audio = new AudioProcessor();
const hud = new BroadcastHud();
let pub = null;          // WhipPublisher activo
let stats = null;        // StatsCollector activo
let digitalZoom = 1;     // zoom aplicado en la vista (digital)

const video = $("#previewVideo");
const els = {
  videoKind: $("#videoSourceKind"), videoSel: $("#videoSelect"), audioSel: $("#audioSelect"),
  btnPreview: $("#btnPreview"), btnStopPreview: $("#btnStopPreview"),
  whipUrl: $("#whipUrl"), whipToken: $("#whipToken"),
  res: $("#resSelect"), mode: $("#modeSelect"),
  vbit: $("#vbitrate"), abit: $("#abitrate"), vbitOut: $("#vbitOut"), abitOut: $("#abitOut"),
  aCodec: $("#audioCodec"), vCodec: $("#videoCodec"), codecSupport: $("#codecSupport"),
  goLive: $("#btnGoLive"), stop: $("#btnStop"), autoReconnect: $("#autoReconnect"),
  hpf: $("#hpfSelect"), vuL: $("#vuL"), vuR: $("#vuR"), pkL: $("#pkL"), pkR: $("#pkR"),
  dbL: $("#dbL"), dbR: $("#dbR"), clip: $("#clipBanner"),
  noSignal: $("#noSignal"), frame: $("#monitorFrame"),
  fs: $("#btnFullscreen"), thirds: $("#btnThirds"), mirror: $("#btnMirror"),
  zoomLabel: $("#zoomLabel"), hudToggle: $("#btnHud"), install: $("#btnInstall"),
  stBitrate: $("#stBitrate"), stFps: $("#stFps"), stRtt: $("#stRtt"), stLoss: $("#stLoss"),
  stRes: $("#stRes"), stCodecs: $("#stCodecs"), stJitter: $("#stJitter"),
  stUptime: $("#stUptime"), stBytes: $("#stBytes"), stRetries: $("#stRetries"),
};

/* --------------------- Persistencia de configuración -------------------- */
const cfg = loadConfig();
if (cfg.whipUrl) els.whipUrl.value = cfg.whipUrl;
if (cfg.whipToken) els.whipToken.value = cfg.whipToken;
if (cfg.res) els.res.value = cfg.res;
if (cfg.mode) els.mode.value = cfg.mode;
if (cfg.vbit) els.vbit.value = cfg.vbit;
if (cfg.abit) els.abit.value = cfg.abit;
if (cfg.aCodec) els.aCodec.value = cfg.aCodec;
if (cfg.vCodec) els.vCodec.value = cfg.vCodec;
if (cfg.hpf) els.hpf.value = cfg.hpf;

function persist() {
  saveConfig({
    whipUrl: els.whipUrl.value.trim(), whipToken: els.whipToken.value.trim(),
    res: els.res.value, mode: els.mode.value,
    vbit: +els.vbit.value, abit: +els.abit.value,
    aCodec: els.aCodec.value, vCodec: els.vCodec.value, hpf: els.hpf.value,
  });
}

/* ------------------------- Dispositivos / captura ------------------------- */
async function refreshDeviceList() {
  const { video: cams, audio: mics } = await CaptureManager.listDevices();
  const fill = (sel, list, kind) => {
    const prev = sel.value || (kind === "audio" ? "" : "");
    sel.innerHTML = "";
    list.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `${kind === "video" ? "Cámara" : "Micrófono"} ${i + 1}`;
      sel.appendChild(o);
    });
    if (kind === "audio") {
      const none = document.createElement("option");
      none.value = "none"; none.textContent = "Sin audio";
      sel.appendChild(none);
    }
    if (prev && list.some((d) => d.deviceId === prev)) sel.value = prev;
  };
  fill(els.videoSel, cams, "video");
  fill(els.audioSel, mics, "audio");
}

async function startPreview() {
  try {
    await capture.start({
      videoKind: els.videoKind.value,
      videoDeviceId: els.videoSel.value || undefined,
      audioDeviceId: els.audioSel.value || undefined,
    });
    video.srcObject = capture.stream;
    els.noSignal.hidden = true;
    els.btnPreview.disabled = true;
    els.btnStopPreview.disabled = false;
    els.goLive.disabled = !isWhipEndpointValid();
    audio.attach(capture.stream);
    audio.setHighPass(+els.hpf.value);
    await refreshDeviceList();      // ahora los labels incluyen nombre real
    log("Previsualización iniciada", "ok");
  } catch (err) {
    els.noSignal.hidden = false;
    log(`Error de captura: ${err.name} — ${err.message}`, "err");
    toast(`No se pudo acceder al dispositivo (${err.name})`, "err");
  }
}

function stopPreview() {
  if (pub) return toast("Detenga primero la transmisión en directo", "warn");
  audio.detach();
  capture.stopAll();
  video.srcObject = null;
  els.noSignal.hidden = false;
  els.btnPreview.disabled = false;
  els.btnStopPreview.disabled = true;
  els.goLive.disabled = true;
}

/** Cambio de dispositivo sin cortar: reabre captura y replaceTrack si hay directo. */
async function swapTrack(kind) {
  if (!capture.stream) return;             // aún no hay previsualización
  const wasLive = pub?.state === "connected" || pub?.state === "reconnecting";
  try {
    await capture.start({
      videoKind: els.videoKind.value,
      videoDeviceId: kind === "video" ? els.videoSel.value : els.videoSel.value || undefined,
      audioDeviceId: kind === "audio" ? els.audioSel.value : els.audioSel.value || undefined,
    });
    video.srcObject = capture.stream;
    if (kind === "audio") { audio.detach(); audio.attach(capture.stream); audio.setHighPass(+els.hpf.value); }
    if (wasLive) {
      const t = kind === "video" ? capture.videoTrack : capture.audioTrack;
      if (t) await pub.replaceTrack(kind, t);
    }
    log(`${kind === "video" ? "Vídeo" : "Audio"} cambiado sin interrumpir`, "ok");
  } catch (err) {
    log(`Cambio de dispositivo fallido: ${err.message}`, "err");
  }
}

/* ------------------------------ Transmisión ------------------------------- */
function isWhipEndpointValid() {
  try { const u = new URL(els.whipUrl.value.trim()); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
}

async function goLive() {
  if (!capture.stream) return toast("Inicie la previsualización primero", "warn");
  if (!isWhipEndpointValid()) return toast("Indique un endpoint WHIP válido", "err");
  persist();

  pub = new WhipPublisher({
    endpoint: els.whipUrl.value.trim(),
    token: els.whipToken.value.trim() || undefined,
    videoKbps: +els.vbit.value,
    audioKbps: +els.abit.value,
    videoCodec: els.vCodec.value || undefined,
    audioCodec: els.aCodec.value || undefined,
    tracks: { video: capture.videoTrack, audio: capture.audioTrack },
  });
  pub.autoReconnect = els.autoReconnect.checked;

  pub.addEventListener("state", (e) => {
    hud.setState(e.detail.state);
    const live = e.detail.state === "connected";
    els.stop.disabled = !(live || e.detail.state === "reconnecting" || e.detail.state === "connecting");
    els.goLive.disabled = live || e.detail.state === "connecting" || e.detail.state === "reconnecting";
  });
  pub.addEventListener("ice", (e) => hud.setIce(e.detail.state));
  pub.addEventListener("codecs", (e) => { if (stats) stats.codecs = { video: e.detail.video, audio: e.detail.audio }; });

  stats = new StatsCollector(pub);
  stats.addEventListener("stats", (e) => paintStats(e.detail));
  stats.start();

  try {
    await pub.connect();
    els.goLive.disabled = true;
    els.stop.disabled = false;
  } catch (err) {
    log(`Publicación rechazada: ${err.message}`, "err");
    toast(`WHIP error: ${err.message.slice(0, 120)}`, "err", 6000);
    hud.setState("failed");
    // con reconexión activa sigue intentándolo cada 4 s
    if (pub.autoReconnect) pub._handleDrop?.("primer fallo");
    else { pub.stop().catch(() => {}); pub = null; }
  }
}

async function stopLive() {
  if (!pub) return;
  stats?.stop();
  await pub.stop();
  pub = null;
  hud.setState("closed");
  els.goLive.disabled = !capture.stream;
  els.stop.disabled = true;
}

/* --------------------------- Pintado de UI -------------------------------- */
let lastAudioDb = -Infinity;
audio.addEventListener("levels", (e) => {
  const L = e.detail;
  els.vuL.style.width = `${L.l}%`;
  els.vuR.style.width = `${L.r}%`;
  els.pkL.style.left = `${AudioProcessor.dbToPct(L.peakL)}%`;
  els.pkR.style.left = `${AudioProcessor.dbToPct(L.peakR)}%`;
  els.dbL.textContent = fmtDb(L.dbL);
  els.dbR.textContent = fmtDb(L.dbR);
  els.clip.hidden = !L.clip;
  lastAudioDb = Math.max(L.dbL, L.dbR);
});

const fmtDb = (db) => (Number.isFinite(db) ? `${db.toFixed(1)} dB` : "-∞ dB");

function paintStats(s) {
  els.stBitrate.textContent = s.kbps != null ? `${Math.round(s.kbps)} kb/s` : "—";
  els.stFps.textContent = s.fps != null ? Math.round(s.fps) : "—";
  els.stRtt.textContent = s.rttMs != null ? `${s.rttMs.toFixed(0)} ms` : "—";
  els.stLoss.textContent = `${(s.lossPct ?? 0).toFixed(2)} %`;
  els.stRes.textContent = s.resolution;
  els.stCodecs.textContent = s.codecs;
  els.stJitter.textContent = s.jitterMs != null ? `${s.jitterMs.toFixed(1)} ms` : "—";
  els.stUptime.textContent = s.uptimeStr;
  els.stBytes.textContent = bytes(s.bytesTotal);
  els.stRetries.textContent = s.retries;
  hud.update(s, lastAudioDb);
}

/* --------------------------------- Zoom ---------------------------------- */
async function applyZoom(factor) {
  factor = Math.min(5, Math.max(1, factor));
  const r = await capture.setZoom(factor);
  if (r.applied === "hardware") {
    digitalZoom = 1;
    els.frame.classList.remove("zoom-video");
    hud.setZoom(r.value);
    els.zoomLabel.textContent = `Zoom HW ${r.value.toFixed(1)}×`;
  } else {
    digitalZoom = factor;
    els.frame.classList.add("zoom-video");
    els.frame.style.setProperty("--zoom", factor);
    hud.setZoom(factor);
    els.zoomLabel.textContent = `Zoom ${factor.toFixed(1)}×${capture.hwZoom ? "" : " (digital)"}`;
  }
}

/* Pinch-to-zoom en móvil + rueda en escritorio sobre el monitor */
let pinchStart = 0, pinchZoom0 = 1;
els.frame.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "touch" || e.isPrimary) return;
});
els.frame.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    pinchStart = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    pinchZoom0 = digitalZoom;
  }
}, { passive: true });
els.frame.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && pinchStart) {
    e.preventDefault();
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    applyZoom(pinchZoom0 * (d / pinchStart));
  }
}, { passive: false });
els.frame.addEventListener("wheel", (e) => {
  if (!capture.videoTrack) return;
  e.preventDefault();
  applyZoom(digitalZoom * (e.deltaY < 0 ? 1.1 : 0.9));
}, { passive: false });

/* ------------------------------ Eventos UI -------------------------------- */
els.btnPreview.onclick = startPreview;
els.btnStopPreview.onclick = stopPreview;
els.videoSel.onchange = () => swapTrack("video");
els.audioSel.onchange = () => swapTrack("audio");
els.videoKind.onchange = async () => {
  if (!capture.stream) return;
  if (els.videoKind.value === "screen") await capture.start({ videoKind: "screen" }).then(() => { video.srcObject = capture.stream; });
  else await capture.switchToCamera().then(() => { video.srcObject = capture.stream; });
};

els.res.onchange = async () => {
  capture.resolutionKey = els.res.value;
  persist();
  if (capture.videoTrack && capture.kind === "camera") await capture.reapplyConstraints();
};
els.mode.onchange = async () => {
  capture.mode = els.mode.value;
  persist();
  if (capture.videoTrack && capture.kind === "camera") await capture.reapplyConstraints();
};

els.vbit.oninput = () => { els.vbitOut.textContent = `${els.vbit.value} kbps`; persist(); if (pub) pub.opts.videoKbps = +els.vbit.value; };
els.abit.oninput = () => { els.abitOut.textContent = `${els.abit.value} kbps`; persist(); if (pub) pub.opts.audioKbps = +els.abit.value; };
els.aCodec.onchange = persist;
els.vCodec.onchange = persist;
els.whipUrl.oninput = () => { persist(); els.goLive.disabled = !capture.stream || !isWhipEndpointValid(); };
els.whipToken.oninput = persist;
els.autoReconnect.onchange = () => { if (pub) pub.autoReconnect = els.autoReconnect.checked; };

els.hpf.onchange = () => { audio.setHighPass(+els.hpf.value); persist(); };

els.goLive.onclick = goLive;
els.stop.onclick = stopLive;

els.fs.onclick = () => {
  const f = els.frame;
  if (document.fullscreenElement) document.exitFullscreen();
  else (f.requestFullscreen ?? f.webkitRequestFullscreen)?.call(f);
};
els.thirds.onclick = () => {
  const on = $("#thirdsOverlay").hidden;
  $("#thirdsOverlay").hidden = !on;
  els.thirds.setAttribute("aria-pressed", String(on));
};
els.mirror.onclick = () => {
  const on = !els.frame.classList.contains("mirror");
  els.frame.classList.toggle("mirror", on);
  els.mirror.setAttribute("aria-pressed", String(on));
};
els.hudToggle.onclick = () => {
  const show = els.hudToggle.getAttribute("aria-pressed") !== "true";
  els.hudToggle.setAttribute("aria-pressed", String(show));
  hud.setVisible(show);
};

/* Doble toque en móvil = reset de zoom */
let lastTap = 0;
els.frame.addEventListener("touchend", () => {
  const now = Date.now();
  if (now - lastTap < 300) applyZoom(1);
  lastTap = now;
});

/* ------------------------ Soporte de códecs (UI) -------------------------- */
async function paintCodecSupport() {
  const vids = ["H264", "H265", "VP8", "VP9", "AV1"];
  const auds = ["opus", "aac", "PCMU", "PCMA"];
  const parts = [];
  for (const c of vids) parts.push(`<b class="${await detectCodecSupport("video", c) ? "ok" : "no"}">${c}</b>`);
  parts.push("·");
  for (const c of auds) parts.push(`<b class="${await detectCodecSupport("audio", c) ? "ok" : "no"}">${c.toUpperCase()}</b>`);
  els.codecSupport.innerHTML = `Soporte del navegador: ${parts.join(" ")}`;
}

/* --------------------------------- PWA ------------------------------------ */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  els.install.hidden = false;
});
els.install.onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.install.hidden = true;
};

/* ------------------------------ Arranque ---------------------------------- */
(async function init() {
  log("WHIP Studio listo. Inicie la previsualización y pulse GO LIVE.", "ok");
  hud.setVisible(true);
  if (!window.isSecureContext) {
    toast("⚠ Se requiere HTTPS (o localhost) para cámara/micrófono", "warn", 6000);
    log("Contexto no seguro: getUserMedia puede estar bloqueado", "warn");
  }
  await refreshDeviceList();
  paintCodecSupport().catch(() => {});
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshDeviceList);
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); log("Service Worker activo (PWA)", "info"); }
    catch (err) { log(`SW no registrado: ${err.message}`, "warn"); }
  }
})();
