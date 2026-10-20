// Génération et cache disque des segments audio (côté serveur uniquement).
//
// Le cache est partagé entre tous les restaurants : la clé ne dépend que de
// ce qui change réellement le son (voix, modèle, réglages, contexte
// d'intonation, texte prononcé). Deux restaurants avec la même voix ne
// paient donc qu'une fois "La commande", "Rayane" ou "cent vingt-cinq".
//
// Arborescence de TTS_CACHE_DIR :
//   final/ab/<clé>.mp3        voix ElevenLabs, servie en "immutable"
//   provisoire/<clé>.mp3      secours Piper, à régénérer plus tard
//   provisoire/<clé>.json     ce qu'il faut pour régénérer (segment, voix)
//   final/index.jsonl         segments générés (pour le téléchargement hors-ligne)
//   piper/ab/<clé>.mp3        phrases complètes lues par Piper (secours)
//   logs/nouveaux-prenoms.jsonl
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { resolveSegment, type ResolvedSegment, type TtsCtx } from "./text.ts";

export const TTS_CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(process.cwd(), "tts-cache");

const MODEL_ID = process.env.TTS_MODEL_ID || "eleven_multilingual_v2";
const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };
const OUTPUT_FORMAT = "mp3_44100_128";
// À incrémenter si le post-traitement (filtre ffmpeg...) change : régénère
// tout le cache disque, donc à manier avec précaution (crédits).
const AUDIO_PROCESSING_VERSION = "1";

// Au-delà, l'annonce part avec Piper ; l'appel ElevenLabs continue en
// arrière-plan et remplacera le fichier provisoire s'il aboutit.
const INTERACTIVE_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS) || 2000;
const GENERATION_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];
// Quota épuisé : inutile de faire attendre 2 s chaque annonce, on passe
// directement par Piper pendant ce délai.
const QUOTA_BREAKER_MS = 10 * 60 * 1000;

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const PIPER_BIN = process.env.PIPER_BIN || "/home/ubuntu/piper/piper";
const PIPER_MODEL =
  process.env.PIPER_MODEL || "/home/ubuntu/piper-voices/fr_FR-siwis-medium.onnx";

// Coupe le silence de début puis, via areverse, celui de fin, en gardant
// 20 ms de marge pour ne pas manger l'attaque des consonnes.
const TRIM_FILTER = [
  "silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:start_silence=0.02",
  "areverse",
  "silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:start_silence=0.02",
  "areverse",
].join(",");

export type TtsSource = "cache" | "cache-provisoire" | "elevenlabs" | "piper";
export type TtsResult = { audio: Buffer; final: boolean; source: TtsSource };

export class TtsError extends Error {
  status: number;
  code: "quota" | "upstream" | "config" | "piper" | "absent";
  constructor(message: string, status: number, code: TtsError["code"]) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function logTts(fields: Record<string, unknown>) {
  console.log(`[tts] ${JSON.stringify(fields)}`);
}

function sha256(parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("␞")).digest("hex");
}

function segmentKey(voiceId: string, r: ResolvedSegment): string {
  return sha256([
    AUDIO_PROCESSING_VERSION,
    voiceId,
    MODEL_ID,
    JSON.stringify(VOICE_SETTINGS),
    OUTPUT_FORMAT,
    r.previous ?? "",
    r.next ?? "",
    r.spoken,
  ]);
}

function segmentPaths(key: string) {
  return {
    final: path.join(TTS_CACHE_DIR, "final", key.slice(0, 2), `${key}.mp3`),
    provisoire: path.join(TTS_CACHE_DIR, "provisoire", `${key}.mp3`),
    meta: path.join(TTS_CACHE_DIR, "provisoire", `${key}.json`),
  };
}

export const PROVISOIRE_DIR = path.join(TTS_CACHE_DIR, "provisoire");

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

// Fichier temporaire puis rename : un lecteur ne voit jamais un MP3 à
// moitié écrit, même si le process est tué en pleine écriture.
async function writeAtomic(file: string, data: Buffer | string) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

function run(
  cmd: string,
  args: string[],
  input: Buffer,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-500);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(cmd)} a échoué (code ${code}) : ${err.trim()}`));
    });
    child.stdin.on("error", () => {}); // process mort avant la fin de l'écriture
    child.stdin.end(input);
  });
}

// Coupe les silences et normalise en MP3 mono. Pour un MP3 ElevenLabs, si
// ffmpeg est absent ou plante, on garde le fichier brut plutôt que de perdre
// une génération payée.
async function trimToMp3(input: Buffer, { required }: { required: boolean }): Promise<Buffer> {
  try {
    const out = await run(
      FFMPEG_BIN,
      [
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-af", TRIM_FILTER,
        "-ac", "1", "-ar", "44100",
        "-c:a", "libmp3lame", "-b:a", "128k",
        "-f", "mp3", "pipe:1",
      ],
      input,
      { timeoutMs: 15_000 }
    );
    if (out.length === 0) throw new Error("ffmpeg n'a rien produit");
    return out;
  } catch (err) {
    if (required) throw err;
    logTts({ evt: "ffmpeg_error", message: String(err) });
    return input;
  }
}

// --- ElevenLabs -----------------------------------------------------------

let quotaBreakerUntil = 0;

export function isQuotaBreakerOpen() {
  return Date.now() < quotaBreakerUntil;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callElevenLabs(voiceId: string, r: ResolvedSegment, signal: AbortSignal): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new TtsError("ELEVENLABS_API_KEY manquant", 500, "config");

  const body: Record<string, unknown> = {
    text: r.spoken,
    model_id: MODEL_ID,
    voice_settings: VOICE_SETTINGS,
  };
  if (r.previous) body.previous_text = r.previous;
  if (r.next) body.next_text = r.next;
  // Seuls les modèles v2.5 (Flash/Turbo) acceptent language_code ; les
  // autres renvoient une erreur s'il est présent.
  if (/_v2_5$/.test(MODEL_ID)) body.language_code = "fr";

  let last: TtsError | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify(body),
        signal,
      }
    );
    if (res.ok) {
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) throw new TtsError("Réponse audio vide", 502, "upstream");
      return audio;
    }
    const message = (await res.text().catch(() => "")).slice(0, 300);
    const quota =
      res.status === 402 || /quota_exceeded|insufficient|credits/i.test(message);
    if (quota) {
      quotaBreakerUntil = Date.now() + QUOTA_BREAKER_MS;
      throw new TtsError(`Quota ElevenLabs épuisé : ${message}`, 503, "quota");
    }
    last = new TtsError(`ElevenLabs ${res.status} : ${message}`, 502, "upstream");
    if (!RETRYABLE_STATUSES.has(res.status) || attempt === RETRY_DELAYS_MS.length) break;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw last ?? new TtsError("Erreur ElevenLabs inconnue", 502, "upstream");
}

// Une seule génération ElevenLabs par clé à la fois (PM2 tourne en mode
// fork, un seul process : une Map en mémoire suffit). Les requêtes
// concurrentes sur le même segment attendent la même promesse.
const elevenInFlight = new Map<string, Promise<Buffer>>();

function generateFinal(key: string, voiceId: string, r: ResolvedSegment): Promise<Buffer> {
  const existing = elevenInFlight.get(key);
  if (existing) return existing;

  const paths = segmentPaths(key);
  const t0 = Date.now();
  const job = (async () => {
    const raw = await callElevenLabs(voiceId, r, AbortSignal.timeout(GENERATION_TIMEOUT_MS));
    const audio = await trimToMp3(raw, { required: false });
    await writeAtomic(paths.final, audio);
    // La vraie voix remplace le secours Piper éventuel.
    await fsp.rm(paths.provisoire, { force: true });
    await fsp.rm(paths.meta, { force: true });
    await appendToIndex(r, voiceId);
    logTts({ evt: "generated", key: key.slice(0, 10), kind: r.kind, ms: Date.now() - t0, bytes: audio.length });
    return audio;
  })();

  elevenInFlight.set(key, job);
  job
    .catch((err) => logTts({ evt: "eleven_error", key: key.slice(0, 10), message: String(err).slice(0, 300) }))
    .finally(() => elevenInFlight.delete(key));
  return job;
}

// --- Index des segments générés ----------------------------------------------
// Une ligne par segment ElevenLabs enregistré, pour que le téléchargement
// hors-ligne retrouve aussi les prénoms appris en service ou passés au script
// avec --prenoms (le nom d'un fichier n'est qu'un hash, illisible). Les
// textes libres n'y figurent pas : ils sont propres à chaque restaurant.

const INDEX_FILE = path.join(TTS_CACHE_DIR, "final", "index.jsonl");

type IndexEntry = { seg: string; ctx: TtsCtx; voiceId: string };

async function appendToIndex(r: ResolvedSegment, voiceId: string) {
  if (r.ctx === "libre") return;
  const entry: IndexEntry = { seg: r.input, ctx: r.ctx, voiceId };
  try {
    await fsp.mkdir(path.dirname(INDEX_FILE), { recursive: true });
    await fsp.appendFile(INDEX_FILE, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    logTts({ evt: "index_error", message: String(err) });
  }
}

let indexCache: { mtimeMs: number; size: number; entries: IndexEntry[] } | null = null;

async function readIndex(): Promise<IndexEntry[]> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(INDEX_FILE);
  } catch {
    return [];
  }
  if (indexCache && indexCache.mtimeMs === stat.mtimeMs && indexCache.size === stat.size) {
    return indexCache.entries;
  }
  const entries: IndexEntry[] = [];
  for (const line of (await fsp.readFile(INDEX_FILE, "utf8")).split("\n")) {
    try {
      if (line) entries.push(JSON.parse(line));
    } catch {
      // ligne tronquée (arrêt brutal pendant l'écriture) : ignorée
    }
  }
  indexCache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
  return entries;
}

// Segments disponibles en version définitive pour une voix : les candidats
// fournis (numéros, prénoms connus, routines du restaurant) plus tout ce qui
// a été généré pour cette voix. Seuls les fichiers réellement présents sont
// renvoyés : le téléchargement hors-ligne ne déclenche jamais de génération.
export async function listCachedSegments(
  voiceId: string,
  candidates: { seg: string; ctx: TtsCtx }[]
): Promise<{ seg: string; ctx: TtsCtx }[]> {
  const indexed = (await readIndex()).filter((e) => e.voiceId === voiceId);
  const seen = new Set<string>();
  const out: { seg: string; ctx: TtsCtx }[] = [];
  for (const c of [...candidates, ...indexed]) {
    const r = resolveSegment(c.seg, c.ctx);
    if (!r.ok) continue;
    const id = `${r.ctx}|${r.input}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (hasFinalSegment(r, voiceId)) out.push({ seg: r.input, ctx: r.ctx });
  }
  return out;
}

// --- Piper (secours local) --------------------------------------------------

const piperInFlight = new Map<string, Promise<Buffer>>();

function synthPiper(text: string): Promise<Buffer> {
  const existing = piperInFlight.get(text);
  if (existing) return existing;

  const job = (async () => {
    const wavPath = path.join(os.tmpdir(), `hackall-piper-${crypto.randomBytes(6).toString("hex")}.wav`);
    const piperDir = path.dirname(PIPER_BIN);
    try {
      await run(PIPER_BIN, ["--model", PIPER_MODEL, "--output_file", wavPath], Buffer.from(`${text}\n`), {
        cwd: piperDir,
        env: {
          ...process.env,
          LD_LIBRARY_PATH: [piperDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
        },
        timeoutMs: 20_000,
      });
      const wav = await fsp.readFile(wavPath);
      return await trimToMp3(wav, { required: true });
    } catch (err) {
      throw new TtsError(`Piper indisponible : ${String(err).slice(0, 300)}`, 503, "piper");
    } finally {
      await fsp.rm(wavPath, { force: true });
    }
  })();

  piperInFlight.set(text, job);
  job.catch(() => {}).finally(() => piperInFlight.delete(text));
  return job;
}

// --- Journal des nouveaux prénoms ------------------------------------------

const NEW_NAMES_LOG = path.join(TTS_CACHE_DIR, "logs", "nouveaux-prenoms.jsonl");
const loggedNames = new Set<string>();

async function logNewName(r: ResolvedSegment, client: string) {
  if (loggedNames.has(r.input)) return;
  loggedNames.add(r.input);
  const line = JSON.stringify({
    date: new Date().toISOString(),
    prenom: r.input,
    prononce: r.spoken,
    corrige: r.spoken !== r.input,
    client,
  });
  try {
    await fsp.mkdir(path.dirname(NEW_NAMES_LOG), { recursive: true });
    await fsp.appendFile(NEW_NAMES_LOG, `${line}\n`);
  } catch (err) {
    logTts({ evt: "log_error", message: String(err) });
  }
}

// --- Points d'entrée ---------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// Pour l'estimation du script de pré-génération (--essai) : le segment
// est-il déjà en cache définitif ? Ne génère rien.
export function hasFinalSegment(r: ResolvedSegment, voiceId: string): boolean {
  return fs.existsSync(segmentPaths(segmentKey(voiceId, r)).final);
}

export async function getSegmentAudio(
  r: ResolvedSegment,
  opts: { voiceId: string; batch: boolean; client: string; cacheOnly?: boolean }
): Promise<TtsResult> {
  const key = segmentKey(opts.voiceId, r);
  const paths = segmentPaths(key);

  const cached = await readIfExists(paths.final);
  if (cached) {
    // Script de régénération : un provisoire peut subsister si la vraie voix
    // est arrivée par un autre chemin ; on fait le ménage.
    if (opts.batch) {
      await fsp.rm(paths.provisoire, { force: true });
      await fsp.rm(paths.meta, { force: true });
    }
    return { audio: cached, final: true, source: "cache" };
  }

  // Téléchargement hors-ligne des tablettes : jamais de génération.
  if (opts.cacheOnly) throw new TtsError("Segment pas encore généré", 404, "absent");

  // Scripts de pré-génération / régénération : on veut la vraie voix ou une
  // erreur explicite (le script réessaiera), jamais un secours Piper.
  if (opts.batch) {
    if (isQuotaBreakerOpen()) throw new TtsError("Quota ElevenLabs épuisé", 503, "quota");
    return { audio: await generateFinal(key, opts.voiceId, r), final: true, source: "elevenlabs" };
  }

  const provisoire = await readIfExists(paths.provisoire);
  if (r.kind === "prenom" && !provisoire) void logNewName(r, opts.client);

  if (!isQuotaBreakerOpen()) {
    const job = generateFinal(key, opts.voiceId, r);
    try {
      return { audio: await withTimeout(job, INTERACTIVE_TIMEOUT_MS), final: true, source: "elevenlabs" };
    } catch {
      // Trop lent ou en erreur : secours Piper. En cas de lenteur, `job`
      // continue en arrière-plan et écrira le fichier final s'il aboutit.
    }
  }

  if (provisoire) return { audio: provisoire, final: false, source: "cache-provisoire" };

  const audio = await synthPiper(r.spoken);
  // Si ElevenLabs a fini entre-temps, ne pas recréer un provisoire inutile.
  if (!fs.existsSync(paths.final)) {
    await writeAtomic(paths.provisoire, audio);
    await writeAtomic(
      paths.meta,
      JSON.stringify({ seg: r.input, ctx: r.ctx, voiceId: opts.voiceId, spoken: r.spoken, createdAt: new Date().toISOString() })
    );
  }
  logTts({ evt: "piper_fallback", key: key.slice(0, 10), kind: r.kind });
  return { audio, final: false, source: "piper" };
}

// Phrase complète lue par Piper, quand un segment n'existe qu'en version
// provisoire. Gardée sur disque : Piper est local et gratuit, rien à
// régénérer (dès que les segments ElevenLabs existent, le kiosque ne la
// demande plus).
export async function getPiperSentence(r: ResolvedSegment): Promise<TtsResult> {
  const key = sha256(["piper", AUDIO_PROCESSING_VERSION, path.basename(PIPER_MODEL), r.spoken]);
  const file = path.join(TTS_CACHE_DIR, "piper", key.slice(0, 2), `${key}.mp3`);
  const cached = await readIfExists(file);
  if (cached) return { audio: cached, final: false, source: "cache-provisoire" };
  const audio = await synthPiper(r.spoken);
  await writeAtomic(file, audio);
  return { audio, final: false, source: "piper" };
}
