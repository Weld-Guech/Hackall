import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
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
    .replace(/[\u0300-\u036f]/g, "") // enlève les accents
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

async function generateAudio(voiceId: string, apiKey: string, text: string): Promise<Buffer> {
  let lastMessage = "Erreur inconnue";
  let lastStatus = 500;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
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
    });

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    lastMessage = await response.text();
    lastStatus = response.status;

    const canRetry = RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1;
    if (!canRetry) break;
    await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
  }

  throw new ElevenLabsError(lastMessage, lastStatus);
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

  const key = normalizeKey(cacheKey ?? text);
  const cacheDir = path.join(CACHE_ROOT, client.id);
  const filePath = path.join(cacheDir, `${key}.mp3`);
  const publicUrl = `/audio/generated/${client.id}/${key}.mp3`;

  // 1. Cache hit : on renvoie l'URL statique, zéro appel API, zéro crédit consommé
  if (fs.existsSync(filePath)) {
    return NextResponse.json({ url: publicUrl, cached: true });
  }

  // 2. Cache miss : on génère via ElevenLabs (modèle Flash, faible latence),
  // avec retry sur les erreurs transitoires et coalescing des requêtes
  // concurrentes identiques.
  try {
    let generation = inFlightGenerations.get(filePath);
    if (!generation) {
      generation = generateAudio(voiceId, apiKey, text);
      inFlightGenerations.set(filePath, generation);
      generation.finally(() => inFlightGenerations.delete(filePath));
    }

    const audioBuffer = await generation;
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(filePath, audioBuffer);

    return NextResponse.json({ url: publicUrl, cached: false });
  } catch (err) {
    const status = err instanceof ElevenLabsError ? err.status : 500;
    const message =
      err instanceof ElevenLabsError
        ? `Erreur ElevenLabs: ${err.message}`
        : `Échec de génération audio: ${String(err)}`;
    return NextResponse.json({ error: message }, { status });
  }
}
