import { NextRequest, NextResponse } from "next/server";
import { verifyLogin } from "@/lib/clients";
import { CLIENT_COOKIE, SESSION_MAX_AGE, createSessionToken } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const login = typeof body?.login === "string" ? body.login : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!login || !password) {
    return NextResponse.json({ error: "Identifiant et mot de passe requis" }, { status: 400 });
  }

  const client = verifyLogin(login, password);
  if (!client) {
    return NextResponse.json({ error: "Identifiant ou mot de passe incorrect" }, { status: 401 });
  }
  if (!client.active) {
    return NextResponse.json(
      { error: "Ce compte a été désactivé. Contacte ton agence." },
      { status: 403 }
    );
  }

  const token = await createSessionToken({ role: "client", clientId: client.id }, SESSION_MAX_AGE);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(CLIENT_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
