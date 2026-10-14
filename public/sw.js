/* playcity service worker. It exists so the app can be installed and so a game against the computer still opens with no
   signal. It never touches live play: /api and /ws always go straight to the network. Everything else is network-first:
   the newest files are used whenever you are online (so a deploy shows up at once), and the last copy seen is the fallback. */
const CACHE = 'playcity-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic' && !res.headers.has('content-range')) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') { const home = await cache.match('/'); if (home) return home; }
      throw err;
    }
  })());
});
