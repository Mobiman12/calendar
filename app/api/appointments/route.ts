"use server";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  Prisma,
  AppointmentStatus,
  AppointmentPaymentStatus,
  AuditAction,
  AuditActorType,
  ConsentScope,
  ConsentSource,
  ConsentType,
} from "@prisma/client";
import { addDays, addMinutes } from "date-fns";
import { randomUUID } from "crypto";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { acquireLock, releaseLock, shouldBypassRedisLock } from "@/lib/redis-lock";
import { createIcsEvent } from "@/lib/notifications/ics";
import { renderBookingConfirmation } from "@/lib/notifications/templates";
import { createMailer } from "@/lib/notifications/mailer";
import { isSmsConfigured, isWhatsappConfigured, sendSms } from "@/lib/notifications/sms";
import { sendWhatsAppNotification } from "@/lib/notifications/whatsapp";
import { scheduleAppointmentReminders } from "@/lib/notifications/reminders";
import { executeWithCircuitBreaker } from "@/lib/circuit-breaker";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { buildServiceStaffAssignmentsFromPayload } from "@/lib/appointments/service-assignments";
import { getTenantIdOrThrow, resolveTenantName } from "@/lib/tenant";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { loadPoliciesForLocation } from "@/lib/policies";
import { resolveNotificationPreferences } from "@/lib/notifications/notification-preferences";
import { buildAppointmentManageUrl, buildAppointmentSmsUrl, createAppointmentAccessToken } from "@/lib/appointments/access-tokens";
import { resolveCancellationDeadline } from "@/lib/appointments/cancellation";
import { CONSENT_METHOD_PERSONAL, normalizeConsentMethod } from "@/lib/consent-method";
import { sendCustomerPermissionEmail } from "@/lib/customer-booking-permissions";
import { publishAppointmentSync } from "@/lib/appointment-sync";

const prisma = getPrismaClient();

const RepeatSchema = z
  .object({
    enabled: z.boolean(),
    frequency: z.enum(["DAILY", "WEEKLY"]),
    count: z.number().int().min(1).max(20),
  })
  .optional();

const ServicesSchema = z
  .array(
    z.object({
      id: z.string().min(1),
      durationOverride: z.number().int().min(5).max(24 * 60).optional(),
      priceOverride: z.number().min(0).optional(),
      staffIds: z.array(z.string().min(1)).optional().default([]),
    }),
  )
  .min(0)
  .optional()
  .default([]);

const CustomerSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("existing"),
    customerId: z.string().min(1),
  }),
  z.object({
    mode: z.literal("new"),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
]);

const PerformedBySchema = z.object({
  staffId: z.string().min(1),
  token: z.string().min(1),
});

const PayloadSchema = z.object({
  locationId: z.string().min(1),
  locationSlug: z.string().min(1),
  startsAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Ungültiger Startzeitpunkt" }),
  endsAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Ungültiger Endzeitpunkt" }),
  staffId: z.string().optional(),
  staffIds: z.array(z.string().min(1)).optional().default([]),
  resources: z.array(z.string()).optional().default([]),
  services: ServicesSchema,
  customer: CustomerSchema.nullable().optional().default(null),
  sendEmail: z.boolean().default(true),
  sendSms: z.boolean().optional(),
  sendWhatsApp: z.boolean().default(false),
  whatsAppOptIn: z.boolean().default(false),
  vipStaffIds: z.array(z.string().min(1)).optional().default([]),
  personalMessage: z.string().max(2000).optional(),
  note: z.string().max(5000).optional(),
  internalMessage: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  repeat: RepeatSchema,
  performedBy: PerformedBySchema,
});

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

function readOnlineBookingEnabled(metadata: Prisma.JsonValue | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return true;
  }
  const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
  return typeof value === "boolean" ? value : true;
}

type ConsentCaptureChannel = {
  scope: ConsentScope;
  enabled: boolean;
};

async function captureCommunicationConsents(params: {
  tx: Prisma.TransactionClient;
  locationId: string;
  customerId: string;
  actorUserId: string | null;
  performerInfo: { staffId: string; staffName: string };
  ipAddress: string | null;
  userAgent: string | null;
  channels: ConsentCaptureChannel[];
}) {
  const activeChannels = params.channels.filter((channel) => channel.enabled);
  if (!activeChannels.length) return;

  const defaultMetadata = {
    method: CONSENT_METHOD_PERSONAL,
    reference: "Kalender",
    note: "Einwilligung beim Termin erfasst",
  };
  const readMetadataRecord = (metadata: Prisma.JsonValue | null) =>
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  const readMetadataString = (value: unknown) => (typeof value === "string" && value.trim().length ? value : null);
  const buildMetadataUpdate = (metadata: Prisma.JsonValue | null) => {
    const existingMetadata = readMetadataRecord(metadata);
    const existingMethod = normalizeConsentMethod(readMetadataString(existingMetadata.method));
    if (existingMethod) {
      return {
        existingMetadata,
        nextMetadata: existingMetadata,
        needsUpdate: false,
      };
    }
    return {
      existingMetadata,
      nextMetadata: { ...existingMetadata, method: defaultMetadata.method },
      needsUpdate: true,
    };
  };

  const existingConsents = await params.tx.consent.findMany({
    where: {
      customerId: params.customerId,
      locationId: params.locationId,
      type: ConsentType.COMMUNICATION,
      scope: { in: activeChannels.map((channel) => channel.scope) },
    },
    select: {
      id: true,
      scope: true,
      granted: true,
      grantedAt: true,
      revokedAt: true,
      metadata: true,
    },
  });
  const consentByScope = new Map(existingConsents.map((consent) => [consent.scope, consent]));
  const now = new Date();

  for (const channel of activeChannels) {
    const existing = consentByScope.get(channel.scope) ?? null;
    if (existing?.granted && !existing.revokedAt) {
      const metadataUpdate = buildMetadataUpdate(existing.metadata ?? null);
      if (!metadataUpdate.needsUpdate) {
        continue;
      }
      await params.tx.consent.update({
        where: { id: existing.id },
        data: {
          metadata: metadataUpdate.nextMetadata as Prisma.InputJsonValue,
          source: ConsentSource.ADMIN,
          recordedById: params.actorUserId,
        },
      });
      await logAuditEvent(
        {
          locationId: params.locationId,
          actorType: AuditActorType.USER,
          actorId: params.actorUserId,
          action: AuditAction.UPDATE,
          entityType: "consent",
          entityId: existing.id,
          diff: {
            metadata: { from: metadataUpdate.existingMetadata, to: metadataUpdate.nextMetadata },
          },
          context: {
            type: ConsentType.COMMUNICATION,
            scope: channel.scope,
            source: "calendar_appointment",
            performedByStaff: params.performerInfo,
          },
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
        params.tx,
      );
      continue;
    }

    if (!existing) {
      const created = await params.tx.consent.create({
        data: {
          customerId: params.customerId,
          locationId: params.locationId,
          type: ConsentType.COMMUNICATION,
          scope: channel.scope,
          granted: true,
          grantedAt: now,
          revokedAt: null,
          source: ConsentSource.ADMIN,
          recordedById: params.actorUserId,
          metadata: {
            method: defaultMetadata.method,
            reference: defaultMetadata.reference,
            note: defaultMetadata.note,
          } satisfies Prisma.InputJsonValue,
        },
      });
      await logAuditEvent(
        {
          locationId: params.locationId,
          actorType: AuditActorType.USER,
          actorId: params.actorUserId,
          action: AuditAction.CREATE,
          entityType: "consent",
          entityId: created.id,
          diff: {
            granted: { from: null, to: true },
            grantedAt: { from: null, to: now.toISOString() },
            revokedAt: { from: null, to: null },
          },
          context: {
            type: ConsentType.COMMUNICATION,
            scope: channel.scope,
            source: "calendar_appointment",
            performedByStaff: params.performerInfo,
          },
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        },
        params.tx,
      );
      continue;
    }

    const metadataUpdate = buildMetadataUpdate(existing.metadata ?? null);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (!existing.granted) {
      changes.granted = { from: existing.granted, to: true };
    }
    if (existing.grantedAt.getTime() !== now.getTime()) {
      changes.grantedAt = { from: existing.grantedAt.toISOString(), to: now.toISOString() };
    }
    if (existing.revokedAt) {
      changes.revokedAt = { from: existing.revokedAt.toISOString(), to: null };
    }
    if (metadataUpdate.needsUpdate) {
      changes.metadata = { from: metadataUpdate.existingMetadata, to: metadataUpdate.nextMetadata };
    }
    if (!Object.keys(changes).length) {
      continue;
    }

    await params.tx.consent.update({
      where: { id: existing.id },
      data: {
        granted: true,
        grantedAt: now,
        revokedAt: null,
        source: ConsentSource.ADMIN,
        recordedById: params.actorUserId,
        ...(metadataUpdate.needsUpdate ? { metadata: metadataUpdate.nextMetadata as Prisma.InputJsonValue } : {}),
      },
    });

    await logAuditEvent(
      {
        locationId: params.locationId,
        actorType: AuditActorType.USER,
        actorId: params.actorUserId,
        action: AuditAction.UPDATE,
        entityType: "consent",
        entityId: existing.id,
        diff: changes,
        context: {
          type: ConsentType.COMMUNICATION,
          scope: channel.scope,
          source: "calendar_appointment",
          performedByStaff: params.performerInfo,
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      },
      params.tx,
    );
  }
}

async function revokeCommunicationConsent(params: {
  tx: Prisma.TransactionClient;
  locationId: string;
  customerId: string;
  actorUserId: string | null;
  performerInfo: { staffId: string; staffName: string };
  ipAddress: string | null;
  userAgent: string | null;
  scope: ConsentScope;
}) {
  const existing = await params.tx.consent.findFirst({
    where: {
      customerId: params.customerId,
      locationId: params.locationId,
      type: ConsentType.COMMUNICATION,
      scope: params.scope,
      granted: true,
      revokedAt: null,
    },
    select: {
      id: true,
      granted: true,
      grantedAt: true,
      revokedAt: true,
    },
  });

  if (!existing) return;

  const now = new Date();

  await params.tx.consent.update({
    where: { id: existing.id },
    data: {
      granted: false,
      revokedAt: now,
      source: ConsentSource.ADMIN,
      recordedById: params.actorUserId,
    },
  });

  await logAuditEvent(
    {
      locationId: params.locationId,
      actorType: AuditActorType.USER,
      actorId: params.actorUserId,
      action: AuditAction.UPDATE,
      entityType: "consent",
      entityId: existing.id,
      diff: {
        granted: { from: existing.granted, to: false },
        revokedAt: { from: existing.revokedAt?.toISOString() ?? null, to: now.toISOString() },
      },
      context: {
        type: ConsentType.COMMUNICATION,
        scope: params.scope,
        source: "calendar_appointment",
        performedByStaff: params.performerInfo,
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    },
    params.tx,
  );
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const payloadRaw = formData.get("payload");
    if (!payloadRaw || typeof payloadRaw !== "string") {
      return NextResponse.json({ error: "Payload fehlt" }, { status: 400 });
    }
    const json = JSON.parse(payloadRaw);
    const parseResult = PayloadSchema.safeParse(json);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          error: "Ungültige Eingabe",
          details: parseResult.error.issues.map((issue) => issue.message),
        },
        { status: 400 },
      );
    }
    const payload = parseResult.data;
    const requestedSendSms = payload.sendSms ?? payload.sendEmail;
    const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
    const userAgent = request.headers.get("user-agent");

    // Resolve tenant from location, with fallback for older Prisma clients
    let locationRecord:
      | { id: string; tenantId?: string; metadata?: unknown }
      | null = null;
    try {
      locationRecord = await prisma.location.findFirst({
        where: { id: payload.locationId, slug: payload.locationSlug },
        select: { id: true, tenantId: true, metadata: true },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Unknown field `tenantId`")) {
        locationRecord = await prisma.location.findFirst({
          where: { id: payload.locationId, slug: payload.locationSlug },
          select: { id: true, metadata: true },
        });
      } else {
        throw error;
      }
    }

    if (!locationRecord) {
      return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
    }

    let tenantId: string;
    try {
      tenantId = await getTenantIdOrThrow(request.headers, {
        locationId: payload.locationId,
        locationSlug: payload.locationSlug,
      });
    } catch (error) {
      console.error("[appointments:create] tenant resolution failed", error);
      return NextResponse.json({ error: "Tenant konnte nicht ermittelt werden." }, { status: 400 });
    }

    if (locationRecord.tenantId && tenantId !== locationRecord.tenantId) {
      return NextResponse.json({ error: "Standort gehört nicht zu diesem Tenant." }, { status: 403 });
    }

    const locationMetadata =
      locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
        ? (locationRecord.metadata as Record<string, unknown>)
        : null;
    const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
    const manualConfirmationMode = bookingPreferences.manualConfirmationMode ?? "both";
    const wantsWhatsApp = payload.sendWhatsApp && payload.whatsAppOptIn;
    const effectiveSendWhatsApp = wantsWhatsApp;
    const effectiveSendSms =
      manualConfirmationMode === "both" ? requestedSendSms : wantsWhatsApp ? false : requestedSendSms;
    const policies = await loadPoliciesForLocation(payload.locationId);

    const membershipSupported = await supportsStaffMemberships(prisma);
    const customerMembershipSupported = await supportsCustomerMemberships(prisma);
    const actorStaff = await prisma.staff.findFirst({
      where: membershipSupported
        ? {
            id: payload.performedBy.staffId,
            location: { tenantId },
            memberships: { some: { locationId: payload.locationId } },
          }
        : {
            id: payload.performedBy.staffId,
            locationId: payload.locationId,
            location: { tenantId },
          },
      select: { id: true, userId: true, displayName: true, firstName: true, lastName: true },
    });

    if (!actorStaff || !verifyBookingPinToken(payload.performedBy.token, actorStaff.id)) {
      return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
    }

    const actorUser = actorStaff.userId
      ? await prisma.user.findUnique({ where: { id: actorStaff.userId }, select: { role: true } })
      : null;
    const isAdmin = actorUser?.role === "ADMIN";

    const customerInput = payload.customer;
    const vipStaffIds = isAdmin ? payload.vipStaffIds ?? [] : [];

    const performerName =
      actorStaff.displayName?.trim() ||
      `${actorStaff.firstName ?? ""} ${actorStaff.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
      "Mitarbeiter";

    const combinedStaffIds = new Set(
      (payload.staffIds ?? [])
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id): id is string => id.length > 0),
    );
    if (payload.staffId && payload.staffId.trim().length) {
      combinedStaffIds.add(payload.staffId.trim());
    }
    for (const serviceEntry of payload.services ?? []) {
      for (const staffId of serviceEntry.staffIds ?? []) {
        if (typeof staffId === "string" && staffId.trim().length > 0) {
          combinedStaffIds.add(staffId.trim());
        }
      }
    }
    const effectiveStaffIds = Array.from(combinedStaffIds);
    let assignedStaffFirstName: string | null = null;

    const performerInfo = {
      staffId: actorStaff.id,
      staffName: performerName,
    };
    const actorUserId = actorStaff.userId ?? null;

    const internalNoteValue = typeof payload.internalMessage === "string" ? payload.internalMessage.trim() : "";
    const serviceStaffAssignments = buildServiceStaffAssignmentsFromPayload(payload.services ?? []);
    const appointmentMetadata = {
      ...(payload.metadata ?? {}),
      createdByStaff: performerInfo,
      assignedStaffIds: effectiveStaffIds,
      serviceStaffAssignments,
      ...(internalNoteValue.length ? { internalNote: internalNoteValue } : {}),
    };

    if (effectiveStaffIds.length) {
      const assignedStaff = await prisma.staff.findMany({
        where: membershipSupported
          ? {
              id: { in: effectiveStaffIds },
              memberships: { some: { locationId: payload.locationId } },
            }
          : {
              id: { in: effectiveStaffIds },
              locationId: payload.locationId,
            },
        select: { id: true, firstName: true, lastName: true, displayName: true },
      });
      if (assignedStaff.length !== effectiveStaffIds.length) {
        return NextResponse.json({ error: "Mindestens ein ausgewählter Mitarbeiter gehört nicht zu diesem Standort." }, { status: 400 });
      }
      const staffById = new Map(assignedStaff.map((staff) => [staff.id, staff]));
      const primaryStaff = staffById.get(effectiveStaffIds[0]) ?? assignedStaff[0] ?? null;
      if (primaryStaff) {
        assignedStaffFirstName =
          primaryStaff.firstName?.trim() ||
          primaryStaff.displayName?.trim().split(/\s+/)[0] ||
          primaryStaff.lastName?.trim() ||
          null;
      }
    }

    const attachments = formData
      .getAll("attachments")
      .filter((attachment): attachment is File => attachment instanceof File)
      .slice(0, MAX_ATTACHMENTS);

    for (const file of attachments) {
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        return NextResponse.json({ error: `Ungültiger Dateityp: ${file.name}` }, { status: 400 });
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return NextResponse.json({ error: `Datei zu groß: ${file.name}` }, { status: 400 });
      }
    }

    const baseStart = new Date(payload.startsAt);
    const baseEnd = new Date(payload.endsAt);
    if (!(baseStart < baseEnd)) {
      return NextResponse.json({ error: "Endzeitpunkt muss nach dem Start liegen." }, { status: 400 });
    }

    const occurrences: Array<{ startsAt: Date; endsAt: Date; index: number }> = [
      { startsAt: baseStart, endsAt: baseEnd, index: 0 },
    ];
    const repeatIntervalDays = payload.repeat?.enabled
      ? payload.repeat.frequency === "DAILY"
        ? payload.repeat.count
        : payload.repeat.count * 7
      : null;
    const repeatUntil = payload.repeat?.enabled
      ? new Date(baseStart.getFullYear(), 11, 31, 23, 59, 59, 999)
      : null;
    if (payload.repeat?.enabled && repeatIntervalDays) {
      let index = 1;
      let startsAt = addDays(baseStart, repeatIntervalDays);
      while (startsAt <= repeatUntil!) {
        const endsAt = addDays(baseEnd, repeatIntervalDays * index);
        occurrences.push({ startsAt, endsAt, index });
        index += 1;
        startsAt = addDays(baseStart, repeatIntervalDays * index);
      }
    }

    const services = await prisma.service.findMany({
      where: {
        id: { in: payload.services.map((service) => service.id) },
        locationId: payload.locationId,
        status: "ACTIVE",
        location: { tenantId },
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

    if (services.length !== payload.services.length) {
      return NextResponse.json({ error: "Mindestens eine Leistung konnte nicht geladen werden." }, { status: 404 });
    }

    const servicesById = new Map(services.map((service) => [service.id, service]));
    const orderedServices = payload.services.map((entry) => {
      const record = servicesById.get(entry.id);
      return { entry, record };
    });

    const lock = await acquireLock(`create-appointment:${payload.locationId}`, { ttlMs: 30_000 });
    if (!lock && !shouldBypassRedisLock()) {
      return NextResponse.json({ error: "Kalender ist gerade gesperrt. Bitte erneut versuchen." }, { status: 423 });
    }
    if (!lock) {
      console.warn("[appointments:create] redis lock unavailable, proceeding without lock");
    }

    try {
      const results: Array<{ appointmentId: string; startsAt: Date; endsAt: Date }> = [];
      let reminderCustomer: {
        id: string;
        email?: string | null;
        phone?: string | null;
        firstName?: string | null;
        lastName?: string | null;
      } | null = null;
      let permissionEmailPayload: {
        customerId: string;
        locationId: string;
        email: string;
        customerName: string;
        createdByUserId: string | null;
      } | null = null;

      const transactionTimeoutMs =
        payload.repeat?.enabled && occurrences.length > 1
          ? Math.min(120_000, 10_000 + occurrences.length * 200)
          : 15_000;

      await prisma.$transaction(async (tx) => {
        let customerId: string | null = null;
        if (customerInput?.mode === "existing") {
          const customerScope: Prisma.CustomerWhereInput = customerMembershipSupported
            ? {
                id: customerInput.customerId,
                location: { tenantId },
                OR: [
                  { locationId: payload.locationId },
                  { memberships: { some: { locationId: payload.locationId } } },
                ],
              }
            : {
                id: customerInput.customerId,
                locationId: payload.locationId,
                location: { tenantId },
              };
          const customer = await tx.customer.findFirst({
            where: customerScope,
            select: { id: true, email: true, phone: true, firstName: true, lastName: true },
          });
          customerId = customer?.id ?? null;
          if (customer?.id) {
            reminderCustomer = {
              id: customer.id,
              email: customer.email ?? null,
              phone: customer.phone ?? null,
              firstName: customer.firstName ?? null,
              lastName: customer.lastName ?? null,
            };
          }
          if (!customerId) {
            throw new Error("customer_not_in_tenant");
          }
        } else if (customerInput?.mode === "new") {
          const newCustomer = await tx.customer.create({
            data: {
              location: { connect: { id: payload.locationId } },
              firstName: customerInput.firstName,
              lastName: customerInput.lastName,
              email: customerInput.email,
              phone: customerInput.phone,
            },
          });
          customerId = newCustomer.id;
          reminderCustomer = {
            id: newCustomer.id,
            email: newCustomer.email ?? null,
            phone: newCustomer.phone ?? null,
            firstName: newCustomer.firstName ?? null,
            lastName: newCustomer.lastName ?? null,
          };
        }

        const shouldSendEmail = Boolean(reminderCustomer?.email);

        if (customerId) {
          await captureCommunicationConsents({
            tx,
            locationId: payload.locationId,
            customerId,
            actorUserId,
            performerInfo,
            ipAddress: ipAddress ?? null,
            userAgent: userAgent ?? null,
            channels: [
              { scope: ConsentScope.EMAIL, enabled: Boolean(payload.sendEmail) },
              { scope: ConsentScope.SMS, enabled: Boolean(effectiveSendSms) },
              { scope: ConsentScope.WHATSAPP, enabled: Boolean(payload.whatsAppOptIn) },
            ],
          });
          if (!payload.whatsAppOptIn) {
            await revokeCommunicationConsent({
              tx,
              locationId: payload.locationId,
              customerId,
              actorUserId,
              performerInfo,
              ipAddress: ipAddress ?? null,
              userAgent: userAgent ?? null,
              scope: ConsentScope.WHATSAPP,
            });
          }
        }

        if (customerId && vipStaffIds.length) {
          if (!isAdmin) {
            throw new Error("vip_not_allowed");
          }
          const staffScope: Prisma.StaffWhereInput = membershipSupported
            ? { id: { in: vipStaffIds }, memberships: { some: { locationId: payload.locationId } } }
            : { id: { in: vipStaffIds }, locationId: payload.locationId };
          const staffRecords = await tx.staff.findMany({
            where: staffScope,
            select: { id: true, metadata: true },
          });
          const eligibleVipStaffIds = staffRecords
            .filter((staff) => !readOnlineBookingEnabled(staff.metadata ?? null))
            .map((staff) => staff.id);
          const eligibleVipSet = new Set(eligibleVipStaffIds);
          const sanitizedVipIds = Array.from(
            new Set(vipStaffIds.filter((staffId) => eligibleVipSet.has(staffId))),
          );

          if (sanitizedVipIds.length) {
            if (!reminderCustomer?.email) {
              throw new Error("vip_email_required");
            }

            const existingPermissions = await tx.customerStaffBookingPermission.findMany({
              where: {
                customerId,
                locationId: payload.locationId,
                isAllowed: true,
                revokedAt: null,
                staffId: { in: sanitizedVipIds },
              },
              select: { staffId: true },
            });
            const alreadyAllowed = new Set(existingPermissions.map((entry) => entry.staffId));
            const toGrant = sanitizedVipIds.filter((staffId) => !alreadyAllowed.has(staffId));

            if (toGrant.length) {
              const now = new Date();
              for (const staffId of toGrant) {
                await tx.customerStaffBookingPermission.upsert({
                  where: { customerId_locationId_staffId: { customerId, locationId: payload.locationId, staffId } },
                  create: {
                    customerId,
                    locationId: payload.locationId,
                    staffId,
                    isAllowed: true,
                    grantedAt: now,
                    grantedByUserId: actorUserId,
                  },
                  update: {
                    isAllowed: true,
                    grantedAt: now,
                    grantedByUserId: actorUserId,
                    revokedAt: null,
                    revokedByUserId: null,
                  },
                });
              }

              permissionEmailPayload = {
                customerId,
                locationId: payload.locationId,
                email: reminderCustomer.email,
                customerName:
                  `${reminderCustomer.firstName ?? ""} ${reminderCustomer.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
                  "Kunde",
                createdByUserId: actorUserId,
              };
            }
          }
        }

        const repeatSeries =
          payload.repeat?.enabled && repeatUntil
            ? {
                seriesId: randomUUID(),
                frequency: payload.repeat.frequency,
                interval: payload.repeat.count,
                until: repeatUntil.toISOString(),
              }
            : null;

        for (const occurrence of occurrences) {
          const { startsAt, endsAt, index } = occurrence;

          const totalAmount = orderedServices.reduce((sum, { entry, record }) => {
            const base = Number(record?.basePrice ?? 0);
            return sum + (entry.priceOverride ?? base);
          }, 0);

          const appointment = await tx.appointment.create({
            data: {
              location: { connect: { id: payload.locationId } },
              customer: customerId ? { connect: { id: customerId } } : undefined,
              confirmationCode: generateConfirmationCode(),
              status: AppointmentStatus.CONFIRMED,
              paymentStatus: AppointmentPaymentStatus.UNPAID,
              source: "ADMIN",
              startsAt,
              endsAt,
              totalAmount: new Prisma.Decimal(totalAmount),
              depositAmount: null,
              currency: "EUR",
              note: payload.note ?? null,
              metadata: repeatSeries
                ? { ...appointmentMetadata, repeat: { ...repeatSeries, index } }
                : { ...appointmentMetadata },
            },
          });

          let cursor = new Date(startsAt);
          for (const { entry, record } of orderedServices) {
            if (!record) continue;
            const duration = entry.durationOverride ?? record.duration;
            const serviceEnds = addMinutes(cursor, duration);

            const normalizedServiceStaff = Array.from(
              new Set(
                (entry.staffIds ?? [])
                  .map((staffId) => (typeof staffId === "string" ? staffId.trim() : ""))
                  .filter((staffId): staffId is string => staffId.length > 0),
              ),
            );
            const staffTargets: Array<string | null> = normalizedServiceStaff.length
              ? normalizedServiceStaff
              : effectiveStaffIds.length
                ? [...effectiveStaffIds]
                : [null];

            // Ensure we never write the literal "unassigned" to the DB (FK würde brechen)
            const cleanedStaffTargets = staffTargets.map((id) => (id === "unassigned" ? null : id));

            for (const staffId of cleanedStaffTargets) {
              await tx.appointmentItem.create({
                data: {
                  appointmentId: appointment.id,
                  serviceId: record.id,
                  staffId,
                  customerId: customerId ?? null,
                  resourceId: payload.resources[0] ?? null,
                  status: "SCHEDULED",
                  startsAt: cursor,
                  endsAt: serviceEnds,
                  price: new Prisma.Decimal(entry.priceOverride ?? Number(record.basePrice ?? 0)),
                  currency: "EUR",
                  metadata: {
                    steps: record.steps.map((step) => ({
                      id: step.id,
                      name: step.name,
                      duration: step.duration,
                      resourceIds: step.resources.map((resource) => resource.resourceId),
                    })),
                  },
                },
              });
            }

            cursor = serviceEnds;
          }

          for (const file of attachments) {
            const arrayBuffer = await file.arrayBuffer();
            await tx.appointmentAttachment.create({
              data: {
                appointmentId: appointment.id,
                locationId: payload.locationId,
                fileName: file.name,
                mimeType: file.type,
                size: file.size,
                data: Buffer.from(arrayBuffer),
              },
            });
          }

          const cancellationDeadline = resolveCancellationDeadline({
            startsAt,
            policies,
            bookingPreferences,
          });
          const tokenExpiresAt = cancellationDeadline ?? startsAt;
          const accessToken = await createAppointmentAccessToken(appointment.id, tokenExpiresAt, tx);
          const manageUrl = buildAppointmentManageUrl(tenantId, accessToken.token);
          const smsUrl = buildAppointmentSmsUrl(accessToken.shortCode);

          await logAuditEvent(
            {
            locationId: payload.locationId,
            actorType: AuditActorType.USER,
            actorId: null,
            action: AuditAction.CREATE,
            entityType: "appointment",
            entityId: appointment.id,
            appointmentId: appointment.id,
            diff: {
              services: orderedServices.map(({ record }) => record?.name ?? ""),
              totalAmount,
              currency: "EUR",
              internalNote: payload.internalMessage ?? null,
              performedByStaff: performerInfo,
            },
            context: { source: "admin_calendar", performedByStaff: performerInfo },
            },
            tx,
          );

          results.push({ appointmentId: appointment.id, startsAt, endsAt });

          const servicesForNotification = orderedServices.map(({ record }) => record ?? null);
          if (shouldSendEmail && customerId) {
            await sendConfirmationEmail({
              appointment,
              services: servicesForNotification,
              customerId,
              personalMessage: payload.personalMessage ?? "",
              manageUrl,
            }).catch(() => null);
          }
          if (effectiveSendSms && customerId) {
            await sendSmsConfirmation({
              appointment,
              tenantId,
              customerId,
              manageUrl,
              smsUrl,
            }).catch((error) => {
              console.warn("[appointments:create] sms failed", error);
            });
          }
          if (effectiveSendWhatsApp && customerId) {
            await sendWhatsappConfirmation({
              appointment,
              manageUrl,
              smsUrl,
              services: servicesForNotification,
              customerId,
              staffFirstName: assignedStaffFirstName,
            }).catch((error) => {
              console.warn("[appointments:create] whatsapp failed", error);
            });
          }
        }
      }, { timeout: transactionTimeoutMs, maxWait: 10_000 });

      if (permissionEmailPayload) {
        try {
          await sendCustomerPermissionEmail(permissionEmailPayload);
        } catch (error) {
          console.error("[appointments:create] permission email failed", error);
        }
      }

      if (reminderCustomer && locationRecord?.metadata) {
        const reminderCustomerPayload = {
          id: reminderCustomer.id,
          email: reminderCustomer.email ?? null,
          phone: reminderCustomer.phone ?? null,
        };
        await Promise.all(
          results.map((entry) =>
            scheduleAppointmentReminders({
              appointment: {
                id: entry.appointmentId,
                startsAt: entry.startsAt,
                endsAt: entry.endsAt,
              },
              customer: reminderCustomerPayload,
              location: { id: payload.locationId },
              locationMetadata: locationRecord?.metadata,
            }),
          ),
        );
      }

      await publishAppointmentSync({
        locationId: payload.locationId,
        action: "created",
        appointmentIds: results.map((entry) => entry.appointmentId),
        timestamp: Date.now(),
      });

      return NextResponse.json({ data: results }, { status: 201 });
    } finally {
      if (lock) {
        await releaseLock(lock.key, lock.token, lock.redis);
      }
    }
  } catch (error) {
    if (error instanceof AppointmentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "unknown_error";
    if (message === "vip_email_required") {
      return NextResponse.json(
        { error: "Für diese Freigabe ist eine E-Mail-Adresse erforderlich." },
        { status: 400 },
      );
    }
    if (message === "vip_not_allowed") {
      return NextResponse.json({ error: "Keine Berechtigung für VIP-Freigabe." }, { status: 403 });
    }
    if (message === "customer_not_in_tenant") {
      return NextResponse.json({ error: "Kunde gehört nicht zu diesem Standort/Tenant." }, { status: 400 });
    }
    console.error("[appointments:create] failed", error);
    return NextResponse.json({ error: "Termin konnte nicht erstellt werden.", detail: message }, { status: 500 });
  }
}

class AppointmentConflictError extends Error {}

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
  const notificationPrefs = resolveNotificationPreferences(location.metadata);
  const emailSenderName = notificationPrefs.emailSenderName ?? tenantName;
  const replyTo = notificationPrefs.emailReplyTo ?? undefined;
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

  const notificationPrefs = resolveNotificationPreferences(location.metadata);
  const smsBrandName = notificationPrefs.smsBrandName ?? location.name ?? "Salon";
  const smsSenderName = notificationPrefs.smsSenderName ?? undefined;
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

function generateConfirmationCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function formatDate(date: Date) {
  return date.toISOString();
}
