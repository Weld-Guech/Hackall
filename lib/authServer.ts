import { cookies } from "next/headers";
import { ADMIN_COOKIE, CLIENT_COOKIE, verifySessionToken } from "./session";

export async function getClientSession() {
  const store = await cookies();
  const session = await verifySessionToken(store.get(CLIENT_COOKIE)?.value);
  return session && session.role === "client" ? session : null;
}

export async function getAdminSession() {
  const store = await cookies();
  const session = await verifySessionToken(store.get(ADMIN_COOKIE)?.value);
  return session && session.role === "admin" ? session : null;
}
