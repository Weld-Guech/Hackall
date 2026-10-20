// Remplace les segments provisoires (voix Piper, créés quand ElevenLabs
// était lent, en erreur ou à court de quota) par la vraie voix ElevenLabs.
//
// À lancer à la main sur le VPS, depuis le dossier du projet, app démarrée :
//   node scripts/tts-regen-provisoire.mjs
//
// Options : --concurrence <n> (défaut 2), --pause <ms> (défaut 400),
//           --base <url> (défaut http://127.0.0.1:3000)
//
// Le serveur supprime lui-même le fichier provisoire quand la vraie voix est
// enregistrée : relancer le script ne refait que ce qui reste.
import fs from "node:fs";
import path from "node:path";
import { ROOT, makeClient, parseArgs, printSummary, readEnvFile, runQueue } from "./lib/common.mjs";

const args = parseArgs(process.argv.slice(2));
const env = readEnvFile();
if (!env.TTS_INTERNAL_TOKEN) {
  console.error("TTS_INTERNAL_TOKEN absent de .env.local : lance d'abord node scripts/tts-setup.mjs");
  process.exit(1);
}

const cacheDir = env.TTS_CACHE_DIR || path.join(ROOT, "tts-cache");
const dir = path.join(cacheDir, "provisoire");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

const items = [];
for (const f of files) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    items.push({ seg: meta.seg, ctx: meta.ctx, voice: meta.voiceId });
  } catch {
    console.log(`Ignoré (illisible) : ${f}`);
  }
}

if (items.length === 0) {
  console.log("Aucun segment provisoire : rien à régénérer.");
  process.exit(0);
}
console.log(`${items.length} segment(s) provisoire(s) à régénérer.`);

const stats = await runQueue(items, {
  call: makeClient({
    base: typeof args.base === "string" ? args.base : "http://127.0.0.1:3000",
    token: env.TTS_INTERNAL_TOKEN,
  }),
  concurrency: Math.max(1, Number(args.concurrence) || 2),
  pauseMs: Number(args.pause ?? 400),
});
printSummary(stats);
process.exit(stats.stopped ? 2 : 0);
