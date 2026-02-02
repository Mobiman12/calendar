import { NextResponse } from "next/server";
import { z } from "zod";
import { AppointmentPaymentStatus, AuditAction, AuditActorType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { publishAppointmentSync } from "@/lib/appointment-sync";

const prisma = getPrismaClient();

const transitions: Record<AppointmentPaymentStatus, AppointmentPaymentStatus[]> = {
  [AppointmentPaymentStatus.UNPAID]: [AppointmentPaymentStatus.AUTHORIZED, AppointmentPaymentStatus.PAID],
  [AppointmentPaymentStatus.AUTHORIZED]: [
    AppointmentPaymentStatus.PAID,
    AppointmentPaymentStatus.REFUNDED,
    AppointmentPaymentStatus.PARTIALLY_REFUNDED,
  ],
  [AppointmentPaymentStatus.PAID]: [
    AppointmentPaymentStatus.REFUNDED,
    AppointmentPaymentStatus.PARTIALLY_REFUNDED,
  ],
  [AppointmentPaymentStatus.REFUNDED]: [],
  [AppointmentPaymentStatus.PARTIALLY_REFUNDED]: [
    AppointmentPaymentStatus.PAID,
    AppointmentPaymentStatus.REFUNDED,
  ],
};

const requestSchema = z.object({
  status: z.nativeEnum(AppointmentPaymentStatus),
  note: z
    .string()
    .max(500)
    .optional()
    .transform((value) => value?.trim() ?? ""),
  amount: z
    .number()
    .positive()
    .max(1_000_000)
    .optional(),
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  const { location, appointmentId } = await context.params;
  const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

  let payload: z.infer<typeof requestSchema>;
  try {
    const json = await request.json();
    payload = requestSchema.parse(json);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, location: { slug: location, tenantId } },
    select: {
      id: true,
      locationId: true,
      paymentStatus: true,
      currency: true,
      metadata: true,
    },
  });

  if (!appointment) {
    return NextResponse.json({ error: "Termin nicht gefunden." }, { status: 404 });
  }

  const allowedTargets = transitions[appointment.paymentStatus] ?? [];
  if (!allowedTargets.includes(payload.status)) {
    return NextResponse.json({ error: "Diese Zahlungsstatus-Änderung ist nicht erlaubt." }, { status: 422 });
  }

  const performer = await prisma.staff.findFirst({
    where: { id: payload.performedBy.staffId, location: { slug: location, tenantId } },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });

  if (!performer || !verifyBookingPinToken(payload.performedBy.token, performer.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  const performerName =
    performer.displayName?.trim() ||
    `${performer.firstName ?? ""} ${performer.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
    "Mitarbeiter";

  const performerInfo = {
    staffId: performer.id,
    staffName: performerName,
  };

  const requiresAmount = payload.status === AppointmentPaymentStatus.PARTIALLY_REFUNDED;
  if (requiresAmount && (payload.amount === undefined || Number.isNaN(payload.amount))) {
    return NextResponse.json({ error: "Bitte gib den Rückerstattungsbetrag an." }, { status: 400 });
  }
  const requiresNote = payload.status === AppointmentPaymentStatus.PARTIALLY_REFUNDED || payload.status === AppointmentPaymentStatus.REFUNDED;
  if (requiresNote && !payload.note) {
    return NextResponse.json({ error: "Bitte gib eine Notiz zur Rückerstattung an." }, { status: 400 });
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const previousMetadata =
        appointment.metadata && typeof appointment.metadata === "object" && !Array.isArray(appointment.metadata)
          ? (appointment.metadata as Record<string, unknown>)
          : {};
      const history: Prisma.JsonArray = Array.isArray(previousMetadata.paymentHistory)
        ? [...(previousMetadata.paymentHistory as Prisma.JsonArray)]
        : [];
      history.push({
        status: payload.status,
        note: payload.note ?? null,
        amount: payload.amount ?? null,
        currency: appointment.currency,
        at: new Date().toISOString(),
        performedByStaff: performerInfo,
      } as Prisma.JsonValue);
      const nextMetadata: Prisma.JsonObject = {
        ...previousMetadata,
        paymentHistory: history,
      };

      const result = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          paymentStatus: payload.status,
          metadata: nextMetadata,
        },
        select: {
          id: true,
          paymentStatus: true,
        },
      });

      await logAuditEvent({
        locationId: appointment.locationId,
        actorType: AuditActorType.USER,
        actorId: null,
        action: AuditAction.UPDATE,
        entityType: "appointment_payment_status",
        entityId: appointment.id,
        appointmentId: appointment.id,
        diff: {
          previousStatus: appointment.paymentStatus,
          newStatus: result.paymentStatus,
          note: payload.note || null,
          amount: payload.amount ?? null,
          performedByStaff: performerInfo,
        },
        context: { source: "backoffice_payment_status_update", performedByStaff: performerInfo },
        ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
        userAgent: request.headers.get("user-agent") ?? null,
      });

      return result;
    });

    await publishAppointmentSync({
      locationId: appointment.locationId,
      action: "payment",
      appointmentId: appointment.id,
      timestamp: Date.now(),
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("[appointment:payment-status] failed", error);
    return NextResponse.json({ error: "Zahlungsstatus konnte nicht aktualisiert werden." }, { status: 500 });
  }
}
