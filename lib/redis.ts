import Redis from "ioredis";

let hasLoggedRedisError = false;

declare global {
  // eslint-disable-next-line no-var
  var __calendarRedisClient: Redis | null | undefined;
}

export function getRedisClient(): Redis | null {
  if (typeof global.__calendarRedisClient !== "undefined") {
    return global.__calendarRedisClient;
  }

  const url = process.env.REDIS_URL;
  if (!url) {
    global.__calendarRedisClient = null;
    return null;
  }

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
  });
  client.on("error", (error) => {
    if (hasLoggedRedisError) return;
    hasLoggedRedisError = true;
    console.warn("[redis] connection error", error);
  });

  global.__calendarRedisClient = client;
  return client;
}
