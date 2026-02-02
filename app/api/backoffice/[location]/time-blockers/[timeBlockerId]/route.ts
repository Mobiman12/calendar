import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { logAuditEvent } from "@/lib/audit/logger";
import { AuditAction, AuditActorType } from "@prisma/client";
import { getHiddenStaffByLocation } from "@/lib/stundenliste-sync";
import { getTenantIdOrThrow } from "@/lib/tenant";

type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER" | "UE_ABBAU";

const TIME_BLOCKER_LABELS: Record<TimeBlockerReason, string> = {
  BREAK: "Zeitblocker · Pause",
  MEAL: "Zeitblocker · Mittagessen",
  VACATION: "Zeitblocker · Urlaub",
  SICK: "Zeitblocker · Krankmeldung",
  PRIVATE: "Zeitblocker · Privater Termin",
  OTHER: "Zeitblocker",
  UE_ABBAU: "Zeitblocker · Ü-Abbau",
};

const prisma = getPrismaClient();
const REASON_VALUES: TimeBlockerReason[] = ["BREAK", "VACATION", "SICK", "MEAL", "PRIVATE", "OTHER", "UE_ABBAU"];
type BlockerMetadata = { type?: TimeBlockerReason; customReason?: string | null; allStaff?: boolean; groupId?: string };

function parseBlockerMetadata(value: unknown): BlockerMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const type =
    typeof record.type === "string" && REASON_VALUES.includes(record.type as TimeBlockerReason)
      ? (record.type as TimeBlockerReason)
      : undefined;
  const customReason = typeof record.customReason === "string" ? record.customReason : null;
  const allStaff = typeof record.allStaff === "boolean" ? record.allStaff : undefined;
  const groupId = typeof record.groupId === "string" && record.groupId.length ? record.groupId : undefined;
  return { type, customReason, allStaff, groupId };
}

const formatStaffName = (
  staff?: { displayName?: string | null; firstName?: string | null; lastName?: string | null } | null,
) => {
  if (!staff) return null;
  const displayName = staff.displayName?.trim();
  if (displayName) return displayName;
  const first = staff.firstName?.trim() ?? "";
  const last = staff.lastName?.trim() ?? "";
  const combined = `${first} ${last}`.trim();
  return combined.length ? combined : null;
};

const parseAuditContext = (value: unknown): { performedByName: string | null } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { performedByName: null };
  }
  const record = value as Record<string, unknown>;
  const performed = record.performedBy;
  if (!performed || typeof performed !== "object" || Array.isArray(performed)) {
    return { performedByName: null };
  }
  const performedRecord = performed as Record<string, unknown>;
  const staffName = typeof performedRecord.staffName === "string" ? performedRecord.staffName : null;
  return { performedByName: staffName };
};

const updateSchema = z.object({
  start: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Ungültiger Startzeitpunkt." }),
  end: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Ungültiger Endzeitpunkt." }),
  allDay: z.boolean().optional().default(false),
  allStaff: z.boolean().optional().default(false),
  staffIds: z.array(z.string()).optional().default([]),
  reason: z.enum(["BREAK", "VACATION", "SICK", "MEAL", "PRIVATE", "OTHER", "UE_ABBAU"]),
  customReason: z.string().max(120).optional(),
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

const deleteSchema = z.object({
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

async function resolveContext(context: { params: Promise<{ location: string; timeBlockerId: string }>, requestHeaders?: Headers }) {
  const { location, timeBlockerId } = await context.params;
  const tenantId = await getTenantIdOrThrow(context.requestHeaders ?? new Headers(), { locationSlug: location });
  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, slug: true, tenantId: true },
  });
  return { locationRecord, timeBlockerId, tenantId };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string; timeBlockerId: string }> },
) {
  const { locationRecord, timeBlockerId } = await resolveContext({
    ...context,
    requestHeaders: new Headers(request.headers),
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const record = await prisma.timeOff.findUnique({
    where: { id: timeBlockerId },
    select: {
      id: true,
      locationId: true,
      staffId: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      metadata: true,
    },
  });

  if (!record || record.locationId !== locationRecord.id) {
    return NextResponse.json({ error: "Zeitblocker nicht gefunden." }, { status: 404 });
  }

  const metadata = parseBlockerMetadata(record.metadata);
  const reasonType = metadata.type ?? "OTHER";
  const customReason = metadata.customReason ?? null;
  const allStaff = typeof metadata.allStaff === "boolean" ? metadata.allStaff : record.staffId === null;
  const blockerGroupId = metadata.groupId ?? record.id;
  const auditLogs = await prisma.auditLog.findMany({
    where: {
      entityType: "time_blocker",
      entityId: blockerGroupId === record.id ? record.id : { in: [record.id, blockerGroupId] },
      locationId: locationRecord.id,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      action: true,
      actorType: true,
      createdAt: true,
      diff: true,
      context: true,
      actor: {
        select: {
          id: true,
          email: true,
          staff: {
            select: {
              displayName: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });

  const auditTrail = auditLogs.map((log) => {
    const actorNameFromUser = formatStaffName(log.actor?.staff) ?? log.actor?.email ?? null;
    const contextInfo = parseAuditContext(log.context);
    const actorName = actorNameFromUser ?? contextInfo.performedByName;
    return {
      id: log.id,
      action: log.action,
      actorType: log.actorType,
      actorName: actorName ?? null,
      createdAt: log.createdAt.toISOString(),
      diff: log.diff ?? null,
      context: log.context ?? null,
    };
  });

  return NextResponse.json({
    id: record.id,
    staffId: record.staffId,
    reason: record.reason,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    reasonType,
    customReason,
    allStaff,
    metadata: record.metadata ?? null,
    auditTrail,
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ location: string; timeBlockerId: string }> },
) {
  const { locationRecord, timeBlockerId } = await resolveContext({
    ...context,
    requestHeaders: new Headers(request.headers),
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof updateSchema>;
  try {
    payload = updateSchema.parse(await request.json());
    // normalize unassigned/null staff IDs
    if (payload.staffIds?.length) {
      payload.staffIds = payload.staffIds.map((id) => (id === "unassigned" ? "" : id)).filter(Boolean);
    }
    if (payload.performedBy?.staffId === "unassigned") {
      payload.performedBy.staffId = "";
    }
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const record = await prisma.timeOff.findUnique({
    where: { id: timeBlockerId },
    select: {
      id: true,
      locationId: true,
      staffId: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      metadata: true,
    },
  });

  if (!record || record.locationId !== locationRecord.id) {
    return NextResponse.json({ error: "Zeitblocker nicht gefunden." }, { status: 404 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const actorStaff = await prisma.staff.findFirst({
    where: membershipSupported
      ? {
          id: payload.performedBy.staffId,
          memberships: { some: { locationId: locationRecord.id } },
        }
      : {
          id: payload.performedBy.staffId,
          locationId: locationRecord.id,
        },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });

  if (!actorStaff || !verifyBookingPinToken(payload.performedBy.token, actorStaff.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }
  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;
  const actorStaffName = formatStaffName(actorStaff) ?? "Mitarbeiter";

  const startsAt = new Date(payload.start);
  const endsAt = new Date(payload.end);
  if (!(startsAt < endsAt)) {
    return NextResponse.json({ error: "Endzeitpunkt muss nach dem Start liegen." }, { status: 400 });
  }

  const staffScope = membershipSupported
    ? {
        memberships: { some: { locationId: locationRecord.id } },
      }
    : { locationId: locationRecord.id };

  const staffRecords = await prisma.staff.findMany({
    where: staffScope,
    select: { id: true },
  });
  const validStaffIds = new Set(staffRecords.map((entry) => entry.id));

  let requestedStaffIds: string[] = [];
  if (payload.allStaff) {
    requestedStaffIds = Array.from(validStaffIds);
  } else if (payload.staffIds.length) {
    const invalidIds = payload.staffIds.filter((id) => !validStaffIds.has(id));
    if (invalidIds.length) {
      return NextResponse.json({ error: "Mindestens ein ausgewählter Mitarbeiter gehört nicht zu diesem Standort." }, { status: 400 });
    }
    requestedStaffIds = payload.staffIds;
  } else {
    // Fallback: wenn kein staffIds mitgegeben wurde, den bisherigen Blocker-Staff beibehalten
    requestedStaffIds = record.staffId ? [record.staffId] : [];
  }

  const desiredStaffIds = Array.from(new Set(requestedStaffIds));
  const desiredStaffKeys = payload.allStaff ? [...desiredStaffIds, null] : desiredStaffIds;

  const trimCustom = payload.customReason?.trim() ?? "";
  const reasonLabel =
    payload.reason === "OTHER"
      ? trimCustom.length
        ? `${TIME_BLOCKER_LABELS.OTHER}: ${trimCustom}`
        : TIME_BLOCKER_LABELS.OTHER
      : TIME_BLOCKER_LABELS[payload.reason];
  const previousMeta = parseBlockerMetadata(record.metadata);
  const blockerGroupId = previousMeta.groupId ?? record.id;
  const relatedRecords =
    previousMeta.groupId !== undefined
      ? await prisma.timeOff.findMany({
          where: {
            locationId: locationRecord.id,
            metadata: {
              path: ["groupId"],
              equals: blockerGroupId,
            },
          },
          select: {
            id: true,
            staffId: true,
          },
        })
      : [record];
  const previousStaffList = relatedRecords.map((entry) => entry.staffId ?? null);

  const staffKey = (value: string | null | undefined) => (value ?? "__null__");
  const baseMetadata = {
    type: payload.reason,
    customReason: payload.reason === "OTHER" ? trimCustom || null : null,
    allStaff: payload.allStaff,
    source: "CALENDAR_BLOCKER",
    groupId: blockerGroupId,
  };

  const baseEntry = {
    locationId: locationRecord.id,
    startsAt,
    endsAt,
    reason: reasonLabel,
    metadata: baseMetadata,
  } as const;

  try {
    const deleteCondition = relatedRecords.length
      ? {
          OR: [
            {
              metadata: {
                path: ["groupId"],
                equals: blockerGroupId,
              },
            },
            { id: blockerGroupId },
          ],
        }
      : { id: record.id };
    await prisma.timeOff.deleteMany({
      where: {
        locationId: locationRecord.id,
        ...deleteCondition,
      },
    });
  } catch (error) {
    console.error("[time-blockers:patch] deleteMany failed", error);
    return NextResponse.json({ error: "Zeitblocker konnte nicht aktualisiert werden." }, { status: 500 });
  }

  let createdRecords;
  try {
    createdRecords = await prisma.$transaction(
      desiredStaffKeys.map((staffId) =>
        prisma.timeOff.create({
          data: {
            ...baseEntry,
            staffId,
          },
          select: {
            id: true,
            staffId: true,
            startsAt: true,
            endsAt: true,
            reason: true,
            metadata: true,
          },
        }),
      ),
    );
  } catch (error) {
    console.error("[time-blockers:patch] recreate failed", error);
    return NextResponse.json({ error: "Zeitblocker konnte nicht aktualisiert werden." }, { status: 500 });
  }

  const updatedRecord = createdRecords[0];
  const diffPayload: Record<string, unknown> = {};
  const previousStart = record.startsAt.toISOString();
  const nextStart = updatedRecord.startsAt.toISOString();
  if (previousStart !== nextStart) {
    diffPayload.startsAt = { previous: previousStart, next: nextStart };
  }
  const previousEnd = record.endsAt.toISOString();
  const nextEnd = updatedRecord.endsAt.toISOString();
  if (previousEnd !== nextEnd) {
    diffPayload.endsAt = { previous: previousEnd, next: nextEnd };
  }
  const previousStaff = record.staffId ?? null;
  const nextStaff = updatedRecord.staffId ?? null;
  if (previousStaff !== nextStaff) {
    diffPayload.staffId = { previous: previousStaff, next: nextStaff };
  }
  const previousReasonType = previousMeta.type ?? "OTHER";
  if (previousReasonType !== payload.reason) {
    diffPayload.reasonType = { previous: previousReasonType, next: payload.reason };
  }
  const previousCustomReason = previousMeta.customReason ?? null;
  const nextCustomReason = payload.reason === "OTHER" ? payload.customReason?.trim() ?? null : null;
  if (previousCustomReason !== nextCustomReason) {
    diffPayload.customReason = { previous: previousCustomReason, next: nextCustomReason };
  }
  const previousAllStaff = Boolean(previousMeta.allStaff);
  if (previousAllStaff !== payload.allStaff) {
    diffPayload.allStaff = { previous: previousAllStaff, next: payload.allStaff };
  }
  diffPayload.staffIds = { previous: previousStaffList, next: desiredStaffKeys };

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "time_blocker",
    entityId: blockerGroupId,
    diff: diffPayload,
    context: {
      source: "calendar_time_blocker",
      performedBy: {
        staffId: actorStaff.id,
        staffName: actorStaffName,
      },
    },
    ipAddress,
    userAgent,
  });

  revalidatePath(`/backoffice/${locationRecord.slug}/calendar`);
  return NextResponse.json({
    success: true,
    data: {
      id: updatedRecord.id,
      staffId: updatedRecord.staffId,
      startsAt: updatedRecord.startsAt.toISOString(),
      endsAt: updatedRecord.endsAt.toISOString(),
      reason: updatedRecord.reason,
      metadata: updatedRecord.metadata ?? null,
    },
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string; timeBlockerId: string }> },
) {
  const { locationRecord, timeBlockerId } = await resolveContext({
    ...context,
    requestHeaders: new Headers(request.headers),
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof deleteSchema>;
  try {
    payload = deleteSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const record = await prisma.timeOff.findUnique({
    where: { id: timeBlockerId },
    select: {
      id: true,
      locationId: true,
      staffId: true,
      startsAt: true,
      endsAt: true,
      reason: true,
      metadata: true,
    },
  });

  if (!record || record.locationId !== locationRecord.id) {
    return NextResponse.json({ error: "Zeitblocker nicht gefunden." }, { status: 404 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const actorStaff = await prisma.staff.findFirst({
    where: membershipSupported
      ? {
          id: payload.performedBy.staffId,
          memberships: { some: { locationId: locationRecord.id } },
        }
      : {
          id: payload.performedBy.staffId,
          locationId: locationRecord.id,
        },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });

  if (!actorStaff || !verifyBookingPinToken(payload.performedBy.token, actorStaff.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }
  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;
  const actorStaffName = formatStaffName(actorStaff) ?? "Mitarbeiter";

  try {
    await prisma.timeOff.delete({ where: { id: timeBlockerId } });
  } catch (error) {
    console.error("[time-blockers:delete] failed", error);
    return NextResponse.json({ error: "Zeitblocker konnte nicht gelöscht werden." }, { status: 500 });
  }

  revalidatePath(`/backoffice/${locationRecord.slug}/calendar`);
  const meta = parseBlockerMetadata(record.metadata);
  const blockerGroupId = meta.groupId ?? record.id;
  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.DELETE,
    entityType: "time_blocker",
    entityId: blockerGroupId,
    diff: {
      startsAt: { previous: record.startsAt.toISOString(), next: null },
      endsAt: { previous: record.endsAt.toISOString(), next: null },
      staffId: { previous: record.staffId ?? null, next: null },
      reasonType: { previous: meta.type ?? "OTHER", next: null },
      customReason: { previous: meta.customReason ?? null, next: null },
      allStaff: { previous: Boolean(meta.allStaff), next: null },
    },
    context: {
      source: "calendar_time_blocker",
      performedBy: {
        staffId: actorStaff.id,
        staffName: actorStaffName,
      },
    },
    ipAddress,
    userAgent,
  });
  return NextResponse.json({ success: true });
}
