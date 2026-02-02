import { ScheduleOwnerType, type Weekday } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";

const prisma = getPrismaClient();

export const WEEK_ORDER: Weekday[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

export type ScheduleEntry = {
  weekday: Weekday;
  startsAt: number | null;
  endsAt: number | null;
};

export type LocationSummary = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  addressLine1: string | null;
  city: string | null;
  createdAt: string;
  updatedAt: string;
  staffCount: number;
  customerCount: number;
  schedule: ScheduleEntry[];
};

type LocationQueryResult = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  addressLine1: string | null;
  city: string | null;
  createdAt: Date;
  updatedAt: Date;
  schedules: Array<{
    rules: Array<{ weekday: Weekday; startsAt: number; endsAt: number; isActive: boolean }>;
  }>;
  _count: { staff: number; customers: number };
};

function mapToSummary(location: LocationQueryResult): LocationSummary {
  const scheduleRules = location.schedules?.[0]?.rules ?? [];
  const schedule = WEEK_ORDER.map<ScheduleEntry>((weekday) => {
    const rule = scheduleRules.find((entry) => entry.weekday === weekday && entry.isActive);
    return {
      weekday,
      startsAt: rule?.startsAt ?? null,
      endsAt: rule?.endsAt ?? null,
    };
  });

  return {
    id: location.id,
    name: location.name,
    slug: location.slug,
    timezone: location.timezone,
    addressLine1: location.addressLine1 ?? null,
    city: location.city ?? null,
    createdAt: location.createdAt.toISOString(),
    updatedAt: location.updatedAt.toISOString(),
    staffCount: location._count.staff ?? 0,
    customerCount: location._count.customers ?? 0,
    schedule,
  };
}

const summarySelect = {
  id: true,
  slug: true,
  name: true,
  timezone: true,
  addressLine1: true,
  city: true,
  createdAt: true,
  updatedAt: true,
  schedules: {
    where: { ownerType: ScheduleOwnerType.LOCATION, isDefault: true },
    take: 1,
    select: {
      rules: {
        select: { weekday: true, startsAt: true, endsAt: true, isActive: true },
      },
    },
  },
  _count: {
    select: {
      staff: true,
      customers: true,
    },
  },
} satisfies Record<string, unknown>;

export async function fetchLocationSummaries(tenantId?: string): Promise<LocationSummary[]> {
  const locations = await prisma.location.findMany(
    tenantId
      ? {
          where: { tenantId },
          orderBy: [{ createdAt: "asc" }],
          select: summarySelect,
        }
      : {
          orderBy: [{ createdAt: "asc" }],
          select: summarySelect,
        },
  );

  return locations.map((location) => mapToSummary(location as LocationQueryResult));
}
