import { NextResponse } from "next/server";
import { addDays, addMonths, format, parseISO, startOfDay, startOfMonth } from "date-fns";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getShiftPlanClient, resolveShiftPlanStaffIdWithLookup } from "@/lib/shift-plan-client";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

type AvailabilityBucket = Record<string, Array<{ start: number; end: number }>>;
type AvailabilityStatusBucket = Record<string, string>;
type AvailabilityStatusByStaff = Record<string, AvailabilityStatusBucket>;
type AvailabilityPayload = { data: Record<string, AvailabilityBucket>; status: AvailabilityStatusByStaff };

const ABSENCE_KEYWORDS = ["urlaub", "urlaubstag", "holiday", "feiertag", "krank", "sick", "frei", "abwesend", "leave", "abwesenheit"];
const MAX_CONCURRENT_STAFF_REQUESTS = 5;
const AVAILABILITY_CACHE_MS = Number.parseInt(process.env.AVAILABILITY_CACHE_MS ?? "0", 10);
const SHIFT_PLAN_CACHE_MS = Number.parseInt(process.env.SHIFT_PLAN_CACHE_MS ?? "0", 10);
const AVAILABILITY_CACHE_ENABLED = Number.isFinite(AVAILABILITY_CACHE_MS) && AVAILABILITY_CACHE_MS > 0;
const SHIFT_PLAN_CACHE_ENABLED = Number.isFinite(SHIFT_PLAN_CACHE_MS) && SHIFT_PLAN_CACHE_MS > 0;
const WEEKDAY_KEYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;

type AvailabilityCacheEntry = {
  timestamp: number;
  data: Record<string, AvailabilityBucket>;
  status: AvailabilityStatusByStaff;
};

type ShiftPlanCacheEntry = {
  timestamp: number;
  plan: Awaited<ReturnType<ReturnType<typeof getShiftPlanClient>["getShiftPlan"]>>;
};

type GlobalAvailabilityStore = {
  availabilityCache?: Map<string, AvailabilityCacheEntry>;
  availabilityPromises?: Map<string, Promise<AvailabilityPayload>>;
  shiftPlanCache?: Map<string, ShiftPlanCacheEntry>;
  shiftPlanPromises?: Map<string, Promise<Awaited<ReturnType<ReturnType<typeof getShiftPlanClient>["getShiftPlan"]>>>>;
};

function getGlobalAvailabilityStore(): GlobalAvailabilityStore {
  const globalObject = globalThis as typeof globalThis & { __availabilityCacheStore__?: GlobalAvailabilityStore };
  if (!globalObject.__availabilityCacheStore__) {
    globalObject.__availabilityCacheStore__ = {};
  }
  const store = globalObject.__availabilityCacheStore__;
  if (!store.availabilityCache) {
    store.availabilityCache = new Map();
  }
  if (!store.availabilityPromises) {
    store.availabilityPromises = new Map();
  }
  if (!store.shiftPlanCache) {
    store.shiftPlanCache = new Map();
  }
  if (!store.shiftPlanPromises) {
    store.shiftPlanPromises = new Map();
  }
  return store;
}

const globalStore = getGlobalAvailabilityStore();
const availabilityCache = globalStore.availabilityCache!;
const availabilityPromises = globalStore.availabilityPromises!;
const shiftPlanCache = globalStore.shiftPlanCache!;
const shiftPlanPromises = globalStore.shiftPlanPromises!;

function parseMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value || value === Prisma.DbNull || value === Prisma.JsonNull) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}


function buildOpeningHoursBucket(
  rules: Array<{ weekday: string | null; startsAt: number; endsAt: number; isActive: boolean }>,
  rangeStart: Date,
  rangeEnd: Date,
): AvailabilityBucket {
  const activeRules = rules.filter((rule) => rule.isActive !== false && rule.weekday && rule.endsAt > rule.startsAt);
  const hasAnyOpeningHours = activeRules.length > 0;
  if (!hasAnyOpeningHours) {
    return {};
  }

  const rulesByWeekday = new Map<string, Array<{ start: number; end: number }>>();
  for (const rule of activeRules) {
    const weekdayKey = rule.weekday as string;
    const list = rulesByWeekday.get(weekdayKey) ?? [];
    list.push({ start: rule.startsAt, end: rule.endsAt });
    rulesByWeekday.set(weekdayKey, list);
  }

  const bucket: AvailabilityBucket = {};
  let cursor = startOfDay(rangeStart);
  const endDate = startOfDay(rangeEnd);
  while (cursor <= endDate) {
    const dayKey = format(cursor, "yyyy-MM-dd");
    const weekday = WEEKDAY_KEYS[cursor.getDay()];
    const ranges = rulesByWeekday.get(weekday) ?? [];
    if (ranges.length) {
      bucket[dayKey] = ranges;
    }
    cursor = addDays(cursor, 1);
  }
  return bucket;
}

function parseMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function collectMonthKeys(start: Date, end: Date): string[] {
  const keys: string[] = [];
  let cursor = startOfMonth(start);
  const limit = startOfMonth(end);
  while (cursor <= limit) {
    keys.push(format(cursor, "yyyy-MM"));
    cursor = addMonths(cursor, 1);
  }
  return keys;
}

async function getShiftPlanWithCache(
  client: ReturnType<typeof getShiftPlanClient>,
  staffId: string,
  monthKey: string,
) {
  if (!SHIFT_PLAN_CACHE_ENABLED) {
    return client.getShiftPlan(staffId, monthKey);
  }
  const cacheKey = `${staffId}:${monthKey}`;
  const now = Date.now();
  const cached = shiftPlanCache.get(cacheKey);
  if (cached && now - cached.timestamp < SHIFT_PLAN_CACHE_MS) {
    return cached.plan;
  }
  let promise = shiftPlanPromises.get(cacheKey);
  if (!promise) {
    promise = client.getShiftPlan(staffId, monthKey);
    shiftPlanPromises.set(cacheKey, promise);
  }
  try {
    const plan = await promise;
    shiftPlanCache.set(cacheKey, { timestamp: Date.now(), plan });
    return plan;
  } finally {
    shiftPlanPromises.delete(cacheKey);
  }
}

async function fetchAvailabilityForStaff(
  staff: {
    id: string;
    code?: string | null;
    metadata?: unknown;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
  },
  monthKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
  client: ReturnType<typeof getShiftPlanClient>,
): Promise<{ staffId: string; bucket: AvailabilityBucket; status: AvailabilityStatusBucket } | null> {

  const bucket: AvailabilityBucket = {};
  const status: AvailabilityStatusBucket = {};
  const shiftPlanStaffId = await resolveShiftPlanStaffIdWithLookup(client, staff);
  if (!shiftPlanStaffId) {
    console.error("[staff-availability] shift plan staff mapping failed", {
      staffId: staff.id,
    });
    return null;
  }

  const plans = await Promise.allSettled(
    monthKeys.map((monthKey) =>
      getShiftPlanWithCache(client, shiftPlanStaffId, monthKey).catch((error) => {
        console.error(
          `[staff-availability] Plan konnte nicht geladen werden (${staff.id} -> ${shiftPlanStaffId}, Monat ${monthKey}).`,
          error,
        );
        throw error;
      }),
    ),
  );

  for (const planResult of plans) {
    if (planResult.status !== "fulfilled") {
      continue;
    }
    const plan = planResult.value;
    for (const day of plan.days) {
      const dayDate = startOfDay(parseISO(day.isoDate));
      if (dayDate < rangeStart || dayDate > rangeEnd) {
        continue;
      }
      const labelRaw =
        typeof (day as { label?: unknown }).label === "string" ? (day as { label?: string }).label ?? "" : "";
      const labelValue = labelRaw.trim();
      const labelNormalized = labelValue.toLowerCase();
      const isNeutralLabel =
        labelNormalized === "verfügbar" || labelNormalized === "verfuegbar" || labelNormalized === "available";
      if (labelValue.length && !isNeutralLabel) {
        status[day.isoDate] = labelValue;
      }
      const isAbsence = labelNormalized.length
        ? ABSENCE_KEYWORDS.some((keyword) => labelNormalized.includes(keyword))
        : false;
      const isHolidayLabel = labelNormalized.includes("feiertag") || labelNormalized.includes("holiday");
      const isHolidayAvailable =
        isHolidayLabel &&
        (labelNormalized.includes("verfügbar") || labelNormalized.includes("verfuegbar") || labelNormalized.includes("available"));
      const startMinutes = parseMinutes(day.start);
      const endMinutes = parseMinutes(day.end);
      if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
        continue;
      }
      if (isAbsence && !isHolidayAvailable) {
        continue;
      }
      if (!bucket[day.isoDate]) {
        bucket[day.isoDate] = [];
      }
      bucket[day.isoDate].push({ start: startMinutes, end: endMinutes });
    }
  }

  if (!Object.keys(bucket).length && !Object.keys(status).length) {
    return null;
  }

  return { staffId: staff.id, bucket, status };
}

async function computeAvailability(
  staffMembers: Array<{
    id: string;
    code?: string | null;
    metadata?: unknown;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
  }>,
  monthKeys: string[],
  rangeStart: Date,
  rangeEnd: Date,
  client: ReturnType<typeof getShiftPlanClient>,
): Promise<AvailabilityPayload> {
  if (!staffMembers.length || !monthKeys.length) {
    return { data: {}, status: {} };
  }
  const availability: Record<string, AvailabilityBucket> = {};
  const status: AvailabilityStatusByStaff = {};

  for (let index = 0; index < staffMembers.length; index += MAX_CONCURRENT_STAFF_REQUESTS) {
    const chunk = staffMembers.slice(index, index + MAX_CONCURRENT_STAFF_REQUESTS);
    const chunkResults = await Promise.allSettled(
      chunk.map((staff) =>
        fetchAvailabilityForStaff(staff, monthKeys, rangeStart, rangeEnd, client).catch((error) => {
          console.error("[staff-availability] Mitarbeiter konnte nicht synchronisiert werden.", { staffId: staff.id, error });
          return null;
        }),
      ),
    );

    for (const result of chunkResults) {
      if (result.status !== "fulfilled") {
        continue;
      }
      const payload = result.value;
      if (payload && payload.bucket) {
        availability[payload.staffId] = payload.bucket;
        if (payload.status && Object.keys(payload.status).length) {
          status[payload.staffId] = payload.status;
        }
      }
    }
  }

  return { data: availability, status };
}

export async function GET(request: Request, context: { params: Promise<{ location: string }> }) {
  const startedAt = Date.now();
  let statusCode = 200;
  let cacheStatus: "disabled" | "hit" | "miss" | "none" = "none";
  let mode: "shiftplan" | "opening-hours" | "unknown" = "unknown";
  let staffCount = 0;
  let monthCount = 0;
  let computeMs: number | null = null;

  try {
    const { location } = await context.params;
    const { searchParams } = new URL(request.url);
    const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");

    if (!startParam || !endParam) {
      statusCode = 400;
      return NextResponse.json({ error: "start und end sind erforderlich." }, { status: 400 });
    }

    const rangeStart = new Date(startParam);
    const rangeEnd = new Date(endParam);

    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
      statusCode = 400;
      return NextResponse.json({ error: "Ungültige Datumsangaben." }, { status: 400 });
    }

    if (rangeEnd < rangeStart) {
      statusCode = 400;
      return NextResponse.json({ error: "Der Endzeitpunkt muss nach dem Start liegen." }, { status: 400 });
    }

    const locationRecord = await prisma.location.findFirst({
      where: { slug: location, tenantId },
      select: { id: true, metadata: true },
    });

    if (!locationRecord) {
      statusCode = 404;
      return NextResponse.json({ error: "Standort wurde nicht gefunden." }, { status: 404 });
    }

    const staffMembershipSupported = await supportsStaffMemberships(prisma);
    const staffScope = staffMembershipSupported
      ? {
          memberships: {
            some: { locationId: locationRecord.id },
          },
        }
      : {
          locationId: locationRecord.id,
        };

    const staffMembers = await prisma.staff.findMany({
      where: {
        ...staffScope,
        status: "ACTIVE",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
        code: true,
        metadata: true,
      },
    });

    staffCount = staffMembers.length;

    if (!staffMembers.length) {
      cacheStatus = "none";
      return NextResponse.json({ data: {}, status: {}, fetchedAt: new Date().toISOString() });
    }

    const bookingPreferences = deriveBookingPreferences(parseMetadataRecord(locationRecord.metadata).bookingPreferences ?? null);
    const useShiftPlan = bookingPreferences.shiftPlan;
    mode = useShiftPlan ? "shiftplan" : "opening-hours";

    const monthKeys = useShiftPlan ? collectMonthKeys(rangeStart, rangeEnd) : [];
    monthCount = monthKeys.length;

    const cacheKey = [
      locationRecord.id,
      rangeStart.toISOString(),
      rangeEnd.toISOString(),
      useShiftPlan ? monthKeys.join("|") : "-",
      useShiftPlan ? "shiftplan" : "opening-hours",
    ].join("::");
    const calculateAvailability = async (): Promise<AvailabilityPayload> => {
      const computeStart = Date.now();
      const locationSchedules = await prisma.schedule.findMany({
        where: { locationId: locationRecord.id, ownerType: "LOCATION" },
        include: { rules: true },
      });
      const openingHoursBucket = buildOpeningHoursBucket(
        locationSchedules.flatMap((schedule) => schedule.rules),
        rangeStart,
        rangeEnd,
      );

      // Schichtplan deaktiviert ⇒ Verfügbarkeit nach Öffnungszeiten (ohne Öffnungszeiten = keine Verfügbarkeit).
      if (!useShiftPlan || !monthKeys.length) {
        const data: Record<string, AvailabilityBucket> = {};
        const status: AvailabilityStatusByStaff = {};
        for (const staff of staffMembers) {
          data[staff.id] = openingHoursBucket;
        }
        computeMs = Date.now() - computeStart;
        return { data, status };
      }

      const client = getShiftPlanClient(tenantId);
      const shiftPlanResult = await computeAvailability(
        staffMembers,
        monthKeys,
        rangeStart,
        rangeEnd,
        client,
      ).catch((error) => {
        console.error("[staff-availability] Berechnung fehlgeschlagen", error);
        return { data: {}, status: {} };
      });

      const merged: Record<string, AvailabilityBucket> = {};
      const status: AvailabilityStatusByStaff = {};
      for (const staff of staffMembers) {
        merged[staff.id] = shiftPlanResult.data[staff.id] ?? {};
        if (shiftPlanResult.status[staff.id]) {
          status[staff.id] = shiftPlanResult.status[staff.id];
        }
      }
      computeMs = Date.now() - computeStart;
      return { data: merged, status };
    };

    if (!AVAILABILITY_CACHE_ENABLED) {
      cacheStatus = "disabled";
      const availability = await calculateAvailability();
      return NextResponse.json({
        data: availability.data,
        status: availability.status,
        fetchedAt: new Date().toISOString(),
        cache: "disabled",
        mode: useShiftPlan ? "shiftplan" : "opening-hours",
      });
    }

    const cached = availabilityCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < AVAILABILITY_CACHE_MS) {
      cacheStatus = "hit";
      return NextResponse.json({
        data: cached.data,
        status: cached.status ?? {},
        fetchedAt: new Date(cached.timestamp).toISOString(),
        cache: "hit",
        mode: useShiftPlan ? "shiftplan" : "opening-hours",
      });
    }

    cacheStatus = "miss";
    let availabilityPromise = availabilityPromises.get(cacheKey);
    if (!availabilityPromise) {
      availabilityPromise = calculateAvailability()
        .finally(() => {
          availabilityPromises.delete(cacheKey);
        });
      availabilityPromises.set(cacheKey, availabilityPromise);
    }

    const availability = await availabilityPromise;
    availabilityCache.set(cacheKey, { timestamp: Date.now(), data: availability.data, status: availability.status });

    return NextResponse.json({
      data: availability.data,
      status: availability.status,
      fetchedAt: new Date().toISOString(),
      cache: "miss",
      mode: useShiftPlan ? "shiftplan" : "opening-hours",
    });
  } finally {
    const totalMs = Date.now() - startedAt;
    console.info("[staff-availability] timing", {
      status: statusCode,
      cache: cacheStatus,
      mode,
      staffCount,
      monthCount,
      computeMs,
      totalMs,
    });
  }
}
