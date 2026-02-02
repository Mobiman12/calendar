#!/usr/bin/env tsx

import "dotenv/config";

import { getLogger } from "@/lib/logger";
import { syncTillhubAppointmentCarts } from "@/lib/tillhub-pos";

async function tick(intervalSeconds: number) {
  const logger = getLogger();
  try {
    const summary = await syncTillhubAppointmentCarts();
    logger.info(summary, "tillhub pos sync completed");
  } catch (error) {
    logger.error({ err: error }, "tillhub pos sync failed");
  } finally {
    setTimeout(() => tick(intervalSeconds), intervalSeconds * 1000);
  }
}

async function main() {
  const intervalSeconds = Number.parseInt(process.env.TILLHUB_POS_SYNC_INTERVAL_SECONDS ?? "10", 10);
  const resolvedInterval = Number.isFinite(intervalSeconds) ? intervalSeconds : 10;
  void tick(resolvedInterval);
  getLogger().info({ intervalSeconds: resolvedInterval }, "tillhub pos sync worker started");
}

main().catch((error) => {
  const logger = getLogger();
  logger.error({ err: error }, "tillhub pos sync worker error");
  process.exit(1);
});
