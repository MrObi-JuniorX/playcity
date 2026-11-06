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

/* Cup notifications (Web Push, docs/whot-cup-prd.md PX-4): "your table is ready", Second Chance offers, check-in,
   the Grand Final. The payload is encrypted for this browser alone; it says what to show and where a tap goes,
   and a tap only ever opens a page on this site. */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { return; }
  if (!d || typeof d.title !== 'string') return;
  const url = typeof d.url === 'string' ? d.url : '/';
  e.waitUntil((async () => {
    // Already looking at it (your table is open on screen): nothing to tell you.
    let path = '/'; try { path = new URL(url, location.origin).pathname; } catch (err) { /* keep the home page */ }
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (c.visibilityState === 'visible' && new URL(c.url).pathname === path) return;
    }
    await self.registration.showNotification(d.title, {
      body: typeof d.body === 'string' ? d.body : '', tag: typeof d.tag === 'string' ? d.tag : 'playcity', renotify: true,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url },
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  let url = new URL('/', location.origin);
  try { const u = new URL(e.notification.data.url, location.origin); if (u.origin === location.origin) url = u; } catch (err) { /* keep the home page */ }
  e.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) if (c.url === url.href && 'focus' in c) return c.focus();
    return self.clients.openWindow(url.href);
  })());
});
