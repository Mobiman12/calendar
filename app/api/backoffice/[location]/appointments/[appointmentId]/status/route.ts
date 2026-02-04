import { NextResponse } from "next/server";
import { z } from "zod";
import {
  AppointmentStatus,
  AppointmentItemStatus,
  AuditAction,
  AuditActorType,
  Prisma,
} from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getTenantIdOrThrow, resolveTenantName } from "@/lib/tenant";
import { formatPersonName } from "@/lib/staff/format-person-name";
import { createAppointmentAccessToken, buildAppointmentManageUrl } from "@/lib/appointments/access-tokens";
import { resolveCancellationDeadline } from "@/lib/appointments/cancellation";
import { createIcsEvent } from "@/lib/notifications/ics";
import { renderBookingConfirmation } from "@/lib/notifications/templates";
import { createMailer } from "@/lib/notifications/mailer";
import { executeWithCircuitBreaker } from "@/lib/circuit-breaker";
import { loadPoliciesForLocation } from "@/lib/policies";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { listSlotHoldMetadata, removeSlotHoldMetadata } from "@/lib/booking-holds";
import { publishAppointmentSync } from "@/lib/appointment-sync";
import { extractRepeatSeries } from "@/lib/appointments/repeat";

const prisma = getPrismaClient();

const allowedStatuses = new Set<AppointmentStatus>([
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.PENDING,
]);

const requestSchema = z.object({
  status: z.nativeEnum(AppointmentStatus),
  reason: z.string().trim().max(500).optional(),
  repeatScope: z.enum(["single", "following"]).optional(),
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
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  let payload: z.infer<typeof requestSchema>;
  try {
    const body = await request.json();
    payload = requestSchema.parse(body);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!allowedStatuses.has(payload.status)) {
    return NextResponse.json({ error: "Statusänderung nicht erlaubt." }, { status: 422 });
  }

  if (payload.status === AppointmentStatus.CANCELLED && !payload.reason?.trim()) {
    return NextResponse.json({ error: "Bitte gib einen Stornierungsgrund an." }, { status: 400 });
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, location: { slug: location, tenantId } },
    select: {
      id: true,
      locationId: true,
      status: true,
      source: true,
      startsAt: true,
      endsAt: true,
      confirmationCode: true,
      metadata: true,
      items: { select: { staffId: true, startsAt: true, endsAt: true } },
      customer: {
        select: { firstName: true, lastName: true, email: true },
      },
    },
  });

  if (!appointment) {
    return NextResponse.json({ error: "Termin nicht gefunden." }, { status: 404 });
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
          metadata: true,
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
          metadata: true,
        },
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

  const targetStatus = payload.status;
  const repeatScope = payload.repeatScope === "following" ? "following" : "single";
  const repeatSeries =
    repeatScope === "following" && targetStatus === AppointmentStatus.CANCELLED
      ? extractRepeatSeries(appointment.metadata)
      : null;
  const performerRole = resolvePerformerRole(performer, membershipSupported);
  const isAdmin = isAdminRole(performerRole);
  const appointmentSnapshot = {
    appointmentStartsAt: appointment.startsAt.toISOString(),
    customerName: formatPersonName(appointment.customer?.firstName ?? null, appointment.customer?.lastName ?? null),
  };

  if (targetStatus === AppointmentStatus.NO_SHOW) {
    const startRef = appointment.startsAt ?? null;
    if (startRef && new Date() < startRef) {
      return NextResponse.json(
        { error: "Als nicht erschienen ist erst nach Terminbeginn möglich." },
        { status: 400 },
      );
    }
  }

  // 24h-Frist nach Terminende: Storno nur innerhalb der Frist,
  // "Nicht erschienen" darf jederzeit gesetzt werden.
  const endRef = appointment.endsAt ?? appointment.startsAt ?? null;
  const bypassWindow =
    targetStatus === AppointmentStatus.NO_SHOW ||
    (isAdmin && targetStatus === AppointmentStatus.CANCELLED);
  if (endRef && !bypassWindow && !isAdmin) {
    const limit = new Date(endRef.getTime() + 24 * 60 * 60 * 1000);
    if (new Date() > limit) {
      return NextResponse.json(
        { error: "Statusänderung/Storno ist nur bis 24 Stunden nach Terminende möglich. Bitte wende dich an den Admin!" },
        { status: 400 },
      );
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const data: {
        status: AppointmentStatus;
        cancelReason?: string | null;
        cancelledAt?: Date | null;
      } = { status: targetStatus };

      if (targetStatus === AppointmentStatus.CANCELLED) {
        data.cancelReason = payload.reason?.trim() ?? null;
        data.cancelledAt = new Date();
      } else if (appointment.status === AppointmentStatus.CANCELLED) {
        data.cancelReason = null;
        data.cancelledAt = null;
      }

      if (repeatSeries) {
        const seriesAppointments = await tx.appointment.findMany({
          where: {
            locationId: appointment.locationId,
            startsAt: { gte: appointment.startsAt },
            metadata: { path: ["repeat", "seriesId"], equals: repeatSeries.seriesId },
          },
          select: { id: true },
        });

        const seriesIds = seriesAppointments.map((entry) => entry.id);
        if (!seriesIds.length) {
          return { updated: null, updatedIds: [] };
        }

        await tx.appointment.updateMany({
          where: { id: { in: seriesIds } },
          data,
        });

        if (targetStatus === AppointmentStatus.CANCELLED) {
          await tx.appointmentItem.updateMany({
            where: { appointmentId: { in: seriesIds } },
            data: { status: AppointmentItemStatus.CANCELLED },
          });
        }

        const updated = await tx.appointment.findUnique({
          where: { id: appointment.id },
          select: {
            id: true,
            status: true,
            cancelReason: true,
            cancelledAt: true,
          },
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
            previousStatus: appointment.status,
            newStatus: targetStatus,
            reason: payload.reason ?? null,
            performedByStaff: performerInfo,
            repeatScope,
            affectedCount: seriesIds.length,
          },
          context: {
            source: "backoffice_status_update",
            performedByStaff: performerInfo,
            appointmentSnapshot,
          },
          ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
          userAgent: request.headers.get("user-agent") ?? null,
        });

        return { updated, updatedIds: seriesIds };
      }

      const updated = await tx.appointment.update({
        where: { id: appointment.id },
        data,
        select: {
          id: true,
          status: true,
          cancelReason: true,
          cancelledAt: true,
        },
      });

      if (targetStatus === AppointmentStatus.CANCELLED) {
        await tx.appointmentItem.updateMany({
          where: { appointmentId: appointment.id },
          data: { status: AppointmentItemStatus.CANCELLED },
        });
      } else if (targetStatus === AppointmentStatus.COMPLETED) {
        await tx.appointmentItem.updateMany({
          where: { appointmentId: appointment.id },
          data: { status: AppointmentItemStatus.COMPLETED },
        });
      } else if (
        targetStatus === AppointmentStatus.CONFIRMED ||
        targetStatus === AppointmentStatus.PENDING
      ) {
        await tx.appointmentItem.updateMany({
          where: { appointmentId: appointment.id, status: { in: [AppointmentItemStatus.CANCELLED, AppointmentItemStatus.PENDING] } },
          data: { status: AppointmentItemStatus.SCHEDULED },
        });
      }

      await logAuditEvent({
        locationId: appointment.locationId,
        actorType: AuditActorType.USER,
        actorId: null,
        action: AuditAction.UPDATE,
        entityType: "appointment",
        entityId: appointment.id,
        appointmentId: appointment.id,
        diff: {
          previousStatus: appointment.status,
          newStatus: targetStatus,
          reason: payload.reason ?? null,
          performedByStaff: performerInfo,
        },
        context: {
          source: "backoffice_status_update",
          performedByStaff: performerInfo,
          appointmentSnapshot,
        },
        ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
        userAgent: request.headers.get("user-agent") ?? null,
      });

      return { updated, updatedIds: [appointment.id] };
    });

    if (!result.updated) {
      return NextResponse.json({ error: "Status konnte nicht aktualisiert werden." }, { status: 500 });
    }

    const shouldSendConfirmation =
      appointment.status === AppointmentStatus.PENDING &&
      targetStatus === AppointmentStatus.CONFIRMED &&
      appointment.source === "WEB";
    if (shouldSendConfirmation) {
      try {
        await sendOnlineConfirmationEmail({
          appointmentId: appointment.id,
          locationId: appointment.locationId,
          tenantId,
        });
      } catch (error) {
        console.warn("[appointment:status] confirmation email failed", error);
      }
    }

    if (targetStatus === AppointmentStatus.CANCELLED) {
      if (repeatSeries && result.updatedIds.length) {
        const items = await prisma.appointmentItem.findMany({
          where: { appointmentId: { in: result.updatedIds } },
          select: { staffId: true, startsAt: true, endsAt: true },
        });
        await removeManualHoldsForAppointment(appointment.locationId, items);
      } else if (appointment.items.length) {
        await removeManualHoldsForAppointment(appointment.locationId, appointment.items);
      }
    }

    for (const updatedId of result.updatedIds) {
      await publishAppointmentSync({
        locationId: appointment.locationId,
        action: "status",
        appointmentId: updatedId,
        timestamp: Date.now(),
      });
    }

    return NextResponse.json({ data: result.updated });
  } catch (error) {
    console.error("[appointment:status] failed", error);
    return NextResponse.json({ error: "Status konnte nicht aktualisiert werden." }, { status: 500 });
  }
}

async function sendOnlineConfirmationEmail(params: {
  appointmentId: string;
  locationId: string;
  tenantId: string;
}) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: params.appointmentId },
    select: {
      id: true,
      confirmationCode: true,
      startsAt: true,
      endsAt: true,
      locationId: true,
      customer: { select: { firstName: true, lastName: true, email: true } },
      items: { select: { service: { select: { id: true, name: true, duration: true } } } },
    },
  });

  if (!appointment || !appointment.customer || !appointment.customer.email) return;
  const customer = appointment.customer;
  const customerEmail = customer.email;
  if (!customerEmail) return;

  const location = await prisma.location.findUnique({
    where: { id: params.locationId },
    select: {
      id: true,
      name: true,
      email: true,
      city: true,
      addressLine1: true,
      timezone: true,
      tenantId: true,
      metadata: true,
      tenant: { select: { name: true } },
    },
  });

  if (!location) return;

  const locationMetadata =
    location.metadata && typeof location.metadata === "object" && !Array.isArray(location.metadata)
      ? (location.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const policies = await loadPoliciesForLocation(location.id);
  const cancellationDeadline = resolveCancellationDeadline({
    startsAt: appointment.startsAt,
    policies,
    bookingPreferences,
  });
  const tokenExpiresAt = cancellationDeadline ?? appointment.startsAt;
  const accessToken = await createAppointmentAccessToken(appointment.id, tokenExpiresAt);
  const manageUrl = buildAppointmentManageUrl(params.tenantId, accessToken.token);

  const customerName =
    `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.replace(/\s+/g, " ").trim() || "Kunde";
  const locationLabel =
    [location.name, location.addressLine1, location.city].filter(Boolean).join(" · ") || undefined;
  const tenantName =
    (await resolveTenantName(location.tenantId, location.tenant?.name ?? location.name)) ??
    location.name ??
    "Dein Team";
  const emailSenderName = bookingPreferences.emailSenderName.trim() || tenantName;
  const replyTo =
    bookingPreferences.emailReplyToEnabled && bookingPreferences.emailReplyTo.trim()
      ? bookingPreferences.emailReplyTo.trim()
      : undefined;

  const services = appointment.items
    .map((item) => item.service)
    .filter((service): service is { id: string; name: string; duration: number } => Boolean(service));

  const ics = createIcsEvent({
    summary: `Termin im ${location.name ?? "Salon"}`,
    description: "Wir freuen uns auf dich!",
    location: locationLabel,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    organizer: {
      name: location.name ?? "Timevex Calendar",
      email: location.email ?? "noreply@example.com",
    },
    attendees: [
      {
        name: customerName,
        email: customerEmail,
      },
    ],
    remindersMinutesBefore: [60],
  });

  const template = renderBookingConfirmation({
    customerName,
    locationName: location.name ?? "Dein Salon",
    start: appointment.startsAt,
    end: appointment.endsAt,
    timeZone: location.timezone ?? "Europe/Berlin",
    services: services.map((service) => ({ name: service.name, duration: service.duration })),
    confirmationCode: appointment.confirmationCode,
    manageUrl,
  });

  const mailer = await createMailer();
  await executeWithCircuitBreaker(
    "mailer:appointment-status-confirmation",
    { failureThreshold: 3, cooldownMs: 5 * 60 * 1000 },
    () =>
      mailer.sendBookingConfirmation({
        to: {
          name: customerName,
          email: customerEmail,
        },
        fromName: emailSenderName,
        replyTo,
        subject: template.subject,
        textBody: template.text,
        htmlBody: template.html,
        attachments: [
          {
            filename: `termin-${appointment.confirmationCode}.ics`,
            content: ics,
            contentType: "text/calendar; charset=utf-8",
          },
        ],
        metadata: {
          appointmentId: appointment.id,
        },
      }),
  );
}

async function removeManualHoldsForAppointment(
  locationId: string,
  items: Array<{ staffId: string | null; startsAt: Date; endsAt: Date }>,
) {
  const relevantItems = items.filter((item) => item.staffId);
  if (!relevantItems.length) return;
  try {
    const holds = await listSlotHoldMetadata(locationId);
    const toRemove = holds.filter((hold) => {
      if (!hold.slotKey.includes("|manual:")) return false;
      const holdStart = Date.parse(hold.reservedFrom);
      const holdEnd = Date.parse(hold.reservedTo);
      if (!Number.isFinite(holdStart) || !Number.isFinite(holdEnd)) return false;
      return relevantItems.some((item) => {
        if (!item.staffId || item.staffId !== hold.staffId) return false;
        return holdStart < item.endsAt.getTime() && holdEnd > item.startsAt.getTime();
      });
    });
    if (!toRemove.length) return;
    await Promise.all(toRemove.map((hold) => removeSlotHoldMetadata(hold.slotKey)));
  } catch (error) {
    console.warn("[appointment:status] hold cleanup failed", error);
  }
}

type StaffMembershipRole = { role: string | null };
type PerformerWithMemberships = {
  metadata: Prisma.JsonValue | null;
  memberships: StaffMembershipRole[];
};
type PerformerWithoutMemberships = {
  metadata: Prisma.JsonValue | null;
};
type PerformerCandidate = PerformerWithMemberships | PerformerWithoutMemberships;

function resolvePerformerRole(performer: PerformerCandidate, membershipSupported: boolean): string | null {
  const membershipRole =
    membershipSupported && "memberships" in performer
      ? performer.memberships.find((entry) => typeof entry.role === "string" && entry.role.trim().length)?.role ?? null
      : null;
  const normalizedMembershipRole = normalizeRole(membershipRole);
  if (isAdminRole(normalizedMembershipRole)) {
    return normalizedMembershipRole;
  }
  const metadataRole = extractRoleFromStaffMetadata(performer.metadata);
  const normalizedMetadataRole = normalizeRole(metadataRole);
  if (isAdminRole(normalizedMetadataRole)) {
    return normalizedMetadataRole;
  }
  return normalizedMembershipRole ?? normalizedMetadataRole;
}

function isAdminRole(role: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return normalized === "2" || normalized === "admin";
}

function normalizeRole(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function extractRoleFromStaffMetadata(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const stundenliste = record.stundenliste;
  if (!isPlainObject(stundenliste)) {
    return null;
  }

  const role =
    normalizeRole((stundenliste as Record<string, unknown>).roleId) ??
    normalizeRole((stundenliste as Record<string, unknown>).role);
  if (role) {
    return role;
  }

  const permissions = (stundenliste as Record<string, unknown>).permissions;
  if (Array.isArray(permissions)) {
    const adminPermission = permissions.find((permission) => {
      const normalized = normalizeRole(permission);
      return normalized && isAdminRole(normalized);
    });
    if (adminPermission) {
      return normalizeRole(adminPermission);
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
