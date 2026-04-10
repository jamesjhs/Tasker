/* ============================================================
   Tasker — Service Worker
   Cache-first for static assets, network-first for /api/
   ============================================================ */

const CACHE_NAME = 'tasker-__APP_VERSION__'; // replaced with the real version by the server at runtime

// External CDN URLs (e.g. Chart.js from jsDelivr) are intentionally excluded
// from precaching to avoid CSP connect-src violations during SW install.
const STATIC_ASSETS = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/manifest.json',
  '/policy.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('SW: Failed to cache', url, err))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for API
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — no network connection.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    return;
  }

  // For SPA navigation requests (all HTML page loads except the standalone pages
  // that have their own content), always serve the precached root shell ('/').
  // This guarantees that navigating directly to a client-side route (e.g.
  // /analytics, /settings, or any other SPA path) always loads the latest
  // app shell that the SW precached on install, instead of accidentally serving
  // a stale per-URL entry from the browser's HTTP cache.
  const STANDALONE_PAGES = ['/policy', '/dpia', '/help', '/guide'];
  if (event.request.mode === 'navigate' && !STANDALONE_PAGES.includes(url.pathname)) {
    event.respondWith(
      caches.match('/').then(cached => cached || fetch('/'))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
