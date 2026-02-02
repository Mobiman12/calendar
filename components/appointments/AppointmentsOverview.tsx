"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AppointmentDetailDrawer } from "@/components/appointments/AppointmentDetailDrawer";
import {
  AppointmentEditDrawer,
  type AppointmentEditTarget,
} from "@/components/appointments/AppointmentEditDrawer";
import type { AppointmentRow, AppointmentDetailPayload } from "@/components/appointments/types";
import { useBookingPinAuth } from "@/components/dashboard/useBookingPinAuth";

type AppointmentStatusFilter = "ALL" | "PENDING" | "CONFIRMED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";

interface AppointmentsOverviewProps {
  locationSlug: string;
  upcoming: AppointmentRow[];
  recent: AppointmentRow[];
  initialFilters: {
    status: AppointmentStatusFilter;
    upcomingRangeDays: number;
    pastRangeDays: number;
    query: string;
  };
  staffOptions: Array<{ id: string; name: string; color: string }>;
  services: Array<{ id: string; name: string; duration: number }>;
}

const STATUS_OPTIONS: Array<{ value: AppointmentStatusFilter; label: string }> = [
  { value: "ALL", label: "Alle Status" },
  { value: "PENDING", label: "Offen" },
  { value: "CONFIRMED", label: "Bestätigt" },
  { value: "COMPLETED", label: "Abgeschlossen" },
  { value: "CANCELLED", label: "Storniert" },
  { value: "NO_SHOW", label: "Nicht erschienen" },
];

const UPCOMING_RANGE_OPTIONS = [
  { value: 7, label: "7 Tage" },
  { value: 14, label: "14 Tage" },
  { value: 21, label: "21 Tage" },
  { value: 30, label: "30 Tage" },
];

const PAST_RANGE_OPTIONS = [
  { value: 30, label: "30 Tage" },
  { value: 60, label: "60 Tage" },
  { value: 90, label: "90 Tage" },
];

export function AppointmentsOverview({
  locationSlug,
  upcoming,
  recent,
  initialFilters,
  staffOptions,
  services,
}: AppointmentsOverviewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppointmentDetailPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [editTarget, setEditTarget] = useState<AppointmentEditTarget | null>(null);

  const {
    actor: bookingActor,
    ensureBookingActor,
    dialogElement: bookingPinDialog,
    sessionSecondsRemaining,
  } = useBookingPinAuth({
    locationSlug,
  });

  const statusFilter = normalizeStatus(searchParams.get("status"), initialFilters.status);
  const upcomingRange = normalizeRange(searchParams.get("upcomingRange"), initialFilters.upcomingRangeDays, UPCOMING_RANGE_OPTIONS);
  const pastRange = normalizeRange(searchParams.get("pastRange"), initialFilters.pastRangeDays, PAST_RANGE_OPTIONS);
  const currentQuery = normalizeQuery(searchParams.get("q"), initialFilters.query);
  const [searchValue, setSearchValue] = useState(currentQuery);
  const isInitialRender = useRef(true);

  useEffect(() => {
    if (!drawerOpen || !activeId) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);

    const load = async () => {
      try {
        const response = await fetch(`/api/backoffice/${locationSlug}/appointments/${activeId}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          const message = response.status === 404 ? "Termin nicht gefunden." : "Termindetails konnten nicht geladen werden.";
          throw new Error(message);
        }
        const json = (await response.json()) as AppointmentDetailPayload;
        if (!cancelled) {
          setDetail(json);
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Unbekannter Fehler beim Laden der Details.";
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [drawerOpen, activeId, locationSlug, reloadToken]);

  const refreshDetail = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const refreshAll = useCallback(() => {
    setReloadToken((value) => value + 1);
    router.refresh();
  }, [router]);

  const handleEdit = useCallback((detailPayload: AppointmentDetailPayload) => {
    const primaryItem = detailPayload.appointment.items[0];
    if (!primaryItem) return;
    setEditTarget({
      appointmentId: detailPayload.appointment.id,
      itemId: primaryItem.id,
      startsAt: new Date(primaryItem.startsAt),
      endsAt: new Date(primaryItem.endsAt),
      staffId: primaryItem.staff?.id ?? undefined,
      serviceId: primaryItem.service?.id ?? undefined,
      note: detailPayload.appointment.note ?? null,
    });
  }, []);

  const handleEditSuccess = useCallback(() => {
    setEditTarget(null);
    refreshAll();
  }, [refreshAll]);

  const handleEditClose = useCallback(() => {
    setEditTarget(null);
  }, []);

  const handleClose = () => {
    setDrawerOpen(false);
    setActiveId(null);
    setDetail(null);
    setError(null);
    setLoading(false);
    setEditTarget(null);
  };

  useEffect(() => {
    if ((!bookingActor || sessionSecondsRemaining <= 0) && (drawerOpen || editTarget)) {
      setDrawerOpen(false);
      setActiveId(null);
      setDetail(null);
      setError(null);
      setLoading(false);
      setEditTarget(null);
    }
  }, [bookingActor, sessionSecondsRemaining, drawerOpen, editTarget]);

  const handleRowClick = useCallback(
    async (row: AppointmentRow) => {
      try {
        await ensureBookingActor("Termin ansehen");
      } catch {
        return;
      }
      setActiveId(row.id);
      setDrawerOpen(true);
    },
    [ensureBookingActor],
  );

  const handleRetry = () => {
    if (!activeId) return;
    refreshDetail();
  };

  const handleStatusChange = (value: AppointmentStatusFilter) => {
    const params = new URLSearchParams(searchParamsString);
    if (value === initialFilters.status) {
      params.delete("status");
    } else {
      params.set("status", value);
    }
    setDrawerOpen(false);
    setActiveId(null);
    router.push(constructUrl(pathname, params), { scroll: false });
  };

  const handleUpcomingRangeChange = (value: number) => {
    const params = new URLSearchParams(searchParamsString);
    if (value === initialFilters.upcomingRangeDays) {
      params.delete("upcomingRange");
    } else {
      params.set("upcomingRange", String(value));
    }
    router.push(constructUrl(pathname, params), { scroll: false });
  };

  const handlePastRangeChange = (value: number) => {
    const params = new URLSearchParams(searchParamsString);
    if (value === initialFilters.pastRangeDays) {
      params.delete("pastRange");
    } else {
      params.set("pastRange", String(value));
    }
    router.push(constructUrl(pathname, params), { scroll: false });
  };

  useEffect(() => {
    setSearchValue(currentQuery);
  }, [currentQuery]);

  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    const timeout = setTimeout(() => {
      const trimmed = searchValue.trim();
      const params = new URLSearchParams(searchParamsString);
      if (trimmed) {
        params.set("q", trimmed);
      } else {
        params.delete("q");
      }
      router.push(constructUrl(pathname, params), { scroll: false });
    }, 400);

    return () => clearTimeout(timeout);
  }, [searchValue, pathname, router, searchParamsString]);

  const tableSections = useMemo(
    () => [
      {
        id: "upcoming",
        title: `Bevorstehende Termine (nächste ${upcomingRange} Tage)`,
        rows: upcoming,
        emptyLabel: "Keine anstehenden Termine gefunden.",
      },
      {
        id: "recent",
        title: `Zuletzt stattgefunden (${pastRange} Tage)`,
        rows: recent,
        emptyLabel: "Keine vergangenen Termine.",
      },
    ],
    [upcoming, recent, upcomingRange, pastRange],
  );

  return (
    <>
      <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-1 flex-col gap-2">
            <label className="text-xs uppercase tracking-widest text-zinc-500">Suche</label>
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="Name, E-Mail, Code oder Service"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
              {searchValue.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSearchValue("")}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100"
                >
                  Zurücksetzen
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs uppercase tracking-widest text-zinc-500">Status</label>
            <select
              value={statusFilter}
              onChange={(event) => handleStatusChange(event.target.value as AppointmentStatusFilter)}
              className="w-56 rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2 lg:w-52">
            <span className="text-xs uppercase tracking-widest text-zinc-500">Zeitraum (bevorstehend)</span>
            <RangeSelector
              options={UPCOMING_RANGE_OPTIONS}
              value={upcomingRange}
              onChange={handleUpcomingRangeChange}
            />
          </div>

          <div className="flex flex-col gap-2 lg:w-52">
            <span className="text-xs uppercase tracking-widest text-zinc-500">Zeitraum (vergangen)</span>
            <RangeSelector options={PAST_RANGE_OPTIONS} value={pastRange} onChange={handlePastRangeChange} />
          </div>
        </div>

        <p className="mt-4 text-xs text-zinc-500">
          Filter wirken sich auf beide Tabellen aus. Status ohne Treffer werden ausgeblendet.
        </p>
      </section>

      {tableSections.map((section) => (
        <AppointmentsTable
          key={section.id}
          title={section.title}
          rows={section.rows}
          emptyLabel={section.emptyLabel}
          onSelect={handleRowClick}
          selectedId={activeId}
        />
      ))}

      <AppointmentDetailDrawer
        open={drawerOpen}
        onClose={handleClose}
        loading={loading}
        error={error}
        detail={detail}
        onRetry={handleRetry}
        locationSlug={locationSlug}
        onReload={refreshAll}
        onEdit={handleEdit}
        ensureBookingActor={ensureBookingActor}
      />

      <AppointmentEditDrawer
        open={Boolean(editTarget)}
        onClose={handleEditClose}
        target={editTarget}
        services={services}
        staffOptions={staffOptions}
        locationSlug={locationSlug}
        onSuccess={handleEditSuccess}
        ensureBookingActor={ensureBookingActor}
      />

      {bookingPinDialog}
    </>
  );
}

function AppointmentsTable({
  title,
  rows,
  emptyLabel = "Keine Daten",
  onSelect,
  selectedId,
}: {
  title: string;
  rows: AppointmentRow[];
  emptyLabel?: string;
  onSelect: (row: AppointmentRow) => void;
  selectedId?: string | null;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <header className="border-b border-zinc-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
      </header>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200 text-sm">
          <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-widest text-zinc-500">
            <tr>
              <th className="px-4 py-3">Datum</th>
              <th className="px-4 py-3">Kund:in</th>
              <th className="px-4 py-3">Service</th>
              <th className="px-4 py-3">Mitarbeiter:in</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Betrag</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white">
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-xs text-zinc-500" colSpan={6}>
                  {emptyLabel}
                </td>
              </tr>
            )}
            {rows.map((appointment) => {
              const isActive = appointment.id === selectedId;
              return (
                <tr
                  key={appointment.id}
                  onClick={() => onSelect(appointment)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(appointment);
                    }
                  }}
                  tabIndex={0}
                  className={`whitespace-nowrap transition ${
                    isActive ? "bg-zinc-50" : "hover:bg-zinc-50"
                  } cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70`}
                >
                  <td className="px-4 py-3 text-zinc-700">
                    {formatDateTime(appointment.startsAtIso)}
                  </td>
                  <td className="px-4 py-3 text-zinc-700">{appointment.customerName}</td>
                  <td className="px-4 py-3 text-zinc-700">{appointment.serviceName}</td>
                  <td className="px-4 py-3 text-zinc-700">{appointment.staffName}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest ${statusBadgeClass(
                        appointment.status,
                      )}`}
                    >
                      {statusLabel(appointment.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-zinc-700">
                    {formatCurrency(appointment.totalAmount, appointment.currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatDateTime(value: string) {
  return format(new Date(value), "dd.MM.yyyy · HH:mm", { locale: de });
}

function formatCurrency(value: number, currency: string) {
  const formatter = new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
  });
  return formatter.format(value);
}

function statusBadgeClass(status: string) {
  switch (status) {
    case "CONFIRMED":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "COMPLETED":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "CANCELLED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    case "NO_SHOW":
      return "bg-red-100 text-red-700 border-red-200";
    default:
      return "bg-amber-100 text-amber-700 border-amber-200";
  }
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

function normalizeStatus(value: string | null | undefined, fallback: AppointmentStatusFilter): AppointmentStatusFilter {
  if (!value) return fallback;
  const upper = value.toUpperCase() as AppointmentStatusFilter;
  return STATUS_OPTIONS.some((option) => option.value === upper) ? upper : fallback;
}

function normalizeRange(value: string | null | undefined, fallback: number, options: Array<{ value: number }>) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && options.some((option) => option.value === parsed) ? parsed : fallback;
}

function normalizeQuery(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  return value.slice(0, 120);
}

function constructUrl(pathname: string, params: URLSearchParams) {
  const query = params.toString();
  return query.length ? `${pathname}?${query}` : pathname;
}

function RangeSelector({
  options,
  value,
  onChange,
}: {
  options?: Array<{ value: number; label: string }>;
  value: number;
  onChange: (value: number) => void;
}) {
  if (!options?.length) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const isActive = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              isActive
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-300 text-zinc-600 hover:border-zinc-400 hover:text-zinc-800"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
