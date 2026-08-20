// Jetons de session signés (HMAC-SHA256 via Web Crypto), volontairement sans
// dépendance à l'API Node `crypto` : ce module est importé à la fois par les
// routes API (runtime Node) et par middleware.ts (runtime Edge par défaut),
// et seule l'API Web Crypto (crypto.subtle) est disponible dans les deux.

const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";

export const CLIENT_COOKIE = "appelresto_session";
export const ADMIN_COOKIE = "appelresto_admin_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours

export type SessionPayload =
  | { role: "admin"; exp: number }
  | { role: "client"; clientId: string; exp: number };

function base64url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(str.length + ((4 - (str.length % 4)) % 4), "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function createSessionToken(
  payload: { role: "admin" } | { role: "client"; clientId: string },
  maxAgeSeconds: number
): Promise<string> {
  const body = JSON.stringify({ ...payload, exp: Date.now() + maxAgeSeconds * 1000 });
  const encoded = base64url(new TextEncoder().encode(body));
  const key = await getKey();
  const signatureBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  const signature = base64url(new Uint8Array(signatureBuf));
  return `${encoded}.${signature}`;
}

export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  try {
    const key = await getKey();
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(signature) as BufferSource,
      new TextEncoder().encode(encoded)
    );
    if (!valid) return null;

    const body = JSON.parse(new TextDecoder().decode(base64urlDecode(encoded)));
    if (typeof body.exp !== "number" || Date.now() > body.exp) return null;
    return body as SessionPayload;
  } catch {
    return null;
  }
}
