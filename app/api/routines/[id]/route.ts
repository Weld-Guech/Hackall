import { NextRequest, NextResponse } from "next/server";
import { getClientSession } from "@/lib/authServer";
import { deleteRoutine, getClientById, updateRoutine } from "@/lib/clients";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label : undefined;
  const text = typeof body?.text === "string" ? body.text : undefined;

  const updated = updateRoutine(session.clientId, id, { label, text });
  if (!updated) return NextResponse.json({ error: "Routine introuvable" }, { status: 404 });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  const { id } = await params;
  const ok = deleteRoutine(session.clientId, id);
  if (!ok) return NextResponse.json({ error: "Routine introuvable" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
