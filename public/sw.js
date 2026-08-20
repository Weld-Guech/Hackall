const AUDIO_CACHE = "appelresto-audio-v1";
const APP_SHELL_CACHE = "appelresto-shell-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Stratégie : les fichiers audio générés (/audio/generated/*.mp3) sont
// "cache first" — une fois qu'un prénom ou un numéro a été prononcé une
// fois, il reste disponible même si le wifi du restaurant tombe.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/audio/generated/")) {
    event.respondWith(
      caches.open(AUDIO_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;

        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  // App shell : network first, fallback cache (pour garder l'UI
  // à jour quand la connexion est bonne, mais utilisable hors-ligne)
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(APP_SHELL_CACHE).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
