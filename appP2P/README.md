# RCM P2P Camera LAN (PWA)

Aplicación web progresiva (PWA) de cámara punto a punto (P2P) en red local, basada en WebRTC vía PeerJS, con preferencia de códec H.264/H.265, diagnóstico en vivo (HUD), grillas y marcos de encuadre persistentes.

## Estructura del proyecto

```
appP2P/
├── index.html              # Aplicación (antes "index p2p.html")
├── manifest.webmanifest    # Manifiesto PWA (nombre, íconos, display standalone)
├── sw.js                   # Service Worker (cache offline: network-first HTML, cache-first CDN peerjs)
└── icons/
    ├── icon.svg            # Ícono vectorial
    ├── icon-192.png        # Ícono 192x192 (launcher / apple-touch-icon)
    ├── icon-512.png        # Ícono 512x512
    ├── icon-maskable-512.png  # Ícono maskable (safe zone 80%)
    └── icon-maskable.svg   # Ícono maskable vectorial
```

## Cómo ejecutar

La PWA requiere un contexto seguro (HTTPS o `localhost`) para registrar el Service Worker y permitir la instalación. Sirve la carpeta con cualquier HTTP estático:

```bash
cd appP2P
python3 -m http.server 8080
# abrir http://localhost:8080/index.html
```

En producción (por ejemplo una Raspberry Pi o un servidor de la LAN) usa HTTPS real o un certificado autofirmado; sin HTTPS el navegador no permitirá instalar la app ni acceder a `getUserMedia` fuera de localhost.

## Instalación como app

- **Android / Chrome**: botón "📲 Instalar app" (aparece cuando el navegador dispara `beforeinstallprompt`) o menú ⋮ → "Instalar aplicación".
- **iOS / Safari**: Compartir → "Agregar a pantalla de inicio" (Safari soporta manifest e íconos; el SW funciona desde iOS 16.4+ en apps instaladas).
- **Escritorio**: Chrome/Edge muestran el ícono de instalación en la barra de direcciones.

## Notas de funcionamiento

- El Service Worker cachea `index.html`, manifiesto, íconos y `peerjs.min.js` (CDN) para que la interfaz cargue sin conexión. La señalización de PeerJS y los flujos WebRTC requieren red disponible; la app muestra el estado de conexión.
- Códecs: se reordena la SDP para preferir H.264 o H.265/HEVC según la selección del usuario; si el par no lo soporta hay fallback automático al resto de códecs compartidos.
- FPS: máximo real 30 (los perfiles de 60 se retiraron porque la mayoría de cámaras no los entregan en 720p/1080p y WebRTC no puede generarlos).
- Preferencias persistidas en `localStorage`: modo de grilla, estilo de marco (con sliders) y códec preferido.
