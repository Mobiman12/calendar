import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import {
  AuditAction,
  AuditActorType,
  Prisma,
  ScheduleOwnerType,
  ScheduleRuleType,
  Weekday,
} from "@prisma/client";
import { getTenantIdOrThrow } from "@/lib/tenant";

const scheduleSchema = z.object({
  schedule: z.array(
    z.object({
      weekday: z.string(),
      label: z.string(),
      isOpen: z.boolean(),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
    }),
  ),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: tenantId, slug: location },
    select: { id: true, metadata: true, timezone: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof scheduleSchema>;
  try {
    payload = scheduleSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const metadataRecord: Record<string, unknown> = { ...parseMetadataRecord(locationRecord.metadata) };
  metadataRecord.companyBookingSchedule = payload.schedule;

  const scheduleMinutes = payload.schedule.map((entry) => {
    const startMinutes = timeToMinutes(entry.start);
    const endMinutes = timeToMinutes(entry.end);
    if (startMinutes >= endMinutes) {
      throw new Error(`Ungültige Zeitspanne für ${entry.label}`);
    }
    return { ...entry, startMinutes, endMinutes };
  });

  try {
    await prisma.$transaction(async (tx) => {
      await tx.location.update({
        where: { id: locationRecord.id },
        data: {
          metadata: metadataRecord as Prisma.JsonObject,
        },
      });

      let schedule = await tx.schedule.findFirst({
        where: { locationId: locationRecord.id, ownerType: ScheduleOwnerType.LOCATION, isDefault: true },
      });

      if (!schedule) {
        schedule = await tx.schedule.create({
          data: {
            locationId: locationRecord.id,
            ownerType: ScheduleOwnerType.LOCATION,
            name: "Standard",
            timezone: locationRecord.timezone ?? "Europe/Berlin",
            isDefault: true,
          },
        });
      }

      for (const entry of scheduleMinutes) {
        const weekday = entry.weekday as Weekday;
        if (!entry.isOpen) {
          await tx.scheduleRule.updateMany({
            where: { scheduleId: schedule.id, weekday },
            data: { isActive: false },
          });
          continue;
        }

        const existing = await tx.scheduleRule.findFirst({
          where: { scheduleId: schedule.id, weekday },
        });

        if (existing) {
          await tx.scheduleRule.update({
            where: { id: existing.id },
            data: {
              startsAt: entry.startMinutes,
              endsAt: entry.endMinutes,
              isActive: true,
            },
          });
        } else {
          await tx.scheduleRule.create({
            data: {
              scheduleId: schedule.id,
              ruleType: ScheduleRuleType.WEEKLY,
              weekday,
              startsAt: entry.startMinutes,
              endsAt: entry.endMinutes,
              isActive: true,
            },
          });
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Speichern fehlgeschlagen.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "company_booking_schedule",
    entityId: locationRecord.id,
    diff: { schedule: payload.schedule },
    context: { source: "company_booking_schedule" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ success: true });
}

function parseMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || value === Prisma.DbNull || value === Prisma.JsonNull) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function timeToMinutes(value: string) {
  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number.parseInt(hoursRaw ?? "0", 10);
  const minutes = Number.parseInt(minutesRaw ?? "0", 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    throw new Error(`Ungültige Uhrzeit: ${value}`);
  }
  return hours * 60 + minutes;
}
