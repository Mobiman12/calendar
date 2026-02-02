import { NextResponse } from "next/server";
import { z } from "zod";
import { AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { isSmsConfigured, sendSms } from "@/lib/notifications/sms";
import { deriveBookingPreferences } from "@/lib/booking-preferences";

const prisma = getPrismaClient();

const requestSchema = z.object({
  message: z.string().trim().min(1, "Bitte eine Nachricht eingeben.").max(480),
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  const { location, appointmentId } = await context.params;
  const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

  let payload: z.infer<typeof requestSchema>;
  try {
    const body = await request.json();
    payload = requestSchema.parse(body);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!isSmsConfigured()) {
    return NextResponse.json({ error: "SMS-Versand ist nicht konfiguriert." }, { status: 412 });
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, location: { slug: location, tenantId } },
    select: {
      id: true,
      locationId: true,
      location: { select: { name: true, metadata: true } },
      customer: { select: { id: true, phone: true } },
    },
  });

  if (!appointment) {
    return NextResponse.json({ error: "Termin nicht gefunden." }, { status: 404 });
  }

  if (!appointment.customer?.phone) {
    return NextResponse.json({ error: "Kunde hat keine Telefonnummer hinterlegt." }, { status: 400 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const performer = membershipSupported
    ? await prisma.staff.findFirst({
        where: {
          id: payload.performedBy.staffId,
          memberships: { some: { locationId: appointment.locationId } },
          location: { tenantId },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          memberships: {
            where: { locationId: appointment.locationId },
            select: { role: true },
          },
        },
      })
    : await prisma.staff.findFirst({
        where: {
          id: payload.performedBy.staffId,
          locationId: appointment.locationId,
          location: { tenantId },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
        },
      });

  if (!performer || !verifyBookingPinToken(payload.performedBy.token, performer.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  const performerName =
    performer.displayName?.trim() ||
    `${performer.firstName ?? ""} ${performer.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
    "Mitarbeiter";

  const performerInfo = { staffId: performer.id, staffName: performerName };
  const locationMetadata =
    appointment.location?.metadata && typeof appointment.location.metadata === "object" && !Array.isArray(appointment.location.metadata)
      ? (appointment.location.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const smsSenderName = bookingPreferences.smsSenderName.trim() || undefined;

  try {
    await sendSms({
      to: appointment.customer.phone,
      body: payload.message,
      tenantId,
      sender: smsSenderName,
    });

    await logAuditEvent({
      locationId: appointment.locationId,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "appointment",
      entityId: appointment.id,
      appointmentId: appointment.id,
      diff: {
        channel: "SMS",
        message: payload.message,
        recipient: appointment.customer.phone,
        performedByStaff: performerInfo,
      },
      context: {
        source: "backoffice_sms",
        performedByStaff: performerInfo,
        channel: "SMS",
        locationName: appointment.location?.name ?? null,
      },
      ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
      userAgent: request.headers.get("user-agent") ?? null,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[appointment:sms] failed", error);
    return NextResponse.json({ error: "SMS konnte nicht gesendet werden." }, { status: 500 });
  }
}
