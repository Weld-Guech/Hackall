import { NextRequest, NextResponse } from "next/server";
import { getClientSession } from "@/lib/authServer";
import { getClientById, updateClient } from "@/lib/clients";

export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  return NextResponse.json({
    id: client.id,
    login: client.login,
    restaurantName: client.restaurantName,
    voiceId: client.voiceId,
    routines: client.routines,
    customNames: client.customNames,
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const existing = getClientById(session.clientId);
  if (!existing) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!existing.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const restaurantName = typeof body?.restaurantName === "string" ? body.restaurantName : undefined;
  const voiceId = typeof body?.voiceId === "string" ? body.voiceId : undefined;

  if (restaurantName !== undefined && !restaurantName.trim()) {
    return NextResponse.json({ error: "Le nom du restaurant ne peut pas être vide" }, { status: 400 });
  }

  const updated = updateClient(session.clientId, { restaurantName, voiceId });
  if (!updated) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });

  return NextResponse.json(updated);
}
