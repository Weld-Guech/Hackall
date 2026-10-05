// AUDIO_CACHE doit rester identique à la constante de app/page.tsx.
const AUDIO_CACHE = "appelresto-audio-v3";
const APP_SHELL_CACHE = "appelresto-shell-v3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Supprime TOUS les anciens caches : élimine les reponses viciees
      // laissees par les versions precedentes sur chaque appareil
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  // Jamais d'interception des POST (api/tts, login, etc.)
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Jamais d'interception des appels API : toujours le reseau
  if (url.pathname.startsWith("/api/")) return;

  // Audio genere : cache d'abord. Un fichier genere ne change jamais
  // (servi en "immutable"), donc inutile de repasser par le reseau a
  // chaque lecture ; on ne met en cache que les reponses valides.
  if (url.pathname.startsWith("/audio/generated/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(AUDIO_CACHE);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })()
    );
    return;
  }

  // App shell : reseau d'abord, cache uniquement des reponses OK
  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (response.ok && url.origin === self.location.origin) {
          const cache = await caches.open(APP_SHELL_CACHE);
          cache.put(event.request, response.clone());
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
