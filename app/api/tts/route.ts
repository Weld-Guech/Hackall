import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getClientSession } from "@/lib/authServer";
import { getClientById } from "@/lib/clients";
import { resolveSegment } from "@/lib/tts/text";
import {
  TtsError,
  getPiperSentence,
  getSegmentAudio,
  hasFinalSegment,
  logTts,
  type TtsResult,
} from "@/lib/tts/server";
import { legacyPost } from "@/lib/tts/legacyPost";

// GET /api/tts?seg=<segment>&ctx=fixe|id|libre&v=<version>[&engine=piper]
//
// Renvoie le MP3 d'un segment d'annonce. Le paramètre v ne sert qu'à
// changer l'URL (cache "immutable" du navigateur et du service worker)
// quand les corrections phonétiques ou la voix changent ; le serveur
// l'ignore.
//
// Les scripts de pré-génération passent l'en-tête x-tts-token (comparé à
// TTS_INTERNAL_TOKEN) au lieu d'une session, avec batch=1 et éventuellement
// voice=<id> ; dry=1 indique seulement si le segment est déjà en cache.

function isInternal(req: NextRequest): boolean {
  const expected = process.env.TTS_INTERNAL_TOKEN ?? "";
  const given = req.headers.get("x-tts-token") ?? "";
  if (expected.length < 16 || !given) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function errorResponse(message: string, status: number, code?: string) {
  return NextResponse.json({ error: message, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const internal = isInternal(req);

  let voiceId: string | undefined;
  let clientTag: string;
  if (internal) {
    voiceId = params.get("voice") || process.env.ELEVENLABS_VOICE_ID;
    clientTag = "script";
  } else {
    const session = await getClientSession();
    if (!session) return errorResponse("Non authentifié", 401);
    const client = getClientById(session.clientId);
    if (!client) return errorResponse("Compte introuvable", 401);
    if (!client.active) return errorResponse("Ce compte a été désactivé.", 403);
    voiceId = client.voiceId || process.env.ELEVENLABS_VOICE_ID;
    clientTag = client.id;
  }
  if (!voiceId) return errorResponse("ELEVENLABS_VOICE_ID manquant côté serveur (.env.local)", 500, "config");

  const resolved = resolveSegment(params.get("seg") ?? "", params.get("ctx") ?? "");
  if (!resolved.ok) return errorResponse(resolved.error, 400);

  if (internal && params.get("dry") === "1") {
    return NextResponse.json(
      { cached: hasFinalSegment(resolved, voiceId), chars: resolved.spoken.length },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const engine = params.get("engine");
  if (engine && (engine !== "piper" || resolved.ctx !== "libre")) {
    return errorResponse("Moteur inconnu", 400);
  }

  const t0 = Date.now();
  let result: TtsResult;
  try {
    result =
      engine === "piper"
        ? await getPiperSentence(resolved)
        : await getSegmentAudio(resolved, {
            voiceId,
            batch: internal && params.get("batch") === "1",
            client: clientTag,
            // En-tête et non paramètre : l'URL doit rester identique à celle
            // du kiosque, c'est la clé du cache de la tablette.
            cacheOnly: req.headers.get("x-tts-cache-only") === "1",
          });
  } catch (err) {
    if (err instanceof TtsError) {
      if (err.code === "absent") return errorResponse(err.message, 404, err.code);
      logTts({ evt: "error", code: err.code, kind: resolved.kind, message: err.message.slice(0, 200) });
      return errorResponse(err.message, err.status, err.code);
    }
    logTts({ evt: "error", kind: resolved.kind, message: String(err).slice(0, 200) });
    return errorResponse("Échec de génération audio", 500);
  }

  if (result.source !== "cache") {
    logTts({ evt: "served", source: result.source, kind: resolved.kind, ms: Date.now() - t0 });
  }

  return new NextResponse(new Uint8Array(result.audio), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(result.audio.length),
      // Un fichier provisoire (Piper) ne doit surtout pas rester en cache :
      // la même URL servira la voix ElevenLabs une fois régénérée.
      "Cache-Control": result.final ? "public, max-age=31536000, immutable" : "no-store",
      "X-TTS-Final": result.final ? "1" : "0",
      "X-TTS-Source": result.source,
    },
  });
}

export async function POST(req: NextRequest) {
  return legacyPost(req);
}
