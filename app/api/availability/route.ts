import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { bookingLimitToMinutes, deriveBookingPreferences } from "@/lib/booking-preferences";
const prisma = getPrismaClient();

const querySchema = z.object({
  services: z.array(z.string().min(1)).nonempty(),
  locationId: z.string().min(1),
  from: z.string().min(1),
  days: z.string().optional(),
  staffId: z.string().optional(),
  timeOfDay: z.enum(["am", "pm", "eve"]).optional(),
  deviceId: z.string().uuid().optional(),
  colorPrecheck: z.string().optional(),
});

type SlotPayload = {
  slotKey: string;
  locationId: string;
  staffId: string;
  start: string;
  end: string;
  reservedFrom?: string;
  reservedTo?: string;
  service?: {
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  };
  services?: Array<{
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  }>;
};

type AvailabilitySlot = {
  slotKey: string;
  locationId: string;
  staffId: string;
  start: string;
  end: string;
  reservedFrom?: string;
  reservedTo?: string;
  isSmart?: boolean;
  services?: Array<{
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  }>;
};

type ServiceMetadata = {
  onlineBookable?: boolean;
  assignedStaffIds?: unknown;
};

type AvailabilityResponse = {
  data: Array<{
    id: string;
    start: string;
    end: string;
    staffId?: string;
    staffName?: string;
    locationId?: string;
    isSmart?: boolean;
  }>;
  meta?: {
    earliestStart?: string;
    minAdvanceMinutes?: number;
    maxAdvanceMinutes?: number | null;
  };
};

const AVAILABILITY_CACHE_TTL_MS = 0;
const AVAILABILITY_CACHE_HEADERS = {
  "Cache-Control": "no-store",
};
const availabilityCache = new Map<string, { expiresAt: number; payload: AvailabilityResponse }>();

function makeAvailabilityCacheKey(params: {
  locationId: string;
  serviceIds: string[];
  from: string;
  days: number;
  staffId?: string;
  timeOfDay?: string;
  deviceId?: string;
  colorPrecheck?: string;
}): string {
  return [
    params.locationId,
    params.serviceIds.join(","),
    params.from,
    String(params.days),
    params.staffId ?? "-",
    params.timeOfDay ?? "-",
    params.deviceId ?? "-",
    params.colorPrecheck ?? "-",
  ].join(":");
}

function readAvailabilityCache(key: string): AvailabilityResponse | null {
  if (AVAILABILITY_CACHE_TTL_MS <= 0) return null;
  const entry = availabilityCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    availabilityCache.delete(key);
    return null;
  }
  return entry.payload;
}

function writeAvailabilityCache(key: string, payload: AvailabilityResponse) {
  if (AVAILABILITY_CACHE_TTL_MS <= 0) return;
  availabilityCache.set(key, { expiresAt: Date.now() + AVAILABILITY_CACHE_TTL_MS, payload });
}

function collectServiceIds(searchParams: URLSearchParams): string[] {
  const list: string[] = [];
  const serviceId = searchParams.get("serviceId");
  if (serviceId) {
    list.push(serviceId);
  }
  for (const entry of searchParams.getAll("services")) {
    list.push(entry);
  }
  return list.filter((value) => value.trim().length > 0);
}

export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const servicesParam = collectServiceIds(request.nextUrl.searchParams);
  const parseResult = querySchema.safeParse({ ...params, services: servicesParam });
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: "Invalid query",
        details: parseResult.error.issues.map((issue) => issue.message),
      },
      { status: 400, headers: AVAILABILITY_CACHE_HEADERS },
    );
  }

  const { services, locationId, from, days, staffId, timeOfDay, deviceId, colorPrecheck } = parseResult.data;
  const uniqueServices = Array.from(new Set(services));
  const startDate = parseDateOnly(from);
  if (!startDate) {
    return NextResponse.json({ error: "Invalid from date" }, { status: 400, headers: AVAILABILITY_CACHE_HEADERS });
  }
  const rangeDays = Math.max(1, Math.min(Number.parseInt(days ?? "7", 10) || 7, 31));
  const endDate = addDays(startDate, rangeDays);
  const cacheKey = makeAvailabilityCacheKey({
    locationId,
    serviceIds: uniqueServices,
    from: startDate.toISOString(),
    days: rangeDays,
    staffId,
    timeOfDay,
    deviceId,
    colorPrecheck,
  });

  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: {
      id: true,
      slug: true,
      tenantId: true,
      timezone: true,
      metadata: true,
    },
  });
  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404, headers: AVAILABILITY_CACHE_HEADERS });
  }

  const locationMetadata =
    location.metadata && typeof location.metadata === "object" && !Array.isArray(location.metadata)
      ? (location.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const maxServicesPerBooking = Math.max(1, Math.min(bookingPreferences.servicesPerBooking ?? 1, 10));
  if (uniqueServices.length > maxServicesPerBooking) {
    return NextResponse.json(
      { error: "Zu viele Leistungen ausgewählt." },
      { status: 400, headers: AVAILABILITY_CACHE_HEADERS },
    );
  }
  const minAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.minAdvance);
  const maxAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.maxAdvance);
  const nowMs = Date.now();
  const earliestStartMs = nowMs + minAdvanceMinutes * 60 * 1000;
  const latestStartMs = maxAdvanceMinutes > 0 ? nowMs + maxAdvanceMinutes * 60 * 1000 : null;
  if (latestStartMs !== null && earliestStartMs > latestStartMs) {
    return NextResponse.json({ data: [] }, { headers: AVAILABILITY_CACHE_HEADERS });
  }
  if (latestStartMs !== null && startDate.getTime() > latestStartMs) {
    return NextResponse.json({ data: [] }, { headers: AVAILABILITY_CACHE_HEADERS });
  }

  const cached = readAvailabilityCache(cacheKey);
  if (cached) {
    const upcoming = filterSlotsByWindow(cached.data, earliestStartMs, latestStartMs);
    return NextResponse.json(
      {
        data: upcoming,
        meta: {
          earliestStart: new Date(earliestStartMs).toISOString(),
          minAdvanceMinutes,
          maxAdvanceMinutes: maxAdvanceMinutes > 0 ? maxAdvanceMinutes : null,
        },
      },
      { headers: AVAILABILITY_CACHE_HEADERS },
    );
  }

  const serviceRecords = await prisma.service.findMany({
    where: {
      id: { in: uniqueServices },
      locationId: location.id,
      status: "ACTIVE",
    },
    select: {
      id: true,
      metadata: true,
    },
  });
  if (serviceRecords.length !== uniqueServices.length) {
    return NextResponse.json({ error: "Service not found" }, { status: 404, headers: AVAILABILITY_CACHE_HEADERS });
  }

  const assignedStaffLists = serviceRecords.map((record) => {
    const metadata = record.metadata as ServiceMetadata | null;
    return {
      onlineBookable: resolveOnlineBookable(metadata),
      assignedStaffIds: resolveAssignedStaffIds(metadata),
    };
  });
  if (assignedStaffLists.some((entry) => !entry.onlineBookable || entry.assignedStaffIds.length === 0)) {
    return NextResponse.json({ data: [] }, { headers: AVAILABILITY_CACHE_HEADERS });
  }
  let allowedStaffIds = new Set(assignedStaffLists[0]?.assignedStaffIds ?? []);
  for (const entry of assignedStaffLists.slice(1)) {
    allowedStaffIds = new Set([...allowedStaffIds].filter((id) => entry.assignedStaffIds.includes(id)));
  }
  if (!allowedStaffIds.size) {
    return NextResponse.json({ data: [] }, { headers: AVAILABILITY_CACHE_HEADERS });
  }
  if (staffId && !allowedStaffIds.has(staffId)) {
    return NextResponse.json({ data: [] }, { headers: AVAILABILITY_CACHE_HEADERS });
  }

  const availabilityUrl = new URL(`/book/${location.tenantId}/${location.slug}/availability`, request.url);
  const cappedEndDate =
    latestStartMs !== null ? new Date(Math.min(endDate.getTime(), latestStartMs)) : endDate;
  availabilityUrl.searchParams.set("from", startDate.toISOString());
  availabilityUrl.searchParams.set("to", cappedEndDate.toISOString());
  uniqueServices.forEach((service) => availabilityUrl.searchParams.append("services", service));
  if (staffId) {
    availabilityUrl.searchParams.set("staffId", staffId);
  }
  if (deviceId) {
    availabilityUrl.searchParams.set("deviceId", deviceId);
  }
  if (colorPrecheck) {
    availabilityUrl.searchParams.set("colorPrecheck", colorPrecheck);
  }

  const response = await fetch(availabilityUrl.toString(), { cache: "no-store" });
  if (!response.ok) {
    return NextResponse.json(
      { error: "Availability fetch failed" },
      { status: response.status, headers: AVAILABILITY_CACHE_HEADERS },
    );
  }

  const payload = (await response.json()) as { data?: AvailabilitySlot[] };
  let slots = Array.isArray(payload.data) ? payload.data : [];

  const serviceSet = new Set(uniqueServices);
  let filteredByStaff = slots.filter((slot) => {
    if (!allowedStaffIds.has(slot.staffId)) return false;
    if (!serviceSet.size) return true;
    const availableServiceIds = new Set((slot.services ?? []).map((service) => service.serviceId));
    for (const serviceId of serviceSet) {
      if (!availableServiceIds.has(serviceId)) return false;
    }
    return true;
  });
  if (!staffId && !filteredByStaff.length && allowedStaffIds.size > 0) {
    const uniqueStaffIds = Array.from(allowedStaffIds);
    const fallbackResults = await Promise.allSettled(
      uniqueStaffIds.map(async (assignedStaffId) => {
        const staffUrl = new URL(availabilityUrl);
        staffUrl.searchParams.set("staffId", assignedStaffId);
        const staffResponse = await fetch(staffUrl.toString(), { cache: "no-store" });
        if (!staffResponse.ok) return [];
        const staffPayload = (await staffResponse.json()) as { data?: AvailabilitySlot[] };
        return Array.isArray(staffPayload.data) ? staffPayload.data : [];
      }),
    );
    const merged = new Map<string, AvailabilitySlot>();
    for (const result of fallbackResults) {
      if (result.status !== "fulfilled") continue;
      for (const slot of result.value) {
        if (!merged.has(slot.slotKey)) {
          merged.set(slot.slotKey, slot);
        }
      }
    }
    slots = Array.from(merged.values());
    filteredByStaff = slots.filter((slot) => allowedStaffIds.has(slot.staffId));
  }
  const filtered =
    timeOfDay
      ? filteredByStaff.filter((slot) =>
          isSlotInTimeOfDay(new Date(slot.start), location.timezone ?? "Europe/Berlin", timeOfDay),
        )
      : filteredByStaff;
  const upcoming = filterSlotsByWindow(filtered, earliestStartMs, latestStartMs);

  const mapped = upcoming
    .map((slot) => {
      const assignments = uniqueServices
        .map((serviceId) => slot.services?.find((service) => service.serviceId === serviceId))
        .filter((assignment): assignment is NonNullable<AvailabilitySlot["services"]>[number] => Boolean(assignment));
      if (assignments.length !== uniqueServices.length) return null;
      const payload: SlotPayload = {
        slotKey: slot.slotKey,
        locationId: location.id,
        staffId: slot.staffId,
        start: slot.start,
        end: slot.end,
        reservedFrom: slot.reservedFrom ?? slot.start,
        reservedTo: slot.reservedTo ?? slot.end,
        services: assignments.map((assignment) => ({
          serviceId: assignment.serviceId,
          steps: assignment.steps ?? [],
        })),
      };
      if (assignments.length === 1) {
        payload.service = {
          serviceId: assignments[0].serviceId,
          steps: assignments[0].steps ?? [],
        };
      }
      return {
        id: encodeSlotId(payload),
        start: slot.start,
        end: slot.end,
        staffId: slot.staffId,
        locationId: location.id,
        isSmart: slot.isSmart ? true : undefined,
      };
    })
    .filter(Boolean) as AvailabilityResponse["data"];

  const responsePayload: AvailabilityResponse = {
    data: mapped,
    meta: {
      earliestStart: new Date(earliestStartMs).toISOString(),
      minAdvanceMinutes,
      maxAdvanceMinutes: maxAdvanceMinutes > 0 ? maxAdvanceMinutes : null,
    },
  };
  writeAvailabilityCache(cacheKey, responsePayload);
  return NextResponse.json(responsePayload, { headers: AVAILABILITY_CACHE_HEADERS });
}

function parseDateOnly(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function isSlotInTimeOfDay(date: Date, timeZone: string, timeOfDay: "am" | "pm" | "eve") {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hour12: false,
    timeZone,
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  if (timeOfDay === "am") {
    return hour < 12;
  }
  if (timeOfDay === "pm") {
    return hour >= 12 && hour < 17;
  }
  return hour >= 17;
}

function filterSlotsByWindow<T extends { start: string }>(
  slots: T[],
  earliestStartMs: number,
  latestStartMs: number | null,
): T[] {
  return slots.filter((slot) => {
    const startMs = Date.parse(slot.start);
    if (!Number.isFinite(startMs)) return false;
    if (startMs < earliestStartMs) return false;
    if (latestStartMs !== null && startMs > latestStartMs) return false;
    return true;
  });
}

function resolveOnlineBookable(metadata: ServiceMetadata | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  const value = metadata.onlineBookable;
  return typeof value === "boolean" ? value : true;
}

function resolveAssignedStaffIds(metadata: ServiceMetadata | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = metadata.assignedStaffIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function encodeSlotId(payload: SlotPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
