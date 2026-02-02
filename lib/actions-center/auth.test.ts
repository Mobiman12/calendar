import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { Prisma } from "@prisma/client";

import { verifyActionsCenterRequest } from "./auth";

type NonceRecord = {
  nonce: string;
  expiresAt: Date;
};

function createMockPrisma() {
  const nonces = new Map<string, NonceRecord>();

  function uniqueError(target: string[]) {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.18.0",
      meta: { target },
    });
  }

  return {
    __reset: () => nonces.clear(),
    $transaction: async (fn: any) => fn({
      actionCenterNonce: {
        deleteMany: async ({ where }: any) => {
          if (!where?.expiresAt?.lt) return { count: 0 };
          const cutoff = new Date(where.expiresAt.lt).getTime();
          for (const [key, record] of nonces) {
            if (record.expiresAt.getTime() < cutoff) {
              nonces.delete(key);
            }
          }
          return { count: 0 };
        },
        create: async ({ data }: any) => {
          if (nonces.has(data.nonce)) {
            throw uniqueError(["nonce"]);
          }
          nonces.set(data.nonce, { nonce: data.nonce, expiresAt: data.expiresAt });
          return data;
        },
      },
    }),
  };
}

const prismaRef: { current: ReturnType<typeof createMockPrisma> } = { current: createMockPrisma() };

vi.mock("@/lib/prisma", () => ({
  getPrismaClient: () => prismaRef.current,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => null,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true, remaining: null }),
}));

const SECRET = "test-secret";

function sign(timestamp: string, nonce: string, body: string) {
  return createHmac("sha256", SECRET).update(`${timestamp}.${nonce}.${body}`).digest("hex");
}

beforeEach(() => {
  prismaRef.current.__reset();
  process.env.ACTIONS_CENTER_SHARED_SECRET = SECRET;
});

function buildRequest(params: { timestamp: string; nonce: string; body: string }) {
  const signature = sign(params.timestamp, params.nonce, params.body);
  return new Request("http://localhost/api/google/actions-center/v1/merchants", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ac-timestamp": params.timestamp,
      "x-ac-nonce": params.nonce,
      "x-ac-signature": signature,
    },
    body: params.body,
  });
}

describe("verifyActionsCenterRequest", () => {
  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ ping: true });
    const req = buildRequest({ timestamp: String(Date.now()), nonce: "nonce-1", body });
    const result = await verifyActionsCenterRequest(req);
    expect(result.ok).toBe(true);
  });

  it("rejects requests with timestamp drift", async () => {
    const body = JSON.stringify({ ping: true });
    const stale = String(Date.now() - 10 * 60 * 1000);
    const req = buildRequest({ timestamp: stale, nonce: "nonce-2", body });
    const result = await verifyActionsCenterRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  it("rejects nonce replays", async () => {
    const body = JSON.stringify({ ping: true });
    const timestamp = String(Date.now());
    const first = await verifyActionsCenterRequest(buildRequest({ timestamp, nonce: "nonce-3", body }));
    expect(first.ok).toBe(true);

    const second = await verifyActionsCenterRequest(buildRequest({ timestamp, nonce: "nonce-3", body }));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.response.status).toBe(401);
    }
  });
});
