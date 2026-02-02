import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";

export type Session = {
  userId: string;
  tenantId: string;
  role: string;
  exp: number;
};

const COOKIE_NAME = "calendar_session";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

export const SESSION_COOKIE_NAME = COOKIE_NAME;
export const SESSION_TTL_MS = DEFAULT_TTL_MS;
function getSecret() {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET ist nicht gesetzt.");
    }
    return "dev-calendar-secret";
  }
  return secret;
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string) {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function createSessionToken(session: Omit<Session, "exp">, ttlMs = DEFAULT_TTL_MS) {
  const exp = Date.now() + ttlMs;
  const payload = JSON.stringify({ ...session, exp });
  const encoded = base64url(payload);
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string | undefined | null): Session | null {
  if (!token || typeof token !== "string") return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    if (!payload.userId || !payload.tenantId) return null;
    return payload as Session;
  } catch {
    return null;
  }
}

export async function getSessionOrNull(): Promise<Session | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

export async function setSessionCookie(session: Omit<Session, "exp">, ttlMs = DEFAULT_TTL_MS) {
  const cookieStore = await cookies();
  const token = createSessionToken(session, ttlMs);
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
    secure: process.env.NODE_ENV === "production",
  });
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}
