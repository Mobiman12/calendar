import type { AuditAction, AuditActorType, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

export interface AuditEventInput {
  locationId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  appointmentId?: string | null;
  diff?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function logAuditEvent(
  event: AuditEventInput,
  client?: PrismaClient | Prisma.TransactionClient,
): Promise<void> {
  const prisma = client ?? getPrismaClient();

  try {
    await prisma.auditLog.create({
      data: {
        locationId: event.locationId ?? null,
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        appointmentId: event.appointmentId ?? null,
        diff: normalizeJson(event.diff),
        context: normalizeJson(event.context),
        ipAddress: event.ipAddress ?? null,
        userAgent: event.userAgent ?? null,
      },
    });
  } catch (error) {
    const logger = getLogger();
    logger.error({ err: error }, "audit log persistence failed");
  }
}

function normalizeJson(value: Record<string, unknown> | null | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return Prisma.JsonNull;
  }
  return value as Prisma.InputJsonValue;
}
