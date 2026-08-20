import { NextRequest, NextResponse } from "next/server";
import { getClientSession } from "@/lib/authServer";
import { addRoutine, getClientById } from "@/lib/clients";

export async function GET() {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  return NextResponse.json(client.routines);
}

export async function POST(req: NextRequest) {
  const session = await getClientSession();
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const client = getClientById(session.clientId);
  if (!client) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 });
  if (!client.active) {
    return NextResponse.json({ error: "Ce compte a été désactivé." }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const label = typeof body?.label === "string" ? body.label : "";
  const text = typeof body?.text === "string" ? body.text : "";

  const result = addRoutine(session.clientId, { label, text });
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result, { status: 201 });
}
