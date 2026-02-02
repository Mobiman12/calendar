import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { differenceInHours, isAfter } from "date-fns";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { findAvailability } from "@/lib/availability";
import { buildAvailabilityRequest } from "@/lib/availability/request-builder";
import { makeAvailabilityCacheKey, readAvailabilityCache, writeAvailabilityCache } from "@/lib/availability/cache";
import { computeSmartSlots, type SmartSlotConfig } from "@/lib/availability/smart-slots";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getLogger } from "@/lib/logger";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { resolvePermittedStaffIdsForDevice } from "@/lib/customer-booking-permissions";
import { getShiftPlanClient, resolveShiftPlanStaffIdWithLookup } from "@/lib/shift-plan-client";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { resolveBookingTenant } from "@/lib/booking-tenant";
import { filterHeldSlots } from "@/lib/booking-holds";
import { buildScheduleIntervals } from "@/lib/availability/intervals";

const prisma = getPrismaClient();
const logger = getLogger();
const AVAILABILITY_CACHE_ENABLED = false;

const MAX_WINDOW_HOURS = 24 * 7; // allow up to one week per Request

const querySchema = z
  .object({
    from: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid from timestamp" })
      .transform((value) => new Date(value)),
    to: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid to timestamp" })
      .transform((value) => new Date(value)),
    services: z.array(z.string().min(1)).nonempty({ message: "At least one service id is required" }),
    staffId: z.string().min(1).optional(),
    granularity: z.number().int().positive().max(60).optional(),
    deviceId: z.string().uuid().optional(),
    colorPrecheck: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!isAfter(data.to, data.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "Parameter 'to' must be later than 'from'",
      });
    }
    const windowHours = differenceInHours(data.to, data.from);
    if (windowHours > MAX_WINDOW_HOURS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: `Requested window is too large (max ${MAX_WINDOW_HOURS / 24} days)`,
      });
    }
    if (data.services.length > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["services"],
        message: "A maximum of 10 services can be requested at once",
      });
    }
  });

function collectServices(searchParams: URLSearchParams): string[] {
  const list: string[] = [];
  if (searchParams.has("service")) {
    list.push(searchParams.get("service") ?? "");
  }
  for (const entry of searchParams.getAll("services")) {
    list.push(entry);
  }
  return list.filter((value) => typeof value === "string" && value.trim().length > 0);
}

function formatSlotsForResponse(slots: Awaited<ReturnType<typeof findAvailability>>): Array<{
  slotKey: string;
  locationId: string;
  staffId: string;
  start: string;
  end: string;
  reservedFrom: string;
  reservedTo: string;
  isSmart?: boolean;
  services: Array<{ serviceId: string; steps: Array<{ stepId: string; start: string; end: string; requiresStaff: boolean; resourceIds: string[] }> }>;
}> {
  return slots.map((slot) => ({
    slotKey: slot.slotKey,
    locationId: slot.locationId,
    staffId: slot.staffId,
    start: (slot.start ?? slot.reservedFrom ?? new Date()).toISOString(),
    end: (slot.end ?? slot.reservedTo ?? slot.start ?? new Date()).toISOString(),
    reservedFrom: (slot.reservedFrom ?? slot.start ?? slot.window?.from ?? new Date()).toISOString(),
    reservedTo: (slot.reservedTo ?? slot.end ?? slot.window?.to ?? slot.start ?? new Date()).toISOString(),
    isSmart: slot.isSmart ? true : undefined,
    services: (slot.services ?? []).map((assignment) => ({
      serviceId: assignment.serviceId,
      steps: (assignment.steps ?? []).map((step) => ({
        stepId: step.stepId,
        start: (step.start ?? slot.start ?? slot.reservedFrom ?? new Date()).toISOString(),
        end: (step.end ?? step.start ?? slot.end ?? slot.reservedTo ?? new Date()).toISOString(),
        requiresStaff: step.requiresStaff,
        resourceIds: step.resourceIds,
      })),
    })),
  }));
}

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

function mergeSlotsByKey<T extends { slotKey: string }>(slots: T[]): T[] {
  const map = new Map<string, T>();
  for (const slot of slots) {
    if (!map.has(slot.slotKey)) {
      map.set(slot.slotKey, slot);
    }
  }
  return Array.from(map.values());
}

function resolveSmartSlotConfig(
  prefs: ReturnType<typeof deriveBookingPreferences>,
  stepUiMin: number,
  timeZone: string,
): SmartSlotConfig | null {
  if (!prefs.smartSlotsEnabled) return null;
  const safeStepUi = Math.max(1, stepUiMin);
  const stepEngineMin = clampEngineStep(prefs.stepEngineMin, safeStepUi);
  const maxOffGridOffsetMin = Math.min(prefs.maxOffGridOffsetMin, Math.floor(safeStepUi / 2));

  return {
    stepUiMin: safeStepUi,
    stepEngineMin,
    bufferMin: prefs.bufferMin,
    minGapMin: prefs.minGapMin,
    maxSmartSlotsPerHour: prefs.maxSmartSlotsPerHour,
    minWasteReductionMin: prefs.minWasteReductionMin,
    maxOffGridOffsetMin,
    timeZone,
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

function normalizeWindowToTimezone(date: Date, timezone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateKey = formatter.format(date);
  return new Date(`${dateKey}T00:00:00.000Z`);
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

export async function GET(request: NextRequest, context: { params: Promise<{ tenant: string; location: string }> }) {
  const startedAt = Date.now();
  let statusCode = 200;
  let cacheStatus: "hit" | "miss" | "none" = "none";
  let mode: "shiftplan" | "opening-hours" | "unknown" = "unknown";
  let slotCount = 0;
  let staffCount = 0;
  let serviceCount = 0;
  let dbMs: number | null = null;
  let shiftPlanMs: number | null = null;
  let availabilityMs: number | null = null;
  let filterMs: number | null = null;
  let warningCount = 0;

  const respond = (response: NextResponse) => {
    response.headers.set("Cache-Control", "no-store");
    logger.info(
      {
        status: statusCode,
        cache: cacheStatus,
        mode,
        slotCount,
        staffCount,
        serviceCount,
        dbMs,
        shiftPlanMs,
        availabilityMs,
        filterMs,
        warningCount,
        totalMs: Date.now() - startedAt,
      },
      "[availability] timing",
    );
    return response;
  };

  const { tenant, location } = await context.params;
  const searchParams = request.nextUrl.searchParams;
  const resolution = await resolveBookingTenant(tenant);
  if (!resolution) {
    statusCode = 404;
    return respond(NextResponse.json({ error: "Tenant not found" }, { status: 404 }));
  }
  const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
  const rateKey = ipAddress ?? request.headers.get("user-agent") ?? "anonymous";
  const rateLimit = await enforceRateLimit(`availability:${rateKey}`, 60, 60);
  if (!rateLimit.allowed) {
    logger.warn({ rateKey }, "availability rate limit exceeded");
    statusCode = 429;
    return respond(NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 }));
  }

  const servicesParam = collectServices(searchParams);
  const parsed = querySchema.safeParse({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    services: servicesParam,
    staffId: searchParams.get("staffId") ?? undefined,
    granularity: searchParams.get("granularity") ? Number(searchParams.get("granularity")) : undefined,
    deviceId: searchParams.get("deviceId") ?? undefined,
    colorPrecheck: searchParams.get("colorPrecheck") ?? undefined,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => issue.message);
    statusCode = 400;
    return respond(NextResponse.json({ error: "Invalid query parameters", details: issues }, { status: 400 }));
  }

  const { from, to, services, staffId, granularity, deviceId, colorPrecheck } = parsed.data;
  const uniqueServices = Array.from(new Set(services));

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: resolution.tenantId, slug: location },
    select: { id: true, slug: true, metadata: true, timezone: true },
  });

  if (!locationRecord) {
    statusCode = 404;
    return respond(NextResponse.json({ error: "Location not found" }, { status: 404 }));
  }

  const locationMetadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const locationTimezone = locationRecord.timezone ?? "Europe/Berlin";
  const windowFrom = normalizeWindowToTimezone(from, locationTimezone);
  const windowTo = normalizeWindowToTimezone(to, locationTimezone);
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  if (!bookingPreferences.onlineBookingEnabled) {
    statusCode = 403;
    return respond(NextResponse.json({ error: "Online-Buchung ist deaktiviert." }, { status: 403 }));
  }
  const maxServicesPerBooking = Math.max(1, Math.min(bookingPreferences.servicesPerBooking ?? 1, 10));
  if (uniqueServices.length > maxServicesPerBooking) {
    statusCode = 400;
    return respond(
      NextResponse.json(
        { error: `Maximal ${maxServicesPerBooking} Leistungen pro Termin.` },
        { status: 400 },
      ),
    );
  }
  const useShiftPlan = bookingPreferences.shiftPlan;
  mode = useShiftPlan ? "shiftplan" : "opening-hours";
  const intervalFromPrefs = Number.parseInt(bookingPreferences.interval ?? "", 10);
  const slotGranularity =
    Number.isFinite(granularity) && granularity > 0
      ? granularity
      : Number.isFinite(intervalFromPrefs) && intervalFromPrefs > 0
        ? intervalFromPrefs
        : 15;
  const smartSlotConfig = resolveSmartSlotConfig(bookingPreferences, slotGranularity, locationTimezone);
  const smartSlotsKey = smartSlotConfig
    ? `smart:${smartSlotConfig.stepEngineMin}:${smartSlotConfig.bufferMin}:${smartSlotConfig.minGapMin}:${smartSlotConfig.maxSmartSlotsPerHour}:${smartSlotConfig.minWasteReductionMin}:${smartSlotConfig.maxOffGridOffsetMin}`
    : "smart:off";

  const staffMembershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = staffMembershipSupported
    ? {
        memberships: {
          some: { locationId: locationRecord.id },
        },
      }
    : {
        locationId: locationRecord.id,
      };

  const cacheKey = makeAvailabilityCacheKey({
    locationId: locationRecord.id,
    windowFrom: windowFrom.toISOString(),
    windowTo: windowTo.toISOString(),
    mode: useShiftPlan ? "shiftplan" : "opening-hours",
    serviceIds: uniqueServices,
    staffId,
    slotGranularityMinutes: slotGranularity,
    smartSlotsKey,
    deviceId,
    colorPrecheck,
  });

  const cachedSlots = AVAILABILITY_CACHE_ENABLED ? await readAvailabilityCache(cacheKey) : null;
  if (cachedSlots) {
    cacheStatus = "hit";
    const filterStart = Date.now();
    const filtered = await filterHeldSlots(cachedSlots);
    filterMs = Date.now() - filterStart;
    slotCount = filtered.length;
    return respond(NextResponse.json({ data: formatSlotsForResponse(filtered), cached: true }));
  }

  cacheStatus = "miss";
  const dbStart = Date.now();
  const [
    serviceRecords,
    staffRecords,
    resourceRecords,
    scheduleRecords,
    timeOffRecords,
    exceptionRecords,
    appointmentItems,
  ] = await Promise.all([
    prisma.service.findMany({
      where: {
        id: { in: uniqueServices },
        locationId: locationRecord.id,
        status: "ACTIVE",
      },
      include: {
        steps: {
          orderBy: { order: "asc" },
          include: { resources: { include: { resource: true } } },
        },
      },
    }),
    prisma.staff.findMany({
      where: {
        ...staffScope,
        status: "ACTIVE",
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
    }),
    prisma.resource.findMany({
      where: {
        locationId: locationRecord.id,
        isActive: true,
      },
    }),
    prisma.schedule.findMany({
      where: {
        locationId: locationRecord.id,
      },
      include: {
        rules: true,
      },
    }),
    prisma.timeOff.findMany({
      where: {
        locationId: locationRecord.id,
        startsAt: { lt: windowTo },
        endsAt: { gt: windowFrom },
      },
    }),
    prisma.availabilityException.findMany({
      where: {
        locationId: locationRecord.id,
        startsAt: { lt: windowTo },
        endsAt: { gt: windowFrom },
      },
    }),
    prisma.appointmentItem.findMany({
      where: {
        appointment: {
          locationId: locationRecord.id,
          status: { not: "CANCELLED" },
        },
        startsAt: { lt: windowTo },
        endsAt: { gt: windowFrom },
      },
      select: {
        id: true,
        serviceId: true,
        staffId: true,
        startsAt: true,
        endsAt: true,
        appointment: {
          select: {
            id: true,
            locationId: true,
            status: true,
          },
        },
      },
    }),
  ]);
  dbMs = Date.now() - dbStart;
  staffCount = staffRecords.length;

  const { staffIds: permittedStaffIds } = await resolvePermittedStaffIdsForDevice({
    deviceId,
    locationId: locationRecord.id,
    prisma,
  });
  const permittedStaffSet = new Set(permittedStaffIds);

  const bookableStaff = staffRecords.filter((staff) => {
    const metadata = staff.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return true;
    }
    const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
    const onlineBookable = typeof value === "boolean" ? value : true;
    return onlineBookable || permittedStaffSet.has(staff.id);
  });
  staffCount = bookableStaff.length;

  // Staff-Schichtpläne aus der Stundenliste in Memory-Schedules umwandeln
  if (!bookableStaff.length) {
    statusCode = 400;
    return respond(NextResponse.json({ error: "No staff available for this location" }, { status: 400 }));
  }

  if (staffId && !bookableStaff.some((staff) => staff.id === staffId)) {
    slotCount = 0;
    return respond(NextResponse.json({ data: [], cached: false }));
  }

  const serviceOrderMap = new Map(serviceRecords.map((service) => [service.id, service]));
  const orderedServices = uniqueServices
    .map((serviceId) => serviceOrderMap.get(serviceId))
    .filter((service): service is (typeof serviceRecords)[number] => Boolean(service));

  if (orderedServices.length !== uniqueServices.length) {
    statusCode = 400;
    return respond(NextResponse.json({ error: "Service not found for this location" }, { status: 400 }));
  }
  serviceCount = orderedServices.length;

  // Basis-Schedules (Resource + optional Location). Staff-Schedules werden je nach Modus separat aufgebaut.
  const baseSchedules = scheduleRecords.filter(
    (schedule) => schedule.ownerType !== "STAFF" && (!useShiftPlan || schedule.ownerType !== "LOCATION"),
  );
  const hasActiveLocationRules = baseSchedules.some(
    (schedule) =>
      schedule.ownerType === "LOCATION" &&
      schedule.rules.some((rule) => rule.isActive !== false && rule.endsAt > rule.startsAt),
  );
  if (!hasActiveLocationRules) {
    // Ohne explizite Öffnungszeiten (oder bei aktivem Schichtplan) ⇒ Location als 24/7 offen behandeln.
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
      metadata: { fallback: "always-open", source: useShiftPlan ? "shiftplan" : "opening-hours" } as Prisma.JsonValue,
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

  // Staff-Schedules aus Stundenliste holen (nur wenn Schichtplan aktiv ist)
  const staffSchedules: typeof scheduleRecords = [];
  const failedShiftPlanStaffIds = new Set<string>();
  const blockedStaffIds = new Set<string>();
  const effectiveTimeOffRecords = [...timeOffRecords];
  if (useShiftPlan) {
    const shiftPlanStart = Date.now();
    const monthKeys = collectMonthKeys(windowFrom, windowTo);
    const targetStaff = staffId ? bookableStaff.filter((s) => s.id === staffId) : bookableStaff;
    try {
      const client = getShiftPlanClient(resolution.tenantId);
      const plans = await Promise.all(
        targetStaff.map(async (staff) => {
          const days: Array<{ startsAtMinutes: number; endsAtMinutes: number; effectiveDate: Date }> = [];
          let hadSuccessfulFetch = false;
          let hadFetchError = false;
          const shiftPlanStaffId = await resolveShiftPlanStaffIdWithLookup(client, staff);
          if (!shiftPlanStaffId) {
            console.warn("[availability] shift plan staff mapping failed", {
              staffId: staff.id,
            });
            return { schedule: null, staffId: staff.id, hasPlan: false, hasError: true };
          }
          for (const monthKey of monthKeys) {
            if (hadFetchError) break;
            try {
              const plan = await client.getShiftPlan(shiftPlanStaffId, monthKey);
              hadSuccessfulFetch = true;
              for (const day of plan.days) {
                const startMinutes = parseMinutes(day.start);
                const endMinutes = parseMinutes(day.end);
                if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) continue;
                const effectiveDate = parseIsoDateToLocalMidnight(day.isoDate);
                if (!effectiveDate) continue;
                days.push({ startsAtMinutes: startMinutes, endsAtMinutes: endMinutes, effectiveDate });
              }
            } catch (error) {
              hadFetchError = true;
              console.warn("[availability] shift plan fetch failed", {
                staffId: staff.id,
                shiftPlanStaffId,
                monthKey,
                error,
              });
            }
          }
          if (hadFetchError) {
            return { schedule: null, staffId: staff.id, hasPlan: false, hasError: true };
          }
          if (!days.length) {
            return { schedule: null, staffId: staff.id, hasPlan: hadSuccessfulFetch, hasError: false };
          }
          const scheduleId = `stundenliste-${staff.id}`;
          return {
            schedule: {
              id: scheduleId,
              locationId: locationRecord.id,
              ownerType: "STAFF" as const,
              staffId: staff.id,
              resourceId: null,
              name: "Schichtplan",
              timezone: locationRecord.timezone ?? "Europe/Berlin",
              isDefault: false,
              metadata: { source: "stundenliste" } as Prisma.JsonValue,
              rules: days.map((day, index) => ({
                id: `${scheduleId}-${index}`,
                scheduleId,
                ruleType: "DATE" as const,
                weekday: null,
                startsAt: day.startsAtMinutes,
                endsAt: day.endsAtMinutes,
                serviceId: null,
                staffId: staff.id,
                priority: 0,
                effectiveFrom: day.effectiveDate,
                effectiveTo: toUtcEndOfDay(day.effectiveDate),
                isActive: true,
                metadata: null,
              })),
              timeOffs: [],
              availabilityExceptions: [],
              appointments: [],
            },
            staffId: staff.id,
            hasPlan: true,
            hasError: false,
          };
        }),
      );
      for (const plan of plans) {
        if (plan?.schedule) {
          staffSchedules.push(plan.schedule);
          continue;
        }
        if (plan?.hasError) {
          failedShiftPlanStaffIds.add(plan.staffId);
          continue;
        }
        if (plan?.hasPlan) {
          blockedStaffIds.add(plan.staffId);
        }
      }
    } catch (error) {
      console.warn("[availability] shift plan fetch failed", error);
      for (const staff of targetStaff) {
        failedShiftPlanStaffIds.add(staff.id);
      }
    }

    if (blockedStaffIds.size) {
      for (const id of blockedStaffIds) {
        effectiveTimeOffRecords.push({
            id: `shiftplan-empty:${locationRecord.id}:${id}:${windowFrom.toISOString()}:${windowTo.toISOString()}`,
            locationId: locationRecord.id,
            scheduleId: null,
            staffId: id,
            reason: "SCHICHTPLAN_LEER",
            startsAt: windowFrom,
            endsAt: windowTo,
            createdById: null,
            metadata: { source: "stundenliste", fallback: "blocked-no-shifts" } as Prisma.JsonValue,
            createdAt: new Date(),
        } as any);
      }
    }

    if (failedShiftPlanStaffIds.size) {
      for (const id of failedShiftPlanStaffIds) {
        effectiveTimeOffRecords.push({
          id: `shiftplan-error:${locationRecord.id}:${id}:${windowFrom.toISOString()}:${windowTo.toISOString()}`,
          locationId: locationRecord.id,
          scheduleId: null,
          staffId: id,
          reason: "SCHICHTPLAN_FEHLER",
          startsAt: windowFrom,
          endsAt: windowTo,
          createdById: null,
          metadata: { source: "stundenliste", fallback: "blocked-shiftplan-error" } as Prisma.JsonValue,
          createdAt: new Date(),
        } as any);
      }
    }
    shiftPlanMs = Date.now() - shiftPlanStart;
  }

  const effectiveSchedules = useShiftPlan ? [...baseSchedules, ...staffSchedules] : baseSchedules;

  if (!effectiveSchedules.length) {
    if (AVAILABILITY_CACHE_ENABLED) {
      await writeAvailabilityCache(cacheKey, []);
    }
    slotCount = 0;
    return respond(NextResponse.json({ data: [], cached: false }));
  }

  const availabilityRequest = buildAvailabilityRequest({
    locationId: locationRecord.id,
    services: orderedServices,
    staff: bookableStaff,
    resources: resourceRecords,
    schedules: effectiveSchedules,
    timeOffs: effectiveTimeOffRecords,
    availabilityExceptions: exceptionRecords,
    appointmentItems,
    window: { from: windowFrom, to: windowTo },
    staffId: staffId ?? undefined,
    slotGranularityMinutes: slotGranularity,
  });

  if (useShiftPlan) {
    const staffWithoutIntervals = new Set<string>();
    for (const staffMember of availabilityRequest.staff) {
      const intervals = buildScheduleIntervals(
        availabilityRequest.schedules,
        "STAFF",
        staffMember.id,
        availabilityRequest.window,
      );
      if (!intervals.length) {
        staffWithoutIntervals.add(staffMember.id);
      }
    }
    if (staffWithoutIntervals.size) {
      for (const id of staffWithoutIntervals) {
        availabilityRequest.timeOffs.push({
          id: `shiftplan-window-empty:${locationRecord.id}:${id}:${windowFrom.toISOString()}:${windowTo.toISOString()}`,
          locationId: locationRecord.id,
          scheduleId: null,
          staffId: id,
          reason: "SCHICHTPLAN_LEER",
          startsAt: windowFrom,
          endsAt: windowTo,
          metadata: { source: "stundenliste", fallback: "blocked-no-shifts-window" },
        });
      }
    }
  }

  const availabilityStart = Date.now();
  const uiSlots = await findAvailability(availabilityRequest);
  const engineSlots =
    smartSlotConfig && smartSlotConfig.stepEngineMin < slotGranularity
      ? await findAvailability({
          ...availabilityRequest,
          slotGranularityMinutes: smartSlotConfig.stepEngineMin,
        })
      : [];
  availabilityMs = Date.now() - availabilityStart;
  const now = new Date();
  const upcomingUiSlots = uiSlots.filter((slot) => {
    const startRef = slot.start ?? slot.reservedFrom ?? slot.window?.from ?? now;
    return startRef.getTime() > now.getTime();
  });
  const upcomingEngineSlots = engineSlots.filter((slot) => {
    const startRef = slot.start ?? slot.reservedFrom ?? slot.window?.from ?? now;
    return startRef.getTime() > now.getTime();
  });
  const smartSlots = smartSlotConfig
    ? computeSmartSlots({
        availabilityRequest,
        uiSlots: upcomingUiSlots,
        engineSlots: upcomingEngineSlots,
        config: smartSlotConfig,
      })
    : [];
  const combinedSlots = smartSlots.length
    ? mergeSlotsByKey([...upcomingUiSlots, ...smartSlots])
    : upcomingUiSlots;
  const filterStart = Date.now();
  const filteredSlots = await filterHeldSlots(combinedSlots);
  filterMs = Date.now() - filterStart;
  slotCount = filteredSlots.length;
  if (failedShiftPlanStaffIds.size === 0 && AVAILABILITY_CACHE_ENABLED) {
    await writeAvailabilityCache(cacheKey, combinedSlots);
  }

  const warnings =
    failedShiftPlanStaffIds.size > 0
      ? ["Schichtplan konnte nicht geladen werden. Bitte Support kontaktieren."]
      : undefined;
  warningCount = warnings?.length ?? 0;

  return respond(NextResponse.json({ data: formatSlotsForResponse(filteredSlots), cached: false, warnings }));
}
