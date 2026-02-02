import { NextResponse } from "next/server";
import { addMinutes, differenceInMinutes, min as minDate, max as maxDate } from "date-fns";
import { Prisma, AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getInternalNoteFromMetadata } from "@/lib/appointments/internal-notes";
import { buildUpdatedMetadata } from "@/lib/appointments/metadata";
import { extractRepeatSeries } from "@/lib/appointments/repeat";
import { buildAppointmentManageUrl, buildAppointmentSmsUrl, createAppointmentAccessToken } from "@/lib/appointments/access-tokens";
import { resolveCancellationDeadline } from "@/lib/appointments/cancellation";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { executeWithCircuitBreaker } from "@/lib/circuit-breaker";
import { formatPersonName } from "@/lib/staff/format-person-name";
import { createIcsEvent } from "@/lib/notifications/ics";
import { createMailer } from "@/lib/notifications/mailer";
import { renderBookingConfirmation } from "@/lib/notifications/templates";
import { isSmsConfigured, isWhatsappConfigured, sendSms } from "@/lib/notifications/sms";
import { sendWhatsAppNotification } from "@/lib/notifications/whatsapp";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { loadPoliciesForLocation } from "@/lib/policies";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { getStundenlisteClient, listEmployeesCached } from "@/lib/stundenliste-client";
import type { AppointmentDetailPayload } from "@/components/appointments/types";
import {
  SERVICE_ASSIGNMENT_NONE_KEY,
  buildServiceStaffAssignmentsFromItems,
  buildServiceStaffAssignmentsFromPayload,
} from "@/lib/appointments/service-assignments";
import { getTenantIdOrThrow, resolveTenantName } from "@/lib/tenant";
import { publishAppointmentSync } from "@/lib/appointment-sync";

type StaffMembershipRole = { role: string | null };
export type PerformerCandidateWithMemberships = {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  code: string | null;
  metadata: Prisma.JsonValue | null;
  memberships: StaffMembershipRole[];
};
export type PerformerCandidateWithoutMemberships = {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  code: string | null;
  metadata: Prisma.JsonValue | null;
};
export type PerformerCandidate = PerformerCandidateWithMemberships | PerformerCandidateWithoutMemberships;

type ServiceUpdatePayload = {
  id: string;
  durationOverride?: number;
  priceOverride?: number;
  staffIds?: string[];
};

const prisma = getPrismaClient();

type AppointmentDetailCacheEntry = {
  timestamp: number;
  payload: AppointmentDetailPayload;
};

type AppointmentDetailCacheStore = {
  entries?: Map<string, AppointmentDetailCacheEntry>;
};

function getAppointmentDetailCacheStore(): AppointmentDetailCacheStore {
  const globalObject = globalThis as typeof globalThis & { __appointmentDetailCache__?: AppointmentDetailCacheStore };
  if (!globalObject.__appointmentDetailCache__) {
    globalObject.__appointmentDetailCache__ = {};
  }
  const store = globalObject.__appointmentDetailCache__;
  if (!store.entries) {
    store.entries = new Map();
  }
  return store;
}

const APPOINTMENT_DETAIL_CACHE_TTL_MS = 30 * 1000;


export async function GET(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  try {
    const { location, appointmentId } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

    const url = new URL(request.url);
    const itemId = url.searchParams.get("itemId");

    let appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, location: { slug: location, tenantId } },
      include: appointmentInclude,
    });

    const resolveByItem = async (targetItemId: string | null) => {
      if (!targetItemId) return null;
      const item = await prisma.appointmentItem.findFirst({
        where: { id: targetItemId, appointment: { location: { slug: location, tenantId } } },
        select: { appointmentId: true },
      });
      if (!item?.appointmentId) return null;
      return prisma.appointment.findFirst({
        where: { id: item.appointmentId, location: { slug: location, tenantId } },
        include: appointmentInclude,
      });
    };

    if (!appointment) {
      appointment = await resolveByItem(appointmentId);
    }

    if (!appointment && itemId) {
      appointment = await resolveByItem(itemId);
    }

    if (!appointment) {
      console.warn("[appointment:detail] not found", {
        location,
        appointmentId,
        itemId,
      });
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }

  const locationName = appointment.location?.name ?? "";
  const locationAddress = [appointment.location?.addressLine1, appointment.location?.city]
    .filter(Boolean)
    .join(", ");
  const customerName = formatPersonName(appointment.customer?.firstName, appointment.customer?.lastName);
  const serviceSummary = appointment.items.map((item) => item.service?.name).filter(Boolean).join(" · ") || "Termin";

  let ics = "";
  try {
    ics = createIcsEvent({
      summary: `${serviceSummary} – ${customerName || "Kunde"}`,
      description: appointment.note ?? undefined,
      location: [locationName, locationAddress].filter(Boolean).join(" · ") || undefined,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      createdAt: appointment.createdAt,
      updatedAt: appointment.updatedAt,
      attendees: appointment.customer
        ? [
            {
              name: customerName || "Kunde",
              email: appointment.customer.email ?? undefined,
              role: "REQ-PARTICIPANT",
            },
          ]
        : undefined,
      status:
        appointment.status === "CANCELLED"
          ? "CANCELLED"
          : appointment.status === "CONFIRMED"
          ? "CONFIRMED"
          : "TENTATIVE",
    });
  } catch (error) {
    console.error("[appointment:ics] failed", error);
    ics = "";
  }

    const itemStarts = appointment.items.map((item) => item.startsAt);
    const itemEnds = appointment.items.map((item) => item.endsAt);
    const derivedStartsAt = itemStarts.length ? minDate(itemStarts) : appointment.startsAt;
    const derivedEndsAt = itemEnds.length ? maxDate(itemEnds) : appointment.endsAt;

    console.info("[appointment:detail] success", {
      location,
      appointmentId: appointment.id,
      itemCount: appointment.items.length,
    });

    const responsePayload: AppointmentDetailPayload = {
      appointment: {
      id: appointment.id,
      confirmationCode: appointment.confirmationCode,
      status: appointment.status,
      paymentStatus: appointment.paymentStatus,
      source: appointment.source,
      startsAt: derivedStartsAt.toISOString(),
      endsAt: derivedEndsAt.toISOString(),
      createdAt: appointment.createdAt.toISOString(),
      updatedAt: appointment.updatedAt.toISOString(),
      totalAmount: decimalToNumber(appointment.totalAmount),
      depositAmount: appointment.depositAmount ? decimalToNumber(appointment.depositAmount) : null,
      currency: appointment.currency,
      note: appointment.note ?? null,
      internalNote: getInternalNoteFromMetadata(appointment.metadata) ?? null,
      internalNoteIsTitle: false,
      cancelReason: appointment.cancelReason ?? null,
      metadata: appointment.metadata,
      durationMinutes: differenceInMinutes(derivedEndsAt, derivedStartsAt),
      customer: appointment.customer
        ? {
            id: appointment.customer.id,
            name: customerName || "Unbekannt",
            email: appointment.customer.email ?? null,
            phone: appointment.customer.phone ?? null,
            notes: appointment.customer.notes ?? null,
          }
        : null,
      items: appointment.items.map((item) => ({
        id: item.id,
        status: item.status,
        startsAt: item.startsAt.toISOString(),
        endsAt: item.endsAt.toISOString(),
        price: decimalToNumber(item.price),
        currency: item.currency,
        notes: item.notes ?? null,
        service: item.service
          ? {
              id: item.service.id,
              name: item.service.name,
              duration: item.service.duration,
            }
          : null,
        staff: item.staff
          ? {
              id: item.staff.id,
              name: item.staff.displayName || formatPersonName(item.staff.firstName, item.staff.lastName) || "Team",
            }
          : null,
        resource: item.resource
          ? {
              id: item.resource.id,
              name: item.resource.name,
              type: item.resource.type,
            }
          : null,
      })),
      attachments: appointment.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        createdAt: attachment.createdAt.toISOString(),
      })),
      notifications: appointment.notifications.map((notification) => ({
        id: notification.id,
        channel: notification.channel,
        trigger: notification.trigger,
        type: notification.trigger,
        status: notification.status,
        scheduledAt: notification.scheduledAt?.toISOString() ?? null,
        sentAt: notification.sentAt?.toISOString() ?? null,
        createdAt: notification.createdAt.toISOString(),
        error: notification.error ?? null,
        metadata:
          notification.metadata && typeof notification.metadata === "object"
            ? (notification.metadata as Record<string, unknown>)
            : null,
      })),
      paymentHistory: extractPaymentHistory(appointment.metadata).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    },
    auditTrail: appointment.auditLogs.map((log) => ({
      id: log.id,
      action: log.action,
      actorType: log.actorType,
      actor: log.actor
        ? {
            id: log.actor.id,
            email: log.actor.email,
            name:
              log.actor.staff?.displayName ??
              formatPersonName(log.actor.staff?.firstName, log.actor.staff?.lastName) ??
              log.actor.email,
          }
        : null,
      context: log.context,
      diff: log.diff,
      createdAt: log.createdAt.toISOString(),
    })),
    ics,
    };

    const cacheStore = getAppointmentDetailCacheStore();
    cacheStore.entries?.set(`${location}:${appointmentId}:${itemId ?? "_"}`, {
      timestamp: Date.now(),
      payload: responsePayload,
    });

    return NextResponse.json(responsePayload);
  } catch (error) {
    console.error("[appointment:detail] unexpected error", error);
    const message = error instanceof Error ? error.message : "Termindetails konnten nicht geladen werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  try {
    const { location, appointmentId } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), {
      locationSlug: location,
    });
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: "Ungültige Anfrage." }, { status: 400 });
    }
    const bodyRecord = body as Record<string, unknown>;
    const serviceUpdates = Array.isArray(bodyRecord.services)
      ? (bodyRecord.services as ServiceUpdatePayload[])
      : null;
    if (serviceUpdates && serviceUpdates.length) {
      return await handleFullAppointmentUpdate({
        request,
        location,
        appointmentId,
        tenantId,
        body: bodyRecord,
        services: serviceUpdates,
      });
    }

    const { itemId, serviceId, staffId, startsAt, endsAt, note, internalMessage, performedBy } = body as {
      itemId?: string;
      serviceId?: string;
      staffId?: string | null;
      startsAt?: string;
      endsAt?: string;
      note?: string | null;
      internalMessage?: string | null;
      performedBy?: { staffId: string; token: string };
    };
    console.info("[appointment:update] payload", {
      appointmentId,
      itemId,
      serviceId,
      staffId,
      startsAt,
      endsAt,
      location,
    });

    if (!performedBy?.staffId || !performedBy?.token) {
      return NextResponse.json({ error: "Buchungs-PIN fehlt." }, { status: 400 });
    }

    if (!itemId || !serviceId || !startsAt || !endsAt) {
      return NextResponse.json({ error: "Erforderliche Felder fehlen." }, { status: 400 });
    }

    const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, location: { slug: location, tenantId: tenantId } },
      select: {
        id: true,
        locationId: true,
        startsAt: true,
        endsAt: true,
        status: true,
        note: true,
        metadata: true,
      },
    });

    if (!appointment) {
      return NextResponse.json({ error: "Termin wurde nicht gefunden." }, { status: 404 });
    }

    const membershipSupported = await supportsStaffMemberships(prisma);

    let performer: PerformerCandidate | null = null;
    if (membershipSupported) {
      performer = await prisma.staff.findFirst({
        where: {
          id: performedBy.staffId,
          memberships: { some: { locationId: appointment.locationId } },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          code: true,
          metadata: true,
          memberships: {
            where: { locationId: appointment.locationId },
            select: { role: true },
          },
        },
      }) as PerformerCandidateWithMemberships | null;
    } else {
      performer = await prisma.staff.findFirst({
        where: {
          id: performedBy.staffId,
          locationId: appointment.locationId,
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          code: true,
          metadata: true,
        },
      }) as PerformerCandidateWithoutMemberships | null;
    }

    if (!performer || !verifyBookingPinToken(performedBy.token, performer.id)) {
      return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
    }

    const performerName =
      performer.displayName?.trim() ||
      formatPersonName(performer.firstName, performer.lastName) ||
      "Mitarbeiter";
    const performerInfo = {
      staffId: performer.id,
      staffName: performerName,
    };

    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return NextResponse.json({ error: "Ungültige Datumsangaben." }, { status: 400 });
    }
    if (endDate <= startDate) {
      return NextResponse.json({ error: "Endzeit muss nach Startzeit liegen." }, { status: 400 });
    }

    const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
    const userAgent = request.headers.get("user-agent") ?? null;

    const targetItem = await prisma.appointmentItem.findFirst({
      where: {
        id: itemId,
        appointmentId: appointment.id,
        appointment: { location: { tenantId } },
      },
      select: {
        id: true,
        staffId: true,
        serviceId: true,
        startsAt: true,
        endsAt: true,
        staff: {
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!targetItem) {
      return NextResponse.json({ error: "Terminposition nicht gefunden." }, { status: 404 });
    }

    const now = new Date();
    const EDIT_GRACE_MS = 24 * 60 * 60 * 1000; // 24h nach Start/Ende bearbeitbar
    const graceCutoff =
      appointment.endsAt
        ? new Date(appointment.endsAt.getTime() + EDIT_GRACE_MS)
        : new Date(appointment.startsAt.getTime() + EDIT_GRACE_MS);
    if (now > graceCutoff) {
      return NextResponse.json(
        { error: "Termine können nur bis 24h nach Beginn/Ende bearbeitet werden." },
        { status: 400 },
      );
    }

    const service = await prisma.service.findFirst({
      where: { id: serviceId, locationId: appointment.locationId },
      select: { id: true, name: true },
    });
    if (!service) {
      return NextResponse.json({ error: "Leistung konnte nicht gefunden werden." }, { status: 400 });
    }

    const previousStaffName =
      targetItem.staff?.displayName?.trim() ||
      formatPersonName(targetItem.staff?.firstName, targetItem.staff?.lastName) ||
      null;
    const previousServiceName = targetItem.service?.name ?? null;

    let staffUpdateId: string | null;
    let staffUpdateName: string | null = null;
    if (staffId === undefined) {
      staffUpdateId = targetItem.staffId ?? null;
    } else if (staffId) {
      let staff;
      if (membershipSupported) {
        staff = await prisma.staff.findFirst({
          where: {
            id: staffId,
            memberships: { some: { locationId: appointment.locationId } },
          },
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
          },
        });
      } else {
        staff = await prisma.staff.findFirst({
          where: { id: staffId, locationId: appointment.locationId },
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
          },
        });
      }
      if (!staff) {
        return NextResponse.json({ error: "Mitarbeiter konnte nicht gefunden werden." }, { status: 400 });
      }
      staffUpdateId = staff.id;
      staffUpdateName =
        staff.displayName?.trim() || formatPersonName(staff.firstName, staff.lastName) || "Mitarbeiter";
    } else {
      staffUpdateId = null;
    }

      const result = await prisma.$transaction(async (tx) => {
        await tx.appointmentItem.update({
          where: { id: itemId },
          data: {
            startsAt: startDate,
            endsAt: endDate,
          staffId: staffUpdateId,
          serviceId,
        },
      });

        const updatedItems = await tx.appointmentItem.findMany({
          where: { appointmentId },
          select: { id: true, startsAt: true, endsAt: true, staffId: true, serviceId: true },
        });
        const updatedAssignedStaffIds = Array.from(
          new Set(
            updatedItems
            .map((item) => item.staffId)
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
        ),
      );

      const bounds = await tx.appointmentItem.aggregate({
        where: { appointmentId },
        _min: { startsAt: true },
        _max: { endsAt: true },
      });

      const timestamp = new Date();
      const updatedAppointment = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          startsAt: bounds._min.startsAt ?? startDate,
          endsAt: bounds._max.endsAt ?? endDate,
          note: note ?? null,
          metadata: buildUpdatedMetadata(
            appointment.metadata,
            performerInfo,
            timestamp,
            updatedAssignedStaffIds,
            buildServiceStaffAssignmentsFromItems(
              updatedItems.map((entry) => ({
                serviceId: entry.serviceId ?? null,
                staffId: entry.staffId ?? null,
              })),
            ),
            typeof internalMessage === "string" ? internalMessage.trim() : undefined,
          ),
          updatedAt: timestamp,
        },
      });

      return {
        appointment: updatedAppointment,
        items: updatedItems,
      };
    });

    const updatedItem = result.items.find((entry) => entry.id === itemId) ?? null;
    const diffPayload: Record<string, unknown> = {
      itemId,
      itemLabel: {
        id: itemId,
        serviceName: previousServiceName ?? service.name,
      },
      performedByStaff: performerInfo,
    };

    if (targetItem.serviceId !== serviceId) {
      diffPayload.service = {
        previousServiceId: targetItem.serviceId ?? null,
        previousServiceName,
        newServiceId: serviceId,
        newServiceName: service.name,
      };
    }

    if ((targetItem.staffId ?? null) !== (staffUpdateId ?? null)) {
      diffPayload.staff = {
        previousStaffId: targetItem.staffId ?? null,
        previousStaffName,
        newStaffId: staffUpdateId,
        newStaffName: staffUpdateName,
      };
    }

    if (
      targetItem.startsAt.getTime() !== startDate.getTime() ||
      targetItem.endsAt.getTime() !== endDate.getTime()
    ) {
      diffPayload.itemTiming = {
        previousStartsAt: targetItem.startsAt.toISOString(),
        previousEndsAt: targetItem.endsAt.toISOString(),
        newStartsAt: startDate.toISOString(),
        newEndsAt: endDate.toISOString(),
      };
    }

    const previousAppointmentStartsAt = appointment.startsAt.toISOString();
    const nextAppointmentStartsAt = result.appointment.startsAt.toISOString();
    if (previousAppointmentStartsAt !== nextAppointmentStartsAt) {
      diffPayload.appointmentStartsAt = {
        previous: previousAppointmentStartsAt,
        next: nextAppointmentStartsAt,
      };
    }

    const previousAppointmentEndsAt = appointment.endsAt ? appointment.endsAt.toISOString() : null;
    const nextAppointmentEndsAt = result.appointment.endsAt.toISOString();
    if (previousAppointmentEndsAt !== nextAppointmentEndsAt) {
      diffPayload.appointmentEndsAt = {
        previous: previousAppointmentEndsAt,
        next: nextAppointmentEndsAt,
      };
    }

    const previousNote = appointment.note ?? null;
    const nextNote = note ?? null;
    if (previousNote !== nextNote) {
      diffPayload.note = {
        previous: previousNote,
        next: nextNote,
      };
    }

    if (updatedItem) {
      const resultingStaffName =
        updatedItem.staffId !== null
          ? staffUpdateName ?? previousStaffName ?? null
          : "Nicht definiert";
      const resultingServiceName =
        serviceId === targetItem.serviceId ? previousServiceName ?? service.name : service.name;
      diffPayload.resultingItem = {
        id: updatedItem.id,
        staffId: updatedItem.staffId ?? null,
        staffName: resultingStaffName,
        serviceId: updatedItem.serviceId,
        serviceName: resultingServiceName,
        startsAt: updatedItem.startsAt.toISOString(),
        endsAt: updatedItem.endsAt.toISOString(),
      };
    }

    await logAuditEvent({
      locationId: appointment.locationId,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "appointment",
      entityId: appointment.id,
      appointmentId: appointment.id,
      diff: diffPayload,
      context: { source: "backoffice_update", performedByStaff: performerInfo },
      ipAddress,
      userAgent,
    });

    console.info("[appointment:update] success", {
      location,
      appointmentId,
      itemId,
    });

    await publishAppointmentSync({
      locationId: result.appointment.locationId,
      action: "updated",
      appointmentId: result.appointment.id,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      data: {
        appointmentId: result.appointment.id,
        startsAt: result.appointment.startsAt.toISOString(),
        endsAt: result.appointment.endsAt.toISOString(),
        items: result.items.map((item) => ({
          id: item.id,
          startsAt: item.startsAt.toISOString(),
          endsAt: item.endsAt.toISOString(),
          staffId: item.staffId,
        })),
      },
    });
  } catch (error) {
    console.error("[appointment:update] unexpected error", error);
    const message = error instanceof Error ? error.message : "Termin konnte nicht aktualisiert werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handleFullAppointmentUpdate({
  request,
  location,
  appointmentId,
  tenantId,
  body,
  services,
}: {
  request: Request;
  location: string;
  appointmentId: string;
  tenantId: string;
  body: Record<string, unknown>;
  services: ServiceUpdatePayload[];
}) {
  const performedBy = body.performedBy as { staffId: string; token: string } | undefined;
  if (!performedBy?.staffId || !performedBy?.token) {
    return NextResponse.json({ error: "Buchungs-PIN fehlt." }, { status: 400 });
  }
  const requestedSendSms = typeof body.sendSms === "boolean" ? body.sendSms : false;
  const requestedSendWhatsApp = typeof body.sendWhatsApp === "boolean" ? body.sendWhatsApp : false;
  const requestedWhatsAppOptIn = typeof body.whatsAppOptIn === "boolean" ? body.whatsAppOptIn : false;
  const startsAtValue = body.startsAt;
  if (typeof startsAtValue !== "string" || !startsAtValue) {
    return NextResponse.json({ error: "Startzeitpunkt fehlt." }, { status: 400 });
  }
  const startDate = new Date(startsAtValue);
  if (Number.isNaN(startDate.getTime())) {
    return NextResponse.json({ error: "Ungültiger Startzeitpunkt." }, { status: 400 });
  }
  const endsAtValue = typeof body.endsAt === "string" ? body.endsAt : null;
  let endDate: Date | null = null;
  let overrideTotalDuration: number | null = null;
  if (endsAtValue) {
    endDate = new Date(endsAtValue);
    if (Number.isNaN(endDate.getTime())) {
      return NextResponse.json({ error: "Ungültiger Endzeitpunkt." }, { status: 400 });
    }
    if (endDate <= startDate) {
      return NextResponse.json({ error: "Endzeit muss nach Startzeit liegen." }, { status: 400 });
    }
    overrideTotalDuration = differenceInMinutes(endDate, startDate);
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, location: { slug: location, tenantId } },
    select: {
      id: true,
      locationId: true,
      customerId: true,
      metadata: true,
      currency: true,
      startsAt: true,
      endsAt: true,
    },
  });

  if (!appointment) {
    return NextResponse.json({ error: "Termin wurde nicht gefunden." }, { status: 404 });
  }

  const locationRecord = await prisma.location.findFirst({
    where: { id: appointment.locationId, tenantId },
    select: { id: true, metadata: true },
  });
  const locationMetadata =
    locationRecord?.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const manualConfirmationMode = bookingPreferences.manualConfirmationMode ?? "both";
  const wantsWhatsApp = requestedSendWhatsApp && requestedWhatsAppOptIn;
  const effectiveSendSms =
    manualConfirmationMode === "both" ? requestedSendSms : wantsWhatsApp ? false : requestedSendSms;
  const effectiveSendWhatsApp = wantsWhatsApp;
  const shouldSendNotifications = effectiveSendSms || effectiveSendWhatsApp;

  const membershipSupported = await supportsStaffMemberships(prisma);
  const customerMembershipSupported = await supportsCustomerMemberships(prisma);
  let performer: PerformerCandidate | null = null;
  if (membershipSupported) {
    performer = (await prisma.staff.findFirst({
      where: {
        id: performedBy.staffId,
        memberships: { some: { locationId: appointment.locationId } },
        location: { tenantId },
      },
      select: {
        id: true,
        displayName: true,
        firstName: true,
        lastName: true,
        code: true,
        metadata: true,
        memberships: {
          where: { locationId: appointment.locationId },
          select: { role: true },
        },
      },
    })) as PerformerCandidateWithMemberships | null;
  } else {
    performer = (await prisma.staff.findFirst({
      where: {
        id: performedBy.staffId,
        locationId: appointment.locationId,
        location: { tenantId },
      },
      select: {
        id: true,
        displayName: true,
        firstName: true,
        lastName: true,
        code: true,
        metadata: true,
      },
    })) as PerformerCandidateWithoutMemberships | null;
  }

  if (!performer || !verifyBookingPinToken(performedBy.token, performer.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  const performerName =
    performer.displayName?.trim() ||
    formatPersonName(performer.firstName, performer.lastName) ||
    "Mitarbeiter";
  const performerInfo = {
    staffId: performer.id,
    staffName: performerName,
  };

  const rawCustomerId = typeof body.customerId === "string" ? body.customerId.trim() : "";
  const requestedCustomerId = rawCustomerId.length ? rawCustomerId : null;
  const existingCustomerId = appointment.customerId ?? null;

  if (existingCustomerId && requestedCustomerId && requestedCustomerId !== existingCustomerId) {
    return NextResponse.json({ error: "Kunde kann nicht geändert werden." }, { status: 400 });
  }

  let targetCustomerId = existingCustomerId;
  if (!existingCustomerId && requestedCustomerId) {
    const customerScope: Prisma.CustomerWhereInput = customerMembershipSupported
      ? {
          id: requestedCustomerId,
          OR: [
            { locationId: appointment.locationId },
            { memberships: { some: { locationId: appointment.locationId } } },
          ],
        }
      : {
          id: requestedCustomerId,
          locationId: appointment.locationId,
        };
    const customerRecord = await prisma.customer.findFirst({
      where: customerScope,
      select: { id: true },
    });
    if (!customerRecord) {
      return NextResponse.json(
        { error: "Der ausgewählte Kunde gehört nicht zu diesem Standort." },
        { status: 400 },
      );
    }
    targetCustomerId = requestedCustomerId;
  }

  const serviceIds = services
    .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
    .filter((id): id is string => id.length > 0);
  if (!serviceIds.length) {
    return NextResponse.json({ error: "Mindestens eine Leistung wird benötigt." }, { status: 400 });
  }
  const uniqueServiceIds = Array.from(new Set(serviceIds));

  const serviceRecords = await prisma.service.findMany({
    where: {
      id: { in: uniqueServiceIds },
      locationId: appointment.locationId,
      status: "ACTIVE",
    },
    include: {
      steps: {
        orderBy: { order: "asc" },
        include: {
          resources: {
            include: { resource: true },
          },
        },
      },
    },
  });

  if (serviceRecords.length !== uniqueServiceIds.length) {
    return NextResponse.json({ error: "Mindestens eine Leistung konnte nicht geladen werden." }, { status: 404 });
  }

  const servicesById = new Map(serviceRecords.map((service) => [service.id, service]));
  const orderedServices = services
    .map((entry) => {
      const record = servicesById.get(entry.id);
      return record ? { entry, record } : null;
    })
    .filter((value): value is { entry: ServiceUpdatePayload; record: (typeof serviceRecords)[number] } => Boolean(value));

  if (!orderedServices.length) {
    return NextResponse.json({ error: "Keine gültigen Leistungen vorhanden." }, { status: 400 });
  }

  const serviceStaffAssignments = buildServiceStaffAssignmentsFromPayload(services);
  const assignmentUnion = Array.from(new Set(Object.values(serviceStaffAssignments).flat()));

  const itemPayloads: Array<{
    serviceId: string;
    staffId: string | null;
    startsAt: Date;
    endsAt: Date;
    price: Prisma.Decimal;
    metadata: Prisma.JsonObject;
  }> = [];

  let cursor = new Date(startDate);
  for (const { entry, record } of orderedServices) {
    const duration =
      entry.durationOverride ??
      (services.length === 1 && overrideTotalDuration !== null ? overrideTotalDuration : record.duration);
    const serviceEnds = addMinutes(cursor, duration);
    const key = entry.id ?? SERVICE_ASSIGNMENT_NONE_KEY;
    const staffTargets = serviceStaffAssignments[key];
    const targetStaffList: Array<string | null> = staffTargets?.length
      ? [...staffTargets]
      : assignmentUnion.length
        ? [...assignmentUnion]
        : [null];
    const itemStart = new Date(cursor);
    const itemEnd = new Date(serviceEnds);
    for (const staffId of targetStaffList) {
      itemPayloads.push({
        serviceId: record.id,
        staffId,
        startsAt: itemStart,
        endsAt: itemEnd,
        price: new Prisma.Decimal(entry.priceOverride ?? Number(record.basePrice ?? 0)),
        metadata: {
          steps: record.steps.map((step) => ({
            id: step.id,
            name: step.name,
            duration: step.duration,
            resourceIds: step.resources.map((resource) => resource.resourceId),
          })),
        } as Prisma.JsonObject,
      });
    }
    cursor = serviceEnds;
  }

  const totalAmount = orderedServices.reduce((sum, { entry, record }) => {
    const base = Number(record.basePrice ?? 0);
    return sum + (entry.priceOverride ?? base);
  }, 0);

  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;
  const noteValue = typeof body.note === "string" ? body.note.trim() : null;
  const internalMessage =
    typeof body.internalMessage === "string" ? body.internalMessage.trim() : undefined;
  const repeatScope = body.repeatScope === "following" ? "following" : "single";
  const repeatSeries = repeatScope === "following" ? extractRepeatSeries(appointment.metadata) : null;

  const itemOffsets = itemPayloads.map((payload) => ({
    serviceId: payload.serviceId,
    staffId: payload.staffId,
    price: payload.price,
    metadata: payload.metadata,
    startOffsetMs: payload.startsAt.getTime() - startDate.getTime(),
    endOffsetMs: payload.endsAt.getTime() - startDate.getTime(),
  }));
  const totalDurationMs = cursor.getTime() - startDate.getTime();

  const result = repeatSeries
    ? await prisma.$transaction(async (tx) => {
        const seriesAppointments = await tx.appointment.findMany({
          where: {
            locationId: appointment.locationId,
            startsAt: { gte: appointment.startsAt },
            metadata: { path: ["repeat", "seriesId"], equals: repeatSeries.seriesId },
          },
          select: { id: true, startsAt: true, metadata: true },
          orderBy: { startsAt: "asc" },
        });

        if (!seriesAppointments.length) {
          return {
            appointment: null,
            items: [],
            assignedStaffIds: [],
            updatedIds: [],
          };
        }

        const shiftMs = startDate.getTime() - appointment.startsAt.getTime();
        const updates: Array<{
          appointment: { id: string; confirmationCode: string; startsAt: Date; endsAt: Date; locationId: string };
          items: Array<{ id: string; staffId: string | null; serviceId: string; startsAt: Date; endsAt: Date }>;
          assignedStaffIds: string[];
        }> = [];

        for (const entry of seriesAppointments) {
          const nextStart = new Date(entry.startsAt.getTime() + shiftMs);
          const nextEnd = new Date(nextStart.getTime() + totalDurationMs);

          await tx.appointmentItem.deleteMany({
            where: { appointmentId: entry.id },
          });

          const createdItems: Array<{ id: string; staffId: string | null; serviceId: string; startsAt: Date; endsAt: Date }> = [];
          for (const payload of itemOffsets) {
            const itemStart = new Date(nextStart.getTime() + payload.startOffsetMs);
            const itemEnd = new Date(nextStart.getTime() + payload.endOffsetMs);
            const created = await tx.appointmentItem.create({
              data: {
                appointmentId: entry.id,
                serviceId: payload.serviceId,
                staffId: payload.staffId,
                customerId: targetCustomerId ?? null,
                resourceId: null,
                status: "SCHEDULED",
                startsAt: itemStart,
                endsAt: itemEnd,
                price: payload.price,
                currency: appointment.currency,
                metadata: payload.metadata,
              },
              select: {
                id: true,
                staffId: true,
                serviceId: true,
                startsAt: true,
                endsAt: true,
              },
            });
            createdItems.push(created);
          }

          const assignedStaffIds = Array.from(
            new Set(
              createdItems
                .map((item) => item.staffId)
                .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
            ),
          );

          const timestamp = new Date();
          const updatedAppointment = await tx.appointment.update({
            where: { id: entry.id },
            data: {
              startsAt: nextStart,
              endsAt: nextEnd,
              note: noteValue,
              customerId: targetCustomerId,
              totalAmount: new Prisma.Decimal(totalAmount),
              metadata: buildUpdatedMetadata(
                entry.metadata,
                performerInfo,
                timestamp,
                assignedStaffIds,
                serviceStaffAssignments,
                internalMessage ?? null,
              ),
              updatedAt: timestamp,
            },
            select: {
              id: true,
              confirmationCode: true,
              startsAt: true,
              endsAt: true,
              locationId: true,
            },
          });

          updates.push({
            appointment: updatedAppointment,
            items: createdItems,
            assignedStaffIds,
          });
        }

        const primary = updates.find((entry) => entry.appointment.id === appointmentId) ?? updates[0];
        return {
          appointment: primary?.appointment ?? null,
          items: primary?.items ?? [],
          assignedStaffIds: primary?.assignedStaffIds ?? [],
          updatedIds: updates.map((entry) => entry.appointment.id),
        };
      })
    : await prisma.$transaction(async (tx) => {
        await tx.appointmentItem.deleteMany({
          where: { appointmentId },
        });

        const createdItems = [];
        for (const payload of itemPayloads) {
          const created = await tx.appointmentItem.create({
            data: {
              appointmentId,
              serviceId: payload.serviceId,
              staffId: payload.staffId,
              customerId: targetCustomerId ?? null,
              resourceId: null,
              status: "SCHEDULED",
              startsAt: payload.startsAt,
              endsAt: payload.endsAt,
              price: payload.price,
              currency: appointment.currency,
              metadata: payload.metadata,
            },
            select: {
              id: true,
              staffId: true,
              serviceId: true,
              startsAt: true,
              endsAt: true,
            },
          });
          createdItems.push(created);
        }

        const assignedStaffIds = Array.from(
          new Set(
            createdItems
              .map((item) => item.staffId)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
          ),
        );

        const timestamp = new Date();
        const updatedAppointment = await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            startsAt: startDate,
            endsAt: overrideTotalDuration !== null && endDate ? endDate : cursor,
            note: noteValue,
            customerId: targetCustomerId,
            totalAmount: new Prisma.Decimal(totalAmount),
            metadata: buildUpdatedMetadata(
              appointment.metadata,
              performerInfo,
              timestamp,
              assignedStaffIds,
              serviceStaffAssignments,
              internalMessage ?? null,
            ),
            updatedAt: timestamp,
          },
        });

        return {
          appointment: updatedAppointment,
          items: createdItems,
          assignedStaffIds,
          updatedIds: [appointmentId],
        };
      });

  if (!result.appointment) {
    return NextResponse.json({ error: "Termin konnte nicht aktualisiert werden." }, { status: 500 });
  }

  await logAuditEvent({
    locationId: appointment.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "appointment",
    entityId: appointmentId,
    appointmentId,
    diff: {
      services: services.map((entry) => entry.id),
      assignedStaffIds: result.assignedStaffIds,
      performedByStaff: performerInfo,
      repeatScope,
    },
    context: { source: "backoffice_update_full", performedByStaff: performerInfo },
    ipAddress,
    userAgent,
  });

  console.info("[appointment:update:full] success", {
    location,
    appointmentId,
    serviceCount: services.length,
  });

  if (shouldSendNotifications && targetCustomerId) {
    try {
      const policies = await loadPoliciesForLocation(appointment.locationId);
      const cancellationDeadline = resolveCancellationDeadline({
        startsAt: result.appointment.startsAt,
        policies,
        bookingPreferences,
      });
      const tokenExpiresAt = cancellationDeadline ?? result.appointment.startsAt;
      const accessToken = await createAppointmentAccessToken(result.appointment.id, tokenExpiresAt);
      const manageUrl = buildAppointmentManageUrl(tenantId, accessToken.token);
      const smsUrl = buildAppointmentSmsUrl(accessToken.shortCode);
      const servicesForNotification = orderedServices.map(({ record }) => record ?? null);

      let staffFirstName: string | null = null;
      if (effectiveSendWhatsApp && result.assignedStaffIds.length) {
        const staff = await prisma.staff.findFirst({
          where: membershipSupported
            ? {
                id: result.assignedStaffIds[0],
                memberships: { some: { locationId: appointment.locationId } },
              }
            : {
                id: result.assignedStaffIds[0],
                locationId: appointment.locationId,
              },
          select: { firstName: true, lastName: true, displayName: true },
        });
        if (staff) {
          staffFirstName =
            staff.firstName?.trim() ||
            staff.displayName?.trim()?.split(/\s+/)[0] ||
            staff.lastName?.trim() ||
            null;
        }
      }

      await sendConfirmationEmail({
        appointment: {
          id: result.appointment.id,
          confirmationCode: result.appointment.confirmationCode,
          startsAt: result.appointment.startsAt,
          endsAt: result.appointment.endsAt,
          locationId: result.appointment.locationId,
        },
        services: servicesForNotification,
        customerId: targetCustomerId,
        personalMessage: "",
        manageUrl,
      }).catch(() => null);

      if (effectiveSendSms) {
        await sendSmsConfirmation({
          appointment: {
            id: result.appointment.id,
            confirmationCode: result.appointment.confirmationCode,
            startsAt: result.appointment.startsAt,
            locationId: result.appointment.locationId,
          },
          tenantId,
          customerId: targetCustomerId,
          manageUrl,
          smsUrl,
        }).catch((error) => {
          console.warn("[appointment:update:full] sms failed", error);
        });
      }

  if (effectiveSendWhatsApp) {
    await sendWhatsappConfirmation({
      appointment: {
        id: result.appointment.id,
        startsAt: result.appointment.startsAt,
        locationId: result.appointment.locationId,
          },
          manageUrl,
          smsUrl,
          services: servicesForNotification,
          customerId: targetCustomerId,
          staffFirstName,
        }).catch((error) => {
          console.warn("[appointment:update:full] whatsapp failed", error);
        });
      }
    } catch (error) {
      console.warn("[appointment:update:full] notification dispatch failed", error);
    }
  }

  for (const updatedId of result.updatedIds) {
    await publishAppointmentSync({
      locationId: result.appointment.locationId,
      action: "updated",
      appointmentId: updatedId,
      timestamp: Date.now(),
    });
  }

  return NextResponse.json({
    success: true,
    data: {
      appointmentId: result.appointment.id,
    },
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  try {
    const { location, appointmentId } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
    const body = await request.json().catch(() => null);
    const performedBy = body && typeof body === "object" ? (body as Record<string, unknown>).performedBy : null;
    const repeatScope =
      body && typeof body === "object" && (body as Record<string, unknown>).repeatScope === "following"
        ? "following"
        : "single";

    if (
      !performedBy ||
      typeof performedBy !== "object" ||
      typeof (performedBy as Record<string, unknown>).staffId !== "string" ||
      typeof (performedBy as Record<string, unknown>).token !== "string"
    ) {
      return NextResponse.json({ error: "Buchungs-PIN fehlt." }, { status: 400 });
    }

    const performerPayload = performedBy as { staffId: string; token: string };

    const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, location: { slug: location, tenantId } },
      select: {
        id: true,
        status: true,
        customerId: true,
        locationId: true,
        confirmationCode: true,
        startsAt: true,
        endsAt: true,
        metadata: true,
        customer: {
          select: { firstName: true, lastName: true },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json({ error: "Termin wurde nicht gefunden." }, { status: 404 });
    }

    const requiresCancel = Boolean(appointment.customerId);
    if (requiresCancel && appointment.status !== "CANCELLED") {
      return NextResponse.json(
        { error: "Termin kann erst nach einer Stornierung gelöscht werden." },
        { status: 400 },
      );
    }

    const membershipSupported = await supportsStaffMemberships(prisma);

    let performer: PerformerCandidate | null = null;
    if (membershipSupported) {
      performer = await prisma.staff.findFirst({
        where: {
          id: performerPayload.staffId,
          memberships: { some: { locationId: appointment.locationId } },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          code: true,
          metadata: true,
          memberships: {
            where: { locationId: appointment.locationId },
            select: { role: true },
          },
        },
      });
    } else {
      performer = await prisma.staff.findFirst({
        where: {
          id: performerPayload.staffId,
          locationId: appointment.locationId,
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          code: true,
          metadata: true,
        },
      });
    }

    if (!performer || !verifyBookingPinToken(performerPayload.token, performer.id)) {
      return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
    }

    const performerRole = await resolveStaffRole(performer, membershipSupported, tenantId);
    const isAdmin = isAdminRole(performerRole);
    const hasCustomer = Boolean(appointment.customerId);
    if (hasCustomer && !isAdmin) {
      return NextResponse.json(
        { error: "Termine mit Kunde dürfen nur von Rolle 2/Admin gelöscht werden." },
        { status: 403 },
      );
    }

    const repeatSeries = repeatScope === "following" ? extractRepeatSeries(appointment.metadata) : null;
    if (repeatSeries) {
      const seriesAppointments = await prisma.appointment.findMany({
        where: {
          locationId: appointment.locationId,
          startsAt: { gte: appointment.startsAt },
          metadata: { path: ["repeat", "seriesId"], equals: repeatSeries.seriesId },
        },
        select: {
          id: true,
          status: true,
          customerId: true,
          startsAt: true,
          endsAt: true,
        },
      });

      if (!seriesAppointments.length) {
        return NextResponse.json({ error: "Termin wurde nicht gefunden." }, { status: 404 });
      }

      if (!isAdmin && seriesAppointments.some((entry) => Boolean(entry.customerId))) {
        return NextResponse.json(
          { error: "Termine mit Kunde dürfen nur von Rolle 2/Admin gelöscht werden." },
          { status: 403 },
        );
      }

      const requiresCancelInSeries = seriesAppointments.some(
        (entry) => Boolean(entry.customerId) && entry.status !== "CANCELLED",
      );
      if (requiresCancelInSeries) {
        return NextResponse.json(
          { error: "Termin kann erst nach einer Stornierung gelöscht werden." },
          { status: 400 },
        );
      }

      if (!isAdmin) {
        const now = new Date();
        for (const entry of seriesAppointments) {
          const endRef = entry.endsAt ?? entry.startsAt ?? null;
          if (!endRef) continue;
          const limit = new Date(endRef.getTime() + 24 * 60 * 60 * 1000);
          if (now > limit) {
            return NextResponse.json(
              { error: "Löschen ist nur bis 24 Stunden nach Terminende möglich. Bitte wende dich an den Admin!" },
              { status: 400 },
            );
          }
        }
      }

      await prisma.appointment.deleteMany({
        where: { id: { in: seriesAppointments.map((entry) => entry.id) } },
      });

      const performerName =
        performer.displayName?.trim() ||
        formatPersonName(performer.firstName, performer.lastName) ||
        "Mitarbeiter";
      const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
      const userAgent = request.headers.get("user-agent") ?? null;
      const appointmentSnapshot = {
        appointmentStartsAt: appointment.startsAt.toISOString(),
        customerName: formatPersonName(appointment.customer?.firstName ?? null, appointment.customer?.lastName ?? null),
      };

      await logAuditEvent({
        locationId: appointment.locationId,
        actorType: AuditActorType.USER,
        actorId: null,
        action: AuditAction.DELETE,
        entityType: "appointment",
        entityId: appointment.id,
        appointmentId: null,
        diff: {
          performedByStaff: {
            staffId: performer.id,
            staffName: performerName,
          },
          repeatScope,
          deletedCount: seriesAppointments.length,
        },
        context: {
          confirmationCode: appointment.confirmationCode,
          reason: "manual-delete",
          appointmentSnapshot,
        },
        ipAddress,
        userAgent,
      });

      for (const entry of seriesAppointments) {
        await publishAppointmentSync({
          locationId: appointment.locationId,
          action: "deleted",
          appointmentId: entry.id,
          timestamp: Date.now(),
        });
      }

      return NextResponse.json({ success: true });
    }

    const endRef = appointment.endsAt ?? appointment.startsAt ?? null;
    if (endRef && !isAdmin) {
      const limit = new Date(endRef.getTime() + 24 * 60 * 60 * 1000);
      if (new Date() > limit) {
        return NextResponse.json(
          { error: "Löschen ist nur bis 24 Stunden nach Terminende möglich. Bitte wende dich an den Admin!" },
          { status: 400 },
        );
      }
    }

    await prisma.appointment.delete({
      where: { id: appointment.id },
    });

    const performerName =
      performer.displayName?.trim() ||
      formatPersonName(performer.firstName, performer.lastName) ||
      "Mitarbeiter";

    const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
    const userAgent = request.headers.get("user-agent") ?? null;
    const appointmentSnapshot = {
      appointmentStartsAt: appointment.startsAt.toISOString(),
      customerName: formatPersonName(appointment.customer?.firstName ?? null, appointment.customer?.lastName ?? null),
    };

    await logAuditEvent({
      locationId: appointment.locationId,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.DELETE,
      entityType: "appointment",
      entityId: appointment.id,
      appointmentId: null,
      diff: {
        performedByStaff: {
          staffId: performer.id,
          staffName: performerName,
        },
      },
      context: {
        confirmationCode: appointment.confirmationCode,
        reason: "manual-delete",
        appointmentSnapshot,
      },
      ipAddress,
      userAgent,
    });

    console.info("[appointment:delete] success", {
      location,
      appointmentId: appointment.id,
      performerId: performer.id,
    });

    await publishAppointmentSync({
      locationId: appointment.locationId,
      action: "deleted",
      appointmentId: appointment.id,
      timestamp: Date.now(),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[appointment:delete] unexpected error", error);
    const message = error instanceof Error ? error.message : "Termin konnte nicht gelöscht werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const appointmentInclude = {
  location: {
    select: {
      id: true,
      name: true,
      addressLine1: true,
      city: true,
    },
  },
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      notes: true,
    },
  },
  items: {
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      status: true,
      startsAt: true,
      endsAt: true,
      price: true,
      currency: true,
      notes: true,
      service: {
        select: {
          id: true,
          name: true,
          duration: true,
        },
      },
      staff: {
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
        },
      },
      resource: {
        select: {
          id: true,
          name: true,
          type: true,
        },
      },
    },
  },
  attachments: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      fileName: true,
      mimeType: true,
      size: true,
      createdAt: true,
    },
  },
  notifications: {
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      channel: true,
      trigger: true,
      status: true,
      scheduledAt: true,
      sentAt: true,
      createdAt: true,
      error: true,
      metadata: true,
    },
  },
  auditLogs: {
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      action: true,
      actorType: true,
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
      context: true,
      diff: true,
      createdAt: true,
    },
  },
} as const;

async function sendConfirmationEmail(params: {
  appointment: {
    id: string;
    confirmationCode: string;
    startsAt: Date;
    endsAt: Date;
    locationId: string;
  };
  services: Array<
    | null
    | {
        id: string;
        name: string;
        duration: number;
      }
  >;
  customerId: string;
  personalMessage: string;
  manageUrl: string;
}) {
  const customer = await prisma.customer.findUnique({
    where: { id: params.customerId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!customer?.email) return;

  const location = await prisma.location.findUnique({
    where: { id: params.appointment.locationId },
    select: {
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

  const tenantName =
    (await resolveTenantName(location.tenantId, location.tenant?.name ?? location.name)) ??
    location.name ??
    "Dein Team";
  const locationMetadata =
    location.metadata && typeof location.metadata === "object" && !Array.isArray(location.metadata)
      ? (location.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const emailSenderName = bookingPreferences.emailSenderName.trim() || tenantName;
  const replyTo =
    bookingPreferences.emailReplyToEnabled && bookingPreferences.emailReplyTo.trim()
      ? bookingPreferences.emailReplyTo.trim()
      : undefined;
  const locationLabel = [location.name, location.addressLine1, location.city].filter(Boolean).join(" · ") || undefined;

  const ics = createIcsEvent({
    summary: `Termin im ${location.name ?? "Salon"}`,
    description: params.personalMessage || "Wir freuen uns auf dich!",
    location: locationLabel,
    startsAt: params.appointment.startsAt,
    endsAt: params.appointment.endsAt,
    organizer: {
      name: location.name ?? "Timevex Calendar",
      email: location.email ?? "noreply@example.com",
    },
    attendees: [
      {
        name: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Kunde",
        email: customer.email,
      },
    ],
    remindersMinutesBefore: [60],
  });

  const template = renderBookingConfirmation({
    customerName: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Kunde",
    locationName: location.name ?? "Dein Salon",
    start: params.appointment.startsAt,
    end: params.appointment.endsAt,
    timeZone: location.timezone ?? "Europe/Berlin",
    services: params.services
      .filter((service): service is { id: string; name: string; duration: number } => Boolean(service))
      .map((service) => ({ name: service.name, duration: service.duration })),
    confirmationCode: params.appointment.confirmationCode,
    personalMessage: params.personalMessage,
    manageUrl: params.manageUrl,
  });

  const mailer = await createMailer();
  await executeWithCircuitBreaker("mailer:admin-appointment", { failureThreshold: 3, cooldownMs: 5 * 60 * 1000 }, () =>
    mailer.sendBookingConfirmation({
      to: {
        name: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Kunde",
        email: customer.email!,
      },
      fromName: emailSenderName,
      replyTo,
      subject: template.subject,
      textBody: template.text,
      htmlBody: template.html,
      attachments: [
        {
          filename: `termin-${params.appointment.confirmationCode}.ics`,
          content: ics,
          contentType: "text/calendar; charset=utf-8",
        },
      ],
      metadata: {
        appointmentId: params.appointment.id,
      },
    }),
  );
}

async function sendSmsConfirmation(params: {
  appointment: {
    id: string;
    confirmationCode: string;
    startsAt: Date;
    locationId: string;
  };
  tenantId: string;
  customerId: string;
  manageUrl: string;
  smsUrl: string;
}) {
  if (!isSmsConfigured()) {
    return;
  }
  const [customer, location] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: params.customerId },
      select: { phone: true },
    }),
    prisma.location.findUnique({
      where: { id: params.appointment.locationId },
      select: { name: true, timezone: true, metadata: true },
    }),
  ]);

  if (!customer?.phone || !location) {
    return;
  }

  const locationMetadata =
    location.metadata && typeof location.metadata === "object" && !Array.isArray(location.metadata)
      ? (location.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const smsBrandName = bookingPreferences.smsBrandName.trim() || location.name || "Salon";
  const smsSenderName = bookingPreferences.smsSenderName.trim() || undefined;
  const startLabel = params.appointment.startsAt.toLocaleString("de-DE", {
    timeZone: location.timezone ?? "Europe/Berlin",
  });
  const manageHint = params.smsUrl
    ? ` Storno: ${params.smsUrl}`
    : params.manageUrl
      ? ` Storno: ${params.manageUrl}`
      : "";

  await sendSms({
    to: customer.phone,
    body: `Termin bestätigt: ${startLabel} bei ${smsBrandName}. Code: ${params.appointment.confirmationCode}.${manageHint}`,
    tenantId: params.tenantId,
    sender: smsSenderName,
  });
}

async function sendWhatsappConfirmation(params: {
  appointment: {
    id: string;
    startsAt: Date;
    locationId: string;
  };
  manageUrl: string;
  smsUrl?: string;
  services: Array<
    | null
    | {
        id: string;
        name: string;
      }
  >;
  customerId: string;
  staffFirstName?: string | null;
}) {
  if (!isWhatsappConfigured()) {
    return;
  }
  const [customer, location] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: params.customerId },
      select: { firstName: true, lastName: true, phone: true },
    }),
    prisma.location.findUnique({
      where: { id: params.appointment.locationId },
      select: {
        name: true,
        timezone: true,
        tenantId: true,
        addressLine1: true,
        city: true,
        tenant: { select: { name: true } },
      },
    }),
  ]);

  if (!customer?.phone || !location) {
    return;
  }

  const timezone = location.timezone ?? "Europe/Berlin";
  const serviceNames =
    params.services
      .map((service) => service?.name ?? null)
      .filter((name): name is string => Boolean(name))
      .join(", ") || "Termin";
  const customerFirstName = customer.firstName?.trim() || "Kunde";
  const customerLastName = customer.lastName?.trim() || "";
  const customerFullName = [customerFirstName, customerLastName].filter(Boolean).join(" ");
  const staffFirstName = params.staffFirstName?.trim() || "Team";
  const dateLabel = params.appointment.startsAt.toLocaleDateString("de-DE", { timeZone: timezone });
  const timeLabel = params.appointment.startsAt.toLocaleTimeString("de-DE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const locationLabel =
    [location.name, location.addressLine1, location.city].filter(Boolean).join(", ") || location.name || "Standort";
  const tenantName =
    (await resolveTenantName(location.tenantId, location.tenant?.name ?? location.name)) ?? "Dein Team";
  const manageLink = params.smsUrl?.trim() || params.manageUrl?.trim() || "";
  const basePlaceholders = [
    customerFirstName,
    customerLastName,
    staffFirstName,
    dateLabel,
    timeLabel,
    serviceNames,
    locationLabel,
    tenantName,
  ];

  await sendWhatsAppNotification({
    tenantId: location.tenantId,
    to: customer.phone,
    templateKey: "bookingConfirmationLink",
    placeholders: [...basePlaceholders, manageLink],
    fallbackTemplateKey: "bookingConfirmation",
    fallbackPlaceholders: basePlaceholders,
    fallbackText:
      `Terminbestätigung\nHallo ${customerFullName},\n\n` +
      `dein Termin bei ${staffFirstName} wurde erfolgreich bestätigt.\n\n` +
      `Datum: ${dateLabel}\nUhrzeit: ${timeLabel}\nLeistung: ${serviceNames}\nWo: ${locationLabel}\n\n` +
      `LG Dein Team von ${tenantName}. Wir freuen uns auf Deinen Besuch.`,
  });
}

function decimalToNumber(input: unknown): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === "number") return input;
  if (typeof input === "bigint") return Number(input);
  if (typeof input === "object" && "toNumber" in (input as { toNumber?: () => number })) {
    try {
      return (input as { toNumber: () => number }).toNumber();
    } catch {
      return 0;
    }
  }
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractPaymentHistory(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const history = (metadata as Record<string, unknown>).paymentHistory;
  if (!Array.isArray(history)) return [];
  return history
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.status !== "string" || typeof record.at !== "string") return null;
      const amountRaw = record.amount;
      const amount =
        typeof amountRaw === "number"
          ? amountRaw
          : typeof amountRaw === "string"
          ? Number.parseFloat(amountRaw)
          : null;
      return {
        status: record.status as string,
        note: typeof record.note === "string" ? record.note : null,
        amount: Number.isFinite(amount as number) ? (amount as number) : null,
        currency: typeof record.currency === "string" ? record.currency : null,
        at: record.at as string,
      };
    })
    .filter(Boolean);
}

function isAdminRole(role: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return normalized === "2" || normalized === "admin";
}

async function resolveStaffRole(
  performer: PerformerCandidate,
  membershipSupported: boolean,
  tenantId: string,
): Promise<string | null> {
  let role: string | null = null;

  const membershipRole =
    membershipSupported && "memberships" in performer
      ? performer.memberships.find((entry) => typeof entry.role === "string" && entry.role.trim().length)?.role?.trim() ??
        null
      : null;
  if (membershipRole) {
    role = membershipRole;
    if (isAdminRole(normalizeRole(membershipRole))) {
      return normalizeRole(membershipRole);
    }
  }

  const metadataRole = extractRoleFromStaffMetadata(performer.metadata);
  if (metadataRole) {
    if (isAdminRole(normalizeRole(metadataRole))) {
      return normalizeRole(metadataRole);
    }
    if (!role) {
      role = metadataRole;
    }
  }

  // Versuche Rolle direkt aus Stundenliste (Schichtplan), entweder über staff.code oder employeeId im Metadata
  const remoteId = extractStundenlisteEmployeeId(performer.metadata) ?? performer.code ?? null;
  if (remoteId) {
    try {
      const client = getStundenlisteClient(tenantId);
      // Immer frisch laden, damit Rollenänderungen im Schichtplan sofort greifen
      const employees = await client.listEmployees();
      const remote = employees.find((employee) => String(employee.id) === String(remoteId));
      if (remote) {
        let candidate =
          normalizeRole(remote.roleId) ??
          normalizeRole(remote.role) ??
          null;

        if (!candidate && Array.isArray(remote.permissions)) {
          candidate =
            remote.permissions
              .map((permission) => normalizeRole(permission))
              .find((normalized) => normalized && isAdminRole(normalized)) ?? null;
        }

        if (candidate) {
          if (isAdminRole(candidate)) {
            return candidate;
          }
          if (!role) {
            role = candidate;
          }
        }
      }
    } catch (error) {
      console.warn("[appointment:resolveStaffRole] Stundenliste-Rollenabfrage fehlgeschlagen", error);
    }
  }

  const normalized = normalizeRole(role);
  console.warn("[appointment:resolveStaffRole] performer", {
    performerId: performer.id,
    code: performer.code,
    roleRaw: role,
    roleNormalized: normalized,
    membershipSupported,
  });
  return normalized;
}

function extractStundenlisteEmployeeId(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const stundenliste = record.stundenliste;
  if (!isPlainObject(stundenliste)) return null;
  const rawId =
    (stundenliste as Record<string, unknown>).employeeId ??
    (stundenliste as Record<string, unknown>).id ??
    null;
  if (rawId === null || rawId === undefined) return null;
  return String(rawId);
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
