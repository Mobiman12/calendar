import { Queue } from "bullmq";

import { getRedisClient } from "@/lib/redis";
import type { NotificationJobName, NotificationJobPayloads } from "@/lib/notifications/jobs";

const QUEUE_NAME = "notifications_dispatch";

let queue: Queue<NotificationJobPayloads[NotificationJobName], void, NotificationJobName> | null = null;
let hasLoggedQueueRedisError = false;

export function getNotificationsQueue() {
  if (queue) {
    return queue;
  }

  const connection = getRedisClient();
  if (!connection) {
    throw new Error("Redis client not available. Make sure REDIS_URL is configured.");
  }

  const queueConnection = connection.duplicate();
  queueConnection.on("error", (error) => {
    if (hasLoggedQueueRedisError) return;
    hasLoggedQueueRedisError = true;
    console.warn("[redis] queue connection error", error);
  });

  queue = new Queue<NotificationJobPayloads[NotificationJobName], void, NotificationJobName>(QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 1_000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  return queue;
}

export function getNotificationsQueueName() {
  return QUEUE_NAME;
}

export async function shutdownNotificationsQueue() {
  await queue?.close();
  queue = null;
}
