import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Prisma, AuditAction, AuditActorType, ConsentSource, ConsentType, ConsentScope } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { findAvailability, type AvailabilitySlot } from "@/lib/availability";
import { buildAvailabilityRequest } from "@/lib/availability/request-builder";
import { makeAvailabilityCacheKey } from "@/lib/availability/cache";
import { getRedisClient } from "@/lib/redis";
import { createIcsEvent } from "@/lib/notifications/ics";
import { renderBookingConfirmation, renderBookingRequest } from "@/lib/notifications/templates";
import { createMailer } from "@/lib/notifications/mailer";
import { loadPoliciesForLocation, calculateDepositAmount } from "@/lib/policies";
import { scheduleAppointmentReminders } from "@/lib/notifications/reminders";
import { isSmsConfigured, isWhatsappConfigured, sendSms } from "@/lib/notifications/sms";
import { sendWhatsAppNotification } from "@/lib/notifications/whatsapp";
import { logAuditEvent } from "@/lib/audit/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getLogger } from "@/lib/logger";
import { executeWithCircuitBreaker } from "@/lib/circuit-breaker";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getShiftPlanClient, resolveShiftPlanStaffIdWithLookup } from "@/lib/shift-plan-client";
import { bookingLimitToMinutes, deriveBookingPreferences } from "@/lib/booking-preferences";
import { resolveBookingTenant } from "@/lib/booking-tenant";
import { buildAppointmentManageUrl, buildAppointmentSmsUrl, createAppointmentAccessToken } from "@/lib/appointments/access-tokens";
import { resolveCancellationDeadline } from "@/lib/appointments/cancellation";
import { resolveTenantName } from "@/lib/tenant";
import { CONSENT_METHOD_ONLINE, normalizeConsentMethod } from "@/lib/consent-method";
import { buildScheduleIntervals } from "@/lib/availability/intervals";
import { resolvePermittedStaffIdsForDevice } from "@/lib/customer-booking-permissions";
import { applyCustomerProfile } from "@/lib/customer-metadata";
import { extractColorMetadata } from "@/lib/color-consultation";
import { normalizePhoneNumber } from "@/lib/notifications/phone";
import { resolveNotificationPreferences, type NotificationPreferences } from "@/lib/notifications/notification-preferences";

const prisma = getPrismaClient();
const logger = getLogger();
const SLOT_CLAIM_TTL_MS = 2 * 60 * 1000;
const IDEMPOTENCY_WAIT_MS = 2000;
const IDEMPOTENCY_POLL_INTERVAL_MS = 100;

class SlotConflictError extends Error {
  constructor(message = "Slot is currently locked") {
    super(message);
    this.name = "SlotConflictError";
  }
}

async function waitForIdempotentAppointment(params: { locationId: string; idempotencyKey: string }) {
  const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;
  while (Date.now() < deadline) {
    const existingAppointment = await prisma.appointment.findFirst({
      where: { locationId: params.locationId, idempotencyKey: params.idempotencyKey },
      select: {
        id: true,
        confirmationCode: true,
        startsAt: true,
        endsAt: true,
        status: true,
        metadata: true,
        customerId: true,
      },
    });
    if (existingAppointment) return existingAppointment;
    await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_POLL_INTERVAL_MS));
  }
  return null;
}

const isoString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid ISO timestamp" });

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().email().optional(),
);

function parseMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

type SmartSlotSettings = {
  stepEngineMin: number;
  bufferMin: number;
  minGapMin: number;
  maxSmartSlotsPerHour: number;
  minWasteReductionMin: number;
  maxOffGridOffsetMin: number;
};

function resolveSmartSlotConfig(
  prefs: ReturnType<typeof deriveBookingPreferences>,
  stepUiMin: number,
): SmartSlotSettings | null {
  if (!prefs.smartSlotsEnabled) return null;
  const safeStepUi = Math.max(1, stepUiMin);
  const stepEngineMin = clampEngineStep(prefs.stepEngineMin, safeStepUi);
  const maxOffGridOffsetMin = Math.min(prefs.maxOffGridOffsetMin, Math.floor(safeStepUi / 2));
  return {
    stepEngineMin,
    bufferMin: prefs.bufferMin,
    minGapMin: prefs.minGapMin,
    maxSmartSlotsPerHour: prefs.maxSmartSlotsPerHour,
    minWasteReductionMin: prefs.minWasteReductionMin,
    maxOffGridOffsetMin,
  };
}

function clampEngineStep(value: number, stepUiMin: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : stepUiMin;
  let candidate = Math.min(stepUiMin, Math.max(1, rounded));
  if (stepUiMin % candidate === 0) return candidate;
  for (let next = candidate; next >= 1; next -= 1) {
    if (stepUiMin % next === 0) return next;
  }
  return stepUiMin;
}

function parseIsoDateToLocalMidnight(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function toUtcEndOfDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function collectMonthKeys(from: Date, to: Date): string[] {
  const keys = new Set<string>();
  const cursor = new Date(from);
  cursor.setDate(1);
  while (cursor <= to) {
    keys.add(cursor.toISOString().slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return Array.from(keys);
}

const consentSchema = z.object({
  type: z.nativeEnum(ConsentType),
  scope: z.nativeEnum(ConsentScope),
  granted: z.boolean(),
  grantedAt: isoString.optional(),
});

const payloadSchema = z
  .object({
    slotKey: z.string().min(1),
    deviceId: z.string().uuid().optional(),
    window: z.object({
      from: isoString,
      to: isoString,
    }),
    staffId: z.string().min(1),
    services: z
      .array(
        z.object({
          serviceId: z.string().min(1),
          price: z.number().nonnegative(),
          currency: z.string().min(1).default("EUR"),
          steps: z.array(
            z.object({
              stepId: z.string().min(1),
              start: isoString,
              end: isoString,
              requiresStaff: z.boolean().optional().default(true),
              resourceIds: z.array(z.string().min(1)).optional().default([]),
            }),
          ),
        }),
      )
      .nonempty(),
    customer: z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      email: optionalEmail,
      phone: optionalTrimmedString,
    }),
    notes: z.string().max(5_000).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    consents: z.array(consentSchema).optional().default([]),
  })
  .superRefine((payload, ctx) => {
    if (!payload.customer.email && !payload.customer.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bitte gib eine Telefonnummer oder E-Mail-Adresse an.",
        path: ["customer", "email"],
      });
    }
  });

type CheckoutPayload = z.infer<typeof payloadSchema>;

type ConsentCaptureInput = {
  type: ConsentType;
  scope: ConsentScope;
  grantedAt?: Date | null;
};

type NotificationChannels = {
  sms: boolean;
  whatsapp: boolean;
};

async function captureOnlineConsents(params: {
  customerId: string;
  locationId: string;
  consents: ConsentCaptureInput[];
  ipAddress: string | null;
  userAgent: string | null;
}) {
  if (!params.consents.length) return;

  const defaultMetadata = {
    method: CONSENT_METHOD_ONLINE,
    reference: "Online-Buchung",
    note: "Einwilligung bei Online-Buchung erfasst",
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

  const existingConsents = await prisma.consent.findMany({
    where: {
      customerId: params.customerId,
      locationId: params.locationId,
      OR: params.consents.map((consent) => ({ type: consent.type, scope: consent.scope })),
    },
    select: {
      id: true,
      type: true,
      scope: true,
      granted: true,
      grantedAt: true,
      revokedAt: true,
      metadata: true,
    },
  });
  const existingByKey = new Map(existingConsents.map((consent) => [`${consent.type}:${consent.scope}`, consent]));
  const now = new Date();

  for (const consentInput of params.consents) {
    const key = `${consentInput.type}:${consentInput.scope}`;
    const existing = existingByKey.get(key) ?? null;
    const metadataUpdate = buildMetadataUpdate(existing?.metadata ?? null);

    if (existing?.granted && !existing.revokedAt) {
      if (!metadataUpdate.needsUpdate) {
        continue;
      }
      await prisma.consent.update({
        where: { id: existing.id },
        data: {
          metadata: metadataUpdate.nextMetadata as Prisma.InputJsonValue,
          source: ConsentSource.WEB,
          recordedById: null,
        },
      });
      await logAuditEvent({
        locationId: params.locationId,
        actorType: AuditActorType.CUSTOMER,
        actorId: null,
        action: AuditAction.UPDATE,
        entityType: "consent",
        entityId: existing.id,
        diff: {
          metadata: { from: metadataUpdate.existingMetadata, to: metadataUpdate.nextMetadata },
        },
        context: {
          type: consentInput.type,
          scope: consentInput.scope,
          source: "online_booking",
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });
      continue;
    }

    const grantedAt = consentInput.grantedAt ?? now;

    if (!existing) {
      const created = await prisma.consent.create({
        data: {
          customerId: params.customerId,
          locationId: params.locationId,
          type: consentInput.type,
          scope: consentInput.scope,
          granted: true,
          grantedAt,
          revokedAt: null,
          source: ConsentSource.WEB,
          recordedById: null,
          metadata: {
            method: defaultMetadata.method,
            reference: defaultMetadata.reference,
            note: defaultMetadata.note,
          } satisfies Prisma.InputJsonValue,
        },
      });
      await logAuditEvent({
        locationId: params.locationId,
        actorType: AuditActorType.CUSTOMER,
        actorId: null,
        action: AuditAction.CREATE,
        entityType: "consent",
        entityId: created.id,
        diff: {
          granted: { from: null, to: true },
          grantedAt: { from: null, to: grantedAt.toISOString() },
          revokedAt: { from: null, to: null },
        },
        context: {
          type: consentInput.type,
          scope: consentInput.scope,
          source: "online_booking",
        },
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
      });
      continue;
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (!existing.granted) {
      changes.granted = { from: existing.granted, to: true };
    }
    if (existing.grantedAt.getTime() !== grantedAt.getTime()) {
      changes.grantedAt = { from: existing.grantedAt.toISOString(), to: grantedAt.toISOString() };
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

    await prisma.consent.update({
      where: { id: existing.id },
      data: {
        granted: true,
        grantedAt,
        revokedAt: null,
        source: ConsentSource.WEB,
        recordedById: null,
        ...(metadataUpdate.needsUpdate ? { metadata: metadataUpdate.nextMetadata as Prisma.InputJsonValue } : {}),
      },
    });

    await logAuditEvent({
      locationId: params.locationId,
      actorType: AuditActorType.CUSTOMER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "consent",
      entityId: existing.id,
      diff: changes,
      context: {
        type: consentInput.type,
        scope: consentInput.scope,
        source: "online_booking",
      },
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }
}

function readMetadataRecord(metadata: Prisma.JsonValue | null) {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function mergeCustomerMetadata(
  metadata: Prisma.JsonValue | null,
  incoming: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base = readMetadataRecord(metadata);
  const { customerProfile, ...rest } = incoming;
  let next: Record<string, unknown> = { ...base, ...rest };
  if (customerProfile && typeof customerProfile === "object" && !Array.isArray(customerProfile)) {
    next = readMetadataRecord(applyCustomerProfile(next as Prisma.InputJsonValue, customerProfile as any));
  }
  return next as Prisma.InputJsonValue;
}

export async function POST(request: NextRequest, context: { params: Promise<{ tenant: string; location: string }> }) {
  const { tenant, location } = await context.params;
  const body = await request.json().catch(() => null);
  const resolution = await resolveBookingTenant(tenant);
  if (!resolution) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const parseResult = payloadSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: "Invalid payload",
        details: parseResult.error.issues.map((issue) => issue.message),
      },
      { status: 400 },
    );
  }

  const payload = parseResult.data;
  const rawPhone = payload.customer.phone?.trim() ?? "";
  const normalizedPhone = rawPhone ? normalizePhoneNumber(rawPhone) : "";
  const localPhone = normalizedPhone.startsWith("+49") ? `0${normalizedPhone.slice(3)}` : "";
  const phoneCandidates = new Set<string>();
  for (const value of [rawPhone, normalizedPhone, localPhone]) {
    if (value) phoneCandidates.add(value);
  }
  const customerPhone = normalizedPhone || rawPhone || null;
  const customerEmail = payload.customer.email?.trim().toLowerCase() ?? null;
  const customerForBooking = {
    ...payload.customer,
    email: customerEmail,
    phone: customerPhone,
  };
  const incomingMetadata =
    payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : null;
  const { request: colorRequest, precheck: colorPrecheck } = extractColorMetadata(incomingMetadata);
  const isColorRequest = Boolean(colorRequest);
  const colorPrecheckQuery = colorPrecheck ? JSON.stringify(colorPrecheck) : undefined;
  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const userAgent = request.headers.get("user-agent") ?? null;
  const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;

  const rateKey = ipAddress ?? customerEmail ?? customerPhone ?? "anonymous";
  const rateLimit = await enforceRateLimit(`checkout:${rateKey}`, 5, 60);
  if (!rateLimit.allowed) {
    logger.warn({ rateKey }, "checkout rate limit exceeded");
    return NextResponse.json(
      { error: "Too many booking attempts. Bitte versuche es später erneut." },
      { status: 429 },
    );
  }

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: resolution.tenantId, slug: location },
    select: {
      id: true,
      slug: true,
      name: true,
      tenantId: true,
      timezone: true,
      metadata: true,
      addressLine1: true,
      city: true,
      tenant: { select: { name: true } },
    },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const locationMetadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const notificationPrefs = resolveNotificationPreferences(locationRecord.metadata);
  const shouldAutoConfirm = bookingPreferences.autoConfirm;
  if (!bookingPreferences.onlineBookingEnabled) {
    return NextResponse.json({ error: "Online-Buchung ist deaktiviert." }, { status: 403 });
  }
  const useShiftPlan = bookingPreferences.shiftPlan;
  const intervalFromPrefs = Number.parseInt(bookingPreferences.interval ?? "", 10);
  const slotGranularityMinutes = Number.isFinite(intervalFromPrefs) && intervalFromPrefs > 0 ? intervalFromPrefs : 15;
  const smartSlotConfig = resolveSmartSlotConfig(bookingPreferences, slotGranularityMinutes);
  const smartSlotsKey = smartSlotConfig
    ? `smart:${smartSlotConfig.stepEngineMin}:${smartSlotConfig.bufferMin}:${smartSlotConfig.minGapMin}:${smartSlotConfig.maxSmartSlotsPerHour}:${smartSlotConfig.minWasteReductionMin}:${smartSlotConfig.maxOffGridOffsetMin}`
    : "smart:off";
  const effectiveSlotGranularityMinutes = smartSlotConfig?.stepEngineMin ?? slotGranularityMinutes;

  const policies = await loadPoliciesForLocation(locationRecord.id);

  const termsConsent = payload.consents.find((consent) => consent.type === "TERMS" && consent.granted);
  if (!termsConsent) {
    return NextResponse.json({ error: "Terms consent required" }, { status: 400 });
  }
  if (idempotencyKey) {
    const existingAppointment = await prisma.appointment.findFirst({
      where: { locationId: locationRecord.id, idempotencyKey },
      select: {
        id: true,
        confirmationCode: true,
        startsAt: true,
        endsAt: true,
        status: true,
        metadata: true,
      },
    });
    if (existingAppointment) {
      const cancellationDeadline = resolveCancellationDeadline({
        startsAt: existingAppointment.startsAt,
        policies,
        bookingPreferences,
      });
      const storedChannels = extractBookingChannels(existingAppointment.metadata) ?? { sms: false, whatsapp: false };
      return NextResponse.json(
        buildCheckoutResponsePayload({
          appointment: existingAppointment,
          policies,
          cancellationDeadline,
          channels: storedChannels,
        }),
        { status: 200 },
      );
    }
  }

  const windowFrom = new Date(payload.window.from);
  const windowTo = new Date(payload.window.to);
  if (windowTo <= windowFrom) {
    return NextResponse.json({ error: "Invalid window range" }, { status: 400 });
  }

  try {
    const requestedServiceIds = payload.services.map((service) => service.serviceId);
    const services = await prisma.service.findMany({
      where: {
        id: { in: requestedServiceIds },
        locationId: locationRecord.id,
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
    if (services.length !== requestedServiceIds.length) {
      return NextResponse.json({ error: "Service not found for this location" }, { status: 400 });
    }

    const staffMembershipSupported = await supportsStaffMemberships(prisma);
    const staffScope: Prisma.StaffWhereInput = staffMembershipSupported
      ? {
          memberships: {
            some: { locationId: locationRecord.id },
          },
          status: "ACTIVE",
        }
      : {
          locationId: locationRecord.id,
          status: "ACTIVE",
        };

    const staffRecords = await prisma.staff.findMany({
      where: {
        ...staffScope,
        id: { in: [payload.staffId] },
      },
      select: {
        id: true,
        locationId: true,
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
        code: true,
        metadata: true,
      },
    });

    if (staffRecords.length !== 1) {
      return NextResponse.json({ error: "Staff not found for this location" }, { status: 400 });
    }
    const staffMetadata = staffRecords[0]?.metadata;
    if (staffMetadata && typeof staffMetadata === "object" && !Array.isArray(staffMetadata)) {
      const onlineBookingEnabled = (staffMetadata as Record<string, unknown>).onlineBookingEnabled;
      if (typeof onlineBookingEnabled === "boolean" && !onlineBookingEnabled) {
        const { staffIds: permittedStaffIds } = await resolvePermittedStaffIdsForDevice({
          deviceId: payload.deviceId,
          locationId: locationRecord.id,
          prisma,
        });
        if (!permittedStaffIds.includes(payload.staffId)) {
          return NextResponse.json({ error: "Staff not available for online booking" }, { status: 400 });
        }
      }
    }

    const rangeFrom = new Date(payload.window.from);
    const rangeTo = new Date(payload.window.to);
    const cacheKey = makeAvailabilityCacheKey({
      locationId: locationRecord.id,
      windowFrom: rangeFrom.toISOString(),
      windowTo: rangeTo.toISOString(),
      mode: useShiftPlan ? "shiftplan" : "opening-hours",
      serviceIds: requestedServiceIds,
      staffId: payload.staffId,
      slotGranularityMinutes: effectiveSlotGranularityMinutes,
      smartSlotsKey,
      deviceId: payload.deviceId,
      colorPrecheck: colorPrecheckQuery,
    });

    const scheduleRecords = await prisma.schedule.findMany({
      where: { locationId: locationRecord.id },
      include: { rules: true },
    });
    const baseSchedules = scheduleRecords.filter((schedule) => schedule.ownerType !== "STAFF");
    const hasActiveLocationRules = baseSchedules.some(
      (schedule) =>
        schedule.ownerType === "LOCATION" &&
        schedule.rules.some((rule) => rule.isActive !== false && rule.endsAt > rule.startsAt),
    );
    if (!hasActiveLocationRules) {
      const scheduleId = `${locationRecord.id}-always-open`;
      const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"] as const;
      baseSchedules.push({
        id: scheduleId,
        locationId: locationRecord.id,
        ownerType: "LOCATION",
        staffId: null,
        resourceId: null,
        name: "24/7",
        timezone: locationRecord.timezone ?? "Europe/Berlin",
        isDefault: false,
        metadata: { fallback: "always-open" } as Prisma.JsonValue,
        createdAt: new Date(),
        updatedAt: new Date(),
        rules: weekdays.map((weekday, index) => ({
          id: `${scheduleId}-${index}`,
          scheduleId,
          ruleType: "WEEKLY",
          weekday,
          startsAt: 0,
          endsAt: 24 * 60,
          serviceId: null,
          staffId: null,
          priority: 0,
          effectiveFrom: null,
          effectiveTo: null,
          isActive: true,
          metadata: null,
        })),
      });
    }

    const staffSchedules: typeof scheduleRecords = [];
    const targetStaff = staffRecords[0] ?? null;
    let shiftPlanFetchSucceeded = false;
    let shiftPlanFetchFailed = false;
    if (useShiftPlan) {
      if (targetStaff?.id) {
        try {
          const client = getShiftPlanClient(resolution.tenantId);
          const monthKeys = collectMonthKeys(rangeFrom, rangeTo);
          const days: Array<{ startsAtMinutes: number; endsAtMinutes: number; effectiveDate: Date }> = [];
          const shiftPlanStaffId = await resolveShiftPlanStaffIdWithLookup(client, targetStaff);
          if (!shiftPlanStaffId) {
            shiftPlanFetchFailed = true;
            console.warn("[checkout] shift plan staff mapping failed", {
              staffId: targetStaff.id,
            });
          }
          if (shiftPlanStaffId) {
            for (const monthKey of monthKeys) {
              if (shiftPlanFetchFailed) break;
              try {
                const plan = await client.getShiftPlan(shiftPlanStaffId, monthKey);
                shiftPlanFetchSucceeded = true;
                for (const day of plan.days) {
                  const startMinutes = parseMinutes(day.start);
                  const endMinutes = parseMinutes(day.end);
                  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) continue;
                  const effectiveDate = parseIsoDateToLocalMidnight(day.isoDate);
                  if (!effectiveDate) continue;
                  days.push({ startsAtMinutes: startMinutes, endsAtMinutes: endMinutes, effectiveDate });
                }
              } catch (error) {
                shiftPlanFetchFailed = true;
                console.warn("[checkout] shift plan fetch failed", {
                  staffId: targetStaff.id,
                  shiftPlanStaffId,
                  monthKey,
                  error,
                });
                break;
              }
            }
          }
          if (days.length) {
            const scheduleId = `stundenliste-${targetStaff.id}`;
            const plan = {
              id: scheduleId,
              locationId: locationRecord.id,
              ownerType: "STAFF",
              staffId: targetStaff.id,
              resourceId: null,
              name: "Schichtplan",
              timezone: locationRecord.timezone ?? "Europe/Berlin",
              isDefault: false,
              metadata: { source: "stundenliste" } as Prisma.JsonValue,
              createdAt: new Date(),
              updatedAt: new Date(),
              rules: days.map((day, index) => ({
                id: `${scheduleId}-${index}`,
                scheduleId,
                ruleType: "DATE",
                weekday: null,
                startsAt: day.startsAtMinutes,
                endsAt: day.endsAtMinutes,
                serviceId: null,
                staffId: targetStaff.id,
                priority: 0,
                effectiveFrom: day.effectiveDate,
                effectiveTo: toUtcEndOfDay(day.effectiveDate),
                isActive: true,
                metadata: null,
              })),
            };
            staffSchedules.push(plan);
          } else {
            // Schichtplan ist aktiv, aber keine Schichten ⇒ komplett nicht verfügbar.
            // Das wird über ein virtuelles TimeOff abgebildet (keine buchbaren Slots).
          }
        } catch (error) {
          shiftPlanFetchFailed = true;
          console.warn("[checkout] skipping stundenliste schedules", error);
        }
      }
    }

    if (useShiftPlan && shiftPlanFetchFailed) {
      return NextResponse.json(
        { error: "Schichtplan konnte nicht geladen werden. Bitte Support kontaktieren." },
        { status: 503 },
      );
    }

    const effectiveSchedules = useShiftPlan ? [...baseSchedules, ...staffSchedules] : baseSchedules;

    const timeOffs = await prisma.timeOff.findMany({
      where: {
        locationId: locationRecord.id,
        startsAt: { lt: rangeTo },
        endsAt: { gt: rangeFrom },
      },
    });

    if (useShiftPlan) {
      if (targetStaff?.id && staffSchedules.length === 0 && shiftPlanFetchSucceeded) {
        timeOffs.push({
          id: `shiftplan-empty:${locationRecord.id}:${targetStaff.id}:${rangeFrom.toISOString()}:${rangeTo.toISOString()}`,
          locationId: locationRecord.id,
          scheduleId: null,
          staffId: targetStaff.id,
          reason: "SCHICHTPLAN_LEER",
          startsAt: rangeFrom,
          endsAt: rangeTo,
          createdById: null,
          metadata: { source: "stundenliste", fallback: "blocked-no-shifts" } as Prisma.JsonValue,
          createdAt: new Date(),
        } as any);
      }
    }

    const availabilityRequest = buildAvailabilityRequest({
      locationId: locationRecord.id,
      services,
      staff: staffRecords,
      resources: await prisma.resource.findMany({
        where: { locationId: locationRecord.id, isActive: true },
      }),
      schedules: effectiveSchedules,
      timeOffs,
      availabilityExceptions: await prisma.availabilityException.findMany({
        where: {
          locationId: locationRecord.id,
          startsAt: { lt: rangeTo },
          endsAt: { gt: rangeFrom },
        },
      }),
      appointmentItems: await prisma.appointmentItem.findMany({
        where: {
          appointment: {
            locationId: locationRecord.id,
            status: { not: "CANCELLED" },
          },
          startsAt: { lt: rangeTo },
          endsAt: { gt: rangeFrom },
        },
        include: { appointment: { select: { id: true, locationId: true } } },
      }),
      window: { from: rangeFrom, to: rangeTo },
      staffId: payload.staffId,
      slotGranularityMinutes: effectiveSlotGranularityMinutes,
    });

    if (useShiftPlan) {
      const intervals = buildScheduleIntervals(
        availabilityRequest.schedules,
        "STAFF",
        payload.staffId,
        availabilityRequest.window,
      );
      if (!intervals.length) {
        availabilityRequest.timeOffs.push({
          id: `shiftplan-window-empty:${locationRecord.id}:${payload.staffId}:${rangeFrom.toISOString()}:${rangeTo.toISOString()}`,
          locationId: locationRecord.id,
          scheduleId: null,
          staffId: payload.staffId,
          reason: "SCHICHTPLAN_LEER",
          startsAt: rangeFrom,
          endsAt: rangeTo,
          metadata: { source: "stundenliste", fallback: "blocked-no-shifts-window" },
        });
      }
    }

    const slots = await findAvailability(availabilityRequest);
    const matchingSlot = slots.find((slot) => slot.slotKey === payload.slotKey);
    if (!matchingSlot) {
      return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
    }

    const pricing = {
      total: payload.services.reduce((sum, service) => sum + (service.price ?? 0), 0),
      currency: payload.services[0]?.currency ?? "EUR",
    };

    const deposit = calculateDepositAmount(policies.deposit, pricing.total);

    const bookingStart = (matchingSlot as any).start ?? matchingSlot.reservedFrom ?? null;
    const bookingEnd = (matchingSlot as any).end ?? matchingSlot.reservedTo ?? null;
    if (!bookingStart || !bookingEnd) {
      return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
    }
    const slotStaffId = matchingSlot.staffId ?? null;
    if (!slotStaffId) {
      return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
    }

    const bookingStartMs = new Date(bookingStart).getTime();
    const nowMs = Date.now();
    const minAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.minAdvance);
    const maxAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.maxAdvance);
    const earliestStartMs = nowMs + minAdvanceMinutes * 60 * 1000;
    const latestStartMs = maxAdvanceMinutes > 0 ? nowMs + maxAdvanceMinutes * 60 * 1000 : null;
    if (
      Number.isFinite(bookingStartMs) &&
      (bookingStartMs < earliestStartMs || (latestStartMs !== null && bookingStartMs > latestStartMs))
    ) {
      return NextResponse.json({ error: "Termin liegt außerhalb des Buchungslimits." }, { status: 409 });
    }

    const appointmentStatus = shouldAutoConfirm ? "CONFIRMED" : "PENDING";
    let appointment: Awaited<ReturnType<typeof prisma.appointment.create>>;
    let customerId: string | null = null;
    const claimExpiresAt = new Date(Date.now() + SLOT_CLAIM_TTL_MS);
    try {
      const bookingResult = await prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.bookingSlotClaim.deleteMany({
          where: { locationId: locationRecord.id, expiresAt: { lt: now } },
        });
        try {
          await tx.bookingSlotClaim.create({
            data: {
              locationId: locationRecord.id,
              slotKey: payload.slotKey,
              idempotencyKey: idempotencyKey ?? null,
              status: "HELD",
              expiresAt: claimExpiresAt,
            },
          });
        } catch (error) {
          if (isUniqueConstraintError(error, ["locationId", "slotKey"])) {
            if (idempotencyKey) {
              const existingAppointment = await tx.appointment.findFirst({
                where: { locationId: locationRecord.id, idempotencyKey },
                select: {
                  id: true,
                  confirmationCode: true,
                  startsAt: true,
                  endsAt: true,
                  status: true,
                  metadata: true,
                  customerId: true,
                },
              });
              if (existingAppointment) {
                return {
                  appointment: existingAppointment,
                  customerId: existingAppointment.customerId ?? null,
                  idempotent: true,
                };
              }
              return {
                awaitIdempotency: true,
              };
            }
            throw new SlotConflictError();
          }
          throw error;
        }

        const conflictingItem = await tx.appointmentItem.findFirst({
          where: {
            appointment: {
              locationId: locationRecord.id,
              status: { not: "CANCELLED" },
            },
            staffId: slotStaffId,
            startsAt: { lt: bookingEnd },
            endsAt: { gt: bookingStart },
          },
          select: { id: true },
        });
        if (conflictingItem) {
          throw new SlotConflictError("Slot is no longer available");
        }

        const existingCustomer = await tx.customer.findFirst({
          where: {
            locationId: locationRecord.id,
            OR: [
              customerEmail ? { email: customerEmail } : undefined,
              phoneCandidates.size ? { phone: { in: Array.from(phoneCandidates) } } : undefined,
            ].filter(Boolean) as any,
          },
          select: { id: true, email: true, phone: true, metadata: true },
        });
        if (existingCustomer && (customerEmail || customerPhone)) {
          const updateData: Prisma.CustomerUpdateInput = {};
          if (customerEmail && !existingCustomer.email) {
            updateData.email = customerEmail;
          }
          if (customerPhone && !existingCustomer.phone) {
            updateData.phone = customerPhone;
          }
          if (incomingMetadata) {
            updateData.metadata = mergeCustomerMetadata(existingCustomer.metadata ?? null, incomingMetadata);
          }
          if (Object.keys(updateData).length > 0) {
            await tx.customer.update({
              where: { id: existingCustomer.id },
              data: updateData,
            });
          }
        }

        let appointment;
        try {
          appointment = await tx.appointment.create({
            data: {
              location: { connect: { id: locationRecord.id } },
              customer: existingCustomer
                ? { connect: { id: existingCustomer.id } }
                : {
                    create: {
                      locationId: locationRecord.id,
                      firstName: payload.customer.firstName,
                      lastName: payload.customer.lastName,
                      email: customerEmail,
                      phone: customerPhone,
                      metadata: incomingMetadata ?? {},
                    },
                  },
              idempotencyKey: idempotencyKey ?? null,
              status: appointmentStatus,
              paymentStatus: deposit ? "DEPOSIT_DUE" : "UNPAID",
              source: "WEB",
              startsAt: bookingStart,
              endsAt: bookingEnd,
              totalAmount: new Prisma.Decimal(pricing.total),
              depositAmount: deposit ? new Prisma.Decimal(deposit.amount) : null,
              currency: pricing.currency,
              note: payload.notes ?? null,
              confirmationCode: generateConfirmationCode(),
              metadata: {
                booking: {
                  services: payload.services.map((svc) => ({
                    id: svc.serviceId,
                    price: svc.price,
                    currency: svc.currency,
                  })),
                  slotKey: payload.slotKey,
                },
                ...(incomingMetadata ? { request: incomingMetadata } : {}),
              },
              items: {
                create: flattenServicesToItems(matchingSlot, payload.services, slotStaffId, {
                  forceUnassigned: false,
                }),
              },
            },
          });
        } catch (error) {
          if (idempotencyKey && isUniqueConstraintError(error, ["locationId", "idempotencyKey"])) {
            const existingAppointment = await tx.appointment.findFirst({
              where: { locationId: locationRecord.id, idempotencyKey },
              select: {
                id: true,
                confirmationCode: true,
                startsAt: true,
                endsAt: true,
                status: true,
                metadata: true,
                customerId: true,
              },
            });
            if (existingAppointment) {
              await tx.bookingSlotClaim.deleteMany({
                where: { locationId: locationRecord.id, slotKey: payload.slotKey },
              });
              return {
                appointment: existingAppointment,
                customerId: existingAppointment.customerId ?? null,
                idempotent: true,
              };
            }
          }
          throw error;
        }

        await tx.bookingSlotClaim.deleteMany({
          where: { locationId: locationRecord.id, slotKey: payload.slotKey },
        });

        return {
          appointment,
          customerId: appointment.customerId ?? existingCustomer?.id ?? null,
          idempotent: false,
        };
      });

      appointment = bookingResult.appointment;
      customerId = bookingResult.customerId;
      if (bookingResult.awaitIdempotency && idempotencyKey) {
        const existingAppointment = await waitForIdempotentAppointment({
          locationId: locationRecord.id,
          idempotencyKey,
        });
        if (existingAppointment) {
          const cancellationDeadline = resolveCancellationDeadline({
            startsAt: existingAppointment.startsAt,
            policies,
            bookingPreferences,
          });
          const storedChannels = extractBookingChannels(existingAppointment.metadata) ?? { sms: false, whatsapp: false };
          return NextResponse.json(
            buildCheckoutResponsePayload({
              appointment: existingAppointment,
              policies,
              cancellationDeadline,
              channels: storedChannels,
            }),
            { status: 200 },
          );
        }
        return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
      }
      if (bookingResult.idempotent) {
        const cancellationDeadline = resolveCancellationDeadline({
          startsAt: appointment.startsAt,
          policies,
          bookingPreferences,
        });
        const storedChannels = extractBookingChannels(appointment.metadata) ?? { sms: false, whatsapp: false };
        return NextResponse.json(
          buildCheckoutResponsePayload({
            appointment,
            policies,
            cancellationDeadline,
            channels: storedChannels,
          }),
          { status: 200 },
        );
      }
    } catch (error) {
      if (error instanceof SlotConflictError) {
        if (idempotencyKey) {
          const existingAppointment = await waitForIdempotentAppointment({
            locationId: locationRecord.id,
            idempotencyKey,
          });
          if (existingAppointment) {
            const cancellationDeadline = resolveCancellationDeadline({
              startsAt: existingAppointment.startsAt,
              policies,
              bookingPreferences,
            });
            const storedChannels = extractBookingChannels(existingAppointment.metadata) ?? { sms: false, whatsapp: false };
            return NextResponse.json(
              buildCheckoutResponsePayload({
                appointment: existingAppointment,
                policies,
                cancellationDeadline,
                channels: storedChannels,
              }),
              { status: 200 },
            );
          }
        }
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (idempotencyKey && isUniqueConstraintError(error, ["locationId", "idempotencyKey"])) {
        const existingAppointment = await prisma.appointment.findFirst({
          where: { locationId: locationRecord.id, idempotencyKey },
          select: {
            id: true,
            confirmationCode: true,
            startsAt: true,
            endsAt: true,
            status: true,
            metadata: true,
          },
        });
        if (existingAppointment) {
          const cancellationDeadline = resolveCancellationDeadline({
            startsAt: existingAppointment.startsAt,
            policies,
            bookingPreferences,
          });
          const storedChannels = extractBookingChannels(existingAppointment.metadata) ?? { sms: false, whatsapp: false };
          return NextResponse.json(
            buildCheckoutResponsePayload({
              appointment: existingAppointment,
              policies,
              cancellationDeadline,
              channels: storedChannels,
            }),
            { status: 200 },
          );
        }
      }
      throw error;
    }
    const deviceId = payload.deviceId?.trim();
    if (customerId && deviceId) {
      try {
        await prisma.customerDevice.upsert({
          where: {
            customerId_deviceId: {
              customerId,
              deviceId,
            },
          },
          update: {
            lastSeenAt: new Date(),
            userAgent: userAgent ?? undefined,
          },
          create: {
            customerId,
            deviceId,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
            userAgent: userAgent ?? undefined,
          },
        });
      } catch (error) {
        logger.warn({ err: error }, "customer device upsert failed");
      }
    }
    if (customerId) {
      const baseConsents: ConsentCaptureInput[] = [];
      if (customerEmail) {
        baseConsents.push({ type: ConsentType.COMMUNICATION, scope: ConsentScope.EMAIL });
      }
      if (customerPhone) {
        baseConsents.push({ type: ConsentType.COMMUNICATION, scope: ConsentScope.SMS });
      }
      const payloadConsents = payload.consents
        .filter((consent) => consent.granted)
        .map((consent) => ({
          type: consent.type,
          scope: consent.scope,
          grantedAt: consent.grantedAt ? new Date(consent.grantedAt) : null,
        }));
      const consentMap = new Map<string, ConsentCaptureInput>();
      for (const consent of [...baseConsents, ...payloadConsents]) {
        const key = `${consent.type}:${consent.scope}`;
        if (!consentMap.has(key)) {
          consentMap.set(key, consent);
        }
      }
      const consentsToCapture = Array.from(consentMap.values());
      if (consentsToCapture.length) {
        try {
          await captureOnlineConsents({
            customerId,
            locationId: locationRecord.id,
            consents: consentsToCapture,
            ipAddress,
            userAgent,
          });
        } catch (error) {
          logger.warn({ err: error }, "online consent capture failed");
        }
      }
    }

    const cancellationDeadline = resolveCancellationDeadline({
      startsAt: appointment.startsAt,
      policies,
      bookingPreferences,
    });
    const tokenExpiresAt = cancellationDeadline ?? appointment.startsAt;
    const accessToken = await createAppointmentAccessToken(appointment.id, tokenExpiresAt);
    const manageUrl = buildAppointmentManageUrl(tenant, accessToken.token);
    const smsUrl = buildAppointmentSmsUrl(accessToken.shortCode);

    const whatsappOptIn = payload.consents.some(
      (consent) => consent.type === "COMMUNICATION" && consent.scope === "WHATSAPP" && consent.granted,
    );

    let notificationChannels: NotificationChannels = { sms: false, whatsapp: false };
    try {
      const serviceNameMap = new Map(services.map((service) => [service.id, service.name]));
      const serviceDisplay = payload.services.map((service) => ({
        name: serviceNameMap.get(service.serviceId) ?? "Service",
        price: service.price,
        currency: service.currency,
      }));
      const serviceNames = serviceDisplay.map((entry) => entry.name).filter((name) => name && name.trim().length);
      const resolvedTenantName =
        (await resolveTenantName(locationRecord.tenantId, locationRecord.tenant?.name ?? locationRecord.name)) ?? null;
      const locationForNotifications = {
        name: locationRecord.name,
        addressLine1: locationRecord.addressLine1,
        city: locationRecord.city,
        tenantId: locationRecord.tenantId,
        timezone: locationRecord.timezone,
        tenantName: resolvedTenantName,
      };
      if (appointment.status === "CONFIRMED") {
        notificationChannels = await sendNotifications({
          appointment,
          customer: customerForBooking,
          serviceNames,
          staff: staffRecords[0],
          location: locationForNotifications,
          notificationPrefs,
          policies,
          deposit,
          manageUrl,
          smsUrl,
          whatsappOptIn,
        });
      } else {
        await sendRequestEmail({
          appointment,
          customer: customerForBooking,
          services: serviceDisplay,
          location: locationForNotifications,
          notificationPrefs,
          manageUrl,
        });
      }
    } catch (error) {
      console.warn("[checkout] notifications failed", error);
    }

    if (appointment.customerId && appointment.status === "CONFIRMED") {
      await scheduleAppointmentReminders({
        appointment: {
          id: appointment.id,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
        },
        customer: {
          id: appointment.customerId,
          email: customerEmail,
          phone: customerPhone,
        },
        location: { id: locationRecord.id },
        locationMetadata: locationRecord.metadata,
      });
    }

    try {
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          metadata: mergeAppointmentMetadata(appointment.metadata ?? null, {
            bookingChannels: notificationChannels,
          }),
        },
      });
    } catch (error) {
      logger.warn({ err: error }, "booking channels metadata update failed");
    }

    const redis = getRedisClient();
    if (redis) {
      try {
        if (!redis.status || redis.status === "end") {
          await redis.connect();
        }
        await redis.del(cacheKey);
      } catch (error) {
        logger.warn({ err: error }, "availability cache invalidation failed");
      }
    }

    return NextResponse.json(
      buildCheckoutResponsePayload({
        appointment,
        policies,
        cancellationDeadline,
        channels: notificationChannels,
      }),
    );
  } catch (error) {
    console.error("[checkout] failed", error);
    return NextResponse.json({ error: "Booking failed" }, { status: 500 });
  }
}

function generateConfirmationCode() {
  return randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
}

function flattenServicesToItems(
  slot: AvailabilitySlot,
  services: CheckoutPayload["services"],
  staffIdFallback: string | null,
  options?: { forceUnassigned?: boolean },
): Prisma.AppointmentItemCreateManyAppointmentInput[] {
  const serviceAssignments = (slot as any).services ?? slot.serviceAssignments ?? [];
  const items: Prisma.AppointmentItemCreateManyAppointmentInput[] = [];
  const forceUnassigned = options?.forceUnassigned ?? false;
  for (const service of services) {
    for (const assignment of serviceAssignments) {
      if (assignment.serviceId !== service.serviceId) continue;
      const steps = assignment.steps ?? [];
      if (!steps.length) continue;
      const start = steps.reduce((min, step) => (step.start < min ? step.start : min), steps[0].start);
      const end = steps.reduce((max, step) => (step.end > max ? step.end : max), steps[0].end);
      items.push({
        staffId: forceUnassigned ? null : steps[0].staffId ?? staffIdFallback ?? null,
        serviceId: assignment.serviceId,
        startsAt: start,
        endsAt: end,
        price: new Prisma.Decimal(service.price),
        currency: service.currency ?? "EUR",
        status: "SCHEDULED",
        metadata: {
          slotKey: slot.slotKey,
          steps: steps.map((step) => ({
            stepId: step.stepId,
            start: step.start,
            end: step.end,
            requiresStaff: step.requiresStaff,
            resourceIds: step.resourceIds ?? [],
          })),
        },
      });
    }
  }
  return items;
}

async function sendNotifications({
  appointment,
  customer,
  serviceNames,
  staff,
  location,
  notificationPrefs,
  policies,
  deposit,
  manageUrl,
  smsUrl,
  whatsappOptIn,
}: {
  appointment: { id: string; confirmationCode: string; startsAt: Date; endsAt: Date; timezone?: string | null };
  customer: CheckoutPayload["customer"];
  serviceNames: string[];
  staff: { id: string; displayName: string | null; firstName: string | null; lastName: string | null; email: string | null };
  location: {
    name: string | null;
    addressLine1: string | null;
    city: string | null;
    tenantId: string;
    timezone: string | null;
    tenantName?: string | null;
  };
  notificationPrefs: NotificationPreferences;
  policies: Awaited<ReturnType<typeof loadPoliciesForLocation>>;
  deposit: { amount: number; currency: string } | null;
  manageUrl: string;
  smsUrl: string;
  whatsappOptIn: boolean;
}): Promise<NotificationChannels> {
  const staffName = staff.displayName?.trim() || `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() || "Mitarbeiter";
  const staffFirstName =
    staff.firstName?.trim() || staff.displayName?.trim().split(/\s+/)[0] || staff.lastName?.trim() || "Team";
  const customerFirstName = customer.firstName?.trim() || "Kunde";
  const customerLastName = customer.lastName?.trim() || "";
  const customerFullName = [customerFirstName, customerLastName].filter(Boolean).join(" ");
  const customerName = `${customer.firstName} ${customer.lastName}`.trim();
  const timezone = location.timezone ?? "Europe/Berlin";
  const dateLabel = appointment.startsAt.toLocaleDateString("de-DE", { timeZone: timezone });
  const timeLabel = appointment.startsAt.toLocaleTimeString("de-DE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  const serviceLabel = serviceNames.filter(Boolean).join(", ") || "Termin";
  const locationLabel =
    [location.name, location.addressLine1, location.city].filter(Boolean).join(", ") || location.name || "Standort";
  const tenantName = location.tenantName ?? location.name ?? "Dein Team";
  const emailSenderName = notificationPrefs.emailSenderName ?? tenantName;
  const replyTo = notificationPrefs.emailReplyTo ?? undefined;
  const smsBrandName = notificationPrefs.smsBrandName ?? location.name ?? "Salon";
  const smsSenderName = notificationPrefs.smsSenderName ?? undefined;
  let smsSent = false;
  let whatsappSent = false;

  try {
    if (customer.email) {
      const locationIcsLabel =
        [location.name, location.addressLine1, location.city].filter(Boolean).join(" · ") || undefined;
      const ics = createIcsEvent({
        summary: `Termin im ${location.name ?? "Salon"}`,
        description: "Wir freuen uns auf dich!",
        location: locationIcsLabel,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        organizer: {
          name: location.name ?? "Timevex Calendar",
          email: "noreply@example.com",
        },
        attendees: [
          {
            name: customerName || "Kunde",
            email: customer.email,
          },
        ],
        remindersMinutesBefore: [60],
      });
      const template = renderBookingConfirmation({
        customerName: customerName || "Kunde",
        locationName: location.name ?? "Dein Salon",
        start: appointment.startsAt,
        end: appointment.endsAt,
        timeZone: location.timezone ?? "Europe/Berlin",
        services: serviceNames.map((name) => ({ name })),
        confirmationCode: appointment.confirmationCode,
        manageUrl,
      });
      const mailer = await createMailer();
      await mailer.sendBookingConfirmation({
        to: {
          name: customerName || "Kunde",
          email: customer.email,
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
      });
    }
  } catch (error) {
    console.warn("[checkout] email send failed", error);
  }

  const shouldSendSms = !whatsappOptIn && isSmsConfigured();
  if (shouldSendSms) {
    if (customer.phone) {
      const smsStart = appointment.startsAt.toLocaleString("de-DE", {
        timeZone: location.timezone ?? "Europe/Berlin",
      });
      const manageHint = smsUrl ? ` Storno: ${smsUrl}` : manageUrl ? ` Storno: ${manageUrl}` : "";
      try {
        await sendSms({
          to: customer.phone,
          body: `Termin bestätigt: ${smsStart} bei ${smsBrandName}. Code: ${appointment.confirmationCode}.${manageHint}`,
          tenantId: location.tenantId,
          sender: smsSenderName,
        });
        smsSent = true;
      } catch (error) {
        console.warn("[checkout] sms failed", error);
      }
    }
  }

  const shouldSendWhatsapp = whatsappOptIn && isWhatsappConfigured();
  if (shouldSendWhatsapp) {
    if (customer.phone) {
      const manageLink = smsUrl || manageUrl || "";
      const basePlaceholders = [
        customerFirstName,
        customerLastName,
        staffFirstName,
        dateLabel,
        timeLabel,
        serviceLabel,
        locationLabel,
        tenantName,
      ];
      try {
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
            `Datum: ${dateLabel}\nUhrzeit: ${timeLabel}\nLeistung: ${serviceLabel}\nWo: ${locationLabel}\n\n` +
            `LG Dein Team von ${tenantName}. Wir freuen uns auf Deinen Besuch.`,
        });
        whatsappSent = true;
      } catch (error) {
        console.warn("[checkout] whatsapp failed", error);
      }
    } else {
      console.warn("[checkout] whatsapp skipped: missing phone");
    }
  } else if (whatsappOptIn) {
    console.warn("[checkout] whatsapp skipped: not configured");
  }

  return { sms: smsSent, whatsapp: whatsappSent };
}

async function sendRequestEmail({
  appointment,
  customer,
  services,
  location,
  notificationPrefs,
  manageUrl,
}: {
  appointment: { id: string; confirmationCode: string; startsAt: Date; endsAt: Date; timezone?: string | null };
  customer: CheckoutPayload["customer"];
  services: Array<{ name: string; price?: number; currency?: string }>;
  location: {
    name: string | null;
    addressLine1: string | null;
    city: string | null;
    tenantId: string;
    timezone: string | null;
    tenantName?: string | null;
  };
  notificationPrefs: NotificationPreferences;
  manageUrl: string;
}) {
  if (!customer.email) return;

  const customerName = `${customer.firstName} ${customer.lastName}`.trim() || "Kunde";
  const tenantName = location.tenantName ?? location.name ?? "Dein Team";
  const emailSenderName = notificationPrefs.emailSenderName ?? tenantName;
  const replyTo = notificationPrefs.emailReplyTo ?? undefined;
  const template = renderBookingRequest({
    customerName,
    locationName: location.name ?? "Dein Salon",
    start: appointment.startsAt,
    end: appointment.endsAt,
    timeZone: location.timezone ?? "Europe/Berlin",
    services,
    confirmationCode: appointment.confirmationCode,
    manageUrl,
  });
  const mailer = await createMailer();
  await mailer.sendBookingConfirmation({
    to: {
      name: customerName,
      email: customer.email,
    },
    fromName: emailSenderName,
    replyTo,
    subject: template.subject,
    textBody: template.text,
    htmlBody: template.html,
    metadata: {
      appointmentId: appointment.id,
    },
  });
}

function buildCheckoutPolicyResponse(
  policies: Awaited<ReturnType<typeof loadPoliciesForLocation>>,
  cancellationDeadline?: Date | null,
) {
  return {
    depositDue: policies.deposit
      ? { amount: policies.deposit.thresholdAmount ?? 0, currency: policies.deposit.currency ?? "EUR" }
      : null,
    cancellation: policies.cancellation
      ? {
          windowHours: policies.cancellation.windowHours,
          deadline: cancellationDeadline?.toISOString() ?? policies.cancellation.deadline ?? null,
          penalty: policies.cancellation.penalty
            ? { kind: policies.cancellation.penalty.kind, value: policies.cancellation.penalty.value }
            : null,
        }
      : null,
    noShow: policies.noShow ?? null,
  };
}

function buildCheckoutResponsePayload(params: {
  appointment: { id: string; confirmationCode: string; startsAt: Date; endsAt: Date; status: string };
  policies: Awaited<ReturnType<typeof loadPoliciesForLocation>>;
  cancellationDeadline?: Date | null;
  channels: NotificationChannels;
}) {
  return {
    data: {
      appointmentId: params.appointment.id,
      confirmationCode: params.appointment.confirmationCode,
      startsAt: params.appointment.startsAt.toISOString(),
      endsAt: params.appointment.endsAt.toISOString(),
      status: params.appointment.status,
      policy: buildCheckoutPolicyResponse(params.policies, params.cancellationDeadline),
      channels: params.channels,
    },
  };
}

function isUniqueConstraintError(error: unknown, fields?: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002") return false;
  if (!fields || fields.length === 0) return true;
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return fields.every((field) => target.includes(field));
  }
  if (typeof target === "string") {
    return fields.every((field) => target.includes(field));
  }
  return false;
}

function extractBookingChannels(metadata: Prisma.JsonValue | null): NotificationChannels | null {
  const record = readMetadataRecord(metadata);
  const raw = record.bookingChannels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.sms !== "boolean" || typeof candidate.whatsapp !== "boolean") {
    return null;
  }
  return { sms: candidate.sms, whatsapp: candidate.whatsapp };
}

function mergeAppointmentMetadata(metadata: Prisma.JsonValue | null, patch: Record<string, unknown>): Prisma.JsonValue {
  const record = readMetadataRecord(metadata);
  return { ...record, ...patch };
}
