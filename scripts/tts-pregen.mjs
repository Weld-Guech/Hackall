// Pré-génère les segments d'annonce dans le cache partagé, pour ne presque
// plus appeler ElevenLabs pendant le service.
//
// À lancer à la main sur le VPS, depuis le dossier du projet, app démarrée :
//   node scripts/tts-pregen.mjs --essai                 (compte, ne génère rien)
//   node scripts/tts-pregen.mjs                         (fixes + 1-999 + prénoms corrigés)
//   node scripts/tts-pregen.mjs --prenoms top-insee.txt (+ un prénom par ligne)
//
// Options :
//   --prenoms <fichier>       liste de prénoms, un par ligne (lignes vides et # ignorées)
//   --avec-prenoms-arabes     ajoute aussi la liste de suggestions du kiosque (~1400)
//   --sans-numeros            ne fait pas les numéros 1 à 999
//   --concurrence <n>         requêtes simultanées (défaut 2)
//   --pause <ms>              pause après chaque génération (défaut 400)
//   --voix <id>               voix à générer (défaut : ELEVENLABS_VOICE_ID)
//   --base <url>              serveur (défaut http://127.0.0.1:3000)
//
// Reprenable : ce qui est déjà en cache est sauté sans coût. Si le quota
// ElevenLabs est épuisé, le script s'arrête ; relance-le plus tard.
import fs from "node:fs";
import path from "node:path";
import { ROOT, makeClient, parseArgs, printSummary, readEnvFile, runQueue } from "./lib/common.mjs";

const FIXED = ["La commande", "est prête.", "Les commandes", "et", "sont prêtes."];

const args = parseArgs(process.argv.slice(2));
const env = readEnvFile();
const token = process.env.TTS_INTERNAL_TOKEN || env.TTS_INTERNAL_TOKEN;
if (!token) {
  console.error("TTS_INTERNAL_TOKEN absent de .env.local : lance d'abord node scripts/tts-setup.mjs");
  process.exit(1);
}

function namesFromTs(file, pattern) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  return Array.from(src.matchAll(pattern), (m) => m[2]);
}

function namesFromTxt(file) {
  return fs
    .readFileSync(path.resolve(file), "utf8")
    .split(/\r?\n/)
    .map((l) => l.split(/[;,\t]/)[0].trim())
    .filter((l) => l && !l.startsWith("#"));
}

const names = [
  ...namesFromTs("lib/phoneticCorrections.ts", /original:\s*(['"])(.*?)\1/g),
  ...(args["avec-prenoms-arabes"] ? namesFromTs("lib/prenomsArabes.ts", /^\s*(["'])(.*?)\1,?\s*$/gm) : []),
  ...(typeof args.prenoms === "string" ? namesFromTxt(args.prenoms) : []),
];

// Dédoublonnage grossier (le serveur normalise de toute façon : "RAYANE" et
// "Rayane" tombent sur le même fichier, le second sera un "déjà en cache").
const seen = new Set();
const uniqueNames = names.filter((n) => {
  const k = n.toLocaleLowerCase("fr").normalize("NFC");
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const items = [
  ...FIXED.map((seg) => ({ seg, ctx: "fixe" })),
  ...(args["sans-numeros"] ? [] : Array.from({ length: 999 }, (_, i) => ({ seg: String(i + 1), ctx: "id" }))),
  ...uniqueNames.map((seg) => ({ seg, ctx: "id" })),
];

const call = makeClient({
  base: typeof args.base === "string" ? args.base : "http://127.0.0.1:3000",
  token,
  voice: typeof args.voix === "string" ? args.voix : undefined,
});

console.log(`${items.length} segments à vérifier (${uniqueNames.length} prénoms).`);

if (args.essai) {
  let missing = 0;
  let chars = 0;
  let invalid = 0;
  for (const item of items) {
    const r = await call(item, { dry: "1" });
    if (r.status !== 200) {
      invalid++;
      if (r.status === 401) {
        console.error("Jeton refusé : as-tu fait pm2 reload après tts-setup ?");
        process.exit(1);
      }
      continue;
    }
    if (!r.body.cached) {
      missing++;
      chars += r.body.chars;
    }
  }
  console.log(`Déjà en cache : ${items.length - missing - invalid}`);
  console.log(`À générer     : ${missing} segments, ~${chars} caractères`);
  console.log(`Invalides     : ${invalid}`);
  console.log("(Crédits : ~1 par caractère en multilingual_v2, ~0,5 en flash_v2_5.)");
  process.exit(0);
}

const stats = await runQueue(items, {
  call,
  concurrency: Math.max(1, Number(args.concurrence) || 2),
  pauseMs: Number(args.pause ?? 400),
});
printSummary(stats);
process.exit(stats.stopped ? 2 : 0);
