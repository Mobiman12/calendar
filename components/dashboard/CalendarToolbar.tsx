"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Filter, Clock, CalendarClock, Activity, Loader2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";

import { DatePicker } from "@/components/ui/DatePicker";

type ViewMode = "list" | "day" | "three" | "week";

type ActivityEntry = {
  id: string;
  summary: string;
  appointmentId?: string | null;
  appointmentStartsAt?: string | null;
  actorName: string | null;
  createdAt: string;
};

interface CalendarToolbarProps {
  locationSlug: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  weekLabel: string;
  rangeLabel: string;
  rangeStart: Date;
  rangeEnd: Date;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onDatePick: (date: Date) => void;
  dateValue: string;
  highlightedDates?: string[];
  filtersOpen: boolean;
  onToggleFilters: () => void;
  showAvailabilityOnly: boolean;
  onToggleAvailability: () => void;
  onOpenNextFreeDialog: () => void;
  activeFilterCount: number;
  onSelectActivity?: (payload: { appointmentId: string; startsAt: Date }) => void;
}

export function CalendarToolbar({
  locationSlug,
  viewMode,
  onViewModeChange,
  weekLabel,
  rangeLabel,
  rangeStart,
  rangeEnd,
  onToday,
  onPrev,
  onNext,
  onDatePick,
  dateValue,
  highlightedDates,
  filtersOpen,
  onToggleFilters,
  showAvailabilityOnly,
  onToggleAvailability,
  onOpenNextFreeDialog,
  activeFilterCount,
  onSelectActivity,
}: CalendarToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityEntries, setActivityEntries] = useState<ActivityEntry[]>([]);
  const anchorDate = useMemo(() => parseISO(dateValue), [dateValue]);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const activityRef = useRef<HTMLDivElement | null>(null);
  const activityTimeoutRef = useRef<number | null>(null);
  const displayLabel = useMemo(() => {
    const formatDay = (date: Date) =>
      `${format(date, "EEE", { locale: de }).replace(/\.$/, "")}, ${format(date, "dd.MM", { locale: de })}`;

    switch (viewMode) {
      case "day":
        return formatDay(anchorDate);
      case "three":
      case "week":
        return `${formatDay(rangeStart)} – ${formatDay(rangeEnd)}`;
      case "list":
      default:
        return rangeLabel;
    }
  }, [anchorDate, rangeEnd, rangeLabel, rangeStart, viewMode]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [pickerOpen]);

  useEffect(() => {
    if (!activityOpen) return;
    let cancelled = false;
    setActivityLoading(true);
    setActivityError(null);
    fetch(`/api/backoffice/${locationSlug}/activities?limit=20`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as { entries?: ActivityEntry[] };
      })
      .then((payload) => {
        if (cancelled) return;
        setActivityEntries(Array.isArray(payload.entries) ? payload.entries : []);
      })
      .catch(() => {
        if (cancelled) return;
        setActivityError("Aktivitäten konnten nicht geladen werden.");
      })
      .finally(() => {
        if (cancelled) return;
        setActivityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activityOpen, locationSlug]);

  useEffect(() => {
    if (!activityOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!activityRef.current) return;
      if (!activityRef.current.contains(event.target as Node)) {
        setActivityOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [activityOpen]);

  useEffect(() => {
    if (!activityOpen) {
      if (activityTimeoutRef.current) {
        window.clearTimeout(activityTimeoutRef.current);
        activityTimeoutRef.current = null;
      }
      return;
    }
    const scheduleClose = () => {
      if (activityTimeoutRef.current) {
        window.clearTimeout(activityTimeoutRef.current);
      }
      activityTimeoutRef.current = window.setTimeout(() => {
        setActivityOpen(false);
      }, 10000);
    };
    const handleActivity = () => scheduleClose();
    scheduleClose();
    window.addEventListener("mousemove", handleActivity);
    window.addEventListener("keydown", handleActivity);
    window.addEventListener("mousedown", handleActivity);
    window.addEventListener("touchstart", handleActivity);
    window.addEventListener("scroll", handleActivity, true);
    return () => {
      if (activityTimeoutRef.current) {
        window.clearTimeout(activityTimeoutRef.current);
        activityTimeoutRef.current = null;
      }
      window.removeEventListener("mousemove", handleActivity);
      window.removeEventListener("keydown", handleActivity);
      window.removeEventListener("mousedown", handleActivity);
      window.removeEventListener("touchstart", handleActivity);
      window.removeEventListener("scroll", handleActivity, true);
    };
  }, [activityOpen]);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-4">
          <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{weekLabel}</span>
          <div className="flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-1 py-1 text-sm">
            <button
              type="button"
              onClick={onToday}
              className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium uppercase tracking-wide text-white shadow-sm transition hover:bg-zinc-700"
            >
              Heute
            </button>
            <div className="flex items-center">
              <button
                type="button"
                onClick={onPrev}
                className="rounded-l-full border border-zinc-200 px-3 py-1 text-zinc-600 transition hover:bg-zinc-100"
                aria-label="Zurück"
              >
                ‹
              </button>
              <div className="relative z-[120]" ref={popoverRef}>
                <button
                  type="button"
                  onClick={() => setPickerOpen((prev) => !prev)}
                  className="border-y border-zinc-200 px-4 py-1 text-sm font-semibold uppercase tracking-wide text-zinc-700 hover:bg-zinc-100"
                >
                  {displayLabel}
                </button>
                {pickerOpen && (
                  <div className="absolute left-1/2 z-[130] mt-2 w-max -translate-x-1/2">
                    <DatePicker
                      value={anchorDate}
                      onChange={(date) => {
                        onDatePick(date);
                        setPickerOpen(false);
                      }}
                      onMonthChange={(date) => {
                        onDatePick(date);
                      }}
                      highlightedDates={highlightedDates}
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={onNext}
                className="rounded-r-full border border-zinc-200 px-3 py-1 text-zinc-600 transition hover:bg-zinc-100"
                aria-label="Weiter"
              >
                ›
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-1 justify-center">
          <div className="flex overflow-hidden rounded-full border border-zinc-200 bg-white text-sm font-medium text-zinc-600">
            {[
              { key: "list" as const, label: "Liste" },
              { key: "day" as const, label: "Tag" },
              { key: "three" as const, label: "3 Tage" },
              { key: "week" as const, label: "Woche" },
            ].map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => onViewModeChange(entry.key)}
                className={`px-4 py-2 transition ${
                  viewMode === entry.key ? "bg-zinc-900 text-white" : "hover:bg-zinc-100"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleAvailability}
            aria-pressed={showAvailabilityOnly}
            className={`inline-flex items-center gap-2 rounded-full border p-2 text-sm font-medium transition ${
              showAvailabilityOnly
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 text-zinc-700 hover:bg-zinc-100"
            }`}
            title="Nur verfügbare Zeiten anzeigen"
          >
            <CalendarClock className="h-4 w-4" />
            <span className="sr-only">Verfügbarkeit filtern</span>
          </button>
          <button
            type="button"
            onClick={onOpenNextFreeDialog}
            className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white p-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
            title="Nächste freie Termine finden"
          >
            <Clock className="h-4 w-4" />
            <span className="sr-only">Nächste freie Termine finden</span>
          </button>
          <div className="relative z-[120]" ref={activityRef}>
            <button
              type="button"
              onClick={() => setActivityOpen((prev) => !prev)}
              className={`inline-flex items-center gap-2 rounded-full border p-2 text-sm font-medium transition ${
                activityOpen
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 text-zinc-700 hover:bg-zinc-100"
              }`}
              title="Letzte Aktivitäten"
            >
              <Activity className="h-4 w-4" />
              <span className="sr-only">Letzte Aktivitäten</span>
            </button>
            {activityOpen && (
              <div className="absolute right-0 z-[130] mt-2 w-80 rounded-xl border border-zinc-200 bg-white p-4 text-sm shadow-lg">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                    Letzte Aktivitäten
                  </span>
                  {activityLoading && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
                </div>
                {activityError ? (
                  <p className="text-sm text-rose-600">{activityError}</p>
                ) : activityEntries.length ? (
                  <div className="max-h-80 space-y-3 overflow-auto pr-1">
                    {activityEntries.map((entry) => {
                      const canJump = Boolean(entry.appointmentId && entry.appointmentStartsAt);
                      const content = (
                        <>
                          <p className="text-sm font-medium text-zinc-900">{entry.summary}</p>
                          <p className="text-xs text-zinc-500">
                            {entry.actorName ?? "System"} · {format(parseISO(entry.createdAt), "dd.MM.yyyy HH:mm")}
                          </p>
                        </>
                      );
                      if (!canJump || !onSelectActivity) {
                        return (
                          <div key={entry.id} className="border-b border-zinc-100 pb-3 last:border-b-0 last:pb-0">
                            {content}
                          </div>
                        );
                      }
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => {
                            if (!entry.appointmentId || !entry.appointmentStartsAt) return;
                            onSelectActivity({
                              appointmentId: entry.appointmentId,
                              startsAt: parseISO(entry.appointmentStartsAt),
                            });
                            setActivityOpen(false);
                          }}
                          className="w-full rounded-lg border border-zinc-100 px-2 py-2 text-left transition hover:border-zinc-200 hover:bg-zinc-50"
                          title="Zum Termin springen"
                        >
                          {content}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500">Noch keine Aktivitäten erfasst.</p>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onToggleFilters}
            className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${
              filtersOpen ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            <Filter className="h-4 w-4" />
            {activeFilterCount > 0 && (
              <span
                className={`inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold ${
                  filtersOpen ? "bg-white text-zinc-900" : "bg-zinc-900 text-white"
                }`}
              >
                {activeFilterCount}
              </span>
            )}
            Filtern
          </button>
        </div>
      </div>
    </div>
  );
}
