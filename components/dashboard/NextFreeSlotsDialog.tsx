"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, differenceInMinutes } from "date-fns";
import { CalendarClock, CalendarDays, Loader2, X } from "lucide-react";

import { formatDateTimeLocalInput, formatInTimeZone, parseDateTimeLocalInput } from "@/lib/timezone";

type StaffOption = {
  id: string;
  name: string;
  color: string;
};

type ServiceOption = {
  id: string;
  name: string;
};

type AvailabilitySlot = {
  slotKey: string;
  staffId: string;
  start: string;
  end: string;
  services?: Array<{
    serviceId: string;
  }>;
};

type NormalizedSlot = {
  slotKey: string;
  staffId: string;
  start: Date;
  end: Date;
  serviceId: string | null;
};

type SearchFilters = {
  serviceId: string;
  staffId: string;
  startInput: string;
};

const SEARCH_WINDOW_DAYS = 14;

type NextFreeSlotsDialogProps = {
  open: boolean;
  onClose: () => void;
  timezone: string;
  locationSlug: string;
  services: ServiceOption[];
  staffOptions: StaffOption[];
  activeStaffIds?: string[];
};

export function NextFreeSlotsDialog({
  open,
  onClose,
  timezone,
  locationSlug,
  services,
  staffOptions,
  activeStaffIds,
}: NextFreeSlotsDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>(() => ({
    serviceId: services[0]?.id ?? "",
    staffId: activeStaffIds?.[0] ?? "",
    startInput: formatDateTimeLocalInput(new Date(), timezone),
  }));
  const [results, setResults] = useState<NormalizedSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setMounted(true);
    return () => {
      setMounted(false);
    };
  }, []);

  const serviceMap = useMemo(() => new Map(services.map((service) => [service.id, service.name])), [services]);
  const staffMap = useMemo(() => new Map(staffOptions.map((staff) => [staff.id, staff])), [staffOptions]);
  const suggestedStaffId = activeStaffIds?.[0] ?? "";
  const defaultServiceId = services[0]?.id ?? "";

  const performSearch = useCallback(
    async (inputFilters: SearchFilters) => {
      if (!inputFilters.serviceId) {
        setError("Bitte wähle eine Leistung aus, um freie Termine zu finden.");
        setResults([]);
        return;
      }
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const from = parseDateTimeLocalInput(inputFilters.startInput, timezone);
        const to = addDays(from, SEARCH_WINDOW_DAYS);
        const params = new URLSearchParams({
          from: from.toISOString(),
          to: to.toISOString(),
          services: inputFilters.serviceId,
          granularity: "15",
        });
        if (inputFilters.staffId && inputFilters.staffId !== "unassigned") {
          params.set("staffId", inputFilters.staffId);
        }
        const response = await fetch(`/book/${locationSlug}/availability?${params.toString()}`, {
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Die nächsten freien Termine konnten nicht geladen werden.");
        }
        const slots = Array.isArray(payload?.data) ? (payload.data as AvailabilitySlot[]) : [];
        const normalized = slots
          .map<NormalizedSlot>((slot) => ({
            slotKey: slot.slotKey,
            staffId: slot.staffId,
            start: new Date(slot.start),
            end: new Date(slot.end),
            serviceId: slot.services?.[0]?.serviceId ?? inputFilters.serviceId ?? null,
          }))
          .sort((a, b) => a.start.getTime() - b.start.getTime());
        setResults(normalized);
        if (!normalized.length) {
          setError("Im ausgewählten Zeitraum wurden keine freien Termine gefunden.");
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setResults([]);
        setError(error instanceof Error ? error.message : "Unbekannter Fehler bei der Verfügbarkeitsabfrage.");
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        setLoading(false);
      }
    },
    [locationSlug, timezone],
  );

  useEffect(() => {
    if (!open) return;
    const initialFilters: SearchFilters = {
      serviceId: defaultServiceId,
      staffId: suggestedStaffId,
      startInput: formatDateTimeLocalInput(new Date(), timezone),
    };
    setFilters(initialFilters);
    setResults([]);
    setError(null);
    if (initialFilters.serviceId) {
      void performSearch(initialFilters);
    }
  }, [open, defaultServiceId, suggestedStaffId, timezone, performSearch]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    }
  }, [open]);

  if (!mounted || !open) {
    return null;
  }

  const selectedServiceName = serviceMap.get(filters.serviceId) ?? "Leistung";
  const searchStart = filters.startInput ? parseDateTimeLocalInput(filters.startInput, timezone) : new Date();
  const topResult = results[0] ?? null;
  const remainingResults = results.slice(1, 6);

  return createPortal(
    <div className="fixed inset-0 z-[2200] flex items-center justify-center bg-black/40 px-4 py-6 backdrop-blur-sm">
      <div className="relative flex w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-zinc-100 px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-emerald-500">Verfügbarkeit</p>
            <h2 className="text-xl font-semibold text-zinc-900">Nächste freie Termine</h2>
            <p className="text-sm text-zinc-500">
              Finde verfügbare Slots nach Leistung, Zeitraum und gewünschten Mitarbeitern.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-zinc-200 p-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Schließen"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-6 px-6 py-5 md:grid-cols-[1.2fr_0.8fr]">
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void performSearch(filters);
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm text-zinc-700">
                <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Ab Zeitpunkt</span>
                <input
                  type="datetime-local"
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  value={filters.startInput}
                  onChange={(event) =>
                    setFilters((previous) => ({ ...previous, startInput: event.target.value || previous.startInput }))
                  }
                  max="2100-12-31T23:59"
                />
              </label>
              <label className="space-y-1.5 text-sm text-zinc-700">
                <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Leistung</span>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  value={filters.serviceId}
                  onChange={(event) => setFilters((previous) => ({ ...previous, serviceId: event.target.value }))}
                >
                  {services.length === 0 && <option value="">Keine Leistungen verfügbar</option>}
                  {services.map((service) => (
                    <option value={service.id} key={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="space-y-1.5 text-sm text-zinc-700">
              <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Mitarbeiter</span>
              <select
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                value={filters.staffId}
                onChange={(event) => setFilters((previous) => ({ ...previous, staffId: event.target.value }))}
              >
                <option value="">Alle verfügbaren Mitarbeiter</option>
                {staffOptions.map((staff) => (
                  <option key={staff.id} value={staff.id}>
                    {staff.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              disabled={loading || !filters.serviceId}
            >
              <CalendarClock className="h-4 w-4" />
              {loading ? "Suche läuft …" : "Freie Termine suchen"}
            </button>

            {error && <p className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}
          </form>

          <div className="space-y-4 rounded-2xl border border-zinc-100 bg-zinc-50/80 p-4">
            {loading ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
                Verfügbare Termine werden ermittelt …
              </div>
            ) : topResult ? (
              <>
                <div className="rounded-2xl border border-emerald-100 bg-white/80 p-4 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-widest text-emerald-500">Frühester Treffer</p>
                  <p className="mt-1 text-lg font-semibold text-zinc-900">
                    {formatInTimeZone(topResult.start, timezone, {
                      weekday: "long",
                      day: "2-digit",
                      month: "2-digit",
                      year: "numeric",
                    })}
                  </p>
                  <p className="text-sm text-zinc-600">
                    {formatInTimeZone(topResult.start, timezone, { hour: "2-digit", minute: "2-digit", hour12: false })} –{" "}
                    {formatInTimeZone(topResult.end, timezone, { hour: "2-digit", minute: "2-digit", hour12: false })},{" "}
                    {differenceInMinutes(topResult.end, topResult.start)} Minuten
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <span
                      className="inline-flex h-2 w-2 rounded-full"
                      style={{ backgroundColor: staffMap.get(topResult.staffId)?.color ?? "#d4d4d8" }}
                    />
                    <span className="text-sm text-zinc-700">{staffMap.get(topResult.staffId)?.name ?? "Team"}</span>
                  </div>
                  <p className="mt-2 text-xs uppercase tracking-widest text-zinc-500">{selectedServiceName}</p>
                </div>
                {remainingResults.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Weitere Optionen</p>
                    <div className="space-y-2">
                      {remainingResults.map((slot) => (
                        <div
                          key={slot.slotKey}
                          className="flex items-center justify-between rounded-xl border border-white/60 bg-white px-3 py-2 text-sm shadow-sm"
                        >
                          <div>
                            <p className="font-medium text-zinc-800">
                              {formatInTimeZone(slot.start, timezone, {
                                weekday: "short",
                                day: "2-digit",
                                month: "2-digit",
                              })}{" "}
                              ·{" "}
                              {formatInTimeZone(slot.start, timezone, {
                                hour: "2-digit",
                                minute: "2-digit",
                                hour12: false,
                              })}
                            </p>
                            <p className="text-xs text-zinc-500">
                              {differenceInMinutes(slot.end, slot.start)} Min ·{" "}
                              {serviceMap.get(slot.serviceId ?? "") ?? selectedServiceName}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-zinc-600">
                            <span
                              className="inline-flex h-2 w-2 rounded-full"
                              style={{ backgroundColor: staffMap.get(slot.staffId)?.color ?? "#d4d4d8" }}
                            />
                            {staffMap.get(slot.staffId)?.name ?? "Team"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-zinc-500">
                <CalendarDays className="h-6 w-6 text-zinc-400" />
                <p>Keine freien Termine ausgewählt. Wähle eine Leistung aus und starte die Suche.</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50 px-6 py-3 text-xs text-zinc-500">
          <span>
            Suchzeitraum: {SEARCH_WINDOW_DAYS} Tage ab{" "}
            {formatInTimeZone(searchStart, timezone, {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
            })}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-sm font-medium text-zinc-700 transition hover:bg-white"
          >
            <X className="h-3 w-3" />
            Schließen
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
