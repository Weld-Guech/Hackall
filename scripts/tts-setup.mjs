// Prépare et vérifie la configuration TTS sur le VPS, sans éditer de
// fichier à la main :
//   node scripts/tts-setup.mjs
//
// - ajoute à .env.local les réglages TTS manquants (jamais d'écrasement ;
//   une copie de sauvegarde est faite avant toute modification) ;
// - génère le jeton interne utilisé par les scripts de pré-génération ;
// - vérifie ffmpeg, Piper, le dossier de cache et la voix configurée.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ENV_FILE, ROOT, readEnvFile } from "./lib/common.mjs";

const VICTORIA = "O31r762Gb3WFygrEOGh0";
const DEFAULTS = {
  TTS_CACHE_DIR: "/home/ubuntu/hackall-tts-cache",
  TTS_MODEL_ID: "eleven_multilingual_v2",
  ELEVENLABS_TIMEOUT_MS: "2000",
  PIPER_BIN: "/home/ubuntu/piper/piper",
  PIPER_MODEL: "/home/ubuntu/piper-voices/fr_FR-siwis-medium.onnx",
  TTS_INTERNAL_TOKEN: crypto.randomBytes(24).toString("hex"),
};

let problems = 0;
const ok = (msg) => console.log(`  OK   ${msg}`);
const ko = (msg) => {
  problems++;
  console.log(`  !!   ${msg}`);
};

console.log("1. Fichier .env.local");
const env = readEnvFile();
const missing = Object.keys(DEFAULTS).filter((k) => !env[k]);
if (missing.length === 0) {
  ok("tous les réglages TTS sont présents");
} else {
  if (fs.existsSync(ENV_FILE)) {
    const backup = `${ENV_FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(ENV_FILE, backup);
    ok(`sauvegarde : ${path.basename(backup)}`);
  }
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const block = [
    current && !current.endsWith("\n") ? "" : null,
    "",
    "# --- Cache audio TTS (ajouté par scripts/tts-setup.mjs) ---",
    ...missing.map((k) => `${k}=${DEFAULTS[k]}`),
    "",
  ].filter((l) => l !== null);
  fs.appendFileSync(ENV_FILE, block.join("\n"));
  missing.forEach((k) => ok(`ajouté : ${k}${k === "TTS_INTERNAL_TOKEN" ? "=(secret généré)" : `=${DEFAULTS[k]}`}`));
  Object.assign(env, Object.fromEntries(missing.map((k) => [k, DEFAULTS[k]])));
}

if (!env.ELEVENLABS_API_KEY) ko("ELEVENLABS_API_KEY absent");
else ok("clé ElevenLabs présente");
if (env.ELEVENLABS_VOICE_ID === VICTORIA) ok("voix par défaut : Victoria");
else ko(`ELEVENLABS_VOICE_ID vaut "${env.ELEVENLABS_VOICE_ID ?? ""}" et non Victoria (${VICTORIA})`);

console.log("2. Restaurants avec une voix personnalisée (cache séparé, non pré-généré)");
try {
  const clients = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "clients.json"), "utf8"));
  const custom = clients.filter((c) => c.voiceId && c.voiceId !== env.ELEVENLABS_VOICE_ID);
  if (custom.length === 0) ok("aucun : tout le monde partage le même cache");
  custom.forEach((c) => console.log(`  --   ${c.restaurantName} : ${c.voiceId}`));
} catch {
  console.log("  --   data/clients.json illisible (ignoré)");
}

console.log("3. ffmpeg");
const ff = spawnSync(env.FFMPEG_BIN || "ffmpeg", ["-version"], { encoding: "utf8" });
if (ff.status === 0) ok(ff.stdout.split("\n")[0]);
else ko("ffmpeg introuvable : sudo apt install -y ffmpeg");

console.log("4. Piper");
if (!fs.existsSync(env.PIPER_BIN)) ko(`binaire absent : ${env.PIPER_BIN}`);
else if (!fs.existsSync(env.PIPER_MODEL)) ko(`voix absente : ${env.PIPER_MODEL}`);
else if (!fs.existsSync(`${env.PIPER_MODEL}.json`)) ko(`fichier de config absent : ${env.PIPER_MODEL}.json`);
else {
  const wav = path.join(os.tmpdir(), `tts-setup-${process.pid}.wav`);
  const piperDir = path.dirname(env.PIPER_BIN);
  const run = spawnSync(env.PIPER_BIN, ["--model", env.PIPER_MODEL, "--output_file", wav], {
    input: "La commande douze est prête.\n",
    cwd: piperDir,
    env: { ...process.env, LD_LIBRARY_PATH: [piperDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (run.status === 0 && fs.existsSync(wav) && fs.statSync(wav).size > 1000) ok("synthèse de test réussie");
  else ko(`échec de la synthèse de test : ${(run.stderr || run.error?.message || "").trim().slice(-300)}`);
  fs.rmSync(wav, { force: true });
}

console.log("5. Dossier de cache");
try {
  fs.mkdirSync(path.join(env.TTS_CACHE_DIR, "logs"), { recursive: true });
  const probe = path.join(env.TTS_CACHE_DIR, ".probe");
  fs.writeFileSync(probe, "ok");
  fs.rmSync(probe);
  ok(env.TTS_CACHE_DIR);
} catch (err) {
  ko(`impossible d'écrire dans ${env.TTS_CACHE_DIR} : ${err.message}`);
}

console.log("");
if (problems === 0) {
  console.log("Tout est prêt.");
} else {
  console.log(`${problems} point(s) à corriger ci-dessus, puis relance : node scripts/tts-setup.mjs`);
}
if (missing.length > 0) {
  console.log("Réglages ajoutés : redémarre l'app pour qu'elle les lise → pm2 reload appelresto --update-env");
}
process.exit(problems === 0 ? 0 : 1);
