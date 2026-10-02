/**
 * sdp.js — Utilidades de manipulación de SDP para WHIP.
 *
 * - preferCodec(): reordena los payload types del section m-line para que
 *   el códec elegido tenga máxima prioridad (el servidor acepta el primero).
 * - setBitrate(): inyecta atributos b=AS/TIAS y x-google-* en la sección.
 * - getCodecName(): extrae el nombre de códec negociado desde local/remote SDP.
 * @module sdp
 */

const AUDIO_ALIASES = {
  opus: ["opus"],
  aac: ["mp4a", "aac", "mpeg4-generic"],
  pcmu: ["pcmu", "g711_µlaw", "gulaw"],
  pcma: ["pcma", "g711_alaw", "alaw"],
};

const VIDEO_ALIASES = {
  H264: ["h264", "avc"],
  H265: ["h265", "hevc"],
  VP8: ["vp8"],
  VP9: ["vp9"],
  AV1: ["av1"],
};

/** Devuelve los pt (payload numbers) que coinciden con el códec pedido. */
function matchingPayloadTypes(sdpLines, kind, codecLabel) {
  const table = kind === "audio" ? AUDIO_ALIASES : VIDEO_ALIASES;
  const needles = (table[codecLabel] ?? [codecLabel]).map((s) => s.toLowerCase());
  const pts = [];
  for (const line of sdpLines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+([A-Za-z0-9_-]+)\//i);
    if (!m) continue;
    const name = m[2].toLowerCase();
    if (needles.some((n) => name.startsWith(n))) pts.push(m[1]);
  }
  return pts;
}

/** Divide el SDP en secciones (global + una por cada m=). */
function splitSections(sdp) {
  const lines = sdp.trim().split(/\r?\n/);
  const sections = [[]];
  for (const l of lines) {
    if (l.startsWith("m=") && sections.at(-1).length) sections.push([]);
    sections.at(-1).push(l);
  }
  return sections;
}

const joinSections = (sections) =>
  sections.map((s) => s.join("\r\n")).join("\r\n") + "\r\n";

/**
 * Reordena la línea m= para priorizar `codec` dentro de la sección `kind`.
 * @param {string} sdp        SDP completo (offer o answer)
 * @param {"audio"|"video"} kind
 * @param {string} codec      etiqueta lógica ("opus","H264","AV1"…)
 * @returns {string} nuevo SDP
 */
export function preferCodec(sdp, kind, codec) {
  if (!codec) return sdp;
  const sections = splitSections(sdp);
  let changed = false;

  for (const sec of sections) {
    const mIdx = sec.findIndex((l) => l.startsWith("m="));
    if (mIdx < 0) continue;
    const mType = sec[mIdx].slice(2).split(" ")[0];
    if (mType !== kind) continue;

    const wanted = matchingPayloadTypes(sec, kind, codec);
    if (!wanted.length) continue; // no soportado → dejar como está

    const parts = sec[mIdx].split(" ");
    const fmts = parts.slice(3);
    const rest = fmts.filter((f) => !wanted.includes(f));
    const ordered = [...wanted.filter((w) => fmts.includes(w)), ...rest];
    sec[mIdx] = [...parts.slice(0, 3), ...ordered].join(" ");
    changed = true;
  }
  return changed ? joinSections(sections) : sdp;
}

/**
 * Fija límites de bitrate sobre la sección `kind`:
 *  - b=AS:<kbps>          (bandwidth agregada)
 *  - b=TIAS:<bits/s>      (transport, usado por Chrome)
 *  - x-google-max/min/start-bitrate (hint WebRTC)
 * @param {number} kbps
 */
export function setBitrate(sdp, kind, kbps) {
  if (!kbps || kbps <= 0) return sdp;
  const bps = Math.round(kbps * 1000);
  const sections = splitSections(sdp);

  for (const sec of sections) {
    const mIdx = sec.findIndex((l) => l.startsWith(`m=${kind}`));
    if (mIdx < 0) continue;

    // 1) Elimina bandwidths y hints google previos de ESTA sección.
    for (let i = sec.length - 1; i > mIdx; i--) {
      if (/^b=(AS|TIAS|CT):/i.test(sec[i]) || /x-google-(max|min|start)-bitrate/.test(sec[i])) {
        sec.splice(i, 1);
      }
    }

    // 2) Líneas b= justo después de m= (orden SDP correcto).
    sec.splice(mIdx + 1, 0, `b=AS:${kbps}`, `b=TIAS:${bps}`);

    // 3) Fusiona/maximiza los parámetros fmtp del pt PRIORITARIO de la sección
    //    (tras preferCodec el índice 3 es el códec elegido; si no hay munging,
    //    se usa igualmente el primero, que es lo que codificará WebRTC).
    const firstPt = sec[mIdx].split(" ")[3];
    const want = [
      ["max-average-bitrate", bps],
      ["max-bitrate", bps],
      ["min-bitrate", Math.round(bps * 0.6)],
      ["x-google-max-bitrate", bps],
      ["x-google-min-bitrate", Math.round(bps * 0.6)],
      ["x-google-start-bitrate", bps],
    ];
    const fmtpIdx = sec.findIndex((l, i) => i > mIdx && l.startsWith(`a=fmtp:${firstPt} `));
    if (fmtpIdx >= 0) {
      const [, rest] = sec[fmtpIdx].split(" ", 2);
      const params = new Map(
        rest.split(";").map((p) => {
          const [k, v] = p.trim().split("=");
          return [k?.toLowerCase(), v];
        }).filter(([k]) => k),
      );
      for (const [k, v] of want) {
        const cur = parseInt(params.get(k) ?? "0", 10);
        // en min-bitrate respetamos el menor; en máximos usamos el mayor ya fijado
        params.set(k, String(k.includes("min") ? (cur || v) : Math.max(cur, v)));
      }
      sec[fmtpIdx] = `a=fmtp:${firstPt} ${[...params].map(([k, v]) => `${k}=${v}`).join(";")}`;
    } else {
      sec.push(`a=fmtp:${firstPt} ${want.map(([k, v]) => `${k}=${v}`).join(";")}`);
    }
  }
  return joinSections(sections);
}

/** Nombre del códec realmente negociado para un sender/receiver. */
export function codecFromSdp(sdp, kind) {
  try {
    const lines = sdp.split(/\r?\n/);
    const mLine = lines.find((l) => l.startsWith(`m=${kind}`));
    if (!mLine) return null;
    const pt = mLine.split(" ")[3];
    const rtp = lines.find((l) => l.startsWith(`a=rtpmap:${pt} `));
    if (!rtp) return null;
    return rtp.split(" ")[1].split("/")[0].toUpperCase();
  } catch {
    return null;
  }
}

/** ¿El navegador ofrece este códec? (para pintar soporte en UI) */
export async function detectCodecSupport(kind, codec) {
  const pc = new RTCPeerConnection();
  if (kind === "audio") pc.addTransceiver("audio"); else pc.addTransceiver("video");
  const offer = await pc.createOffer();
  pc.close();
  return matchingPayloadTypes(offer.sdp.split(/\r?\n/), kind, codec).length > 0;
}

/**
 * Fija el bitrate REAL del canal mediante RTCRtpSender.setParameters().
 * Es el mecanismo garantizado en Chrome/Edge/Safari/Firefox para limitar la
 * codificación (los hints del SDP son solo sugerencias). Se llama:
 *   - al negociar (createOffer antes/setLocalDescription después),
 *   - al cambiar el slider en caliente (WhipPublisher.applyBitrates),
 *   - en cada reconexión (_negotiate vuelve a leer this.opts).
 * @param {RTCRtpSender} sender
 * @param {"video"|"audio"} kind
 * @param {number} kbps
 */
export async function senderParameters(sender, kind, kbps) {
  if (!sender || !kbps || kbps <= 0) return false;
  const params = sender.getParameters?.();
  if (!params) return false;
  if (!params.encodings || !params.encodings.length) {
    params.encodings = [{ rid: kind === "video" ? "q" : "a" }];
  }
  const bps = Math.round(kbps * 1000);
  for (const enc of params.encodings) {
    enc.maxBitrate = bps;
    enc.minBitrate = Math.round(bps * 0.6);
    if (kind === "video") enc.startBitrate = bps;
  }
  await sender.setParameters(params);
  return true;
}
