import { NextResponse, type NextRequest } from "next/server";
import { subDays } from "date-fns";

import { getPrismaClient } from "@/lib/prisma";
import { deriveBookingPreferences, bookingPreferencesDefaults } from "@/lib/booking-preferences";
import { normalizeColorDurationConfig } from "@/lib/color-consultation";
import { AppointmentItemStatus, AppointmentStatus } from "@prisma/client";

const prisma = getPrismaClient();

type ServiceMetadata = {
  priceVisible?: boolean;
  showDurationOnline?: boolean;
  onlineBookable?: boolean;
  assignedStaffIds?: unknown;
  isComplex?: boolean;
  addOnServiceIds?: unknown;
  popularityWeight?: number;
  serviceWeight?: number;
  colorConsultationDurations?: unknown;
};

type ServicesResponse = {
  data: Array<{
    id: string;
    name: string;
    description?: string;
    durationMin: number;
    priceCents?: number;
    showDurationOnline?: boolean;
    isComplex?: boolean;
    categoryId?: string;
    categoryName?: string;
    assignedStaffIds: string[];
    addOnServiceIds?: string[];
    colorConsultationDurations?: ReturnType<typeof normalizeColorDurationConfig>;
  }>;
  popularServiceIds?: string[];
  popularServiceIdsByCategory?: Record<string, string[]>;
};

const SERVICES_CACHE_TTL_MS = 30_000;
const SERVICES_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=30, stale-while-revalidate=30",
};
const servicesCache = new Map<string, { expiresAt: number; payload: ServicesResponse }>();

const POPULAR_SERVICES_LIMIT_DEFAULT = bookingPreferencesDefaults.popularServicesLimit;
const POPULAR_WINDOW_DAYS_DEFAULT = bookingPreferencesDefaults.popularServicesWindowDays;
const POPULAR_SERVICES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
type PopularServicesPayload = {
  overall: string[];
  byCategory: Record<string, string[]>;
};

const popularServicesCache = new Map<string, { expiresAt: number; payload: PopularServicesPayload }>();

function readServicesCache(key: string): ServicesResponse | null {
  const entry = servicesCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    servicesCache.delete(key);
    return null;
  }
  return entry.payload;
}

function writeServicesCache(key: string, payload: ServicesResponse) {
  servicesCache.set(key, { expiresAt: Date.now() + SERVICES_CACHE_TTL_MS, payload });
}

function resolveAddOnServiceIds(metadata: ServiceMetadata | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = metadata.addOnServiceIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function resolveServiceWeight(metadata: ServiceMetadata | null): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return 1;
  const raw =
    typeof metadata.serviceWeight === "number"
      ? metadata.serviceWeight
      : typeof metadata.popularityWeight === "number"
        ? metadata.popularityWeight
        : 1;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(0, raw);
}

async function resolvePopularServiceIds(
  locationId: string,
  services: Array<{ id: string; name: string; metadata: ServiceMetadata | null; categoryId: string | null }>,
  eligibleServiceIds: string[],
  windowDays: number,
  limit: number,
) {
  if (!eligibleServiceIds.length) return { overall: [], byCategory: {} };
  if (!Number.isFinite(windowDays) || windowDays <= 0 || !Number.isFinite(limit) || limit <= 0) {
    return { overall: [], byCategory: {} };
  }
  const cacheKey = `${locationId}:${windowDays}:${limit}`;
  const cached = popularServicesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const since = subDays(new Date(), windowDays);
  const counts = await prisma.appointmentItem.groupBy({
    by: ["serviceId"],
    where: {
      serviceId: { in: eligibleServiceIds },
      status: { not: AppointmentItemStatus.CANCELLED },
      appointment: {
        locationId,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        startsAt: { gte: since },
      },
    },
    _count: { serviceId: true },
  });

  const nameById = new Map(services.map((service) => [service.id, service.name]));
  const weightById = new Map(
    services.map((service) => [service.id, resolveServiceWeight(service.metadata ?? null)]),
  );
  const categoryById = new Map(services.map((service) => [service.id, service.categoryId]));

  const scored = counts
    .map((entry) => {
      const weight = weightById.get(entry.serviceId) ?? 1;
      const count = entry._count.serviceId ?? 0;
      return {
        serviceId: entry.serviceId,
        score: count * weight,
        count,
        name: nameById.get(entry.serviceId) ?? "",
        categoryId: categoryById.get(entry.serviceId) ?? null,
      };
    })
    .filter((entry) => entry.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name, "de");
  });

  const popularIds = scored.slice(0, limit).map((entry) => entry.serviceId);
  const byCategory: Record<string, string[]> = {};
  for (const entry of scored) {
    if (!entry.categoryId) continue;
    const list = byCategory[entry.categoryId] ?? [];
    if (list.length < limit) {
      list.push(entry.serviceId);
      byCategory[entry.categoryId] = list;
    }
  }
  const payload: PopularServicesPayload = { overall: popularIds, byCategory };
  popularServicesCache.set(cacheKey, { expiresAt: Date.now() + POPULAR_SERVICES_CACHE_TTL_MS, payload });
  return payload;
}

export async function GET(request: NextRequest) {
  const locationId = request.nextUrl.searchParams.get("locationId");
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
  }

  const locationRecord = await prisma.location.findUnique({
    where: { id: locationId },
    select: { metadata: true },
  });
  const metadataRecord =
    locationRecord?.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : {};
  const bookingPreferences = deriveBookingPreferences((metadataRecord as Record<string, unknown>).bookingPreferences ?? null);
  const popularWindowDays =
    typeof bookingPreferences.popularServicesWindowDays === "number"
      ? bookingPreferences.popularServicesWindowDays
      : POPULAR_WINDOW_DAYS_DEFAULT;
  const popularLimit =
    typeof bookingPreferences.popularServicesLimit === "number"
      ? bookingPreferences.popularServicesLimit
      : POPULAR_SERVICES_LIMIT_DEFAULT;
  const cacheKey = `${locationId}:${popularWindowDays}:${popularLimit}`;
  const cached = readServicesCache(cacheKey);
  if (cached) {
    return NextResponse.json(cached, { headers: SERVICES_CACHE_HEADERS });
  }

  const services = await prisma.service.findMany({
    where: {
      locationId,
      status: "ACTIVE",
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      duration: true,
      basePrice: true,
      metadata: true,
      description: true,
      categoryId: true,
      category: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  const filtered = services.filter((service) => {
    const metadata = service.metadata as ServiceMetadata | null;
    const onlineBookable = typeof metadata?.onlineBookable === "boolean" ? metadata.onlineBookable : true;
    const assignedStaffIds = resolveAssignedStaffIds(metadata);
    return onlineBookable && assignedStaffIds.length > 0;
  });
  const addOnServiceIds = new Set<string>();
  services.forEach((service) => {
    resolveAddOnServiceIds(service.metadata as ServiceMetadata | null).forEach((id) => addOnServiceIds.add(id));
  });
  const eligibleServiceIds = filtered.map((service) => service.id).filter((id) => !addOnServiceIds.has(id));
  const popularServices = await resolvePopularServiceIds(
    locationId,
    services.map((service) => ({
      id: service.id,
      name: service.name,
      metadata: service.metadata as ServiceMetadata | null,
      categoryId: service.categoryId ?? null,
    })),
    eligibleServiceIds,
    popularWindowDays,
    popularLimit,
  );

  const payload: ServicesResponse = {
    data: filtered.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description ?? undefined,
      durationMin: service.duration,
      priceCents:
        (service.metadata as ServiceMetadata | null)?.priceVisible === false
          ? undefined
          : service.basePrice
            ? Math.round(Number(service.basePrice) * 100)
            : undefined,
      showDurationOnline:
        (service.metadata as ServiceMetadata | null)?.showDurationOnline === false ? false : true,
      isComplex: typeof (service.metadata as ServiceMetadata | null)?.isComplex === "boolean"
        ? (service.metadata as ServiceMetadata).isComplex
        : undefined,
      categoryId: service.category?.id ?? service.categoryId ?? undefined,
      categoryName: service.category?.name ?? undefined,
      assignedStaffIds: resolveAssignedStaffIds(service.metadata as ServiceMetadata | null),
      addOnServiceIds: resolveAddOnServiceIds(service.metadata as ServiceMetadata | null),
      colorConsultationDurations: normalizeColorDurationConfig(
        (service.metadata as ServiceMetadata | null)?.colorConsultationDurations,
      ),
    })),
    popularServiceIds: popularServices.overall,
    popularServiceIdsByCategory: popularServices.byCategory,
  };

  writeServicesCache(cacheKey, payload);
  return NextResponse.json(payload, { headers: SERVICES_CACHE_HEADERS });
}

function resolveAssignedStaffIds(metadata: ServiceMetadata | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = metadata.assignedStaffIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}
