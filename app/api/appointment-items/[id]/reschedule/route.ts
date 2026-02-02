import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { addMinutes, differenceInMinutes } from "date-fns";
import { AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { acquireLock, releaseLock, shouldBypassRedisLock } from "@/lib/redis-lock";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getLogger } from "@/lib/logger";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { publishAppointmentSync } from "@/lib/appointment-sync";

const payloadSchema = z.object({
  startsAt: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid startsAt" }),
  staffId: z.string().optional(),
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

const logger = getLogger();


export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers);
  const payloadResult = payloadSchema.safeParse(await request.json().catch(() => null));

  if (!payloadResult.success) {
    return NextResponse.json(
      {
        error: "Invalid payload",
        details: payloadResult.error.issues.map((issue) => issue.message),
      },
      { status: 400 },
    );
  }

  const payload = payloadResult.data;
  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;

  const rateKey = ipAddress ?? request.headers.get("user-agent") ?? "anonymous";
  const rateLimit = await enforceRateLimit(`reschedule:${rateKey}`, 20, 60);
  if (!rateLimit.allowed) {
    logger.warn({ rateKey }, "reschedule rate limit exceeded");
    return NextResponse.json({ error: "Too many reschedule attempts." }, { status: 429 });
  }

  const prisma = getPrismaClient();

  const item = await prisma.appointmentItem.findUnique({
    where: { id },
    include: {
      appointment: {
        include: {
          items: true,
          location: { select: { tenantId: true } },
        },
      },
    },
  });

  if (!item || !item.appointment || item.appointment.location?.tenantId !== tenantId) {
    return NextResponse.json({ error: "Appointment item not found" }, { status: 404 });
  }

  const lockKey = `reschedule:${item.appointment.locationId}:${id}`;
  const lock = await acquireLock(lockKey, { ttlMs: 30_000 });
  if (!lock && !shouldBypassRedisLock()) {
    return NextResponse.json({ error: "Unable to acquire lock" }, { status: 409 });
  }
  if (!lock) {
    logger.warn({ lockKey }, "redis lock unavailable, continuing without lock");
  }

  const newStart = new Date(payload.startsAt);
  const duration = differenceInMinutes(item.endsAt, item.startsAt);
  const newEnd = addMinutes(newStart, duration);
  const deltaMinutes = differenceInMinutes(newStart, item.startsAt);
  const staffId = payload.staffId ?? item.staffId ?? undefined;

  let performerInfo: { staffId: string; staffName: string } | null = null;

  try {
    const performerStaff = await prisma.staff.findFirst({
      where: {
        id: payload.performedBy.staffId,
        locationId: item.appointment.locationId,
        location: { tenantId },
      },
      select: {
        id: true,
        displayName: true,
        firstName: true,
        lastName: true,
      },
    });

    if (!performerStaff || !verifyBookingPinToken(payload.performedBy.token, performerStaff.id)) {
      return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
    }

    const performerName =
      performerStaff.displayName?.trim() ||
      `${performerStaff.firstName ?? ""} ${performerStaff.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
      "Mitarbeiter";
    performerInfo = {
      staffId: performerStaff.id,
      staffName: performerName,
    };

    const result = await prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findUnique({
        where: { id: item.appointmentId },
      });

      if (!appointment) {
        throw new Error("Appointment not found");
      }

      const locationId = appointment.locationId;

      if (staffId) {
        const staff = await tx.staff.findFirst({
          where: {
            id: staffId,
            locationId,
            status: "ACTIVE",
          },
        });

        if (!staff) {
          throw new ConflictError("Mitarbeiter gehört nicht zum Standort");
        }
      }

      const updatedAppointment = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          startsAt: addMinutes(appointment.startsAt, deltaMinutes),
          endsAt: addMinutes(appointment.endsAt, deltaMinutes),
        },
      });

      const updatedItems = await Promise.all(
        item.appointment.items.map((appointmentItem) => {
          const itemDuration = differenceInMinutes(appointmentItem.endsAt, appointmentItem.startsAt);
          const shiftedStart = addMinutes(appointmentItem.startsAt, deltaMinutes);
          const shiftedEnd = addMinutes(shiftedStart, itemDuration);
          return tx.appointmentItem.update({
            where: { id: appointmentItem.id },
            data: {
              startsAt: shiftedStart,
              endsAt: shiftedEnd,
              staffId,
            },
          });
        }),
      );

      return {
        appointment: updatedAppointment,
        items: updatedItems,
      };
    });

    await logAuditEvent({
      locationId: item.appointment.locationId,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "appointment",
      entityId: item.appointmentId,
      appointmentId: item.appointmentId,
      diff: {
        deltaMinutes,
        newStartsAt: result.appointment.startsAt.toISOString(),
        staffId: staffId ?? null,
        performedByStaff: performerInfo,
      },
      context: { source: "backoffice_reschedule", performedByStaff: performerInfo },
      ipAddress,
      userAgent,
    });

    await publishAppointmentSync({
      locationId: item.appointment.locationId,
      action: "rescheduled",
      appointmentId: result.appointment.id,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      data: {
        appointmentId: result.appointment.id,
        startsAt: result.appointment.startsAt.toISOString(),
        endsAt: result.appointment.endsAt.toISOString(),
      },
    });
  } catch (error) {
    if (error instanceof ConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logger.error({ err: error }, "reschedule handler failed");
    const message = error instanceof Error ? error.message : "Reschedule failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (lock) {
      await releaseLock(lock.key, lock.token, lock.redis);
    }
  }
}

class ConflictError extends Error {}
