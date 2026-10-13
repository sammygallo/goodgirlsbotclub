// Bump this version whenever you need to forcibly clear all cached assets.
const CACHE_NAME = 'st-mobile-v2';

// Matches Vite's hashed asset filenames: /assets/index-AbCdEf12.js
const HASHED_ASSET = /\/assets\/.+\.[a-f0-9]{8,}\.(js|css)$/;

self.addEventListener('install', () => {
  // Take over immediately — don't wait for old SW to unload.
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Delete all caches from previous versions.
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Network-only for API / dynamic routes — never cache.
  if (
    url.pathname.startsWith('/api') ||
    url.pathname.startsWith('/thumbnail') ||
    url.pathname.startsWith('/characters') ||
    url.pathname.startsWith('/csrf-token') ||
    url.pathname.startsWith('/hero/')
  ) {
    return;
  }

  // ── HTML (navigation requests) → network-first ─────────────────────────────
  // Always fetch fresh HTML so users get the correct hashed asset filenames
  // after a deploy. Fall back to cache only when completely offline.
  if (
    e.request.mode === 'navigate' ||
    e.request.headers.get('accept')?.includes('text/html')
  ) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          return response;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // ── Hashed JS/CSS assets → cache-first ─────────────────────────────────────
  // These filenames are immutable (hash changes with content), so caching
  // them forever is safe and makes repeat visits instant.
  if (HASHED_ASSET.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // ── Everything else (icons, manifest, fonts…) → cache-first ────────────────
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
