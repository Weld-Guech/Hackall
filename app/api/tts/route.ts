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

  // 2. Cache miss : on génère via ElevenLabs (modèle Flash, faible latence)
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
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
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `Erreur ElevenLabs: ${errText}` },
        { status: response.status }
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

    return NextResponse.json({ url: publicUrl, cached: false });
  } catch (err) {
    return NextResponse.json(
      { error: "Échec de génération audio", details: String(err) },
      { status: 500 }
    );
  }
}
