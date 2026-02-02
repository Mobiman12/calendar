import { endOfDay, format, isValid, parseISO, startOfDay, subDays } from "date-fns";
import { de } from "date-fns/locale";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getSessionOrNull } from "@/lib/session";
import { readTenantContext } from "@/lib/tenant";
import { hasPermission, resolvePermissionSnapshot } from "@/lib/role-permissions";
import { KpiCard } from "@/components/dashboard/KpiCard";

export const dynamic = "force-dynamic";

const numberFormatter = new Intl.NumberFormat("de-DE");

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return numberFormatter.format(value);
}

function toNumber(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof (value as Prisma.Decimal).toNumber === "function") {
    return (value as Prisma.Decimal).toNumber();
  }
  return null;
}

function formatCurrency(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return `${Math.round(value * 100)} %`;
}

function formatDurationMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const rounded = Math.round(value);
  if (rounded >= 60) {
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  return `${rounded} min`;
}

function formatLeadTimeHours(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  const hours = Math.max(0, value);
  if (hours >= 48) {
    return `${(hours / 24).toFixed(1)} Tage`;
  }
  if (hours >= 1) {
    return `${Math.round(hours)} Std`;
  }
  return `${Math.round(hours * 60)} min`;
}

function normalizeDateParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim().length ? raw.trim() : null;
}

function buildRangeHref(locationSlug: string, from: Date, to: Date): string {
  const params = new URLSearchParams();
  params.set("from", format(from, "yyyy-MM-dd"));
  params.set("to", format(to, "yyyy-MM-dd"));
  return `/backoffice/${locationSlug}/analytics?${params.toString()}`;
}

export default async function AnalyticsPage({
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
      ? {
          where: { tenantId: tenantId, slug: location },
          select: { id: true, name: true, slug: true, currency: true, tenantId: true },
        }
      : { where: { slug: location }, select: { id: true, name: true, slug: true, currency: true, tenantId: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({
      where: { slug: location },
      select: { id: true, name: true, slug: true, currency: true, tenantId: true },
    });
  }
  if (!locationRecord) {
    notFound();
  }

  const userRecord = session?.userId
    ? await prisma.user.findUnique({ where: { id: session.userId }, select: { metadata: true, role: true } })
    : null;
  const permissionSnapshot = await resolvePermissionSnapshot({
    session,
    tenantId: locationRecord.tenantId ?? tenantId,
    userMetadata: userRecord?.metadata,
  });
  if (!hasPermission(permissionSnapshot, "calendar.analytics.view")) {
    notFound();
  }

  const canViewAppointments = hasPermission(permissionSnapshot, "calendar.analytics.appointments");
  const canViewRevenue = hasPermission(permissionSnapshot, "calendar.analytics.revenue");
  const canViewServices = hasPermission(permissionSnapshot, "calendar.analytics.services");
  const canViewStaff = hasPermission(permissionSnapshot, "calendar.analytics.staff");
  const canViewCustomers = hasPermission(permissionSnapshot, "calendar.analytics.customers");
  const canViewChannels = hasPermission(permissionSnapshot, "calendar.analytics.channels");

  const hasAnySection =
    canViewAppointments ||
    canViewRevenue ||
    canViewServices ||
    canViewStaff ||
    canViewCustomers ||
    canViewChannels;

  const now = new Date();
  const rawFrom = normalizeDateParam(query.from);
  const rawTo = normalizeDateParam(query.to);
  const parsedFrom = rawFrom ? parseISO(rawFrom) : null;
  const parsedTo = rawTo ? parseISO(rawTo) : null;

  let rangeStart = startOfDay(isValid(parsedFrom) ? parsedFrom : subDays(now, 30));
  let rangeEnd = endOfDay(isValid(parsedTo) ? parsedTo : now);
  if (rangeStart > rangeEnd) {
    [rangeStart, rangeEnd] = [rangeEnd, rangeStart];
  }

  const rangeLabel = `${format(rangeStart, "dd.MM.yyyy", { locale: de })} – ${format(rangeEnd, "dd.MM.yyyy", { locale: de })}`;
  const locationCurrency = locationRecord.currency ?? "EUR";
  const appointmentWhere = {
    locationId: locationRecord.id,
    startsAt: { gte: rangeStart, lte: rangeEnd },
  };

  const statusCountsPromise = canViewAppointments
    ? prisma.appointment.groupBy({
        by: ["status"],
        where: appointmentWhere,
        _count: { id: true },
      })
    : Promise.resolve([]);

  const paymentCountsPromise = canViewRevenue
    ? prisma.appointment.groupBy({
        by: ["paymentStatus"],
        where: appointmentWhere,
        _count: { id: true },
        _sum: { totalAmount: true, depositAmount: true },
      })
    : Promise.resolve([]);

  const revenueSummaryPromise = canViewRevenue
    ? prisma.appointment.aggregate({
        _sum: { totalAmount: true, depositAmount: true },
        _count: { id: true },
        where: {
          ...appointmentWhere,
          status: { in: ["CONFIRMED", "COMPLETED"] },
        },
      })
    : Promise.resolve(null);

  const avgMetricsPromise = canViewAppointments
    ? prisma.$queryRaw<{ avg_duration: number | null; avg_lead_hours: number | null }[]>`
        SELECT
          AVG(EXTRACT(EPOCH FROM ("endsAt" - "startsAt")) / 60) AS avg_duration,
          AVG(EXTRACT(EPOCH FROM ("startsAt" - "createdAt")) / 3600) AS avg_lead_hours
        FROM "Appointment"
        WHERE "locationId" = ${locationRecord.id}
          AND "startsAt" >= ${rangeStart}
          AND "startsAt" <= ${rangeEnd}
      `
    : Promise.resolve([]);

  const sourceBreakdownPromise = canViewChannels
    ? prisma.appointment.groupBy({
        by: ["source"],
        where: appointmentWhere,
        _count: { id: true },
      })
    : Promise.resolve([]);

  const hourlyBreakdownPromise = canViewAppointments
    ? prisma.$queryRaw<{ hour: number; count: number }[]>`
        SELECT EXTRACT(HOUR FROM "startsAt")::int AS hour, COUNT(*)::int AS count
        FROM "Appointment"
        WHERE "locationId" = ${locationRecord.id}
          AND "startsAt" >= ${rangeStart}
          AND "startsAt" <= ${rangeEnd}
        GROUP BY hour
        ORDER BY hour
      `
    : Promise.resolve([]);

  const topServicesPromise = canViewServices
    ? prisma.appointmentItem.groupBy({
        by: ["serviceId"],
        where: {
          appointment: {
            locationId: locationRecord.id,
            startsAt: { gte: rangeStart, lte: rangeEnd },
            status: { in: ["CONFIRMED", "COMPLETED"] },
          },
        },
        _count: { id: true },
        _sum: { price: true },
        orderBy: [{ _count: { id: "desc" } }],
        take: 8,
      })
    : Promise.resolve([]);

  const topStaffPromise = canViewStaff
    ? prisma.appointmentItem.groupBy({
        by: ["staffId"],
        where: {
          staffId: { not: null },
          appointment: {
            locationId: locationRecord.id,
            startsAt: { gte: rangeStart, lte: rangeEnd },
            status: { in: ["CONFIRMED", "COMPLETED"] },
          },
        },
        _count: { id: true },
        _sum: { price: true },
        orderBy: [{ _count: { id: "desc" } }],
        take: 8,
      })
    : Promise.resolve([]);

  const customerStatsPromise = canViewCustomers
    ? prisma.$queryRaw<{ active_count: number; new_count: number; repeat_count: number }[]>`
        WITH active_customers AS (
          SELECT DISTINCT "customerId"
          FROM "Appointment"
          WHERE "locationId" = ${locationRecord.id}
            AND "startsAt" >= ${rangeStart}
            AND "startsAt" <= ${rangeEnd}
            AND "customerId" IS NOT NULL
        ),
        new_customers AS (
          SELECT id
          FROM "Customer"
          WHERE "locationId" = ${locationRecord.id}
            AND "createdAt" >= ${rangeStart}
            AND "createdAt" <= ${rangeEnd}
        )
        SELECT
          (SELECT COUNT(*) FROM active_customers) AS active_count,
          (SELECT COUNT(*) FROM new_customers) AS new_count,
          (SELECT COUNT(*) FROM active_customers ac
            WHERE EXISTS (
              SELECT 1 FROM "Appointment" a
              WHERE a."locationId" = ${locationRecord.id}
                AND a."customerId" = ac."customerId"
                AND a."startsAt" < ${rangeStart}
            )
          ) AS repeat_count
      `
    : Promise.resolve([]);

  const topCustomersPromise = canViewCustomers
    ? prisma.appointment.groupBy({
        by: ["customerId"],
        where: {
          ...appointmentWhere,
          customerId: { not: null },
          status: { in: ["CONFIRMED", "COMPLETED"] },
        },
        _count: { id: true },
        _sum: { totalAmount: true },
        orderBy: [{ _count: { id: "desc" } }],
        take: 6,
      })
    : Promise.resolve([]);

  const [
    statusCounts,
    paymentCounts,
    revenueSummary,
    avgMetricsRows,
    sourceBreakdown,
    hourlyBreakdown,
    topServices,
    topStaff,
    customerStatsRows,
    topCustomers,
  ] = await Promise.all([
    statusCountsPromise,
    paymentCountsPromise,
    revenueSummaryPromise,
    avgMetricsPromise,
    sourceBreakdownPromise,
    hourlyBreakdownPromise,
    topServicesPromise,
    topStaffPromise,
    customerStatsPromise,
    topCustomersPromise,
  ]);

  const statusMap = new Map(
    statusCounts.map((entry) => [entry.status, entry._count.id]),
  );
  const totalAppointments = Array.from(statusMap.values()).reduce((acc, value) => acc + value, 0);
  const confirmedCount = statusMap.get("CONFIRMED") ?? 0;
  const completedCount = statusMap.get("COMPLETED") ?? 0;
  const cancelledCount = statusMap.get("CANCELLED") ?? 0;
  const noShowCount = statusMap.get("NO_SHOW") ?? 0;
  const pendingCount = statusMap.get("PENDING") ?? 0;

  const paymentMap = new Map(
    paymentCounts.map((entry) => [
      entry.paymentStatus,
      {
        count: entry._count.id,
        totalAmount: toNumber(entry._sum.totalAmount) ?? 0,
        depositAmount: toNumber(entry._sum.depositAmount) ?? 0,
      },
    ]),
  );

  const paidRevenue =
    (paymentMap.get("PAID")?.totalAmount ?? 0) + (paymentMap.get("AUTHORIZED")?.totalAmount ?? 0);
  const refundRevenue =
    (paymentMap.get("REFUNDED")?.totalAmount ?? 0) + (paymentMap.get("PARTIALLY_REFUNDED")?.totalAmount ?? 0);
  const bookedRevenue = toNumber(revenueSummary?._sum.totalAmount) ?? 0;
  const depositRevenue = toNumber(revenueSummary?._sum.depositAmount) ?? 0;
  const bookedCount = revenueSummary?._count.id ?? 0;
  const averageTicket = bookedCount ? bookedRevenue / bookedCount : null;

  const avgMetrics = avgMetricsRows[0] ?? null;
  const avgDuration = avgMetrics?.avg_duration ?? null;
  const avgLeadHours = avgMetrics?.avg_lead_hours ?? null;

  const serviceIds = topServices.map((entry) => entry.serviceId);
  const staffIds = topStaff
    .map((entry) => entry.staffId)
    .filter((value): value is string => typeof value === "string");
  const customerIds = topCustomers
    .map((entry) => entry.customerId)
    .filter((value): value is string => typeof value === "string");

  const [serviceRecords, staffRecords, customerRecords] = await Promise.all([
    canViewServices && serviceIds.length
      ? prisma.service.findMany({
          where: { id: { in: serviceIds }, locationId: locationRecord.id },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    canViewStaff && staffIds.length
      ? prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, displayName: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
    canViewCustomers && customerIds.length
      ? prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
  ]);

  const serviceMap = new Map(serviceRecords.map((service) => [service.id, service.name ?? "Unbenannt"]));
  const staffMap = new Map(
    staffRecords.map((staff) => [
      staff.id,
      staff.displayName ?? `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() || "Unbekannt",
    ]),
  );
  const customerMap = new Map(
    customerRecords.map((customer) => [
      customer.id,
      `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unbekannt",
    ]),
  );

  const customerStats = customerStatsRows[0] ?? { active_count: 0, new_count: 0, repeat_count: 0 };
  const hourlyMap = new Map(hourlyBreakdown.map((entry) => [entry.hour, entry.count]));
  const hourlyRows = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourlyMap.get(hour) ?? 0,
  }));

  const quickRanges = [
    { label: "Letzte 7 Tage", days: 7 },
    { label: "Letzte 30 Tage", days: 30 },
    { label: "Letzte 90 Tage", days: 90 },
  ];

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-widest text-zinc-500">Statistik</p>
          <h1 className="text-3xl font-semibold text-zinc-900">{locationRecord.name ?? locationRecord.slug}</h1>
          <p className="text-sm text-zinc-600">Zeitraum: {rangeLabel}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label className="flex flex-col text-xs text-zinc-500">
              Von
              <input
                type="date"
                name="from"
                defaultValue={format(rangeStart, "yyyy-MM-dd")}
                className="mt-1 rounded-md border border-zinc-200 px-2 py-1 text-sm text-zinc-700"
              />
            </label>
            <label className="flex flex-col text-xs text-zinc-500">
              Bis
              <input
                type="date"
                name="to"
                defaultValue={format(rangeEnd, "yyyy-MM-dd")}
                className="mt-1 rounded-md border border-zinc-200 px-2 py-1 text-sm text-zinc-700"
              />
            </label>
            <button
              type="submit"
              className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700"
            >
              Aktualisieren
            </button>
          </form>
          <div className="flex flex-wrap gap-2 text-xs text-zinc-500">
            {quickRanges.map((range) => (
              <a
                key={range.label}
                href={buildRangeHref(locationRecord.slug, subDays(now, range.days - 1), now)}
                className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 transition hover:border-emerald-300 hover:text-emerald-700"
              >
                {range.label}
              </a>
            ))}
          </div>
        </div>
      </header>

      {!hasAnySection && (
        <div className="rounded-lg border border-zinc-200 bg-white px-5 py-6 text-sm text-zinc-600">
          Für deine Rolle sind aktuell keine Statistik-Bausteine freigeschaltet. Bitte wende dich an den Administrator.
        </div>
      )}

      {canViewAppointments && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900">Termin-Überblick</h2>
            <span className="text-xs uppercase tracking-widest text-zinc-400">Status</span>
          </div>
          <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Termine gesamt" value={formatNumber(totalAppointments)} helper="Im gewählten Zeitraum" />
            <KpiCard label="Bestätigt" value={formatNumber(confirmedCount)} helper="Status: Confirmed" />
            <KpiCard label="Abgeschlossen" value={formatNumber(completedCount)} helper="Status: Completed" />
            <KpiCard label="Offen" value={formatNumber(pendingCount)} helper="Status: Pending" />
            <KpiCard label="Storniert" value={formatNumber(cancelledCount)} helper="Status: Cancelled" />
            <KpiCard label="Nicht erschienen" value={formatNumber(noShowCount)} helper="Status: No-Show" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-zinc-900">Buchungsqualität</h3>
              <div className="mt-3 grid gap-3 text-sm text-zinc-700">
                <div className="flex items-center justify-between">
                  <span>No-Show-Quote</span>
                  <span className="font-semibold">
                    {formatPercent(totalAppointments ? noShowCount / totalAppointments : 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Storno-Quote</span>
                  <span className="font-semibold">
                    {formatPercent(totalAppointments ? cancelledCount / totalAppointments : 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Ø Termindauer</span>
                  <span className="font-semibold">{formatDurationMinutes(avgDuration)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Ø Vorlaufzeit</span>
                  <span className="font-semibold">{formatLeadTimeHours(avgLeadHours)}</span>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-zinc-200 bg-white p-4">
              <h3 className="text-sm font-semibold text-zinc-900">Auslastung nach Uhrzeit</h3>
              <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-zinc-600">
                {hourlyRows.map((entry) => (
                  <div key={entry.hour} className="flex items-center justify-between rounded-md border border-zinc-100 px-2 py-1">
                    <span>{String(entry.hour).padStart(2, "0")}:00</span>
                    <span className="font-semibold text-zinc-800">{formatNumber(entry.count)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {canViewRevenue && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-zinc-900">Umsatz &amp; Zahlungen</h2>
            <span className="text-xs uppercase tracking-widest text-zinc-400">Finanzen</span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Umsatz bezahlt" value={formatCurrency(paidRevenue, locationCurrency)} helper="PAID + AUTHORIZED" />
            <KpiCard label="Geplanter Umsatz" value={formatCurrency(bookedRevenue, locationCurrency)} helper="Confirmed + Completed" />
            <KpiCard label="Anzahlungen" value={formatCurrency(depositRevenue, locationCurrency)} helper="Einbehaltene Deposits" />
            <KpiCard label="Ø Warenkorb" value={formatCurrency(averageTicket, locationCurrency)} helper="Durchschnitt pro Termin" />
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-zinc-900">Zahlungsstatus</h3>
            <div className="mt-3 grid gap-2 text-sm text-zinc-700">
              {[
                { key: "PAID", label: "Bezahlt" },
                { key: "AUTHORIZED", label: "Autorisiert" },
                { key: "UNPAID", label: "Offen" },
                { key: "REFUNDED", label: "Erstattet" },
                { key: "PARTIALLY_REFUNDED", label: "Teilweise erstattet" },
              ].map((entry) => {
                const item = paymentMap.get(entry.key);
                return (
                  <div key={entry.key} className="flex items-center justify-between">
                    <span>{entry.label}</span>
                    <span className="font-semibold">
                      {formatNumber(item?.count ?? 0)} · {formatCurrency(item?.totalAmount ?? 0, locationCurrency)}
                    </span>
                  </div>
                );
              })}
              {refundRevenue > 0 && (
                <div className="flex items-center justify-between text-red-600">
                  <span>Erstattungen gesamt</span>
                  <span className="font-semibold">{formatCurrency(refundRevenue, locationCurrency)}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {(canViewServices || canViewStaff) && (
        <section className="grid gap-4 lg:grid-cols-2">
          {canViewServices && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">Top Leistungen</h2>
                <span className="text-xs uppercase tracking-widest text-zinc-400">nach Buchungen</span>
              </div>
              <div className="mt-3 space-y-2 text-sm">
                {topServices.length === 0 && <p className="text-zinc-500">Keine Daten im Zeitraum.</p>}
                {topServices.map((entry) => (
                  <div key={entry.serviceId} className="flex items-center justify-between">
                    <span className="text-zinc-700">{serviceMap.get(entry.serviceId) ?? "Unbekannt"}</span>
                    <span className="font-semibold text-zinc-900">
                      {formatNumber(entry._count.id)}
                      {canViewRevenue && ` · ${formatCurrency(toNumber(entry._sum.price) ?? 0, locationCurrency)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {canViewStaff && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">Top Mitarbeiter</h2>
                <span className="text-xs uppercase tracking-widest text-zinc-400">nach Terminen</span>
              </div>
              <div className="mt-3 space-y-2 text-sm">
                {topStaff.length === 0 && <p className="text-zinc-500">Keine Daten im Zeitraum.</p>}
                {topStaff.map((entry) => (
                  <div key={entry.staffId ?? "unknown"} className="flex items-center justify-between">
                    <span className="text-zinc-700">{entry.staffId ? staffMap.get(entry.staffId) ?? "Unbekannt" : "Ohne Mitarbeiter"}</span>
                    <span className="font-semibold text-zinc-900">
                      {formatNumber(entry._count.id)}
                      {canViewRevenue && ` · ${formatCurrency(toNumber(entry._sum.price) ?? 0, locationCurrency)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {(canViewCustomers || canViewChannels) && (
        <section className="grid gap-4 lg:grid-cols-2">
          {canViewCustomers && (
            <div className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">Kundenaktivität</h2>
                <span className="text-xs uppercase tracking-widest text-zinc-400">Highlights</span>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <KpiCard label="Aktive Kunden" value={formatNumber(customerStats.active_count)} helper="Mit Termin im Zeitraum" />
                <KpiCard label="Neue Kunden" value={formatNumber(customerStats.new_count)} helper="Neu angelegt im Zeitraum" />
                <KpiCard label="Wiederkehrend" value={formatNumber(customerStats.repeat_count)} helper="Bereits früher gebucht" />
              </div>
              <div className="space-y-2 text-sm text-zinc-700">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Top Kunden</h3>
                {topCustomers.length === 0 && <p className="text-zinc-500">Keine Daten im Zeitraum.</p>}
                {topCustomers.map((entry) => (
                  <div key={entry.customerId ?? "unknown"} className="flex items-center justify-between">
                    <span>{entry.customerId ? customerMap.get(entry.customerId) ?? "Unbekannt" : "Ohne Kunde"}</span>
                    <span className="font-semibold">
                      {formatNumber(entry._count.id)}
                      {canViewRevenue && ` · ${formatCurrency(toNumber(entry._sum.totalAmount) ?? 0, locationCurrency)}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {canViewChannels && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-900">Buchungskanäle</h2>
                <span className="text-xs uppercase tracking-widest text-zinc-400">Quelle</span>
              </div>
              <div className="mt-3 space-y-2 text-sm">
                {sourceBreakdown.length === 0 && <p className="text-zinc-500">Keine Daten im Zeitraum.</p>}
                {sourceBreakdown.map((entry) => (
                  <div key={entry.source} className="flex items-center justify-between">
                    <span className="text-zinc-700">{entry.source}</span>
                    <span className="font-semibold text-zinc-900">{formatNumber(entry._count.id)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
