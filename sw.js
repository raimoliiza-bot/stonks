// Portfell – taustaskript. Leht ja ikoonid tulevad võimalusel võrgust (nii jõuab uus versioon kohe kohale),
// võrguta avamisel puhvrist. Andmepäringud Apps Scriptile lähevad alati otse võrku.
const PUHVER = 'portfell-v2';
const KEST = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(PUHVER).then(c => c.addAll(KEST))); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== PUHVER).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => { if (r.ok) { const k = r.clone(); caches.open(PUHVER).then(c => c.put(e.request, k)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./')))
  );
});
