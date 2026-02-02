"use client";

import { addMinutes, format, startOfDay } from "date-fns";
import { de } from "date-fns/locale";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Loader2 } from "lucide-react";

import type { BookingActor } from "@/components/dashboard/booking-pin-types";
import { useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";
import { useToast } from "@/components/ui/ToastProvider";

type StaffOption = {
  id: string;
  name: string;
  color: string;
};

export type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER";

const TIME_BLOCKER_LABEL_VARIANTS: Record<TimeBlockerReason, string[]> = {
  BREAK: ["Zeitblocker · Pause", "Pause"],
  MEAL: ["Zeitblocker · Mittagessen", "Mittagessen"],
  VACATION: ["Zeitblocker · Urlaub", "Urlaub"],
  SICK: ["Zeitblocker · Krankmeldung", "Krankmeldung"],
  PRIVATE: ["Zeitblocker · Privater Termin", "Privater Termin"],
  OTHER: ["Zeitblocker", "Anderer Grund"],
};

const TIME_BLOCKER_OPTIONS: Array<{ value: TimeBlockerReason; label: string }> = [
  { value: "BREAK", label: TIME_BLOCKER_LABEL_VARIANTS.BREAK[1] },
  { value: "MEAL", label: TIME_BLOCKER_LABEL_VARIANTS.MEAL[1] },
  { value: "VACATION", label: TIME_BLOCKER_LABEL_VARIANTS.VACATION[1] },
  { value: "SICK", label: TIME_BLOCKER_LABEL_VARIANTS.SICK[1] },
  { value: "PRIVATE", label: TIME_BLOCKER_LABEL_VARIANTS.PRIVATE[1] },
  { value: "OTHER", label: TIME_BLOCKER_LABEL_VARIANTS.OTHER[1] },
];

const TIME_BLOCKER_REASON_VALUES: ReadonlyArray<TimeBlockerReason> = ["BREAK", "VACATION", "SICK", "MEAL", "PRIVATE", "OTHER"];

const isTimeBlockerReason = (value: unknown): value is TimeBlockerReason =>
  typeof value === "string" && TIME_BLOCKER_REASON_VALUES.includes(value as TimeBlockerReason);

const PRIMARY_TIME_BLOCKER_LABEL: Record<TimeBlockerReason, string> = {
  BREAK: TIME_BLOCKER_LABEL_VARIANTS.BREAK[0],
  MEAL: TIME_BLOCKER_LABEL_VARIANTS.MEAL[0],
  VACATION: TIME_BLOCKER_LABEL_VARIANTS.VACATION[0],
  SICK: TIME_BLOCKER_LABEL_VARIANTS.SICK[0],
  PRIVATE: TIME_BLOCKER_LABEL_VARIANTS.PRIVATE[0],
  OTHER: TIME_BLOCKER_LABEL_VARIANTS.OTHER[0],
};

const SLOT_MINUTES = 30;

const inferReasonTypeFromLabel = (label: string | null | undefined): TimeBlockerReason | null => {
  if (!label) return null;
  const normalized = label.trim().toLowerCase();
  for (const [reasonKey, variants] of Object.entries(TIME_BLOCKER_LABEL_VARIANTS) as Array<[TimeBlockerReason, string[]]>) {
    for (const variant of variants) {
      const candidate = variant.toLowerCase();
      if (normalized === candidate || normalized.includes(candidate)) {
        return reasonKey;
      }
    }
  }
  if (normalized.startsWith("zeitblocker")) {
    return "OTHER";
  }
  return null;
};

const computeReasonDisplay = (reason: TimeBlockerReason, customReason?: string | null) => {
  if (reason === "OTHER") {
    const trimmed = customReason?.trim() ?? "";
    return trimmed.length ? `${PRIMARY_TIME_BLOCKER_LABEL.OTHER}: ${trimmed}` : PRIMARY_TIME_BLOCKER_LABEL.OTHER;
  }
  return PRIMARY_TIME_BLOCKER_LABEL[reason];
};

const toInputValue = (value: Date) => format(value, "yyyy-MM-dd'T'HH:mm");

const parseInputValue = (value: string, fallback: Date) => {
  if (!value) return fallback;
  const next = new Date(value);
  if (Number.isNaN(next.getTime())) {
    return fallback;
  }
  return next;
};

const isAllDayRange = (start: Date, end: Date) => {
  const duration = end.getTime() - start.getTime();
  const minutes = Math.round(duration / 60000);
  return minutes >= 24 * 60 && start.getHours() === 0 && start.getMinutes() === 0;
};

export type TimeBlockerDetailUpdatePayload = {
  blocker: {
    id: string;
    staffId: string | null;
    reason: string | null;
    reasonType: TimeBlockerReason | null;
    customReason: string | null;
    allStaff: boolean;
    startsAt: Date;
    endsAt: Date;
  };
  staff?: StaffOption;
};

interface TimeBlockerDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  blocker: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    reason: string | null;
    staffId?: string | null;
    reasonType?: TimeBlockerReason | null;
    customReason?: string | null;
    allStaff?: boolean;
  } | null;
  staff?: StaffOption | null;
  staffOptions: StaffOption[];
  locationName: string;
  locationSlug: string;
  timezone: string;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
  onUpdated: (payload: TimeBlockerDetailUpdatePayload) => void;
  onDeleted: (blockerId: string) => void;
}

export function TimeBlockerDetailDrawer({
  open,
  onClose,
  blocker,
  staff,
  staffOptions,
  locationName,
  locationSlug,
  timezone,
  ensureBookingActor,
  onUpdated,
  onDeleted,
}: TimeBlockerDetailDrawerProps) {
  const { pushToast } = useToast();
  const { actor, registerActivity, secondsRemaining } = useBookingPinSession();
  const staffIndex = useMemo(() => new Map(staffOptions.map((entry) => [entry.id, entry])), [staffOptions]);
  const previousRangeRef = useRef<{ start: Date; end: Date } | null>(null);

  const [allStaff, setAllStaff] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [reason, setReason] = useState<TimeBlockerReason>("BREAK");
  const [customReason, setCustomReason] = useState("");
  const [start, setStart] = useState(() => new Date());
  const [end, setEnd] = useState(() => addMinutes(new Date(), SLOT_MINUTES));
  const [allDay, setAllDay] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleWrapperClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget && !saving && !deleteLoading) {
        onClose();
      }
    },
    [onClose, saving, deleteLoading],
  );

  const handleInteraction = useCallback(() => {
    registerActivity();
  }, [registerActivity]);

  const resetForm = useCallback(() => {
    if (!blocker) return;
    const nextReason = blocker.reasonType ?? inferReasonTypeFromLabel(blocker.reason) ?? "OTHER";
    setAllStaff(blocker.allStaff ?? false);
    setSelectedStaffId(blocker.staffId ?? null);
    setReason(nextReason);
    setCustomReason(blocker.customReason ?? "");
    setStart(blocker.startsAt);
    setEnd(blocker.endsAt);
    setAllDay(isAllDayRange(blocker.startsAt, blocker.endsAt));
    previousRangeRef.current = null;
    setSaveError(null);
    setDeleteError(null);
  }, [blocker]);

  const lastBlockerSnapshotRef = useRef<{
    id: string;
    updatedAt: number;
    reasonType: TimeBlockerReason | null;
    customReason: string | null;
    allStaff: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open || !blocker) {
      lastBlockerSnapshotRef.current = null;
      return;
    }
    const snapshot = {
      id: blocker.id,
      updatedAt: blocker.endsAt.getTime() ^ blocker.startsAt.getTime(),
      reasonType: blocker.reasonType ?? null,
      customReason: blocker.customReason ?? null,
      allStaff: blocker.allStaff ?? false,
    };
    const prev = lastBlockerSnapshotRef.current;
    const unchanged =
      prev &&
      prev.id === snapshot.id &&
      prev.reasonType === snapshot.reasonType &&
      prev.customReason === snapshot.customReason &&
      prev.allStaff === snapshot.allStaff &&
      prev.updatedAt === snapshot.updatedAt;
    if (!unchanged) {
      lastBlockerSnapshotRef.current = snapshot;
      resetForm();
    }
  }, [open, blocker, resetForm]);

  useEffect(() => {
    if (open) {
      registerActivity();
    }
  }, [open, registerActivity]);

  useEffect(() => {
    if (open && (!actor || secondsRemaining <= 0)) {
      onClose();
    }
  }, [open, actor, secondsRemaining, onClose]);

  const selectableStaff = useMemo(
    () => staffOptions.filter((option) => option.id !== "unassigned"),
    [staffOptions],
  );

  const selectedStaff = useMemo(() => {
    if (!blocker || allStaff) return null;
    if (selectedStaffId) {
      return staffIndex.get(selectedStaffId) ?? null;
    }
    if (blocker.staffId) {
      return staffIndex.get(blocker.staffId) ?? staff ?? null;
    }
    return staff ?? null;
  }, [blocker, allStaff, selectedStaffId, staffIndex, staff]);

  const staffName = useMemo(() => {
    if (allStaff) return "Alle Mitarbeitenden";
    return selectedStaff?.name ?? "Nicht definiert";
  }, [allStaff, selectedStaff]);

  if (!open || !blocker) {
    return null;
  }

  const startLabel = format(blocker.startsAt, "EEEE, dd.MM.yyyy", { locale: de });
  const timeLabel = `${format(blocker.startsAt, "HH:mm", { locale: de })} – ${format(blocker.endsAt, "HH:mm", {
    locale: de,
  })}`;
  const reasonLabel = TIME_BLOCKER_OPTIONS.find((option) => option.value === reason)?.label ?? null;
  const detailBody =
    reason === "OTHER" ? customReason.trim() || blocker.reason || "Kein Grund hinterlegt." : reasonLabel || "Kein Grund hinterlegt.";
  const staffColor = allStaff ? "#6b7280" : selectedStaff?.color ?? "#9ca3af";
  const staffInitial = allStaff ? "∗" : (staffName.trim().charAt(0) || "•").toUpperCase();

  const busy = saving || deleteLoading;

  const handleAllDayToggle = (checked: boolean) => {
    handleInteraction();
    setAllDay(checked);
    if (checked) {
      previousRangeRef.current = { start, end };
      const normalized = startOfDay(start);
      setStart(normalized);
      setEnd(addMinutes(normalized, 24 * 60));
    } else if (previousRangeRef.current) {
      setStart(previousRangeRef.current.start);
      setEnd(previousRangeRef.current.end);
      previousRangeRef.current = null;
    }
  };

  const handleSave = async () => {
    if (saving) return;
    if (!blocker) return;
    handleInteraction();
    if (!allStaff && !selectedStaffId && selectableStaff.length > 0) {
      // allow "Nicht definiert" by leaving selectedStaffId null, so no error.
      // nothing to do
    }
    if (!allDay && start >= end) {
      setSaveError("Endzeitpunkt muss nach dem Start liegen.");
      return;
    }
    let actor: BookingActor;
    try {
      actor = await ensureBookingActor("Zeitblocker speichern");
    } catch {
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/backoffice/${locationSlug}/time-blockers/${blocker.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: start.toISOString(),
          end: end.toISOString(),
          allDay,
          allStaff,
          staffIds: allStaff ? [] : selectedStaffId ? [selectedStaffId] : [],
          reason,
          customReason: reason === "OTHER" ? customReason.trim() || null : undefined,
          performedBy: {
            staffId: actor.staffId,
            token: actor.token,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Zeitblocker konnte nicht aktualisiert werden.");
      }

      const detail = payload?.data as
        | {
            id: string;
            staffId: string | null;
            startsAt: string;
            endsAt: string;
            reason: string | null;
            metadata: Record<string, unknown> | null;
          }
        | undefined;

      const reasonString = computeReasonDisplay(reason, customReason);
      const fallbackStaff = allStaff ? undefined : selectedStaffId ? staffIndex.get(selectedStaffId) ?? undefined : undefined;

      let updated: TimeBlockerDetailUpdatePayload;
      if (detail) {
        const metadata = detail.metadata ?? {};
        const detailReasonType =
          (isTimeBlockerReason(metadata?.type) ? metadata.type : null) ?? inferReasonTypeFromLabel(detail.reason) ?? null;
        const detailCustomReasonRaw = metadata?.customReason;
        const detailCustomReason =
          detailReasonType === "OTHER"
            ? typeof detailCustomReasonRaw === "string"
              ? detailCustomReasonRaw
              : detailCustomReasonRaw === null
              ? null
              : customReason.trim() || null
            : null;

        updated = {
          blocker: {
            id: detail.id,
            staffId: detail.staffId ?? null,
            reason: typeof detail.reason === "string" ? detail.reason : reasonString,
            reasonType: detailReasonType,
            customReason: detailCustomReason,
            allStaff: Boolean(metadata?.allStaff) || detail.staffId === null,
            startsAt: new Date(detail.startsAt),
            endsAt: new Date(detail.endsAt),
          },
          staff:
            Boolean(metadata?.allStaff) || detail.staffId === null
              ? undefined
              : staffIndex.get(detail.staffId ?? "") ?? fallbackStaff,
        };
      } else {
        updated = {
          blocker: {
            id: blocker.id,
            staffId: allStaff ? null : selectedStaffId ?? null,
            reason: reasonString,
            reasonType: reason,
            customReason: reason === "OTHER" ? customReason.trim() || null : null,
            allStaff,
            startsAt: start,
            endsAt: end,
          },
          staff: fallbackStaff,
        };
      }

      onUpdated(updated);
      setDeleteError(null);
      const nextReasonState =
        updated.blocker.reasonType ?? inferReasonTypeFromLabel(updated.blocker.reason ?? null) ?? reason;
      setReason(nextReasonState);
      setCustomReason(updated.blocker.customReason ?? "");
      setAllStaff(updated.blocker.allStaff);
      setSelectedStaffId(updated.blocker.staffId ?? null);
      setStart(updated.blocker.startsAt);
      setEnd(updated.blocker.endsAt);
      setAllDay(isAllDayRange(updated.blocker.startsAt, updated.blocker.endsAt));
      pushToast({ variant: "success", message: "Zeitblocker aktualisiert." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zeitblocker konnte nicht aktualisiert werden.";
      setSaveError(message);
      pushToast({ variant: "error", message });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (deleteLoading) return;
    if (!blocker) return;
    handleInteraction();
    let actor: BookingActor;
    try {
      actor = await ensureBookingActor("Zeitblocker löschen");
    } catch {
      return;
    }
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/backoffice/${locationSlug}/time-blockers/${blocker.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          performedBy: {
            staffId: actor.staffId,
            token: actor.token,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Zeitblocker konnte nicht gelöscht werden.");
      }
      pushToast({ variant: "success", message: "Zeitblocker gelöscht." });
      onDeleted(blocker.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zeitblocker konnte nicht gelöscht werden.";
      setDeleteError(message);
      pushToast({ variant: "error", message });
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1300] flex justify-end bg-black/40" onClick={handleWrapperClick} role="presentation">
      <div className="relative flex h-full w-full max-w-md flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-400">
              Zeitblocker{reasonLabel ? ` · ${reasonLabel}` : ""}
            </p>
            <h2 className="text-2xl font-semibold text-zinc-900">{startLabel}</h2>
            <p className="text-sm text-zinc-500">
              {timeLabel} · {timezone}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSave}
                className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
                disabled={busy}
              >
                {saving ? "Speichert …" : "Speichern"}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleConfirmDelete();
                }}
                className="rounded-full border border-rose-200 px-3 py-1 text-sm text-rose-600 transition hover:bg-rose-50"
                disabled={busy}
              >
                {deleteLoading ? "Löscht …" : "Entfernen"}
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-zinc-300 px-3 py-1 text-sm text-zinc-600 transition hover:bg-zinc-100"
              disabled={busy}
            >
              Schließen
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="space-y-6">
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Mitarbeiter:in</h3>
              <div className="flex items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-full text-lg font-semibold text-white"
                  style={{ backgroundColor: staffColor }}
                >
                  {staffInitial}
                </span>
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-zinc-900">{staffName}</span>
                  <span className="text-xs text-zinc-500">Standort: {locationName}</span>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Gilt für</h3>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={allStaff}
                  onChange={(event) => {
                    handleInteraction();
                    const checked = event.target.checked;
                    setAllStaff(checked);
                    if (checked) {
                      setSelectedStaffId(null);
                    }
                  }}
                  className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                  disabled={busy}
                />
                Alle Mitarbeiter
              </label>
              {!allStaff && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      handleInteraction();
                      setSelectedStaffId(null);
                    }}
                    className={`rounded-full border px-3 py-1 text-sm transition ${
                      selectedStaffId === null
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                    }`}
                    disabled={busy}
                  >
                    Nicht definiert
                  </button>
                  {selectableStaff.map((option) => {
                    const selected = selectedStaffId === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => {
                          handleInteraction();
                          setSelectedStaffId(option.id);
                        }}
                        className={`rounded-full border px-3 py-1 text-sm transition ${
                          selected
                            ? "border-zinc-900 bg-zinc-900 text-white"
                            : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        }`}
                        disabled={busy}
                      >
                        {option.name}
                      </button>
                    );
                  })}
                  {selectableStaff.length === 0 && (
                    <p className="text-xs text-zinc-500">Keine Mitarbeitenden verfügbar.</p>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Grund</h3>
              <select
                value={reason}
                onChange={(event) => {
                  handleInteraction();
                  setReason(event.target.value as TimeBlockerReason);
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                disabled={busy}
              >
                {TIME_BLOCKER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {reason === "OTHER" && (
                <input
                  type="text"
                  value={customReason}
                  onChange={(event) => {
                    handleInteraction();
                    setCustomReason(event.target.value);
                  }}
                  placeholder="Grund angeben"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  maxLength={120}
                  disabled={busy}
                />
              )}
              <p className="text-xs text-zinc-500">
                Aktueller Grund: <span className="font-medium text-zinc-700">{detailBody}</span>
              </p>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-zinc-900">Zeitraum</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Start</label>
                  <input
                    type="datetime-local"
                    value={toInputValue(start)}
                    onChange={(event) => {
                      handleInteraction();
                      setStart(parseInputValue(event.target.value, start));
                    }}
                    className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    disabled={busy || allDay}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Ende</label>
                  <input
                    type="datetime-local"
                    value={toInputValue(end)}
                    onChange={(event) => {
                      handleInteraction();
                      setEnd(parseInputValue(event.target.value, end));
                    }}
                    className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    disabled={busy || allDay}
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(event) => handleAllDayToggle(event.target.checked)}
                  className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                  disabled={busy}
                />
                Ganzer Tag
              </label>
              <p className="text-xs text-zinc-500">
                Zeitblocker werden im Kalender als reservierte Slots angezeigt. Bei „Anderer Grund“ erscheint der eingegebene Text direkt im Slot.
              </p>
            </section>
            {saveError && (
              <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{saveError}</p>
            )}
          </div>

          {deleteError && (
            <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">{deleteError}</div>
          )}
        </div>
        {busy && (
          <div className="absolute inset-0 z-[1310] flex items-center justify-center rounded-l-3xl bg-white/75 backdrop-blur-[1px]">
            <div className="rounded-full bg-white/90 p-4 shadow-lg">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-700" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
