#!/usr/bin/env tsx

import "dotenv/config";
import { Worker } from "bullmq";

import { getNotificationsQueueName } from "@/lib/notifications/queue";
import { getRedisClient } from "@/lib/redis";
import { NotificationJobNames, notificationJobSchemas, type NotificationJobName, type NotificationJobPayloads } from "@/lib/notifications/jobs";
import { sendNotification } from "@/lib/notifications/send";
import { getLogger } from "@/lib/logger";

async function main() {
  const logger = getLogger();
  const connection = getRedisClient();
  if (!connection) {
    throw new Error("Redis connection required for notifications worker.");
  }

  const worker = new Worker<NotificationJobPayloads[NotificationJobName], void, NotificationJobName>(
    getNotificationsQueueName(),
    async (job) => {
      const schema = notificationJobSchemas[job.name];
      if (!schema) {
        throw new Error(`Unsupported job type ${job.name}`);
      }
      const payload = schema.parse(job.data) as NotificationJobPayloads[NotificationJobName];

      switch (job.name) {
        case NotificationJobNames.AppointmentReminder: {
          const data = payload as NotificationJobPayloads[typeof NotificationJobNames.AppointmentReminder];
          await sendNotification({
            type: "REMINDER",
            data,
          });
          return;
        }
        case NotificationJobNames.AppointmentFollowUp: {
          const data = payload as NotificationJobPayloads[typeof NotificationJobNames.AppointmentFollowUp];
          await sendNotification({
            type: "FOLLOW_UP",
            data,
          });
          return;
        }
        default:
          throw new Error(`Unknown job ${job.name}`);
      }
    },
    {
      connection,
      concurrency: Number.parseInt(process.env.NOTIFICATIONS_WORKER_CONCURRENCY ?? "5", 10),
    },
  );

  worker.on("completed", (job) => {
    logger.info({ id: job.id, name: job.name }, "notifications job completed");
  });

  worker.on("failed", (job, error) => {
    logger.error({ id: job?.id, name: job?.name, err: error }, "notifications job failed");
  });

  logger.info("notifications worker started");
}

main().catch((error) => {
  const logger = getLogger();
  logger.error({ err: error }, "notifications worker error");
  process.exit(1);
});
