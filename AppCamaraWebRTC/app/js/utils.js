/**
 * utils.js — Helpers compartidos (dom, formato, log, toasts).
 * @module utils
 */

/** Atajo de querySelector. */
export const $ = (sel) => document.querySelector(sel);

/** Formatea segundos → HH:MM:SS. */
export function hms(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** Formatea bytes → unidad legible. */
export function bytes(b) {
  if (!Number.isFinite(b)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Amortigua valores (smoothing exponencial). */
export function smooth(prev, next, k = 0.3) {
  return prev == null ? next : prev + k * (next - prev);
}

/** Logger visual en el panel "Registro del emisor". */
const logList = $("#logList");
export function log(msg, level = "info") {
  const li = document.createElement("li");
  li.className = level;
  const t = document.createElement("time");
  t.textContent = new Date().toLocaleTimeString("es-ES", { hour12: false });
  const strong = document.createElement("strong");
  strong.textContent = msg;
  li.append(t, strong);
  logList?.prepend(li);
  while (logList && logList.children.length > 120) logList.lastChild.remove();
  console[level === "err" ? "error" : level === "warn" ? "warn" : "log"](msg);
}

/** Toast temporal esquina inferior derecha. */
export function toast(msg, kind = "info", ms = 3500) {
  const stack = $("#toasts");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Persistencia sencilla de la configuración en localStorage. */
const CFG_KEY = "whip-studio-config";
export function saveConfig(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* modo privado */ }
}
export function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
}
