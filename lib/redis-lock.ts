import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { getRedisClient } from "./redis";

export interface AcquireLockOptions {
  ttlMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  connectTimeoutMs?: number;
}

export interface ExtendLockOptions {
  ttlMs?: number;
}

export interface LockHandle {
  key: string;
  token: string;
  redis: Redis;
  release: () => Promise<boolean>;
  extend: (options?: ExtendLockOptions) => Promise<boolean>;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;

export function shouldBypassRedisLock(): boolean {
  const requireLock = (process.env.REDIS_LOCK_REQUIRED ?? "").trim().toLowerCase() === "true";
  if (requireLock) return false;
  return process.env.NODE_ENV !== "production";
}

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

const EXTEND_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  end
  return 0
`;

export async function acquireLock(key: string, options: AcquireLockOptions = {}): Promise<LockHandle | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const token = randomUUID();

  const ready = await ensureRedisReady(redis, connectTimeoutMs);
  if (!ready) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let result: string | null = null;
    try {
      result = await redis.set(key, token, "PX", ttlMs, "NX");
    } catch (error) {
      return null;
    }
    if (result === "OK") {
      return {
        key,
        token,
        redis,
        release: () => releaseLock(key, token, redis),
        extend: (extendOptions) => extendLock(key, token, redis, extendOptions),
      };
    }
    await delay(retryDelayMs);
  }

  return null;
}

export async function releaseLock(key: string, token: string, redisClient?: Redis): Promise<boolean> {
  const redis = redisClient ?? getRedisClient();
  if (!redis) return false;

  const ready = await ensureRedisReady(redis, DEFAULT_CONNECT_TIMEOUT_MS);
  if (!ready) return false;

  try {
    const result = await redis.eval(RELEASE_SCRIPT, 1, key, token);
    return result === 1;
  } catch (error) {
    return false;
  }
}

export async function extendLock(
  key: string,
  token: string,
  redisClient?: Redis,
  options: ExtendLockOptions = {},
): Promise<boolean> {
  const redis = redisClient ?? getRedisClient();
  if (!redis) return false;

  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const ready = await ensureRedisReady(redis, DEFAULT_CONNECT_TIMEOUT_MS);
  if (!ready) return false;

  try {
    const result = await redis.eval(EXTEND_SCRIPT, 1, key, token, ttlMs);
    return result === 1;
  } catch (error) {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureRedisReady(redis: Redis, timeoutMs: number): Promise<boolean> {
  if (redis.status === "ready") return true;
  if (redis.status === "end") return false;

  try {
    await withTimeout(redis.connect(), timeoutMs);
  } catch (error) {
    return false;
  }

  return redis.status === "ready";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("redis_timeout"));
    }, timeoutMs);

    promise.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
