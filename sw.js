self.addEventListener('install', (e) => {
  console.log('Service Worker: Installed');
});

self.addEventListener('fetch', (e) => {
  // Filhal basic rakhte hain taaki error hat jaye
  e.respondWith(fetch(e.request));
});
