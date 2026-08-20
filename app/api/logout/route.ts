import { NextResponse } from "next/server";
import { CLIENT_COOKIE } from "@/lib/session";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(CLIENT_COOKIE);
  return res;
}
