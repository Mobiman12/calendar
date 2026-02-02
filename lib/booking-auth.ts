import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

const TOKEN_VERSION = "v1";
const DEFAULT_SECRET = "calendar-booking-pin";
const secret =
  process.env.BOOKING_PIN_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  process.env.AUTH_SECRET ??
  DEFAULT_SECRET;

function createSignature(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createBookingPinToken(staffId: string, ttlMs = 15 * 60 * 1000) {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${TOKEN_VERSION}:${staffId}:${expiresAt}`;
  const signature = createSignature(payload);
  return {
    token: `${payload}:${signature}`,
    expiresAt,
  };
}

export function verifyBookingPinToken(token: string, staffId: string): boolean {
  if (typeof token !== "string" || !token.length) return false;
  const parts = token.split(":");
  if (parts.length !== 4) return false;
  const [version, tokenStaffId, expiresAtRaw, signature] = parts;
  if (version !== TOKEN_VERSION) return false;
  if (tokenStaffId !== staffId) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;

  const expectedSignature = createSignature(`${version}:${tokenStaffId}:${expiresAtRaw}`);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  try {
    return timingSafeEqual(signatureBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

export function secureComparePin(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const normalizedA = a.trim();
  const normalizedB = b.trim();
  if (!normalizedA.length || !normalizedB.length) {
    return false;
  }
  const bufferA = Buffer.from(normalizedA);
  const bufferB = Buffer.from(normalizedB);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  try {
    return timingSafeEqual(bufferA, bufferB);
  } catch {
    return false;
  }
}
