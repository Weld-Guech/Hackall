// Segments d'annonce (/api/tts) : cache d'abord, pour que le kiosque continue
// d'annoncer si le réseau coupe. Changer de nom uniquement si le format des
// réponses change (l'URL contient déjà la version des segments).
const TTS_CACHE = "appelresto-tts-v1";
// Anciennes annonces "phrase entière", gardées pour rejouer l'historique.
const AUDIO_CACHE = "appelresto-audio-v3";
const APP_SHELL_CACHE = "appelresto-shell-v4";
const KEPT_CACHES = [TTS_CACHE, AUDIO_CACHE, APP_SHELL_CACHE];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Supprime les caches des versions précédentes, mais plus l'audio
      // courant : avant, chaque mise à jour vidait le cache des tablettes.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !KEPT_CACHES.includes(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

async function cacheFirst(request, cacheName, isCacheable) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  // Jamais d'interception des POST (login, ancienne api/tts, etc.)
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Seuls les segments définitifs (voix ElevenLabs) sont gardés : un
  // segment provisoire (Piper) doit être redemandé pour recevoir la vraie
  // voix une fois régénérée.
  if (url.pathname === "/api/tts") {
    event.respondWith(
      cacheFirst(event.request, TTS_CACHE, (r) => r.ok && r.headers.get("X-TTS-Final") === "1")
    );
    return;
  }

  // Jamais d'interception des autres appels API : toujours le réseau
  if (url.pathname.startsWith("/api/")) return;

  // Ancien audio généré (historique) : un fichier ne change jamais.
  if (url.pathname.startsWith("/audio/generated/")) {
    event.respondWith(cacheFirst(event.request, AUDIO_CACHE, (r) => r.ok));
    return;
  }

  // App shell : réseau d'abord, cache uniquement des réponses OK
  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(APP_SHELL_CACHE);
          cache.put(event.request, response.clone());
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
