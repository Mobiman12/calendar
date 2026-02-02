import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, AuditAction, AuditActorType } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getHiddenStaffByLocation } from "@/lib/stundenliste-sync";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { logAuditEvent } from "@/lib/audit/logger";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER" | "UE_ABBAU";

const reasonLabels: Record<TimeBlockerReason, string> = {
  BREAK: "Zeitblocker · Pause",
  MEAL: "Zeitblocker · Mittagessen",
  VACATION: "Zeitblocker · Urlaub",
  SICK: "Zeitblocker · Krankmeldung",
  PRIVATE: "Zeitblocker · Privater Termin",
  OTHER: "Zeitblocker",
  UE_ABBAU: "Zeitblocker · Ü-Abbau",
};

const payloadSchema = z.object({
  locationId: z.string().min(1),
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

const formatStaffDisplayName = (staff: { displayName?: string | null; firstName?: string | null; lastName?: string | null }) => {
  const displayName = staff.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const first = staff.firstName?.trim() ?? "";
  const last = staff.lastName?.trim() ?? "";
  const combined = `${first} ${last}`.trim();
  return combined.length ? combined : "Mitarbeiter";
};

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, slug: true, tenantId: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof payloadSchema>;
  try {
    const body = await request.json();
    payload = payloadSchema.parse(body);
    // unassigned darf nicht als staffId in die DB, also vorab rausfiltern
    if (payload.staffIds?.length) {
      payload.staffIds = payload.staffIds.map((id) => (id === "unassigned" ? "" : id)).filter(Boolean);
    }
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (payload.locationId !== locationRecord.id) {
    return NextResponse.json({ error: "Standortzuordnung ungültig." }, { status: 400 });
  }

  const startsAt = new Date(payload.start);
  const endsAt = new Date(payload.end);

  if (!(startsAt < endsAt)) {
    return NextResponse.json({ error: "Endzeitpunkt muss nach dem Start liegen." }, { status: 400 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;
  const actorStaff = await prisma.staff.findFirst({
    where: membershipSupported
      ? {
          id: payload.performedBy.staffId,
          memberships: { some: { locationId: locationRecord.id } },
          location: { tenantId },
        }
      : {
          id: payload.performedBy.staffId,
          locationId: locationRecord.id,
          location: { tenantId },
        },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });

  if (!actorStaff || !verifyBookingPinToken(payload.performedBy.token, actorStaff.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  const staffScope = membershipSupported
    ? {
        memberships: { some: { locationId: locationRecord.id } },
      }
    : { locationId: locationRecord.id };

  const hiddenStaffIds = Array.from(getHiddenStaffByLocation().get(locationRecord.id) ?? new Set<string>());

  const staffRecords = await prisma.staff.findMany({
    where: {
      ...staffScope,
      ...(hiddenStaffIds.length ? { id: { notIn: hiddenStaffIds } } : {}),
    },
    select: { id: true },
  });
  const validStaffIds = new Set(staffRecords.map((entry) => entry.id));

  let targetStaffIds: string[] = [];
  if (payload.allStaff) {
    targetStaffIds = [...validStaffIds];
  } else {
    const requestedIds = payload.staffIds ?? [];
    if (requestedIds.length === 0) {
      return NextResponse.json({ error: "Bitte mindestens einen Mitarbeiter auswählen." }, { status: 400 });
    }
    const invalidIds = requestedIds.filter((id) => !validStaffIds.has(id));
    if (invalidIds.length) {
      return NextResponse.json({ error: "Mindestens ein Mitarbeiter gehört nicht zu diesem Standort." }, { status: 400 });
    }
    targetStaffIds = requestedIds;
  }

  const reasonLabel = reasonLabels[payload.reason];
  const groupId = randomUUID();
  const metadata: Prisma.JsonObject = {
    type: payload.reason,
    source: "CALENDAR_BLOCKER",
    allStaff: payload.allStaff,
    groupId,
    ...(payload.reason === "OTHER" && payload.customReason?.trim()
      ? { customReason: payload.customReason.trim() }
      : {}),
  };

  const reasonValue =
    payload.reason === "OTHER"
      ? payload.customReason?.trim()?.length
        ? `${reasonLabel}: ${payload.customReason.trim()}`
        : reasonLabel
      : reasonLabel;

  const baseEntry: Omit<Prisma.TimeOffCreateManyInput, "staffId"> = {
    locationId: locationRecord.id,
    startsAt,
    endsAt,
    reason: reasonValue,
    metadata,
  };

  const data: Prisma.TimeOffCreateManyInput[] = targetStaffIds.length
    ? targetStaffIds.map((staffId) => ({ ...baseEntry, staffId }))
    : [{ ...baseEntry, staffId: null }];

  if (payload.allStaff && targetStaffIds.length > 0) {
    data.push({ ...baseEntry, staffId: null });
  }

  try {
    const createdRecords = await prisma.$transaction(
      data.map((entry) =>
        prisma.timeOff.create({
          data: entry,
          select: {
            id: true,
            staffId: true,
            startsAt: true,
            endsAt: true,
            reason: true,
            metadata: true,
            locationId: true,
          },
        }),
      ),
    );

    const actorStaffName = formatStaffDisplayName(actorStaff);
    await Promise.all(
      createdRecords.map((record) => {
        const meta =
          record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : {};
        const reasonType = typeof meta.type === "string" ? meta.type : payload.reason;
        const customReason = typeof meta.customReason === "string" ? meta.customReason : null;
        const allStaffFlag = typeof meta.allStaff === "boolean" ? meta.allStaff : payload.allStaff;
        return logAuditEvent({
          locationId: record.locationId,
          actorType: AuditActorType.USER,
          actorId: null,
          action: AuditAction.CREATE,
          entityType: "time_blocker",
          entityId: record.id,
          diff: {
            startsAt: { previous: null, next: record.startsAt.toISOString() },
            endsAt: { previous: null, next: record.endsAt.toISOString() },
            staffId: { previous: null, next: record.staffId ?? null },
            reasonType: { previous: null, next: reasonType },
            customReason: { previous: null, next: customReason },
            allStaff: { previous: null, next: allStaffFlag },
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
      }),
    );

    revalidatePath(`/backoffice/${locationRecord.slug}/calendar`);
    return NextResponse.json({ success: true, created: createdRecords.length });
  } catch (error) {
    console.error("[time-blockers] creation failed", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return NextResponse.json({ error: "Zeitblocker konnte nicht gespeichert werden." }, { status: 400 });
    }
    return NextResponse.json({ error: "Zeitblocker konnte nicht gespeichert werden." }, { status: 500 });
  }
}
