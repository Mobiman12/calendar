import { getRedisClient } from "@/lib/redis";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number | null;
}

export async function enforceRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const redis = getRedisClient();
  if (!redis) {
    return { allowed: true, remaining: null };
  }

  if (!redis.status || redis.status === "end") {
    await redis.connect();
  }

  const redisKey = `ratelimit:${key}`;
  const count = await redis.incr(redisKey);

  if (count === 1) {
    await redis.expire(redisKey, windowSeconds);
  }

  const allowed = count <= limit;
  const remaining = allowed ? limit - count : 0;

  return { allowed, remaining };
}
