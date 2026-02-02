import { addDays, subDays } from "date-fns";
import { AppointmentStatus, Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { AppointmentsOverview } from "@/components/appointments/AppointmentsOverview";
import type { AppointmentRow } from "@/components/appointments/types";
import { autoCompletePastAppointments } from "@/lib/appointments/auto-complete";
import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";

export default async function AppointmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ location: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ location }, query] = await Promise.all([params, searchParams]);
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const session = await getSessionOrNull();
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  let locationRecord = await prisma.location.findFirst(
    tenantId
      ? { where: { tenantId: tenantId, slug: location }, select: { id: true, name: true, slug: true } }
      : { where: { slug: location }, select: { id: true, name: true, slug: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, select: { id: true, name: true, slug: true } });
  }

  if (!locationRecord) {
    notFound();
  }

  await autoCompletePastAppointments(prisma, locationRecord.id);

  const now = new Date();
  const filters = parseFilters(query);
  const searchConditions = buildSearchConditions(filters.query);
  const upcomingUntil = addDays(now, filters.upcomingRangeDays);
  const pastSince = subDays(now, filters.pastRangeDays);

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

  const [upcomingAppointments, recentAppointments, staffMembers, serviceDefinitions] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        locationId: locationRecord.id,
        status:
          filters.status && filters.status !== "ALL"
            ? { equals: filters.status }
            : { in: DEFAULT_UPCOMING_STATUSES },
        startsAt: { gte: now, lt: upcomingUntil },
        ...(searchConditions ? { OR: searchConditions } : {}),
      },
      orderBy: { startsAt: "asc" },
      take: 25,
      include: {
        customer: { select: { firstName: true, lastName: true, email: true } },
        items: {
          select: {
            service: { select: { name: true } },
            staff: { select: { displayName: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.appointment.findMany({
      where: {
        locationId: locationRecord.id,
        status:
          filters.status && filters.status !== "ALL"
            ? { equals: filters.status }
            : { in: DEFAULT_PAST_STATUSES },
        startsAt: { lt: now, gte: pastSince },
        ...(searchConditions ? { OR: searchConditions } : {}),
      },
      orderBy: { startsAt: "desc" },
      take: 20,
      include: {
        customer: { select: { firstName: true, lastName: true, email: true } },
        items: {
          select: {
            service: { select: { name: true } },
            staff: { select: { displayName: true, firstName: true, lastName: true } },
          },
        },
      },
    }),
    prisma.staff.findMany({
      where: staffScope,
      select: {
        id: true,
        displayName: true,
        firstName: true,
        lastName: true,
        color: true,
      },
      orderBy: [{ displayName: "asc" }, { firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.service.findMany({
      where: { locationId: locationRecord.id },
      select: {
        id: true,
        name: true,
        duration: true,
      },
      orderBy: { name: "asc" },
    }),
  ]);

  const upcomingRows = upcomingAppointments.map((appointment) => simplifyAppointment(appointment));
  const recentRows = recentAppointments.map((appointment) => simplifyAppointment(appointment));

  const staffOptions = staffMembers.map((staff) => {
    const name =
      staff.displayName || `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() || "Teammitglied";
    return {
      id: staff.id,
      name,
      color: staff.color ?? "#1f2937",
    };
  });

  const serviceOptions = serviceDefinitions.map((service) => ({
    id: service.id,
    name: service.name ?? "Service",
    duration: service.duration ?? 30,
  }));

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Termine</p>
        <h1 className="text-3xl font-semibold text-zinc-900">
          {locationRecord.name ?? locationRecord.slug}
        </h1>
        <p className="text-sm text-zinc-600">
          Überblick über kommende Buchungen und kürzlich abgeschlossene Termine. Klicke auf eine Zeile, um Timeline,
          Zahlstatus und Audit-Verlauf anzuzeigen.
        </p>
      </header>

      <AppointmentsOverview
        locationSlug={locationRecord.slug}
        upcoming={upcomingRows}
        recent={recentRows}
        initialFilters={filters}
        staffOptions={staffOptions}
        services={serviceOptions}
      />
    </section>
  );
}

function simplifyAppointment(appointment: {
  id: string;
  startsAt: Date;
  totalAmount: unknown;
  status: string;
  currency: string;
  customer: { firstName: string | null; lastName: string | null; email: string | null } | null;
  items: Array<{
    service: { name: string | null } | null;
    staff:
      | {
          displayName: string | null;
          firstName: string | null;
          lastName: string | null;
        }
      | null;
  }>;
}): AppointmentRow {
  const mainItem = appointment.items[0];
  const staff = mainItem?.staff;
  const staffDisplayName = staff
    ? staff.displayName ?? `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim()
    : null;
  const staffName = staff ? (staffDisplayName || "–") : "–";

  const customerDisplayName = appointment.customer
    ? `${appointment.customer.firstName ?? ""} ${appointment.customer.lastName ?? ""}`.trim()
    : null;
  const customerName = customerDisplayName || "Unbekannt";

  const amount = decimalToNumber(appointment.totalAmount);

  return {
    id: appointment.id,
    startsAtIso: appointment.startsAt.toISOString(),
    customerName,
    customerContact: appointment.customer?.email ?? undefined,
    serviceName: mainItem?.service?.name ?? "Service",
    staffName,
    status: appointment.status,
    totalAmount: amount,
    currency: appointment.currency,
  };
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

const DEFAULT_UPCOMING_STATUSES: AppointmentStatus[] = ["CONFIRMED", "PENDING"];
const DEFAULT_PAST_STATUSES: AppointmentStatus[] = ["CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW", "PENDING"];
const ALLOWED_STATUS_VALUES: Array<AppointmentStatus | "ALL"> = [
  "ALL",
  "PENDING",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];
const ALLOWED_UPCOMING_RANGES = [7, 14, 21, 30];
const ALLOWED_PAST_RANGES = [30, 60, 90];

function parseFilters(query: Record<string, string | string[] | undefined>) {
  const statusRaw = extractSingleValue(query.status);
  const status = ALLOWED_STATUS_VALUES.includes(statusRaw as AppointmentStatus | "ALL")
    ? (statusRaw as AppointmentStatus | "ALL")
    : "ALL";

  const upcomingRange = clampRange(extractSingleValue(query.upcomingRange), ALLOWED_UPCOMING_RANGES, 21);
  const pastRange = clampRange(extractSingleValue(query.pastRange), ALLOWED_PAST_RANGES, 30);
  const search = (extractSingleValue(query.q) ?? "").trim().slice(0, 120);

  return {
    status,
    upcomingRangeDays: upcomingRange,
    pastRangeDays: pastRange,
    query: search,
  };
}

function extractSingleValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function clampRange(value: string | undefined, allowed: number[], fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && allowed.includes(parsed) ? parsed : fallback;
}

function buildSearchConditions(query: string | undefined) {
  if (!query) return null;
  const value = query;
  const mode = "insensitive" as const;
  return [
    { confirmationCode: { contains: value, mode } },
    {
      customer: {
        OR: [
          { firstName: { contains: value, mode } },
          { lastName: { contains: value, mode } },
          { email: { contains: value, mode } },
          { phone: { contains: value, mode } },
        ],
      },
    },
    {
      items: {
        some: {
          service: { name: { contains: value, mode } },
        },
      },
    },
    {
      items: {
        some: {
          staff: {
            OR: [
              { displayName: { contains: value, mode } },
              { firstName: { contains: value, mode } },
              { lastName: { contains: value, mode } },
            ],
          },
        },
      },
    },
  ];
}
