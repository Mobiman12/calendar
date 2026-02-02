"use client";

import { addMinutes, differenceInMinutes, format } from "date-fns";
import { de } from "date-fns/locale";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { useToast } from "@/components/ui/ToastProvider";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";
import { useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";

type StaffOption = {
  id: string;
  name: string;
  color: string;
};

type ServiceOption = {
  id: string;
  name: string;
  duration: number;
};

export type AppointmentEditTarget = {
  appointmentId: string;
  itemId: string;
  startsAt: Date;
  endsAt: Date;
  staffId?: string;
  serviceId?: string;
  note: string | null;
};

interface AppointmentEditDrawerProps {
  open: boolean;
  onClose: () => void;
  target: AppointmentEditTarget | null;
  services: ServiceOption[];
  staffOptions: StaffOption[];
  locationSlug: string;
  onSuccess: () => void;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
}

export function AppointmentEditDrawer({
  open,
  onClose,
  target,
  services,
  staffOptions,
  locationSlug,
  onSuccess,
  ensureBookingActor,
}: AppointmentEditDrawerProps) {
  const { pushToast } = useToast();
  const { actor, registerActivity, secondsRemaining } = useBookingPinSession();
  const activityRef = useRef(registerActivity);

  useEffect(() => {
    activityRef.current = registerActivity;
  }, [registerActivity]);

  const handleInteraction = useCallback(() => {
    activityRef.current();
  }, []);

  useEffect(() => {
    if (open) {
      registerActivity();
    }
  }, [open, registerActivity]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === "function") {
        active.blur();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (open && (!actor || secondsRemaining <= 0)) {
      onClose();
    }
  }, [actor, secondsRemaining, open, onClose]);
  const [startDateInput, setStartDateInput] = useState("");
  const [startTimeInput, setStartTimeInput] = useState("");
  const [endDateInput, setEndDateInput] = useState("");
  const [endTimeInput, setEndTimeInput] = useState("");
  const [selectedServiceId, setSelectedServiceId] = useState<string | undefined>(undefined);
  const [selectedStaffId, setSelectedStaffId] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const serviceMap = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const [initialDuration, setInitialDuration] = useState(30);
  const formatDateInput = useCallback((value: Date) => format(value, "yyyy-MM-dd", { locale: de }), []);
  const formatTimeInput = useCallback((value: Date) => format(value, "HH:mm", { locale: de }), []);

  useEffect(() => {
    if (!open || !target) return;
    const diff = Math.max(5, Math.abs(differenceInMinutes(target.endsAt, target.startsAt)) || 30);
    setInitialDuration(diff);
  }, [open, target]);

  const computeEffectiveDuration = useCallback(() => {
    const serviceDuration = selectedServiceId ? serviceMap.get(selectedServiceId)?.duration : undefined;
    if (serviceDuration && serviceDuration > 0) {
      return serviceDuration;
    }
    return initialDuration;
  }, [selectedServiceId, serviceMap, initialDuration]);

  const activeService = selectedServiceId ? serviceMap.get(selectedServiceId) : undefined;

  useEffect(() => {
    if (!open || !target) return;
    setError(null);
    setSaving(false);
    setSelectedServiceId(target.serviceId ?? services[0]?.id);
    setSelectedStaffId(target.staffId);
    setStartDateInput(formatDateInput(target.startsAt));
    setStartTimeInput(formatTimeInput(target.startsAt));
    setEndDateInput(formatDateInput(target.endsAt));
    setEndTimeInput(formatTimeInput(target.endsAt));
    setNote(target.note ?? "");
  }, [open, target, services, formatDateInput, formatTimeInput]);

  useEffect(() => {
    if (!open) return;
    const start = parseDateTime(startDateInput, startTimeInput);
    if (!start) return;
    const currentEnd = parseDateTime(endDateInput, endTimeInput);
    const desiredDuration = computeEffectiveDuration();
    if (!currentEnd) {
      const nextEnd = addMinutes(start, desiredDuration);
      setEndDateInput(formatDateInput(nextEnd));
      setEndTimeInput(formatTimeInput(nextEnd));
      return;
    }
    const diff = differenceInMinutes(currentEnd, start);
    if (Math.abs(diff - desiredDuration) <= 1) {
      const nextEnd = addMinutes(start, desiredDuration);
      setEndDateInput(formatDateInput(nextEnd));
      setEndTimeInput(formatTimeInput(nextEnd));
    }
  }, [open, startDateInput, startTimeInput, endDateInput, endTimeInput, computeEffectiveDuration, formatDateInput, formatTimeInput]);

  if (!open || !target) {
    return null;
  }

  const handleSubmit = async () => {
    if (saving) return;
    if (!startDateInput || !startTimeInput || !endDateInput || !endTimeInput) {
      setError("Bitte Start- und Endzeit auswählen.");
      return;
    }
    if (!selectedServiceId || !serviceMap.has(selectedServiceId)) {
      setError("Bitte eine Leistung auswählen.");
      return;
    }

    const start = parseDateTime(startDateInput, startTimeInput);
    if (!start) {
      setError("Ungültiges Datum oder Uhrzeit.");
      return;
    }
    const endValue = parseDateTime(endDateInput, endTimeInput);
    if (!endValue) {
      setError("Bitte gültige Endzeit wählen.");
      return;
    }
    const now = new Date();
    const originalStillActive = target.endsAt > now;
    if (!originalStillActive && start <= now) {
      setError("Termine können nur bearbeitet werden, solange sie nicht abgeschlossen sind.");
      return;
    }

    const fallbackDuration = Math.max(5, computeEffectiveDuration());
    const end = endValue <= start ? addMinutes(start, fallbackDuration) : endValue;

    setSaving(true);
    setError(null);

    let bookingActor: BookingActor;
    try {
      bookingActor = await ensureBookingActor();
    } catch {
      setError("Aktion abgebrochen.");
      return;
    }

    try {
      const response = await fetch(`/api/backoffice/${locationSlug}/appointments/${target.appointmentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: target.itemId,
          serviceId: selectedServiceId,
          staffId: selectedStaffId ?? null,
          note: note.trim() || null,
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          performedBy: {
            staffId: bookingActor.staffId,
            token: bookingActor.token,
          },
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Termin konnte nicht aktualisiert werden.");
      }

      pushToast({ variant: "success", message: "Termin aktualisiert." });
      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Termin konnte nicht aktualisiert werden.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (saving) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[1180] flex justify-end bg-black/25 backdrop-blur-sm"
      onPointerDownCapture={handleInteraction}
      onKeyDownCapture={handleInteraction}
    >
      <div className="relative flex h-full w-full max-w-3xl flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-400">Termin bearbeiten</p>
            <h2 className="text-2xl font-semibold text-zinc-900">
              {format(target.startsAt, "EEEE, dd.MM.yyyy", { locale: de })}
            </h2>
            <p className="text-xs text-zinc-500">
              {format(target.startsAt, "HH:mm", { locale: de })} – {format(target.endsAt, "HH:mm", { locale: de })}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-600"
            disabled={saving}
          >
            Schließen
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Startdatum</label>
              <input
                type="date"
                value={startDateInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setStartDateInput(value);
                  const newStart = parseDateTime(value, startTimeInput);
                  if (!newStart) {
                    return;
                  }
                  const currentEnd = parseDateTime(endDateInput, endTimeInput);
                  if (!currentEnd || currentEnd <= newStart) {
                    const nextEnd = addMinutes(newStart, computeEffectiveDuration());
                    setEndDateInput(formatDateInput(nextEnd));
                    setEndTimeInput(formatTimeInput(nextEnd));
                  }
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Startzeit</label>
              <input
                type="time"
                step={300}
                value={startTimeInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setStartTimeInput(value);
                  const newStart = parseDateTime(startDateInput, value);
                  if (!newStart) {
                    return;
                  }
                  const currentEnd = parseDateTime(endDateInput, endTimeInput);
                  if (!currentEnd || currentEnd <= newStart) {
                    const nextEnd = addMinutes(newStart, computeEffectiveDuration());
                    setEndDateInput(formatDateInput(nextEnd));
                    setEndTimeInput(formatTimeInput(nextEnd));
                  }
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Enddatum</label>
              <input
                type="date"
                value={endDateInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setEndDateInput(value);
                  const newEnd = parseDateTime(value, endTimeInput);
                  const start = parseDateTime(startDateInput, startTimeInput);
                  if (!newEnd || !start) {
                    return;
                  }
                  if (newEnd <= start) {
                    const nextEnd = addMinutes(start, computeEffectiveDuration());
                    setEndDateInput(formatDateInput(nextEnd));
                    setEndTimeInput(formatTimeInput(nextEnd));
                  }
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Endzeit</label>
              <input
                type="time"
                step={300}
                value={endTimeInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setEndTimeInput(value);
                  const newEnd = parseDateTime(endDateInput, value);
                  const start = parseDateTime(startDateInput, startTimeInput);
                  if (!newEnd || !start) {
                    return;
                  }
                  if (newEnd <= start) {
                    const nextEnd = addMinutes(start, computeEffectiveDuration());
                    setEndDateInput(formatDateInput(nextEnd));
                    setEndTimeInput(formatTimeInput(nextEnd));
                  }
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
          </div>

          <div className="mt-6 space-y-2">
            <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Leistung</label>
            <select
              value={selectedServiceId ?? ""}
              onChange={(event) => setSelectedServiceId(event.target.value || undefined)}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            >
              <option value="" disabled>
                Leistung auswählen
              </option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} · {service.duration} Min.
                </option>
              ))}
            </select>
          </div>

  <div className="mt-6 space-y-2">
            <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Mitarbeiter</label>
            <select
              value={selectedStaffId ?? ""}
              onChange={(event) => setSelectedStaffId(event.target.value || undefined)}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            >
              <option value="">Nicht definiert</option>
              {staffOptions.map((staff) => (
                <option key={staff.id} value={staff.id}>
                  {staff.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-6 space-y-2">
            <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Notiz</label>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              placeholder="Interne oder kundensichtbare Hinweise aktualisieren"
            />
          </div>

          {error && (
            <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          )}
        </div>

        <footer className="border-t border-zinc-200 px-6 py-4">
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
              disabled={saving}
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-600"
              disabled={saving}
            >
              {saving ? "Speichern…" : "Änderungen speichern"}
            </button>
          </div>
        </footer>
        {saving && (
          <div className="absolute inset-0 z-[1190] flex items-center justify-center rounded-l-3xl bg-white/75 backdrop-blur-[1px]">
            <div className="rounded-full bg-white/90 p-4 shadow-lg">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-700" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function parseDateTime(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const iso = `${date}T${time}:00`;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value;
}
