import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/password";
import { ADMIN_COOKIE, SESSION_MAX_AGE, createSessionToken } from "@/lib/session";

export async function POST(req: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json(
      { error: "ADMIN_PASSWORD manquant côté serveur (.env.local)" },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!password || !timingSafeEqualStr(password, adminPassword)) {
    return NextResponse.json({ error: "Mot de passe incorrect" }, { status: 401 });
  }

  const token = await createSessionToken({ role: "admin" }, SESSION_MAX_AGE);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
