"use client";

import { format, isSameDay } from "date-fns";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CalendarAppointmentRecord } from "./CalendarDaysView";
import type { AppointmentStatus } from "@prisma/client";

type StaffIndex = Map<string, { id: string; name: string; color: string }>;

const STATUS_META: Record<AppointmentStatus, { label: string }> = {
  PENDING: { label: "Offen" },
  CONFIRMED: { label: "Bestätigt" },
  COMPLETED: { label: "Abgeschlossen" },
  CANCELLED: { label: "Storniert" },
  NO_SHOW: { label: "Nicht erschienen" },
};

const TOOLTIP_OPEN_DELAY_MS = 120;
const TOOLTIP_CLOSE_DELAY_MS = 120;

function usePointerFine() {
  const [pointerFine, setPointerFine] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(pointer: fine)");
    const update = () => setPointerFine(media.matches);
    update();
    if (media.addEventListener) {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return pointerFine;
}

interface CalendarListViewProps {
  days: Date[];
  appointments: CalendarAppointmentRecord[];
  staffIndex: StaffIndex;
  onSelectAppointment?: (payload: { appointmentId: string; itemId?: string }) => void;
}

export function CalendarListView({ days, appointments, staffIndex, onSelectAppointment }: CalendarListViewProps) {
  const pointerFine = usePointerFine();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const openTooltipTimerRef = useRef<number | null>(null);
  const closeTooltipTimerRef = useRef<number | null>(null);
  const [tooltipState, setTooltipState] = useState<{
    appointment: CalendarAppointmentRecord;
    rect: DOMRect;
  } | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const scheduleTooltipOpen = useCallback(
    (appointment: CalendarAppointmentRecord, rect: DOMRect) => {
      if (!pointerFine) return;
      if (closeTooltipTimerRef.current) {
        window.clearTimeout(closeTooltipTimerRef.current);
        closeTooltipTimerRef.current = null;
      }
      if (openTooltipTimerRef.current) {
        window.clearTimeout(openTooltipTimerRef.current);
        openTooltipTimerRef.current = null;
      }
      openTooltipTimerRef.current = window.setTimeout(() => {
        setTooltipState({ appointment, rect });
      }, TOOLTIP_OPEN_DELAY_MS);
    },
    [pointerFine],
  );

  const scheduleTooltipClose = useCallback(() => {
    if (!pointerFine) return;
    if (openTooltipTimerRef.current) {
      window.clearTimeout(openTooltipTimerRef.current);
      openTooltipTimerRef.current = null;
    }
    if (closeTooltipTimerRef.current) {
      window.clearTimeout(closeTooltipTimerRef.current);
      closeTooltipTimerRef.current = null;
    }
    closeTooltipTimerRef.current = window.setTimeout(() => {
      setTooltipState(null);
    }, TOOLTIP_CLOSE_DELAY_MS);
  }, [pointerFine]);

  const holdTooltipOpen = useCallback(() => {
    if (!pointerFine) return;
    if (closeTooltipTimerRef.current) {
      window.clearTimeout(closeTooltipTimerRef.current);
      closeTooltipTimerRef.current = null;
    }
  }, [pointerFine]);

  useEffect(() => {
    return () => {
      if (openTooltipTimerRef.current) {
        window.clearTimeout(openTooltipTimerRef.current);
      }
      if (closeTooltipTimerRef.current) {
        window.clearTimeout(closeTooltipTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltipState || !pointerFine) return;
    const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
    const tooltipWidth = tooltipRef.current?.offsetWidth ?? 0;
    if (!tooltipHeight || !tooltipWidth) return;
    const rect = tooltipState.rect;
    const margin = 12;
    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;
    const shouldPreferLeft = spaceRight < tooltipWidth && spaceLeft > spaceRight;
    const baseLeft = shouldPreferLeft ? rect.left - tooltipWidth - 12 : rect.right + 12;
    const clampedLeft = Math.max(margin, Math.min(baseLeft, window.innerWidth - tooltipWidth - margin));
    const idealTop = rect.top + rect.height / 2 - tooltipHeight / 2;
    const clampedTop = Math.max(margin, Math.min(idealTop, window.innerHeight - tooltipHeight - margin));
    setTooltipPosition({ top: clampedTop, left: clampedLeft });
  }, [tooltipState, pointerFine]);

  useEffect(() => {
    if (!tooltipState || !pointerFine) return;
    const handleResize = () => {
      const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
      const tooltipWidth = tooltipRef.current?.offsetWidth ?? 0;
      if (!tooltipHeight || !tooltipWidth) return;
      const rect = tooltipState.rect;
      const margin = 12;
      const spaceRight = window.innerWidth - rect.right;
      const spaceLeft = rect.left;
      const shouldPreferLeft = spaceRight < tooltipWidth && spaceLeft > spaceRight;
      const baseLeft = shouldPreferLeft ? rect.left - tooltipWidth - 12 : rect.right + 12;
      const clampedLeft = Math.max(margin, Math.min(baseLeft, window.innerWidth - tooltipWidth - margin));
      const idealTop = rect.top + rect.height / 2 - tooltipHeight / 2;
      const clampedTop = Math.max(margin, Math.min(idealTop, window.innerHeight - tooltipHeight - margin));
      setTooltipPosition({ top: clampedTop, left: clampedLeft });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [tooltipState, pointerFine]);

  return (
    <section className="space-y-4">
      {days.map((day) => {
        const dayAppointments = appointments
          .filter((appointment) => isSameDay(appointment.startsAt, day))
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

        if (!dayAppointments.length) {
          return null;
        }

        return (
          <div key={day.toISOString()} className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
            <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-sm font-semibold text-zinc-700">
              <span className="uppercase tracking-wide text-zinc-500">
                {format(day, "EEE, dd.MM.yyyy")}
              </span>
              <span className="text-xs text-zinc-400">{format(day, "MMMM yyyy")}</span>
            </header>
            <ul className="divide-y divide-zinc-100">
              {dayAppointments.map((appointment) => {
                const staff = appointment.staffId ? staffIndex.get(appointment.staffId) : undefined;
                const timeLabel = `${format(appointment.startsAt, "HH:mm")} – ${format(appointment.endsAt, "HH:mm")}`;
                return (
                  <li
                    key={appointment.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectAppointment?.({ appointmentId: appointment.appointmentId, itemId: appointment.id })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectAppointment?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
                      }
                    }}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-zinc-700 transition hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/70"
                    onPointerEnter={(event) => scheduleTooltipOpen(appointment, event.currentTarget.getBoundingClientRect())}
                    onPointerLeave={scheduleTooltipClose}
                    onFocus={(event) => scheduleTooltipOpen(appointment, event.currentTarget.getBoundingClientRect())}
                    onBlur={scheduleTooltipClose}
                  >
                    <span className="basis-32 font-medium text-zinc-900">{timeLabel}</span>
                    <span className="flex-1 min-w-[180px] font-semibold text-zinc-900">{appointment.displayLabel}</span>
                    <span className="flex min-w-[200px] flex-col gap-0.5 text-zinc-600">
                      {appointment.note && <span className="text-xs text-zinc-500">{appointment.note}</span>}
                      {appointment.hasService && appointment.displayLabel !== appointment.serviceName && (
                        <span>{appointment.serviceName}</span>
                      )}
                    </span>
                    <span className="text-xs uppercase tracking-wide text-zinc-400">{staff ? staff.name : "Nicht definiert"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {typeof document !== "undefined" && pointerFine && tooltipState &&
        (() => {
          const { appointment } = tooltipState;
          const staff = appointment.staffId ? staffIndex.get(appointment.staffId) : undefined;
          const timeLabel = `${format(appointment.startsAt, "HH:mm")} – ${format(appointment.endsAt, "HH:mm")}`;
          const statusMeta = STATUS_META[appointment.status] ?? STATUS_META.PENDING;
          const headerLabel = `${statusMeta.label} (${timeLabel})`;
          const customerName = appointment.customerName?.trim() || appointment.displayLabel || "Kunde";
          const customerPhone = appointment.customerPhone?.trim() || "";
          const serviceLabel = appointment.serviceName?.trim() || appointment.displayLabel || "Service";
          const isOnlineBooking = Boolean(appointment.isOnline);
          const bookingSourceLabel = isOnlineBooking ? "Online gebucht" : "Manuell gebucht";
          const staffName = staff?.name ?? "Nicht definiert";
          const staffInitial = staffName.trim().charAt(0).toUpperCase() || "•";
          const staffSelectionLabel = isOnlineBooking
            ? "Vom Kunden ausgewählt"
            : staff
              ? "Vom Team ausgewählt"
              : "Nicht zugewiesen";

          return createPortal(
            <div
              ref={tooltipRef}
              className="pointer-events-auto fixed z-[2147483640] w-72 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-zinc-200 bg-white text-left text-xs text-zinc-700 shadow-xl"
              style={{ top: `${tooltipPosition.top}px`, left: `${tooltipPosition.left}px` }}
              onPointerEnter={holdTooltipOpen}
              onPointerLeave={scheduleTooltipClose}
            >
              <div className="h-3 w-full bg-emerald-200" />
              <div className="flex items-center justify-between gap-3 px-4 pt-3">
                <p className="text-sm font-semibold text-zinc-900">{headerLabel}</p>
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-zinc-200 text-zinc-500">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <rect x="4.5" y="6.5" width="15" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M4.5 10.5H19.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M8 4.5V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M16 4.5V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </span>
              </div>
              <div className="px-4 pb-4 pt-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-200 text-zinc-500">
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
                      <path
                        d="M5 19c1.6-3.2 4.1-4.8 7-4.8s5.4 1.6 7 4.8"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">{customerName}</p>
                    {customerPhone && <p className="text-xs text-zinc-500">{customerPhone}</p>}
                  </div>
                </div>
                <div className="mt-3 space-y-3">
                  <div className="flex items-start gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                      <svg
                        className="h-4 w-4"
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                      >
                        <rect x="4" y="5" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M8 19h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">{serviceLabel}</p>
                      <p className="text-xs text-zinc-500">{bookingSourceLabel}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-100 text-[12px] font-semibold text-sky-700">
                      {staffInitial}
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">{staffName}</p>
                      <p className="text-xs text-zinc-500">{staffSelectionLabel}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          );
        })()}
    </section>
  );
}
