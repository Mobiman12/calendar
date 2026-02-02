import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getIdempotencyRecord, setIdempotencyRecord } from "./idempotency";

class MockRedis {
  private store = new Map<string, string>();
  status = "ready";

  async connect() {
    this.status = "ready";
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._args: Array<string | number>) {
    this.store.set(key, value);
  }
}

const redisRef: { current: MockRedis | null } = { current: null };

vi.mock("./redis", () => ({
  getRedisClient: () => redisRef.current,
}));

describe("idempotency helpers", () => {
  beforeEach(() => {
    redisRef.current = new MockRedis();
  });

  afterEach(() => {
    redisRef.current = null;
  });

  it("stores and retrieves records", async () => {
    const key = "checkout-123";
    const record = {
      status: "completed" as const,
      response: { ok: true },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await setIdempotencyRecord(key, record);
    const stored = await getIdempotencyRecord<typeof record.response>(key);
    expect(stored).toMatchObject(record);
  });

  it("returns null when redis client is unavailable", async () => {
    redisRef.current = null;
    const record = await getIdempotencyRecord("missing");
    expect(record).toBeNull();
  });
});
