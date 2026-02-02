import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import {
  acquireSlotHold,
  encodeHoldId,
  storeSlotHoldMetadata,
} from "@/lib/booking-holds";
import { bookingLimitToMinutes, deriveBookingPreferences } from "@/lib/booking-preferences";
import { getRedisClient } from "@/lib/redis";
import { resolvePermittedStaffIdsForDevice } from "@/lib/customer-booking-permissions";

const prisma = getPrismaClient();
const HOLD_TTL_MS = 5 * 60 * 1000;

const holdSchema = z
  .object({
    locationId: z.string().min(1),
    serviceId: z.string().min(1).optional(),
    serviceIds: z.array(z.string().min(1)).optional(),
    start: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid start" }),
    fromDate: z.string().optional(),
    deviceId: z.string().uuid().optional(),
    colorPrecheck: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((payload, ctx) => {
    if (!payload.serviceId && (!payload.serviceIds || payload.serviceIds.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Service is required", path: ["serviceId"] });
    }
  });

type ServiceMetadata = {
  onlineBookable?: boolean;
  assignedStaffIds?: unknown;
};

type AvailabilitySlot = {
  slotKey: string;
  locationId: string;
  staffId: string;
  start: string;
  end: string;
  reservedFrom?: string;
  reservedTo?: string;
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

declare global {
  // eslint-disable-next-line no-var
  var __calendarHoldRotation: Map<string, number> | undefined;
}

function getRotationMap(): Map<string, number> {
  if (!global.__calendarHoldRotation) {
    global.__calendarHoldRotation = new Map();
  }
  return global.__calendarHoldRotation;
}

function formatLocalDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeStartOfDay(date: Date, timeZone: string): Date {
  const dateKey = formatLocalDateKey(date, timeZone);
  return new Date(`${dateKey}T00:00:00.000Z`);
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

async function nextRotationOffset(key: string): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const value = await redis.incr(key);
    if (value === 1) {
      await redis.expire(key, 60 * 60 * 24);
    }
    return Math.max(0, value - 1);
  }

  const map = getRotationMap();
  const current = map.get(key) ?? 0;
  map.set(key, current + 1);
  return current;
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

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null);
  const parsed = holdSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { locationId, serviceId, serviceIds, start, deviceId, colorPrecheck } = parsed.data;
  const requestedServices = (serviceIds && serviceIds.length > 0 ? serviceIds : serviceId ? [serviceId] : []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const uniqueServices = Array.from(new Set(requestedServices));
  if (!uniqueServices.length) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) {
    return NextResponse.json({ error: "Invalid start" }, { status: 400 });
  }

  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { id: true, slug: true, tenantId: true, timezone: true, metadata: true },
  });
  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const locationMetadata =
    location.metadata && typeof location.metadata === "object" && !Array.isArray(location.metadata)
      ? (location.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  if (!bookingPreferences.onlineBookingEnabled) {
    return NextResponse.json({ error: "Online-Buchung ist deaktiviert." }, { status: 403 });
  }
  const maxServicesPerBooking = Math.max(1, Math.min(bookingPreferences.servicesPerBooking ?? 1, 10));
  if (uniqueServices.length > maxServicesPerBooking) {
    return NextResponse.json({ error: "Zu viele Leistungen ausgewählt." }, { status: 400 });
  }

  const minAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.minAdvance);
  const maxAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.maxAdvance);
  const nowMs = Date.now();
  const earliestStartMs = nowMs + minAdvanceMinutes * 60 * 1000;
  const latestStartMs = maxAdvanceMinutes > 0 ? nowMs + maxAdvanceMinutes * 60 * 1000 : null;
  const startMs = startDate.getTime();
  if (startMs < earliestStartMs || (latestStartMs !== null && startMs > latestStartMs)) {
    return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
  }

  const serviceRecords = await prisma.service.findMany({
    where: { id: { in: uniqueServices }, locationId: location.id, status: "ACTIVE" },
    select: { id: true, name: true, metadata: true },
  });
  if (serviceRecords.length !== uniqueServices.length) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  const assignedStaffLists = serviceRecords.map((record) => {
    const metadata = record.metadata as ServiceMetadata | null;
    return {
      onlineBookable: resolveOnlineBookable(metadata),
      assignedStaffIds: resolveAssignedStaffIds(metadata),
    };
  });
  if (assignedStaffLists.some((entry) => !entry.onlineBookable || entry.assignedStaffIds.length === 0)) {
    return NextResponse.json({ error: "No capacity" }, { status: 409 });
  }
  let allowedStaffIds = new Set(assignedStaffLists[0]?.assignedStaffIds ?? []);
  for (const entry of assignedStaffLists.slice(1)) {
    allowedStaffIds = new Set([...allowedStaffIds].filter((id) => entry.assignedStaffIds.includes(id)));
  }
  if (!allowedStaffIds.size) {
    return NextResponse.json({ error: "No capacity" }, { status: 409 });
  }
  const { staffIds: permittedStaffIds } = await resolvePermittedStaffIdsForDevice({
    deviceId,
    locationId: location.id,
    prisma,
  });
  const permittedStaffSet = new Set(permittedStaffIds);

  const timezone = location.timezone ?? "Europe/Berlin";
  const dayStart = normalizeStartOfDay(startDate, timezone);
  const dayEnd = addDays(dayStart, 1);

  const availabilityUrl = new URL(`/book/${location.tenantId}/${location.slug}/availability`, request.url);
  availabilityUrl.searchParams.set("from", dayStart.toISOString());
  availabilityUrl.searchParams.set("to", dayEnd.toISOString());
  uniqueServices.forEach((service) => availabilityUrl.searchParams.append("services", service));
  if (deviceId) {
    availabilityUrl.searchParams.set("deviceId", deviceId);
  }
  if (colorPrecheck && Object.keys(colorPrecheck).length > 0) {
    availabilityUrl.searchParams.set("colorPrecheck", JSON.stringify(colorPrecheck));
  }

  const availabilityResponse = await fetch(availabilityUrl.toString(), { cache: "no-store" });
  if (!availabilityResponse.ok) {
    return NextResponse.json({ error: "Availability fetch failed" }, { status: availabilityResponse.status });
  }
  const availabilityPayload = (await availabilityResponse.json()) as { data?: AvailabilitySlot[] };
  const availabilitySlots = Array.isArray(availabilityPayload.data) ? availabilityPayload.data : [];

  const serviceSet = new Set(uniqueServices);
  const candidates = availabilitySlots.filter((slot) => {
    if (!allowedStaffIds.has(slot.staffId)) return false;
    const slotStart = Date.parse(slot.start);
    if (!Number.isFinite(slotStart) || slotStart !== startMs) return false;
    const availableServices = new Set((slot.services ?? []).map((serviceEntry) => serviceEntry.serviceId));
    for (const serviceId of serviceSet) {
      if (!availableServices.has(serviceId)) return false;
    }
    return true;
  });

  if (!candidates.length) {
    return NextResponse.json({ error: "No capacity" }, { status: 409 });
  }

  const candidateStaffIds = Array.from(new Set(candidates.map((slot) => slot.staffId)));
  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffRecords = await prisma.staff.findMany({
    where: membershipSupported
      ? {
          id: { in: candidateStaffIds },
          status: "ACTIVE",
          memberships: { some: { locationId: location.id } },
        }
      : {
          id: { in: candidateStaffIds },
          status: "ACTIVE",
          locationId: location.id,
        },
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      metadata: true,
    },
  });

  const eligibleStaff = staffRecords.filter((member) => {
    const metadata = member.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      return true;
    }
    const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
    const onlineBookable = typeof value === "boolean" ? value : true;
    return onlineBookable || permittedStaffSet.has(member.id);
  });
  const staffById = new Map(
    eligibleStaff.map((member) => [
      member.id,
      member.displayName?.trim() || `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || "Team",
    ]),
  );
  const onlineStaffIds = new Set(staffById.keys());
  const eligibleCandidates = candidates.filter((slot) => onlineStaffIds.has(slot.staffId));
  if (!eligibleCandidates.length) {
    return NextResponse.json({ error: "No capacity" }, { status: 409 });
  }

  const eligibleStaffIds = Array.from(new Set(eligibleCandidates.map((slot) => slot.staffId)));

  const bookingCounts = await prisma.appointmentItem.groupBy({
    by: ["staffId"],
    where: {
      staffId: { in: eligibleStaffIds },
      startsAt: { gte: dayStart, lt: dayEnd },
      appointment: { locationId: location.id, status: { not: "CANCELLED" } },
    },
    _count: { staffId: true },
  });
  const loadByStaff = new Map<string, number>();
  for (const staffId of eligibleStaffIds) {
    loadByStaff.set(staffId, 0);
  }
  bookingCounts.forEach((entry) => {
    if (entry.staffId) {
      loadByStaff.set(entry.staffId, entry._count.staffId ?? 0);
    }
  });

  const rotationKey = `booking-pool-rotation:${location.id}:${uniqueServices.join(",")}:${formatLocalDateKey(
    startDate,
    timezone,
  )}`;
  const rotationOffset = await nextRotationOffset(rotationKey);

  const staffBuckets = new Map<number, string[]>();
  eligibleStaffIds.forEach((staffId) => {
    const load = loadByStaff.get(staffId) ?? 0;
    const bucket = staffBuckets.get(load) ?? [];
    bucket.push(staffId);
    staffBuckets.set(load, bucket);
  });

  const orderedStaffIds: string[] = [];
  Array.from(staffBuckets.keys())
    .sort((a, b) => a - b)
    .forEach((load) => {
      const bucket = staffBuckets.get(load) ?? [];
      bucket.sort();
      if (bucket.length > 1) {
        const offset = rotationOffset % bucket.length;
        const rotated = bucket.slice(offset).concat(bucket.slice(0, offset));
        orderedStaffIds.push(...rotated);
      } else {
        orderedStaffIds.push(...bucket);
      }
    });

  const slotByStaff = new Map<string, AvailabilitySlot>();
  for (const slot of eligibleCandidates) {
    if (!slotByStaff.has(slot.staffId)) {
      slotByStaff.set(slot.staffId, slot);
    }
  }
  const serviceNameById = new Map(serviceRecords.map((record) => [record.id, record.name]));

  for (const staffId of orderedStaffIds) {
    const slot = slotByStaff.get(staffId);
    if (!slot) continue;
    const assignments = uniqueServices
      .map((serviceId) => (slot.services ?? []).find((serviceEntry) => serviceEntry.serviceId === serviceId))
      .filter((assignment): assignment is NonNullable<AvailabilitySlot["services"]>[number] => Boolean(assignment));
    if (assignments.length !== uniqueServices.length) continue;

    const hold = await acquireSlotHold(slot.slotKey, HOLD_TTL_MS);
    if (!hold) continue;

    const ttlMs = hold.expiresAt - Date.now();
    if (ttlMs > 0) {
      await storeSlotHoldMetadata(
        {
          slotKey: slot.slotKey,
          locationId: location.id,
          staffId: slot.staffId,
          start: slot.start,
          end: slot.end,
          reservedFrom: slot.reservedFrom ?? slot.start,
          reservedTo: slot.reservedTo ?? slot.end,
          expiresAt: hold.expiresAt,
          serviceNames: uniqueServices
            .map((serviceId) => serviceNameById.get(serviceId))
            .filter((name): name is string => Boolean(name)),
        },
        ttlMs,
      );
    }

    const slotPayload: SlotPayload = {
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
      slotPayload.service = {
        serviceId: assignments[0].serviceId,
        steps: assignments[0].steps ?? [],
      };
    }
    const holdId = encodeHoldId({ slotKey: slot.slotKey, token: hold.token });
    const staffName = staffById.get(slot.staffId) ?? "Team";

    return NextResponse.json({
      holdId,
      slotId: encodeSlotId(slotPayload),
      slotKey: slot.slotKey,
      staffId: slot.staffId,
      staffName,
      expiresAt: new Date(hold.expiresAt).toISOString(),
      token: hold.token,
    });
  }

  return NextResponse.json({ error: "No capacity" }, { status: 409 });
}
