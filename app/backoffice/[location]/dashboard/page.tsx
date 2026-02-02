import { addDays, format, formatDistanceToNow, subDays } from "date-fns";
import { de } from "date-fns/locale";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { ActivityList } from "@/components/dashboard/ActivityList";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";

const currencyFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

function formatRelative(date: Date) {
  return formatDistanceToNow(date, { addSuffix: true, locale: de });
}

function formatDateTime(date: Date) {
  return format(date, "dd.MM.yyyy · HH:mm", { locale: de });
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const session = await getSessionOrNull();
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  let locationRecord = await prisma.location.findFirst(
    tenantId
      ? {
          where: { tenantId: tenantId, slug: location },
          select: {
            id: true,
            name: true,
            slug: true,
            timezone: true,
          },
        }
      : {
          where: { slug: location },
          select: {
            id: true,
            name: true,
            slug: true,
            timezone: true,
          },
        },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({
      where: { slug: location },
      select: { id: true, name: true, slug: true, timezone: true },
    });
  }

  if (!locationRecord) {
    notFound();
  }

  const now = new Date();
  const last30Days = subDays(now, 30);
  const next7Days = addDays(now, 7);

  const membershipSupported = await supportsCustomerMemberships(prisma);

  const customerScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        OR: [
          { locationId: locationRecord.id },
          { memberships: { some: { locationId: locationRecord.id } } },
        ],
      }
    : { locationId: locationRecord.id };

  const [
    revenueAggregate,
    totalAppointmentsLast30,
    noShowAppointmentsLast30,
    bookingsNext7,
    upcomingAppointments,
    recentAppointments,
    recentCustomers,
  ] = await Promise.all([
    prisma.appointment.aggregate({
      _sum: { totalAmount: true, depositAmount: true },
      where: {
        locationId: locationRecord.id,
        status: { in: ["COMPLETED", "CONFIRMED"] },
        startsAt: { gte: last30Days },
      },
    }),
    prisma.appointment.count({
      where: {
        locationId: locationRecord.id,
        startsAt: { gte: last30Days },
      },
    }),
    prisma.appointment.count({
      where: {
        locationId: locationRecord.id,
        status: "NO_SHOW",
        startsAt: { gte: last30Days },
      },
    }),
    prisma.appointment.count({
      where: {
        locationId: locationRecord.id,
        status: { in: ["CONFIRMED", "PENDING"] },
        startsAt: { gte: now, lt: next7Days },
      },
    }),
    prisma.appointment.findMany({
      where: {
        locationId: locationRecord.id,
        status: { in: ["CONFIRMED", "PENDING"] },
        startsAt: { gte: now },
      },
      include: {
        customer: { select: { firstName: true, lastName: true } },
        items: {
          select: {
            service: { select: { name: true } },
            staff: { select: { displayName: true, firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { startsAt: "asc" },
      take: 5,
    }),
    prisma.appointment.findMany({
      where: { locationId: locationRecord.id },
      include: {
        customer: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
    prisma.customer.findMany({
      where: customerScope,
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        createdAt: true,
      },
    }),
  ]);

  const totalRevenue = Number(revenueAggregate._sum.totalAmount ?? 0);
  const totalDeposit = Number(revenueAggregate._sum.depositAmount ?? 0);
  const noShowRate =
    totalAppointmentsLast30 > 0 ? `${Math.round((noShowAppointmentsLast30 / totalAppointmentsLast30) * 100)} %` : "–";

  const upcomingItems = upcomingAppointments.map((appointment) => {
    const mainItem = appointment.items[0];
    const staffName = mainItem?.staff
      ? mainItem.staff.displayName ?? `${mainItem.staff.firstName ?? ""} ${mainItem.staff.lastName ?? ""}`.trim()
      : undefined;
    return {
      id: appointment.id,
      title: mainItem?.service?.name ?? "Service",
      subtitle: [
        appointment.customer ? `${appointment.customer.firstName} ${appointment.customer.lastName}`.trim() : "Kunde",
        staffName ? `· ${staffName}` : "",
      ]
        .join(" ")
        .trim(),
      meta: formatDateTime(appointment.startsAt),
      href: `/backoffice/${locationRecord.slug}/appointments`,
    };
  });

  const recentAppointmentItems = recentAppointments.map((appointment) => ({
    id: appointment.id,
    title: appointment.customer
      ? `${appointment.customer.firstName} ${appointment.customer.lastName}`.trim()
      : "Unbekannter Kunde",
    subtitle: `Status: ${statusLabel(appointment.status)}`,
    meta: `Angelegt ${formatRelative(appointment.createdAt)}`,
    href: `/backoffice/${locationRecord.slug}/appointments`,
  }));

  const recentCustomerIds = recentCustomers.map((customer) => customer.id);
  const recentCustomerCounts = recentCustomerIds.length
    ? await prisma.appointment.groupBy({
        by: ["customerId"],
        where: {
          locationId: locationRecord.id,
          customerId: { in: recentCustomerIds },
        },
        _count: {
          _all: true,
        },
      })
    : [];
  const recentCountEntries = recentCustomerCounts
    .filter((entry): entry is typeof entry & { customerId: string } => Boolean(entry.customerId))
    .map((entry) => [entry.customerId, entry._count._all] as const);
  const recentCountMap = new Map<string, number>(recentCountEntries);
  const customerItems = recentCustomers.map((customer) => ({
    id: customer.id,
    title: `${customer.firstName} ${customer.lastName}`.trim(),
    subtitle: customer.email ?? customer.phone ?? "Keine Kontaktdaten",
    meta: `${recentCountMap.get(customer.id) ?? 0} Termine`,
    href: `/backoffice/${locationRecord.slug}/customers`,
  }));

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Dashboard</p>
        <h1 className="text-3xl font-semibold text-zinc-900">
          {locationRecord.name ?? locationRecord.slug}
        </h1>
        <p className="text-sm text-zinc-600">
          Überblick über Umsatz, Auslastung und aktuelle Aktivitäten der letzten 30 Tage.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <KpiCard
          label="Umsatz (30 Tage)"
          value={formatCurrency(totalRevenue)}
          helper={`Anzahlung: ${formatCurrency(totalDeposit)}`}
        />
        <KpiCard
          label="Gebuchte Termine (nächste 7 Tage)"
          value={`${bookingsNext7}`}
          helper="inkl. bestätigte & offene Termine"
        />
        <KpiCard label="Nicht erschienen (30 Tage)" value={noShowRate} helper="Verpasste Termine vs. Gesamt" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ActivityList title="Bevorstehende Termine" items={upcomingItems} />
        <ActivityList title="Neueste Buchungen" items={recentAppointmentItems} />
        <ActivityList title="Neue Kund:innen" items={customerItems} />
      </div>
    </section>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "CONFIRMED":
      return "Bestätigt";
    case "PENDING":
      return "Offen";
    case "COMPLETED":
      return "Abgeschlossen";
    case "CANCELLED":
      return "Storniert";
    case "NO_SHOW":
      return "Nicht erschienen";
    default:
      return status;
  }
}
