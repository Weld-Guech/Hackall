import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/authServer";
import { deleteClient, setClientActive, setClientPassword, updateClient } from "@/lib/clients";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const body = await req.json().catch(() => null);

  if (typeof body?.password === "string" && body.password) {
    if (body.password.length < 6) {
      return NextResponse.json(
        { error: "Le mot de passe doit faire au moins 6 caractères" },
        { status: 400 }
      );
    }
    const ok = setClientPassword(id, body.password);
    if (!ok) return NextResponse.json({ error: "Client introuvable" }, { status: 404 });
  }

  if (typeof body?.active === "boolean") {
    const ok = setClientActive(id, body.active);
    if (!ok) return NextResponse.json({ error: "Client introuvable" }, { status: 404 });
  }

  const restaurantName = typeof body?.restaurantName === "string" ? body.restaurantName : undefined;
  const voiceId = typeof body?.voiceId === "string" ? body.voiceId : undefined;

  const updated = updateClient(id, { restaurantName, voiceId });
  if (!updated) return NextResponse.json({ error: "Client introuvable" }, { status: 404 });

  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const { id } = await params;
  const ok = deleteClient(id);
  if (!ok) return NextResponse.json({ error: "Client introuvable" }, { status: 404 });

  return NextResponse.json({ ok: true });
}
