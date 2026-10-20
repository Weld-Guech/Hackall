import { NextResponse } from "next/server";
import { getClientSession } from "@/lib/authServer";
import { getClientById } from "@/lib/clients";
import { PHONETIC_CORRECTIONS } from "@/lib/phoneticCorrections";
import { PRENOMS_ARABES } from "@/lib/prenomsArabes";
import { FIXED, type TtsCtx } from "@/lib/tts/text";
import { listCachedSegments } from "@/lib/tts/server";

// GET /api/tts/catalogue : segments déjà générés pour la voix du
// restaurant, que la tablette télécharge en arrière-plan pour annoncer
// sans latence et sans réseau. Ne renvoie que des fichiers existants.
export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 401 });
  if (!client.active) return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });

  const voiceId = client.voiceId || process.env.ELEVENLABS_VOICE_ID;
  if (!voiceId) return NextResponse.json({ segments: [] });

  const id = (seg: string) => ({ seg, ctx: "id" as TtsCtx });
  const candidates = [
    ...Object.values(FIXED).map((seg) => ({ seg, ctx: "fixe" as TtsCtx })),
    ...Array.from({ length: 999 }, (_, i) => id(String(i + 1))),
    ...PHONETIC_CORRECTIONS.map((c) => id(c.original)),
    ...PRENOMS_ARABES.map(id),
    ...client.customNames.map(id),
    ...client.routines.map((r) => ({ seg: r.text, ctx: "libre" as TtsCtx })),
  ];

  const segments = await listCachedSegments(voiceId, candidates);
  return NextResponse.json({ segments }, { headers: { "Cache-Control": "no-store" } });
}
