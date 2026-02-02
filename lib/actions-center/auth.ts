import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import { getPrismaClient } from "@/lib/prisma";
import { getRedisClient } from "@/lib/redis";
import { enforceRateLimit } from "@/lib/rate-limit";

const MAX_DRIFT_MS = 5 * 60 * 1000;
const NONCE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_GLOBAL = 600;
const RATE_LIMIT_IP = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;

let rateLimitWarned = false;

const logger = getLogger();
const prisma = getPrismaClient();

export type ActionsCenterAuthResult =
  | {
      ok: true;
      requestId: string;
      rawBody: string;
      body: unknown;
      ip: string | null;
    }
  | {
      ok: false;
      requestId: string;
      response: NextResponse;
    };

export function jsonResponse(requestId: string, body: unknown, init?: ResponseInit) {
  const response = NextResponse.json(body, init);
  response.headers.set("x-request-id", requestId);
  return response;
}

function getRequestId(req: Request) {
  return req.headers.get("x-request-id") ?? randomUUID();
}

function getRequestIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip");
}

function hmacSignature(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function isTimingSafeEqualHex(a: string, b: string) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

async function enforceRateLimitIfConfigured(req: Request, requestId: string) {
  const redis = getRedisClient();
  if (!redis) {
    if (!rateLimitWarned) {
      rateLimitWarned = true;
      logger.warn({ requestId }, "[actions-center] rate limit disabled (redis missing)");
    }
    return null;
  }

  const ip = getRequestIp(req) ?? "unknown";
  const [globalLimit, ipLimit] = await Promise.all([
    enforceRateLimit("actions-center:global", RATE_LIMIT_GLOBAL, RATE_LIMIT_WINDOW_SECONDS),
    enforceRateLimit(`actions-center:ip:${ip}`, RATE_LIMIT_IP, RATE_LIMIT_WINDOW_SECONDS),
  ]);

  if (!globalLimit.allowed || !ipLimit.allowed) {
    logger.warn({ requestId }, "[actions-center] rate limit exceeded");
    return jsonResponse(requestId, { error: "rate_limited" }, { status: 429 });
  }

  return null;
}

async function registerNonce(nonce: string) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.actionCenterNonce.deleteMany({ where: { expiresAt: { lt: now } } });
      await tx.actionCenterNonce.create({ data: { nonce, expiresAt } });
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}

export async function verifyActionsCenterRequest(req: Request): Promise<ActionsCenterAuthResult> {
  const requestId = getRequestId(req);
  const secret = process.env.ACTIONS_CENTER_SHARED_SECRET;
  if (!secret) {
    logger.error({ requestId }, "[actions-center] missing ACTIONS_CENTER_SHARED_SECRET");
    return {
      ok: false,
      requestId,
      response: jsonResponse(requestId, { error: "actions_center_not_configured" }, { status: 500 }),
    };
  }

  const rawBody = await req.text();
  const timestampHeader = req.headers.get("x-ac-timestamp");
  const nonce = req.headers.get("x-ac-nonce");
  const signature = req.headers.get("x-ac-signature");

  if (!timestampHeader || !nonce || !signature) {
    logger.warn({ requestId }, "[actions-center] missing auth headers");
    return {
      ok: false,
      requestId,
      response: jsonResponse(requestId, { error: "unauthorized" }, { status: 401 }),
    };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) {
    logger.warn({ requestId }, "[actions-center] invalid timestamp header");
    return {
      ok: false,
      requestId,
      response: jsonResponse(requestId, { error: "unauthorized" }, { status: 401 }),
    };
  }

  const drift = Math.abs(Date.now() - timestamp);
  if (drift > MAX_DRIFT_MS) {
    logger.warn({ requestId }, "[actions-center] timestamp drift exceeded");
    return {
      ok: false,
      requestId,
      response: jsonResponse(requestId, { error: "unauthorized" }, { status: 401 }),
    };
  }

  const expected = hmacSignature(secret, `${timestampHeader}.${nonce}.${rawBody}`);
  if (!isTimingSafeEqualHex(signature, expected)) {
    logger.warn({ requestId }, "[actions-center] invalid signature");
    return {
      ok: false,
      requestId,
      response: jsonResponse(requestId, { error: "unauthorized" }, { status: 401 }),
    };
  }

  const rateLimitResponse = await enforceRateLimitIfConfigured(req, requestId);
  if (rateLimitResponse) {
    return { ok: false, requestId, response: rateLimitResponse };
  }

  try {
    const accepted = await registerNonce(nonce);
    if (!accepted) {
      logger.warn({ requestId }, "[actions-center] nonce replay blocked");
      return {
        ok: false,
        requestId,
        response: jsonResponse(requestId, { error: "unauthorized" }, { status: 401 }),
      };
    }
  } catch (error) {
    logger.error({ requestId, err: error }, "[actions-center] nonce store failed");
    return {
      ok: false,
      requestId,
      response: jsonResponse(requestId, { error: "server_error" }, { status: 500 }),
    };
  }

  let body: unknown = null;
  if (rawBody.trim().length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return {
        ok: false,
        requestId,
        response: jsonResponse(requestId, { error: "invalid_json" }, { status: 400 }),
      };
    }
  }

  logger.info({ requestId, method: req.method, path: new URL(req.url).pathname }, "[actions-center] request");

  return {
    ok: true,
    requestId,
    rawBody,
    body,
    ip: getRequestIp(req),
  };
}
