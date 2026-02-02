import { NextResponse } from "next/server";
import { AppointmentItemStatus, AppointmentStatus, AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { resolveBookingTenant } from "@/lib/booking-tenant";
import { hashAppointmentAccessToken } from "@/lib/appointments/access-tokens";
import { logAuditEvent } from "@/lib/audit/logger";

export async function POST(
  request: Request,
  context: { params: Promise<{ tenant: string; token: string }> },
) {
  const { tenant, token } = await context.params;
  const resolution = await resolveBookingTenant(tenant);
  if (!resolution) {
    return NextResponse.json({ error: "Tenant nicht gefunden." }, { status: 404 });
  }

  const formData = await request.formData();
  const reasonRaw = formData.get("reason");
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";

  const prisma = getPrismaClient();
  const tokenHash = hashAppointmentAccessToken(token);
  const accessToken = await prisma.appointmentAccessToken.findUnique({
    where: { tokenHash },
    include: {
      appointment: {
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          customerId: true,
          locationId: true,
          location: { select: { tenantId: true } },
        },
      },
    },
  });

  const redirectUrl = new URL(`/book/${encodeURIComponent(tenant)}/appointment/${encodeURIComponent(token)}`, request.url);

  if (!accessToken?.appointment || accessToken.appointment.location.tenantId !== resolution.tenantId) {
    redirectUrl.searchParams.set("error", "Ungültiger Terminlink.");
    return NextResponse.redirect(redirectUrl);
  }

  const now = new Date();
  if (accessToken.expiresAt <= now || accessToken.revokedAt) {
    redirectUrl.searchParams.set("error", "Die Stornierungsfrist ist abgelaufen.");
    return NextResponse.redirect(redirectUrl);
  }

  if (accessToken.appointment.status === AppointmentStatus.CANCELLED) {
    redirectUrl.searchParams.set("status", "cancelled");
    return NextResponse.redirect(redirectUrl);
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({
        where: { id: accessToken.appointment.id },
        data: {
          status: AppointmentStatus.CANCELLED,
          cancelReason: reason || null,
          cancelledAt: new Date(),
        },
      });

      await tx.appointmentItem.updateMany({
        where: { appointmentId: accessToken.appointment.id },
        data: { status: AppointmentItemStatus.CANCELLED },
      });

      await tx.appointmentAccessToken.update({
        where: { id: accessToken.id },
        data: { revokedAt: new Date() },
      });
    });

    await logAuditEvent({
      locationId: accessToken.appointment.locationId,
      actorType: AuditActorType.CUSTOMER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "appointment",
      entityId: accessToken.appointment.id,
      appointmentId: accessToken.appointment.id,
      diff: {
        previousStatus: accessToken.appointment.status,
        newStatus: AppointmentStatus.CANCELLED,
        cancelReason: reason || null,
      },
      context: { source: "booking_manage_cancel" },
      ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
      userAgent: request.headers.get("user-agent") ?? null,
    });

    redirectUrl.searchParams.set("status", "cancelled");
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    console.error("[booking:cancel] failed", error);
    redirectUrl.searchParams.set("error", "Stornierung fehlgeschlagen.");
    return NextResponse.redirect(redirectUrl);
  }
}
