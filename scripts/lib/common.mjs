// Outils partagés par les scripts TTS (Node 20, sans dépendance).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENV_FILE = path.join(ROOT, ".env.local");

export function readEnvFile() {
  const env = {};
  if (!fs.existsSync(ENV_FILE)) return env;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

// --nom valeur / --drapeau
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Appelle la route /api/tts du serveur local avec le jeton interne.
export function makeClient({ base, token, voice }) {
  return async function call(item, extra = {}) {
    const params = new URLSearchParams({ seg: item.seg, ctx: item.ctx, batch: "1", ...extra });
    const v = item.voice ?? voice;
    if (v) params.set("voice", v);
    const res = await fetch(`${base}/api/tts?${params}`, { headers: { "x-tts-token": token } });
    if (extra.dry) return { status: res.status, body: res.ok ? await res.json() : await res.text() };
    if (res.ok) {
      await res.arrayBuffer();
      return { status: 200, source: res.headers.get("X-TTS-Source") };
    }
    const body = await res.json().catch(() => ({}));
    return { status: res.status, code: body.code, error: body.error };
  };
}

const BACKOFF_MS = [5_000, 15_000, 45_000];

// Traite la liste avec `concurrency` requêtes en parallèle et une pause
// après chaque vraie génération (les fichiers déjà en cache passent sans
// attendre). S'arrête net si le quota ElevenLabs est épuisé : relancer le
// script plus tard reprend là où il s'était arrêté.
export async function runQueue(items, { call, concurrency, pauseMs, label = (i) => i.seg }) {
  const stats = { total: items.length, cache: 0, generated: 0, failed: [] };
  let index = 0;
  let stop = null;
  let done = 0;

  async function worker() {
    while (!stop && index < items.length) {
      const item = items[index++];
      let attempt = 0;
      for (;;) {
        let r;
        try {
          r = await call(item);
        } catch (err) {
          r = { status: 0, error: `serveur injoignable (${err.cause?.code ?? err.message})` };
        }
        if (r.status === 200) {
          if (r.source === "cache") stats.cache++;
          else {
            stats.generated++;
            console.log(`[${done + 1}/${items.length}] généré : ${label(item)}`);
            await sleep(pauseMs);
          }
          break;
        }
        if (r.code === "quota") {
          stop = `Quota ElevenLabs épuisé : ${r.error ?? ""}`;
          break;
        }
        if (r.status === 400 || r.status === 401) {
          if (r.status === 401) stop = "Jeton refusé : TTS_INTERNAL_TOKEN différent entre le script et le serveur (pm2 reload fait ?)";
          stats.failed.push(`${label(item)} → ${r.error ?? r.status}`);
          break;
        }
        if (attempt >= BACKOFF_MS.length) {
          stats.failed.push(`${label(item)} → ${r.error ?? r.status}`);
          break;
        }
        console.log(`  réessai dans ${BACKOFF_MS[attempt] / 1000} s (${label(item)} : ${r.error ?? r.status})`);
        await sleep(BACKOFF_MS[attempt++]);
      }
      done++;
      if (done % 100 === 0) console.log(`… ${done}/${items.length} traités`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ...stats, stopped: stop };
}

export function printSummary(s) {
  console.log("");
  console.log(`Déjà en cache : ${s.cache}`);
  console.log(`Générés       : ${s.generated}`);
  console.log(`Échecs        : ${s.failed.length}`);
  s.failed.slice(0, 30).forEach((f) => console.log(`  - ${f}`));
  if (s.failed.length > 30) console.log(`  … et ${s.failed.length - 30} autres`);
  if (s.stopped) {
    console.log("");
    console.log(`ARRÊT : ${s.stopped}`);
    console.log("Relance la même commande plus tard : ce qui est fait ne sera pas refait.");
  }
}
