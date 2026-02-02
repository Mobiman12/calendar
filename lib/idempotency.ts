import type Redis from "ioredis";
import { getRedisClient } from "./redis";

export interface IdempotencyRecord<T = unknown> {
  status: "pending" | "completed" | "failed";
  response?: T;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const PREFIX = "idempotency:v1";

export async function getIdempotencyRecord<T = unknown>(
  key: string,
  redisClient?: Redis,
): Promise<IdempotencyRecord<T> | null> {
  const redis = redisClient ?? getRedisClient();
  if (!redis) return null;

  if (!redis.status || redis.status === "end") {
    await redis.connect();
  }

  const raw = await redis.get(buildRedisKey(key));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as IdempotencyRecord<T>;
  } catch {
    return null;
  }
}

export async function setIdempotencyRecord<T = unknown>(
  key: string,
  record: IdempotencyRecord<T>,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  redisClient?: Redis,
) {
  const redis = redisClient ?? getRedisClient();
  if (!redis) return;

  if (!redis.status || redis.status === "end") {
    await redis.connect();
  }

  await redis.set(buildRedisKey(key), JSON.stringify(record), "EX", ttlSeconds);
}

function buildRedisKey(key: string): string {
  return `${PREFIX}:${key}`;
}
