// Service worker mínimo de Puente Live.
// Solo cachea el "cascarón" de la app (HTML, manifest, íconos) para que abra
// rápido y el navegador pueda ofrecer "Instalar app". NO intercepta el
// WebSocket ni nada de la traducción — eso siempre va directo a la red.
const CACHE = 'puente-live-v1';
const SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Solo responde desde caché para el cascarón estático; todo lo demás (y
  // cualquier método que no sea GET) pasa de largo a la red sin tocarlo.
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (!SHELL.includes(url.pathname)) return;

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
