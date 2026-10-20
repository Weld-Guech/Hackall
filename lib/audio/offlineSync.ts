// Téléchargement en arrière-plan de tous les segments déjà générés, dans le
// cache du service worker : les annonces partent ensuite sans latence, même
// sans réseau. Reprenable (ce qui est déjà en cache est sauté) et discret
// (deux téléchargements à la fois, en pause pendant une annonce).
import { resolveSegment, segmentUrl, type TtsCtx } from "../tts/text.ts";

// Doit rester identique à TTS_CACHE dans public/sw.js.
export const TTS_SW_CACHE = "appelresto-tts-v1";

export type SyncState = "running" | "done" | "offline" | "unsupported";
export type SyncProgress = { state: SyncState; done: number; total: number; failed: number };

const CONCURRENCY = 2;
const MAX_NETWORK_ERRORS = 5;
const PROGRESS_EVERY = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function syncOfflineAudio(opts: {
  voiceTag: string;
  // Une annonce est en cours de chargement : on lui laisse la bande passante.
  isBusy: () => boolean;
  shouldStop: () => boolean;
  onProgress: (p: SyncProgress) => void;
}): Promise<SyncProgress> {
  if (typeof window === "undefined" || !("caches" in window)) {
    const p: SyncProgress = { state: "unsupported", done: 0, total: 0, failed: 0 };
    opts.onProgress(p);
    return p;
  }

  // Demande à iOS/Android de ne pas effacer ce cache pour faire de la place.
  navigator.storage?.persist?.().catch(() => {});

  let segments: { seg: string; ctx: TtsCtx }[];
  try {
    const res = await fetch("/api/tts/catalogue", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error(String(res.status));
    segments = (await res.json()).segments ?? [];
  } catch {
    const p: SyncProgress = { state: "offline", done: 0, total: 0, failed: 0 };
    opts.onProgress(p);
    return p;
  }

  // Mêmes URL que le kiosque (segmentUrl), sinon le cache ne servirait à rien.
  const urls: string[] = [];
  for (const s of segments) {
    const r = resolveSegment(s.seg, s.ctx);
    if (r.ok) urls.push(segmentUrl(r, opts.voiceTag));
  }

  const cache = await caches.open(TTS_SW_CACHE);
  const wanted = new Set(urls.map((u) => new URL(u, location.href).href));
  const keys = await cache.keys();
  // Ménage : anciennes versions d'un prénom corrigé, textes libres d'un jour...
  // (redemandés au serveur si jamais on en a de nouveau besoin).
  await Promise.all(keys.filter((req) => !wanted.has(req.url)).map((req) => cache.delete(req)));
  const have = new Set(keys.map((req) => req.url));
  const missing = urls.filter((u) => !have.has(new URL(u, location.href).href));

  const progress: SyncProgress = {
    state: "running",
    done: urls.length - missing.length,
    total: urls.length,
    failed: 0,
  };
  opts.onProgress({ ...progress });

  // Sous contrôle du service worker, c'est lui qui range la réponse dans le
  // cache ; sinon (premier chargement, dev), on la range nous-mêmes.
  const swControlled = Boolean(navigator.serviceWorker?.controller);
  let index = 0;
  let networkErrors = 0;

  async function worker() {
    while (index < missing.length && !opts.shouldStop() && networkErrors < MAX_NETWORK_ERRORS) {
      while (opts.isBusy() && !opts.shouldStop()) await sleep(250);
      const url = missing[index++];
      try {
        const res = await fetch(url, {
          credentials: "same-origin",
          headers: { "x-tts-cache-only": "1" },
        });
        if (res.ok && res.headers.get("X-TTS-Final") === "1") {
          if (swControlled) await res.arrayBuffer();
          else await cache.put(url, res);
          progress.done++;
        } else {
          await res.arrayBuffer().catch(() => {});
          progress.failed++;
        }
        networkErrors = 0;
      } catch {
        networkErrors++;
        progress.failed++;
      }
      if ((progress.done + progress.failed) % PROGRESS_EVERY === 0) opts.onProgress({ ...progress });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  progress.state = networkErrors >= MAX_NETWORK_ERRORS ? "offline" : "done";
  opts.onProgress({ ...progress });
  return progress;
}
