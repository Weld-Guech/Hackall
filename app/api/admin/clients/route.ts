import { NextRequest, NextResponse } from "next/server";
import { getAdminSession } from "@/lib/authServer";
import { createClient, listClients } from "@/lib/clients";

export async function GET() {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  return NextResponse.json(listClients());
}

export async function POST(req: NextRequest) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const login = typeof body?.login === "string" ? body.login.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const restaurantName = typeof body?.restaurantName === "string" ? body.restaurantName.trim() : "";
  const voiceId = typeof body?.voiceId === "string" ? body.voiceId.trim() : "";

  if (!login || !password || !restaurantName) {
    return NextResponse.json(
      { error: "Identifiant, mot de passe et nom du restaurant requis" },
      { status: 400 }
    );
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Le mot de passe doit faire au moins 6 caractères" },
      { status: 400 }
    );
  }

  try {
    const client = createClient({ login, password, restaurantName, voiceId });
    return NextResponse.json(client, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erreur inconnue" },
      { status: 409 }
    );
  }
}
