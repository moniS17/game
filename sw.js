const CACHE_NAME = 'battlegrid-v2';
const ASSETS = [
  './',
  'index.html',
  'login.html',
  'menu.html',
  'mode.html',
  'buy.html',
  'tech.html',
  'template.html',
  'editor.html',
  'info.html',
  'diplomacy.html',
  'units.js',
  'board.js',
  'algorithms.js',
  'rules.js',
  'render.js',
  'game.js',
  'state.js',
  'ai.js',
  'input.js',
  'auth.js',
  'minicpm.js',
  'wasm-cpm.js',
  'manifest.json',
  'assets/infantry.svg',
  'assets/motorized.svg',
  'assets/cavalry.svg',
  'assets/artillery.svg',
  'assets/tank.svg',
  'assets/city.svg',
  'assets/village.svg',
  'assets/forest.svg',
  'assets/grass.svg',
  'assets/water.svg',
  'assets/gold.svg',
  'assets/fort.svg',
  'assets/supply.svg',
  'assets/sword.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
