import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getClientSession } from "@/lib/authServer";
import { getClientById } from "@/lib/clients";

// Dossier de cache local, isolé par client (chaque restaurant a sa propre
// voix, donc le même texte/numéro doit produire un fichier audio différent).
// En prod, préfère un stockage persistant (S3, Vercel Blob...) car le
// filesystem d'une fonction serverless n'est pas garanti de survivre entre
// deux invocations.
const CACHE_ROOT = path.join(process.cwd(), "audio-cache");

function normalizeKey(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // enlève les accents
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 80);
}

// Erreurs transitoires côté ElevenLabs (quota concurrent dépassé, souci
// ponctuel serveur) : on retente plutôt que de renvoyer tout de suite une
// erreur. C'est ce qui fait échouer un appel légitime quand plusieurs
// commandes sont appelées coup sur coup ("fréquence trop rapprochée").
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [400, 1000];
// Délai max pour obtenir les en-têtes de réponse d'ElevenLabs.
const ELEVENLABS_TIMEOUT_MS = 15000;
// Garde-fou contre les générations incontrôlées (crédits ElevenLabs).
const MAX_TEXT_LENGTH = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ElevenLabsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Identifiant court et non réversible pour les logs : on ne journalise jamais
// le texte annoncé (prénoms = données personnelles) ni la clé API.
function logId(key: string) {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 8);
}

function logTts(fields: Record<string, unknown>) {
  console.log(`[tts] ${JSON.stringify(fields)}`);
}

// Ouvre un flux ElevenLabs (endpoint /stream : les octets MP3 arrivent au fur
// et à mesure de la génération au lieu d'attendre le fichier complet). Les
// nouvelles tentatives ne sont possibles qu'avant le premier octet : une fois
// le flux commencé, on ne peut plus rejouer la réponse.
async function openElevenLabsStream(
  voiceId: string,
  apiKey: string,
  text: string
): Promise<ReadableStream<Uint8Array>> {
  let lastMessage = "Erreur inconnue";
  let lastStatus = 500;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        language_code: "fr",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });

    if (response.ok && response.body) {
      return response.body;
    }

    lastMessage = await response.text();
    lastStatus = response.status;

    const canRetry = RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1;
    if (!canRetry) break;
    await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
  }

  throw new ElevenLabsError(lastMessage, lastStatus);
}

type LogMeta = { client: string; key: string };

// Lance une génération en streaming. Le flux ElevenLabs est dupliqué : une
// branche part immédiatement vers le navigateur, l'autre est accumulée puis
// écrite dans le cache disque une fois complète (écriture atomique via un
// fichier temporaire, pour ne jamais servir un MP3 tronqué). Si le navigateur
// se déconnecte en cours de route, la branche cache continue de se remplir.
async function startGeneration(
  voiceId: string,
  apiKey: string,
  text: string,
  filePath: string,
  meta: LogMeta,
  t0: number
): Promise<{ stream: ReadableStream<Uint8Array>; done: Promise<Buffer> }> {
  const upstream = await openElevenLabsStream(voiceId, apiKey, text);
  const [toClient, toCache] = upstream.tee();

  const done = (async () => {
    const reader = toCache.getReader();
    const chunks: Uint8Array[] = [];
    let firstChunkAt: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstChunkAt === null) firstChunkAt = Date.now();
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw new Error("Flux audio vide");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, filePath);
    logTts({
      evt: "generated",
      ...meta,
      first_chunk_ms: firstChunkAt ? firstChunkAt - t0 : null,
      total_ms: Date.now() - t0,
      bytes: buffer.length,
    });
    return buffer;
  })();

  return { stream: toClient, done };
}

// Coalesce les générations concurrentes pour un même fichier (ex : la
// pré-génération pendant la frappe et l'appel réel qui arrivent en même
// temps, ou deux onglets sur le même appareil) : au lieu de déclencher deux
// appels ElevenLabs pour le même prénom, la seconde requête attend le
// résultat de la première.
const inFlightGenerations = new Map<string, Promise<Buffer>>();

export async function POST(req: NextRequest) {
  const session = await getClientSession();
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const client = getClientById(session.clientId);
  if (!client) {
    return NextResponse.json({ error: "Compte introuvable" }, { status: 401 });
  }
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = client.voiceId || process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return NextResponse.json(
      { error: "ELEVENLABS_API_KEY ou ELEVENLABS_VOICE_ID manquant côté serveur (.env.local)" },
      { status: 500 }
    );
  }

  const { text, cacheKey } = await req.json();

  if (!text || typeof text !== "string") {
    return NextResponse.json({ error: "Paramètre 'text' requis" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: "Texte trop long" }, { status: 400 });
  }

  const key = normalizeKey(cacheKey ?? text);
  const cacheDir = path.join(CACHE_ROOT, client.id);
  const filePath = path.join(cacheDir, `${key}.mp3`);
  const publicUrl = `/audio/generated/${client.id}/${key}.mp3`;

  // Deux modes de réponse :
  //   - "Accept: audio/mpeg" (annonce réelle) : on renvoie directement les
  //     octets audio, en streaming si la génération est en cours. Un seul
  //     aller-retour au lieu de POST (URL) puis GET (fichier).
  //   - JSON (pré-génération pendant la frappe) : on renvoie seulement l'URL.
  const wantsAudio = (req.headers.get("accept") ?? "").includes("audio/mpeg");
  const mode = wantsAudio ? "audio" : "json";
  const t0 = Date.now();
  const meta: LogMeta = { client: client.id, key: logId(key) };
  const audioHeaders = (cache: string) => ({
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
    "X-Audio-Url": publicUrl,
    "X-Cache": cache,
  });

  // 1. Cache hit : zéro appel API, zéro crédit consommé
  if (fs.existsSync(filePath)) {
    logTts({ evt: "hit", ...meta, mode });
    if (!wantsAudio) return NextResponse.json({ url: publicUrl, cached: true });
    return new NextResponse(new Uint8Array(fs.readFileSync(filePath)), {
      headers: audioHeaders("hit"),
    });
  }

  try {
    // 2. Génération déjà en cours pour ce fichier : on attend son résultat au
    // lieu de payer un second appel ElevenLabs.
    const inFlight = inFlightGenerations.get(filePath);
    if (inFlight) {
      const buffer = await inFlight;
      logTts({ evt: "coalesced", ...meta, mode, total_ms: Date.now() - t0 });
      if (!wantsAudio) return NextResponse.json({ url: publicUrl, cached: false });
      return new NextResponse(new Uint8Array(buffer), { headers: audioHeaders("coalesced") });
    }

    // 3. Cache miss : génération ElevenLabs en streaming (modèle Flash).
    logTts({ evt: "miss", ...meta, mode });
    const generation = startGeneration(voiceId, apiKey, text, filePath, meta, t0);
    const done = generation.then((g) => g.done);
    inFlightGenerations.set(filePath, done);
    done
      .catch((err) => logTts({ evt: "error", ...meta, stage: "stream", message: String(err) }))
      .finally(() => inFlightGenerations.delete(filePath));

    const { stream } = await generation;
    logTts({ evt: "upstream_open", ...meta, mode, ttfb_ms: Date.now() - t0 });

    if (!wantsAudio) {
      // La pré-génération n'a pas besoin des octets : on abandonne la branche
      // client (la branche cache continue) et on attend l'écriture du fichier.
      stream.cancel().catch(() => {});
      await done;
      return NextResponse.json({ url: publicUrl, cached: false });
    }
    return new NextResponse(stream, { headers: audioHeaders("miss") });
  } catch (err) {
    const status = err instanceof ElevenLabsError ? err.status : 500;
    const message =
      err instanceof ElevenLabsError
        ? `Erreur ElevenLabs: ${err.message}`
        : `Échec de génération audio: ${String(err)}`;
    logTts({ evt: "error", ...meta, stage: "open", status });
    return NextResponse.json({ error: message }, { status });
  }
}
