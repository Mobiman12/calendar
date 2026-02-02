import type { Prisma } from "@prisma/client";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function buildUpdatedMetadata(
  existing: unknown,
  performer: { staffId: string; staffName: string },
  timestamp: Date,
  assignedStaffIds?: string[],
  serviceStaffAssignments?: Record<string, string[]>,
  internalNote?: string | null,
): Prisma.JsonObject {
  const base = isPlainObject(existing) ? { ...(existing as Record<string, unknown>) } : {};
  base.lastUpdatedByStaff = performer;
  base.lastUpdatedAt = timestamp.toISOString();
  if (Array.isArray(assignedStaffIds)) {
    base.assignedStaffIds = assignedStaffIds;
  }
  if (serviceStaffAssignments && typeof serviceStaffAssignments === "object") {
    base.serviceStaffAssignments = serviceStaffAssignments;
  }
  if (typeof internalNote === "string") {
    const trimmed = internalNote.trim();
    base.internalNote = trimmed.length ? trimmed : null;
  } else if (internalNote === null) {
    base.internalNote = null;
  }
  return base as Prisma.JsonObject;
}
