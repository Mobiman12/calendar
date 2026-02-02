import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireLock, extendLock, releaseLock } from "./redis-lock";

class MockRedis {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  status = "ready";

  async connect() {
    this.status = "ready";
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    this.cleanup(key);

    let px: number | undefined;
    let ex: number | undefined;
    let nx = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "PX") {
        px = Number(args[++i]);
      } else if (arg === "EX") {
        ex = Number(args[++i]) * 1_000;
      } else if (arg === "NX") {
        nx = true;
      }
    }

    if (nx && this.store.has(key)) {
      return null;
    }

    const ttl = px ?? ex;
    const expiresAt = ttl ? Date.now() + ttl : undefined;
    this.store.set(key, { value: String(value), expiresAt });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    this.cleanup(key);
    return this.store.get(key)?.value ?? null;
  }

  async del(key: string): Promise<number> {
    this.cleanup(key);
    if (this.store.has(key)) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async eval(script: string, _keys: number, key: string, token: string, ttl?: number): Promise<number> {
    this.cleanup(key);
    const entry = this.store.get(key);
    if (script.includes("del")) {
      if (entry && entry.value === token) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    if (script.includes("pexpire")) {
      if (entry && entry.value === token) {
        const ttlMs = Number(ttl);
        entry.expiresAt = Number.isFinite(ttlMs) ? Date.now() + ttlMs : entry.expiresAt;
        this.store.set(key, entry);
        return 1;
      }
      return 0;
    }
    return 0;
  }

  private cleanup(key: string) {
    const entry = this.store.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
    }
  }
}

const redisRef: { current: MockRedis | null } = { current: null };

vi.mock("./redis", () => ({
  getRedisClient: () => redisRef.current,
}));

describe("redis-lock helpers", () => {
  beforeEach(() => {
    redisRef.current = new MockRedis();
  });

  afterEach(() => {
    redisRef.current = null;
  });

  it("acquires and releases a lock", async () => {
    const lock = await acquireLock("lock:test", { ttlMs: 500 });
    expect(lock).not.toBeNull();
    const second = await acquireLock("lock:test", { ttlMs: 500, maxAttempts: 1 });
    expect(second).toBeNull();

    if (lock) {
      await lock.release();
    }

    const third = await acquireLock("lock:test", { ttlMs: 500, maxAttempts: 1 });
    expect(third).not.toBeNull();
  });

  it("fails to extend lock with incorrect token", async () => {
    const lock = await acquireLock("lock:extend", { ttlMs: 500 });
    expect(lock).not.toBeNull();
    if (!lock) return;

    const result = await extendLock("lock:extend", "wrong-token", lock.redis, { ttlMs: 1_000 });
    expect(result).toBe(false);

    const ok = await lock.extend({ ttlMs: 1_000 });
    expect(ok).toBe(true);
  });

  it("releaseLock returns false for unknown lock", async () => {
    const released = await releaseLock("lock:missing", "token");
    expect(released).toBe(false);
  });
});
