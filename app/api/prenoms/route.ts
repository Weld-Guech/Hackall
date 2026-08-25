import { NextRequest, NextResponse } from "next/server";
import { getClientSession } from "@/lib/authServer";
import { addCustomName, getClientById } from "@/lib/clients";

// Appelée silencieusement par le kiosque après une annonce par prénom :
// enregistre ce prénom pour qu'il soit suggéré la prochaine fois, s'il
// n'est pas déjà connu (liste arabe fournie ou prénoms déjà appris).
export async function POST(req: NextRequest) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const prenom = typeof body?.prenom === "string" ? body.prenom : "";
  if (!prenom.trim()) {
    return NextResponse.json({ error: "Paramètre 'prenom' requis" }, { status: 400 });
  }

  const customNames = addCustomName(session.clientId, prenom);
  if (!customNames) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });

  return NextResponse.json({ customNames });
}
