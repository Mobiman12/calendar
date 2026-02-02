import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";

const PBKDF2_ALGO = "sha256";
const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_PREFIX = `pbkdf2$${PBKDF2_ALGO}$`;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function timingSafeEqualString(a: string, b: string) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function parsePbkdf2Hash(stored: string) {
  const parts = stored.split("$");
  if (parts.length !== 5) return null;
  const [, algo, iterationsRaw, salt, hash] = parts;
  const iterations = Number(iterationsRaw);
  if (!algo || !Number.isFinite(iterations) || !salt || !hash) return null;
  return { algo, iterations, salt, hash };
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_ALGO).toString("hex");
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export function isPasswordStrong(password: string) {
  return (
    password.length >= 8 &&
    /[A-Za-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

export function verifyPassword(input: string, stored: string | null) {
  if (!stored) return false;
  if (stored.startsWith(PBKDF2_PREFIX)) {
    const parsed = parsePbkdf2Hash(stored);
    if (!parsed) return false;
    const computed = pbkdf2Sync(input, parsed.salt, parsed.iterations, PBKDF2_KEYLEN, parsed.algo).toString("hex");
    return timingSafeEqualString(computed, parsed.hash);
  }
  const isLegacySha = /^[a-f0-9]{64}$/i.test(stored);
  if (isLegacySha) {
    return timingSafeEqualString(sha256(input), stored);
  }
  const allowPlaintext =
    process.env.ALLOW_PLAINTEXT_PASSWORDS?.toLowerCase() === "true" ||
    process.env.NODE_ENV !== "production";
  if (allowPlaintext) {
    return timingSafeEqualString(input, stored);
  }
  return false;
}

export function needsRehash(stored: string | null) {
  if (!stored) return false;
  return !stored.startsWith(PBKDF2_PREFIX);
}

// Backwards-compatible alias for older callers.
export function safeCompareHash(input: string, stored: string | null) {
  return verifyPassword(input, stored);
}
