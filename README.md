# WHIP Studio — Panel de transmisión en directo (WebRTC / WHIP → MediaMTX)

Aplicación web profesional **broadcast-first** para publicar vídeo y audio en
directo mediante **WebRTC** y el protocolo **WHIP**
([draft-ietf-whip](https://datatracker.ietf.org/doc/draft-ietf-wish-whip/)),
compatible con [MediaMTX](https://github.com/bluenviron/mediamtx) y cualquier
servidor WHIP estándar (Cloudflare Stream Delivery, Twitch WHIP, etc.).

Pensada para **radio, televisión, podcasting, iglesias, eventos y transmisiones
móviles**. Estilo operativo tipo OBS / Larix Broadcaster / LiveU.

---

## Estructura del proyecto

```
app/
├── index.html              # Shell de la aplicación (UI completa)
├── manifest.webmanifest    # Manifiesto PWA (Android/iOS/desktop)
├── sw.js                   # Service Worker (cache offline del shell)
├── css/styles.css          # Tema oscuro broadcast, responsive
├── icons/                  # icon.svg + PNG 192/512 (maskable)
└── js/                     # Arquitectura modular ES2023 (ESM puros)
    ├── main.js             # Orquestador UI ↔ módulos
    ├── devices.js          # Captura: cámaras UVC/HDMI-USB, pantalla, hot-swap, zoom HW
    ├── audio.js            # Web Audio: HPF OFF/80/100 Hz, RMS→dB, vúmetro estéreo, peak-hold
    ├── sdp.js              # Munging SDP: prioridad de códecs + límites de bitrate
    ├── whip.js             # Publicación WHIP: offer→POST→answer, reconexión 4 s, DELETE
    ├── stats.js            # getStats(): bitrate, FPS, RTT, pérdida, jitter, uptime
    ├── hud.js              # HUD broadcast + Battery API + Screen Wake Lock
    └── utils.js            # Helpers (dom, formato, log, toasts, persistencia)
```

Sin dependencias externas ni build: se sirve como estáticos.

## Requisitos funcionales cubiertos

| # | Requisito | Dónde |
|---|-----------|-------|
| 1 | Selección dinámica de dispositivos, webcams/UVC/capturadoras HDMI-USB, pantalla, cambio sin cortar emisión (`replaceTrack`) | `devices.js`, `main.js` |
| 2 | Previsualización, pantalla completa, regla de tercios, zoom por hardware (`applyConstraints({zoom})`) y pinch-to-zoom móvil | `index.html`, `main.js` |
| 3 | Web Audio API: HPF OFF/80/100 Hz, RMS→dBFS, vúmetro estéreo, peak-hold, aviso de clipping | `audio.js` |
| 4 | Resoluciones 360p–4K, bitrate vídeo/audio configurable, modos Estudio (`maintain-resolution`) / Exteriores (`maintain-framerate`) | `devices.js`, UI |
| 5 | Códecs Opus/AAC/PCMU/PCMA y H264/H265/VP8/VP9/AV1 con munging de prioridad + detección de soporte del navegador | `sdp.js`, `whip.js` |
| 6 | WHIP: SDP offer → HTTP POST (`application/sdp`) → answer → conexión completa; cierre con `DELETE` (+`If-Match` ETag) | `whip.js` |
| 7 | Estadísticas: bitrate, FPS, RTT, packet loss, resolución activa, códecs negociados, tiempo en vivo | `stats.js` |
| 8 | Reconexión automática ante `disconnected`/`failed`, reintento cada 4 s restaurando la sesión | `whip.js` |
| 9 | HUD: estado, batería, bitrate, FPS, dB, códec, resolución, zoom, pérdida | `hud.js` |
| 10 | PWA: manifest, service worker, botón de instalación, wake lock | `manifest.webmanifest`, `sw.js` |
| 11 | Tema oscuro profesional, responsive (monitor prioritario en móvil) | `css/styles.css` |

## Cómo ejecutar

### 1. Servir la app (HTTPS o localhost son obligatorios para getUserMedia)

```bash
cd app
python3 -m http.server 8443        # desarrollo en localhost
# o detrás de un proxy inverso con TLS para uso desde el móvil
```

### 2. Configurar MediaMTX como receptor WHIP

`mediamtx.yml` (MediaMTX ≥ v1.x):

```yaml
webrtc: yes
webrtcListenAddress: :8189         # señalización WHIP sobre HTTP
webrtcLocalUDPAddress: :8189       # RTP/RTCP
webrtcAllowOrigin: "*"             # CORS para servir la app desde otro origen
```

Endpoint a introducir en la app:

```
http://<host>:8189/<canal>/whip    ✅ ingest WHIP (publicación)
```

Reproduce la salida con VLC, ffplay u otro cliente (HLS/WebRTC salientes):

```
ffplay http://<host>:8888/<canal>/stream.m3u8   # si activas HLS
```

### 3. Operar

1. Elige origen (cámara/pantalla), cámara y micrófono → **Iniciar previsualización**.
2. Ajusta resolución, bitrate, códecs y modo Estudio/Exteriores.
3. Verifica encuadre (tercios) y niveles (VU estéreo + peak).
4. Pulsa **GO LIVE**. El HUD muestra batería, bitrate, FPS, dB, códec, zoom…
5. Si cae la red, la sesión se restaura sola cada 4 s (contador RECONNECTS).

## Notas técnicas

- **Trickle ICE desactivado durante el handshake**: el offer se envía con sus
  candidatos reunidos (≤2,5 s) porque MediaMTX espera un SDP completo.
- **Bitrate**: se inyectan `b=AS`, `b=TIAS` y `max-bitrate/min-bitrate/x-google-*`
  en el `a=fmtp` del payload prioritario tras seleccionar el códec.
- **Códecs no soportados por el navegador** se marcan en rojo en el panel; la
  negociación degrada elegantemente al primer códec común.
- **Battery API** solo existe en Chromium; en Safari/Firefox el HUD muestra `n/d`.
- **iOS**: añade a Home Screen para standalone; requiere iOS ≥ 14.3 para WebRTC.
- La medición RMS pasa por el mismo HPF que se emite, de forma que el VU refleja
  fielmente la señal publicada.
- El Service Worker **nunca intercepta** peticiones cross-origin ni métodos
  distintos de GET: la ingesta WHIP (POST/DELETE) siempre va directa al servidor.

## Producción

- Sirve la app bajo TLS real (Let's Encrypt) si accedes desde móvil/tablet.
- Activa `whipBearerToken` en tu proxy o `authMethod: http` en MediaMTX y usa
  el campo *Bearer Token* del panel.
- Para NAT estrictos añade un TURN propio a `RTC_CONFIG` en `js/whip.js`.
