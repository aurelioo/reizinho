/* =============================================================
   Service Worker — dashboard funciona offline.
   Core same-origin: network-first (atualiza online, cache offline).
   CDN (Web Awesome, esm.sh): cache-first (assets versionados).
   Supabase nunca é cacheado (dados vivos; offline quem responde
   é o IndexedDB do app).
   ============================================================= */

const CACHE = 'reizinho-v2';
const CORE = [
  './',
  './index.html',
  './css/app.css',
  './js/data.js',
  './js/repo.js',
  './js/sync.js',
  './js/app.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.endsWith('.supabase.co')) return;

  const putInCache = r => {
    if (r && r.ok) {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
    }
    return r;
  };

  if (url.origin === location.origin) {
    // no-cache: revalida com o servidor (ETag) em vez de aceitar o
    // max-age do Pages — deploy novo aparece no próximo reload
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(putInCache)
        .catch(() => caches.match(e.request, { ignoreSearch: true })
          .then(hit => hit ?? caches.match('./index.html')))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(hit => hit ?? fetch(e.request).then(putInCache))
    );
  }
});
