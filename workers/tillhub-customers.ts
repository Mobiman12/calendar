#!/usr/bin/env tsx

import "dotenv/config";

import { getLogger } from "@/lib/logger";
import { syncTillhubCustomersForTenant } from "@/lib/tillhub-customers";

const DEFAULT_INTERVAL_MINUTES = 60;

function resolveIntervalMinutes(): number {
  const raw = Number.parseInt(process.env.TILLHUB_CUSTOMER_SYNC_INTERVAL_MINUTES ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_INTERVAL_MINUTES;
}

function resolveTenantId(): string | null {
  const explicit = process.env.TILLHUB_CUSTOMER_SYNC_TENANT_ID?.trim();
  if (explicit) return explicit;
  const fallback = process.env.DEFAULT_TENANT_ID?.trim();
  return fallback || null;
}

async function runOnce() {
  const logger = getLogger();
  const tenantId = resolveTenantId();
  if (!tenantId) {
    logger.warn("tillhub customer sync skipped: missing tenant id");
    return;
  }
  const summary = await syncTillhubCustomersForTenant(tenantId);
  logger.info(
    {
      tenantId,
      locations: summary.locations,
      total: summary.total,
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
    },
    "tillhub customer sync completed",
  );
}

async function main() {
  const logger = getLogger();
  const intervalMinutes = resolveIntervalMinutes();
  const intervalMs = intervalMinutes * 60 * 1000;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      logger.error({ err: error }, "tillhub customer sync failed");
    } finally {
      running = false;
    }
  };

  await tick();
  const timer = setInterval(tick, intervalMs);
  logger.info({ intervalMinutes }, "tillhub customer sync worker started");
}

main().catch((error) => {
  const logger = getLogger();
  logger.error({ err: error }, "tillhub customer sync worker error");
  process.exit(1);
});
