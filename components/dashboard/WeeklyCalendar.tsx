"use client";

import { addDays, addMinutes, differenceInMinutes, format, isSameDay } from "date-fns";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { useToast } from "@/components/ui/ToastProvider";
import { combineDateWithMinutesInTimeZone } from "@/lib/timezone";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";
import { AppointmentComposerDrawer } from "@/components/dashboard/AppointmentComposerDrawer";
import { getReadableTextColor, toRgba } from "@/lib/color";
import type { AppointmentStatus } from "@prisma/client";

type StaffColumn = {
  id: string;
  name: string;
  color: string;
};

type AppointmentBlock = {
  id: string;
  appointmentId: string;
  staffId?: string;
  startsAt: Date;
  endsAt: Date;
  serviceName: string;
  confirmationCode: string;
  customerName: string;
  displayLabel: string;
  hasCustomer: boolean;
  hasService: boolean;
  timeLabel: string;
  status: AppointmentStatus;
  note: string | null;
  isColorRequest?: boolean;
};

type TimeBlockerBlock = {
  id: string;
  staffId?: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  reasonType?: TimeBlockerReason | null;
  customReason?: string | null;
  allStaff: boolean;
};

type AppointmentPlacement = {
  appointment: AppointmentBlock;
  laneIndex: number;
  laneCount: number;
};

type BlockerPlacement = {
  blocker: TimeBlockerBlock;
  laneIndex: number;
  laneCount: number;
};

function CancelledCalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="6.5"
        width="14"
        height="13.5"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M5 10.5H19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9 4V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M15 4V7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7.25 19.25L16.75 9.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

type StaffDayEntry =
  | { type: "appointment"; appointment: AppointmentBlock; start: Date; end: Date }
  | { type: "blocker"; blocker: TimeBlockerBlock; start: Date; end: Date };

function layoutStaffDayEvents(
  day: Date,
  appointments: AppointmentBlock[],
  blockers: TimeBlockerBlock[],
): { appointmentPlacements: AppointmentPlacement[]; blockerPlacements: BlockerPlacement[] } {
  const dayStart = setTime(day, START_HOUR);
  const dayEnd = addMinutes(dayStart, TOTAL_MINUTES);

  const entries: StaffDayEntry[] = [];

  for (const appointment of appointments) {
    const start = appointment.startsAt > dayStart ? appointment.startsAt : dayStart;
    const end = appointment.endsAt < dayEnd ? appointment.endsAt : dayEnd;
    if (end <= start) continue;
    entries.push({ type: "appointment", appointment, start, end });
  }

  for (const blocker of blockers) {
    const start = blocker.startsAt > dayStart ? blocker.startsAt : dayStart;
    const end = blocker.endsAt < dayEnd ? blocker.endsAt : dayEnd;
    if (end <= start) continue;
    entries.push({ type: "blocker", blocker, start, end });
  }

  entries.sort((a, b) => {
    const diff = a.start.getTime() - b.start.getTime();
    if (diff !== 0) return diff;
    return a.end.getTime() - b.end.getTime();
  });

  const laneEnds: Date[] = [];
  const laneAssignments: Array<{ entry: StaffDayEntry; laneIndex: number }> = [];

  for (const entry of entries) {
    let laneIndex = laneEnds.findIndex((laneEnd) => entry.start >= laneEnd);
    if (laneIndex === -1) {
      laneIndex = laneEnds.length;
      laneEnds.push(entry.end);
    } else {
      laneEnds[laneIndex] = entry.end;
    }
    laneAssignments.push({ entry, laneIndex });
  }

  const laneCount = laneEnds.length || 1;
  const appointmentPlacements: AppointmentPlacement[] = [];
  const blockerPlacements: BlockerPlacement[] = [];

  for (const assignment of laneAssignments) {
    const { entry, laneIndex } = assignment;
    if (entry.type === "appointment") {
      appointmentPlacements.push({ appointment: entry.appointment, laneIndex, laneCount });
    } else {
      blockerPlacements.push({ blocker: entry.blocker, laneIndex, laneCount });
    }
  }

  return { appointmentPlacements, blockerPlacements };
}

interface WeeklyCalendarProps {
  location: {
    id: string;
    name: string;
    timezone: string;
  };
  locationSlug: string;
  weekStart: Date;
  staff: StaffColumn[];
  showUnassigned?: boolean;
  appointments: AppointmentBlock[];
  blockers?: TimeBlockerBlock[];
  services: Array<{
    id: string;
    name: string;
    duration: number;
    basePrice: number;
    currency: string;
  }>;
  resources: Array<{
    id: string;
    name: string;
    type: string;
    color?: string | null;
  }>;
  customers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    appointmentCount: number;
    lastAppointment: string | null;
    lastAppointmentStatus: string | null;
    consents: {
      email: boolean;
      sms: boolean;
      whatsapp: boolean;
    };
  }>;
  availability?: Record<string, Record<string, Array<{ start: number; end: number }>>>;
  visibleDays?: Date[];
  displayRange?: { start: number; end: number } | null;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
  onOpenAppointment?: (payload: { appointmentId: string; itemId?: string }) => void;
  onOpenBlocker?: (payload: { blocker: TimeBlockerBlock; staff?: StaffColumn }) => void;
  onAppointmentUpdated?: () => void;
  viewportHeight?: string;
}

const START_HOUR = 0;
const END_HOUR = 24;
const SLOT_MINUTES = 30;
const SLOT_PIXEL_HEIGHT = 32;
const MIN_APPOINTMENT_MINUTES = 5;
const PIXELS_PER_MINUTE = SLOT_PIXEL_HEIGHT / SLOT_MINUTES;
const TOTAL_MINUTES = (END_HOUR - START_HOUR) * 60;
const DRAG_DELAY_MS = 500;

const minutesToPixels = (value: number) => value * PIXELS_PER_MINUTE;
const pixelsToMinutes = (value: number) => value / PIXELS_PER_MINUTE;
const STATUS_META: Record<
  AppointmentStatus,
  { label: string; badgeClass: string }
> = {
  PENDING: { label: "Offen", badgeClass: "bg-amber-100 text-amber-700 border-amber-200" },
  CONFIRMED: { label: "Bestätigt", badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  COMPLETED: { label: "Abgeschlossen", badgeClass: "bg-sky-100 text-sky-700 border-sky-200" },
  CANCELLED: { label: "Storniert", badgeClass: "bg-rose-100 text-rose-700 border-rose-200" },
  NO_SHOW: { label: "Nicht erschienen", badgeClass: "bg-zinc-200 text-zinc-600 border-zinc-300" },
};

type DragState = {
  itemId: string;
  appointmentId: string;
  staffId: string;
  initialStaffId: string;
  day: Date;
  originalStart: Date;
  originalEnd: Date;
  pointerStartY: number;
  previewStart: Date;
  previewEnd: Date;
};

type PendingDragState = {
  pointerId: number;
  timeoutId: number;
  state: DragState;
  cancel: () => void;
};

export function WeeklyCalendar({
  location,
  locationSlug,
  weekStart,
  staff,
  showUnassigned = true,
  appointments,
  blockers = [],
  services,
  resources,
  customers,
  availability,
  visibleDays,
  displayRange,
  ensureBookingActor,
  onOpenAppointment,
  onOpenBlocker,
  onAppointmentUpdated,
  viewportHeight,
}: WeeklyCalendarProps) {
  const router = useRouter();

  const days = useMemo(() => {
    if (visibleDays && visibleDays.length) {
      return visibleDays.map((day) => new Date(day));
    }
    return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  }, [visibleDays, weekStart]);

  const isMultiDayView = days.length > 1;
  const displayStart = displayRange?.start ?? 0;
  const displayEnd = displayRange?.end ?? TOTAL_MINUTES;
  const displayTotalMinutes = Math.max(SLOT_MINUTES, displayEnd - displayStart);
  const slots = useMemo(
    () => Array.from({ length: displayTotalMinutes / SLOT_MINUTES }, (_, index) => displayStart + index * SLOT_MINUTES),
    [displayStart, displayTotalMinutes],
  );


  const staffColumns = useMemo(() => {
    const unassignedColumn: StaffColumn = {
      id: "unassigned",
      name: "Nicht definiert",
      color: "#9ca3af",
    };
    if (showUnassigned) {
      return staff.length ? [unassignedColumn, ...staff] : [unassignedColumn];
    }
    return staff;
  }, [staff, showUnassigned]);

  const columnRefs = useRef(new Map<string, HTMLDivElement>());

  const [records, setRecords] = useState<AppointmentBlock[]>(appointments);
  const [blockerRecords, setBlockerRecords] = useState<TimeBlockerBlock[]>(blockers);
  useEffect(() => {
    setRecords(appointments);
  }, [appointments]);
  useEffect(() => {
    setBlockerRecords(blockers);
  }, [blockers]);

  const [dragState, setDragState] = useState<DragState | null>(null);
  const pendingDragRef = useRef<PendingDragState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { pushToast } = useToast();
  const [composer, setComposer] = useState<{ start: Date; staffId?: string } | null>(null);
  const clickSuppressedRef = useRef(false);
  const blurActiveElement = useCallback(() => {
    if (typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === "function") {
      active.blur();
    }
    if (typeof window !== "undefined") {
      const selection = window.getSelection();
      if (selection && selection.type !== "None") {
        selection.removeAllRanges();
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      pendingDragRef.current?.cancel();
    };
  }, []);

  const appointmentsByStaff = useMemo(() => {
    const map = new Map<string, AppointmentBlock[]>();
    for (const staffMember of staffColumns) {
      map.set(staffMember.id, []);
    }

    for (const appointment of records) {
      const fallbackKey =
        appointment.staffId && staffColumns.some((column) => column.id === appointment.staffId)
          ? appointment.staffId
          : "unassigned";
      const key = fallbackKey ?? "unassigned";
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)?.push(appointment);
    }
    return map;
  }, [records, staffColumns]);

  const blockersByStaff = useMemo(() => {
    const map = new Map<string, TimeBlockerBlock[]>();
    if (!map.has("unassigned")) {
      map.set("unassigned", []);
    }
    for (const staffMember of staffColumns) {
      if (!map.has(staffMember.id)) {
        map.set(staffMember.id, []);
      }
    }
    for (const blocker of blockerRecords) {
      const preferredKey = blocker.staffId ?? "unassigned";
      const key = map.has(preferredKey) ? preferredKey : "unassigned";
      map.get(key)?.push(blocker);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    }
    return map;
  }, [blockerRecords, staffColumns]);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      setDragState((state) => {
        if (!state) return state;

        const deltaY = event.clientY - state.pointerStartY;
        const rawDeltaMinutes = Math.round(pixelsToMinutes(deltaY));
        const baseDayStart = setTime(state.day, START_HOUR);
        const originalStartMinutes = differenceInMinutes(state.originalStart, baseDayStart);
        const targetMinutes = originalStartMinutes + rawDeltaMinutes;
        const snappedMinutes = Math.round(targetMinutes / SLOT_MINUTES) * SLOT_MINUTES;
        const duration = differenceInMinutes(state.originalEnd, state.originalStart);
        const minStartMinute = displayStart;
        const maxStartMinute = Math.max(displayStart, displayEnd - duration);
        const clampedStartMinute = Math.max(minStartMinute, Math.min(maxStartMinute, snappedMinutes));
        const clampedStart = addMinutes(baseDayStart, clampedStartMinute);
        const clampedEnd = addMinutes(clampedStart, duration);

        let targetStaffId = state.staffId;
        for (const [id, element] of columnRefs.current.entries()) {
          if (!element) continue;
          const rect = element.getBoundingClientRect();
          if (event.clientX >= rect.left && event.clientX <= rect.right) {
            targetStaffId = id;
            break;
          }
        }

        return {
          ...state,
          previewStart: clampedStart,
          previewEnd: clampedEnd,
          staffId: targetStaffId,
        };
      });
    },
    [displayEnd, displayStart],
  );

  const handlePointerUp = useCallback(() => {
    setDragState((state) => {
      if (!state) return null;
      const duration = differenceInMinutes(state.originalEnd, state.originalStart);
      const itemId = state.itemId;
      const appointmentId = state.appointmentId;
      const staffId = state.staffId === "unassigned" ? undefined : state.staffId;
      const newStart = state.previewStart;
      const newEnd = state.previewEnd;
      const delta = differenceInMinutes(newStart, state.originalStart);
      const staffChanged = state.staffId !== state.initialStaffId;
      const moved = delta !== 0 || staffChanged;

      if (!moved) {
        clickSuppressedRef.current = true;
        const payload = { appointmentId, itemId: state.itemId };
        if (onOpenAppointment) {
          onOpenAppointment(payload);
        }
        setTimeout(() => {
          clickSuppressedRef.current = false;
        }, 0);
        return null;
      }

      const dayKey = format(state.day, "yyyy-MM-dd");
      const ranges = getAvailabilityRanges(availability, state.staffId, dayKey);
      const startMinutes = differenceInMinutes(newStart, setTime(state.day, START_HOUR));
      const endMinutes = startMinutes + duration;
      const isAvailable =
        state.staffId === "unassigned" ||
        ranges.some((range) => startMinutes >= range.start && endMinutes <= range.end);
      if (!isAvailable) {
        pushToast({ variant: "info", message: "Außerhalb der Verfügbarkeit – Termin wird trotzdem verschoben." });
      }

      clickSuppressedRef.current = true;
      (async () => {
        try {
          const actor = await ensureBookingActor();
          const response = await fetch(`/api/appointment-items/${itemId}/reschedule`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              startsAt: newStart.toISOString(),
              staffId,
              performedBy: {
                staffId: actor.staffId,
                token: actor.token,
              },
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload?.error ?? "Reschedule fehlgeschlagen.");
          }

          const updatedItems: Array<{ id: string; startsAt: string; endsAt: string; staffId: string | null }> =
            payload?.data?.items ?? [];

          setRecords((current) =>
            current.map((record) => {
              if (record.appointmentId !== appointmentId) {
                return record;
              }
              const match = updatedItems.find((item) => item.id === record.id);
              if (!match) {
                return {
                  ...record,
                  staffId,
                  startsAt: addMinutes(record.startsAt, delta),
                  endsAt: addMinutes(record.endsAt, delta),
                };
              }
              return {
                ...record,
                staffId: match.staffId ?? undefined,
                startsAt: new Date(match.startsAt),
                endsAt: new Date(match.endsAt),
              };
            })
          );
          setError(null);
          pushToast({ variant: "success", message: "Termin aktualisiert." });
          onAppointmentUpdated?.();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Reschedule fehlgeschlagen.";
          setError(message);
          pushToast({ variant: "error", message });
        } finally {
          clickSuppressedRef.current = false;
        }
      })().catch(() => null);
      return null;
    });
  }, [availability, ensureBookingActor, onAppointmentUpdated, onOpenAppointment, pushToast]);

  useEffect(() => {
    if (!dragState) return undefined;
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp, { once: true });
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragState, handlePointerMove, handlePointerUp]);

  const scrollStyle = viewportHeight ? { maxHeight: viewportHeight } : undefined;

  return (
    <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="flex overflow-y-auto" style={scrollStyle}>
            <div
              className="flex-none border-r border-zinc-200 bg-white"
              style={{ width: "4.5rem" }}
            >
              <div className="sticky top-0 z-20 h-12 border-b border-zinc-200 bg-white" />
              <div className="relative bg-white" style={{ height: `${minutesToPixels(displayTotalMinutes)}px` }}>
                {slots.map((minute) => {
                  const hour = Math.floor(minute / 60) % 24;
                  const mins = minute % 60;
                  const label = mins === 0 ? `${hour.toString().padStart(2, "0")}:00` : "";
                  return (
                    <div
                      key={minute}
                      className={`relative flex items-start px-3 pt-0 text-xs text-zinc-500 ${
                        mins === 0 ? "font-medium text-zinc-700" : ""
                      }`}
                      style={{ height: `${minutesToPixels(SLOT_MINUTES)}px` }}
                    >
                      {label && (
                        <span className="absolute -top-2 left-3 leading-none">
                          {label}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="relative flex flex-1">
              <div className="pointer-events-none absolute left-0 right-0 top-12 z-10 h-[2px] bg-zinc-300" />
              {staffColumns.map((staffMember, staffIndex) => (
                <div
                  key={staffMember.id}
                  className={`flex-1 border-l border-zinc-200 first:border-l-0 ${
                    dragState?.staffId === staffMember.id ? "bg-zinc-50" : ""
                  }`}
                  ref={(element) => {
                    if (element) {
                      columnRefs.current.set(staffMember.id, element);
                    } else {
                      columnRefs.current.delete(staffMember.id);
                    }
                  }}
                >
                  <div className="sticky top-0 z-20 bg-white">
                    <ColumnHeader
                      name={staffMember.name}
                      color={staffMember.id === "unassigned" ? null : staffMember.color}
                    />
                  </div>
                  {days.map((day) => {
                    const appointmentsForDay = (appointmentsByStaff.get(staffMember.id) ?? []).filter((appointment) =>
                      isSameDay(day, appointment.startsAt),
                    );
                    const blockersForDay = (blockersByStaff.get(staffMember.id) ?? []).filter((blocker) =>
                      blockerOverlapsDay(blocker, day),
                    );
                    const layout = layoutStaffDayEvents(day, appointmentsForDay, blockersForDay);

                    return (
                      <div
                        key={`${staffMember.id}-${day.toISOString()}`}
                        className="relative border-b border-zinc-200 bg-[#f9fafc]"
                        style={{ height: `${minutesToPixels(displayTotalMinutes)}px` }}
                        onClick={async (event) => {
                          const target = event.target as HTMLElement;
                          const blockingCard = target.closest<HTMLElement>("[data-appointment-card]");
                          if (blockingCard && blockingCard.dataset.blocksAvailability !== "false") {
                            return;
                          }
                          const blockerCard = target.closest<HTMLElement>("[data-blocker-card]");
                          if (blockerCard) {
                            return;
                          }
                          const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                          const offsetY = event.clientY - rect.top;
                          const rawMinutes = Math.floor(pixelsToMinutes(offsetY));
                          const snapped = Math.floor(rawMinutes / SLOT_MINUTES) * SLOT_MINUTES;
                          const offsetMinutes = Math.max(0, Math.min(displayTotalMinutes - SLOT_MINUTES, snapped));
                          const absoluteMinutes = displayStart + offsetMinutes;
                          const dayKey = format(day, "yyyy-MM-dd");
                          const ranges = getAvailabilityRanges(availability, staffMember.id, dayKey);
                          const slotEnd = absoluteMinutes + SLOT_MINUTES;
                          const isAvailable =
                            staffMember.id === "unassigned" ||
                            ranges.some((range) => absoluteMinutes >= range.start && slotEnd <= range.end);
                          if (!isAvailable) {
                            pushToast({
                              variant: "info",
                              message: "Außerhalb der Verfügbarkeit – Termin kann dennoch erstellt werden.",
                            });
                          }
                          const start = combineDateWithMinutesInTimeZone(day, absoluteMinutes, location.timezone);
                          try {
                            await ensureBookingActor();
                          } catch {
                            return;
                          }
                          setComposer({
                            start,
                            staffId: staffMember.id === "unassigned" ? undefined : staffMember.id,
                          });
                        }}
                      >
                      <div className="pointer-events-none absolute inset-0 z-0 bg-[repeating-linear-gradient(135deg,rgba(180,188,199,0.3)_0px,rgba(180,188,199,0.3)_5.5px,rgba(249,250,252,0.96)_5.5px,rgba(249,250,252,0.96)_12px)]" />
                      {(() => {
                        const dayKey = format(day, "yyyy-MM-dd");
                        const merged = getAvailabilityRanges(availability, staffMember.id, dayKey);
                        return merged
                          .map((range) => clampRange(range, displayStart, displayEnd))
                          .filter((range): range is { start: number; end: number } => Boolean(range))
                          .map((range, index) => (
                            <div
                              key={`${dayKey}-${staffMember.id}-avail-${index}`}
                              className="pointer-events-none absolute left-0 right-0 z-10 bg-white calendar-free-slot"
                              style={{
                                backgroundColor: "#ffffff",
                                top: `${minutesToPixels(range.start - displayStart)}px`,
                                height: `${minutesToPixels(range.end - range.start)}px`,
                              }}
                            />
                          ));
                      })()}
                      <div className="pointer-events-none absolute inset-0 z-20">
                        {slots.map((minute) => (
                          <div
                            key={`${day.toISOString()}-${minute}`}
                            className={minute % 60 === 0 ? "border-t border-zinc-200" : "border-t border-zinc-100"}
                            style={{ height: `${minutesToPixels(SLOT_MINUTES)}px` }}
                          />
                        ))}
                        <div className="absolute bottom-0 left-0 right-0 border-b border-zinc-200" />
                      </div>
                        <div className="relative z-30">
                          {layout.blockerPlacements.map(({ blocker, laneIndex, laneCount }) => (
                            <BlockerCard
                              key={blocker.id}
                              blocker={blocker}
                              day={day}
                              displayStart={displayStart}
                              displayTotalMinutes={displayTotalMinutes}
                              staff={staffMember.id === "unassigned" ? undefined : staffMember}
                              onOpen={onOpenBlocker}
                              laneIndex={laneIndex}
                              laneCount={laneCount}
                              preferLeftTooltip={staffIndex === staffColumns.length - 1}
                            />
                          ))}
                          {layout.appointmentPlacements.map(({ appointment, laneIndex, laneCount }) => (
                            <AppointmentCard
                              key={appointment.id}
                              appointment={appointment}
                              staffColor={staffMember.color}
                              day={day}
                              isDragging={dragState?.itemId === appointment.id}
                              preview={
                                dragState?.itemId === appointment.id
                                  ? { start: dragState.previewStart, end: dragState.previewEnd }
                                  : null
                              }
                              displayStart={displayStart}
                              displayTotalMinutes={displayTotalMinutes}
                              onPointerDown={(event) => {
                                if (event.button !== 0 || dragState || pendingDragRef.current) {
                                  return;
                                }
                                const pointerId = event.pointerId;
                                const state: DragState = {
                                  itemId: appointment.id,
                                  appointmentId: appointment.appointmentId,
                                  staffId: staffMember.id,
                                  initialStaffId: staffMember.id,
                                  day,
                                  originalStart: appointment.startsAt,
                                  originalEnd: appointment.endsAt,
                                  pointerStartY: event.clientY,
                                  previewStart: appointment.startsAt,
                                  previewEnd: appointment.endsAt,
                                };

                                function handlePendingPointerEnd(endEvent: PointerEvent) {
                                  if (endEvent.pointerId !== pointerId) {
                                    return;
                                  }
                                  const pending = pendingDragRef.current;
                                  if (!pending || pending.pointerId !== pointerId) {
                                    return;
                                  }
                                  window.clearTimeout(pending.timeoutId);
                                  window.removeEventListener("pointerup", handlePendingPointerEnd);
                                  window.removeEventListener("pointercancel", handlePendingPointerEnd);
                                  pendingDragRef.current = null;
                                }

                                const timeoutId = window.setTimeout(() => {
                                  const pending = pendingDragRef.current;
                                  if (!pending || pending.pointerId !== pointerId) {
                                    return;
                                  }
                                  window.removeEventListener("pointerup", handlePendingPointerEnd);
                                  window.removeEventListener("pointercancel", handlePendingPointerEnd);
                                  pendingDragRef.current = null;
                                  setDragState(pending.state);
                                }, DRAG_DELAY_MS);

                                pendingDragRef.current = {
                                  pointerId,
                                  timeoutId,
                                  state,
                                  cancel: () => {
                                    const pending = pendingDragRef.current;
                                    if (!pending || pending.pointerId !== pointerId) {
                                      return;
                                    }
                                    window.clearTimeout(pending.timeoutId);
                                    window.removeEventListener("pointerup", handlePendingPointerEnd);
                                    window.removeEventListener("pointercancel", handlePendingPointerEnd);
                                    pendingDragRef.current = null;
                                  },
                                };

                                window.addEventListener("pointerup", handlePendingPointerEnd);
                                window.addEventListener("pointercancel", handlePendingPointerEnd);
                              }}
                              onPointerUp={handlePointerUp}
                              suppressClickRef={clickSuppressedRef}
                              onOpenAppointment={onOpenAppointment}
                              compactLayout={isMultiDayView}
                              laneIndex={laneIndex}
                              laneCount={laneCount}
                              preferLeftTooltip={staffIndex === staffColumns.length - 1}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {error && <div className="border-t border-red-200 bg-red-50 px-6 py-3 text-sm text-red-700">{error}</div>}
      <AppointmentComposerDrawer
        open={Boolean(composer)}
        onClose={() => setComposer(null)}
        locationId={location.id}
        locationSlug={locationSlug}
        initialStart={composer?.start ?? new Date()}
        initialStaffId={composer?.staffId}
        timezone={location.timezone}
        staffOptions={staffColumns}
        services={services}
        resources={resources.map((resource) => ({
          ...resource,
          color: resource.color ?? undefined,
        }))}
        customers={customers.map((customer) => ({
          ...customer,
          email: customer.email ?? "",
          phone: customer.phone ?? "",
        }))}
        ensureBookingActor={ensureBookingActor}
        onCreated={() => {
          setComposer(null);
          router.refresh();
        }}
      />
    </section>
  );
}

function ColumnHeader({ name, color }: { name: string; color: string | null }) {
  const initial = name.trim().charAt(0) || "•";
  const badgeColor = color ?? "#e5e7eb";
  const textColor = getReadableTextColor(badgeColor);
  return (
    <div className="sticky top-0 z-20 flex h-12 items-center gap-3 bg-white px-4">
      <span
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase shadow-sm"
        style={{ backgroundColor: badgeColor, color: textColor }}
      >
        {initial}
      </span>
      <span className="text-sm font-semibold text-zinc-900">{name}</span>
    </div>
  );
}

function BlockerCard({
  blocker,
  day,
  displayStart,
  displayTotalMinutes,
  staff,
  onOpen,
  laneIndex,
  laneCount,
  preferLeftTooltip = false,
}: {
  blocker: TimeBlockerBlock;
  day: Date;
  displayStart: number;
  displayTotalMinutes: number;
  staff?: StaffColumn;
  onOpen?: (payload: { blocker: TimeBlockerBlock; staff?: StaffColumn }) => void;
  laneIndex: number;
  laneCount: number;
  preferLeftTooltip?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const defaultTooltipOffsetRef = useRef(0);
  const [tooltipSide, setTooltipSide] = useState<"left" | "right">(preferLeftTooltip ? "left" : "right");
  const [tooltipOffset, setTooltipOffset] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
      if (!rect) return;
      const tooltipWidth = 280;
      const spaceRight = window.innerWidth - rect.right;
      const spaceLeft = rect.left;
      const shouldLeft = preferLeftTooltip || (spaceRight < tooltipWidth && spaceLeft > spaceRight);
      setTooltipSide(shouldLeft ? "left" : "right");

      const margin = 12;
      const viewportHeight = window.innerHeight;
      const idealTop = rect.top + rect.height / 2 - tooltipHeight / 2;
      const clampedTop = Math.max(margin, Math.min(idealTop, viewportHeight - tooltipHeight - margin));
      const offsetWithinCard = clampedTop - rect.top;
      defaultTooltipOffsetRef.current = offsetWithinCard;
      setTooltipOffset(offsetWithinCard);
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [preferLeftTooltip, blocker.startsAt, blocker.endsAt]);

  const dayStart = setTime(day, START_HOUR);
  const dayEnd = addMinutes(dayStart, TOTAL_MINUTES);
  const intervalStart = blocker.startsAt > dayStart ? blocker.startsAt : dayStart;
  const intervalEnd = blocker.endsAt < dayEnd ? blocker.endsAt : dayEnd;
  if (!(intervalEnd > intervalStart)) {
    return null;
  }

  const absoluteStartMinutes = differenceInMinutes(intervalStart, dayStart);
  const absoluteEndMinutes = differenceInMinutes(intervalEnd, dayStart);
  const clampedStart = Math.max(displayStart, absoluteStartMinutes);
  const clampedEnd = Math.min(displayStart + displayTotalMinutes, absoluteEndMinutes);
  if (clampedEnd <= clampedStart) {
    return null;
  }

  const relativeTopMinutes = clampedStart - displayStart;
  const availableMinutes = displayTotalMinutes - relativeTopMinutes;
  if (availableMinutes <= 0) {
    return null;
  }

  const desiredMinutes = clampedEnd - clampedStart;
  const minimumMinutes = Math.min(SLOT_MINUTES, availableMinutes);
  const finalMinutes = Math.min(Math.max(desiredMinutes, minimumMinutes), availableMinutes);

  const top = minutesToPixels(relativeTopMinutes);
  const height = minutesToPixels(finalMinutes);
  const timeLabel = `${format(intervalStart, "HH:mm")} – ${format(intervalEnd, "HH:mm")}`;
  const label = blocker.reasonType ? TIME_BLOCKER_LABELS[blocker.reasonType] : blocker.reason?.trim() || "–";
  const detailBody =
    blocker.reasonType === "OTHER"
      ? blocker.customReason?.trim() || "Kein Grund hinterlegt."
      : blocker.reason?.trim() || label;
  const staffName = staff?.name ?? "Nicht definiert";
  const staffInitial = staffName.trim().charAt(0).toUpperCase() || "•";

  const laneSpan = Math.max(1, laneCount);
  const laneWidth = 100 / laneSpan;
  const laneLeft = laneIndex * laneWidth;
  const insetLeftPx = 0;
  const isLastLane = laneIndex === laneCount - 1;
  const rightMarginPx = isLastLane ? 20 : 2;
  const laneGapPx = laneCount > 1 ? 0 : 0;
  const laneOffsetPx = laneIndex === 0 ? insetLeftPx : Math.max(0, insetLeftPx - laneGapPx);

  return (
    <div
      ref={containerRef}
      className="absolute z-[60] h-full overflow-visible"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        left: `calc(${laneLeft}% + ${laneOffsetPx}px)`,
        width: `calc(${laneWidth}% - ${laneOffsetPx + rightMarginPx}px)`,
      }}
      onPointerLeave={() => setTooltipOffset(defaultTooltipOffsetRef.current)}
    >
      <div
        className="group/blocker relative flex h-full w-full cursor-default items-start gap-3 rounded-md border border-[#727272] bg-[#8f8f8f] px-3 py-1.5 text-left text-white shadow-sm"
        data-blocker-card
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.({ blocker, staff });
        }}
        onPointerMove={(event) => {
          const rect = containerRef.current?.getBoundingClientRect();
          const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
          if (!rect || !tooltipHeight) return;
          const margin = 12;
          const viewportHeight = window.innerHeight;
          const cursorOffset = event.clientY - rect.top - tooltipHeight / 2;
          const absoluteTop = rect.top + cursorOffset;
          const clampedAbsoluteTop = Math.max(margin, Math.min(absoluteTop, viewportHeight - tooltipHeight - margin));
          setTooltipOffset(clampedAbsoluteTop - rect.top);
        }}
      >
        <span
          className="mt-1 h-2.5 w-2.5 flex-shrink-0 self-start rounded-full"
          style={{ backgroundColor: staff?.color ?? "#6b7280" }}
        />
        <div className="flex flex-1 flex-col items-start gap-0.5 text-xs">
          <span className="text-[13px] font-semibold leading-tight text-white">{staffName}</span>
          <span className="text-[12px] font-medium text-zinc-100/80">{label}</span>
        </div>
        <span className="pointer-events-none absolute bottom-1.5 right-2 text-2xl font-bold leading-none text-zinc-100/70">
          ⦸
        </span>

        <div
          ref={tooltipRef}
          className={`pointer-events-none absolute top-0 z-[80] w-64 flex-col gap-3 rounded-xl border border-zinc-200 bg-white shadow-xl opacity-0 transition-opacity duration-100 invisible group-hover/blocker:visible group-hover/blocker:opacity-100 ${
            tooltipSide === "left" ? "right-full mr-3" : "left-full ml-3"
          }`}
          style={{ top: `${tooltipOffset}px` }}
        >
          <header className="rounded-t-xl bg-zinc-500 px-4 py-2 text-sm font-semibold text-white">
            Zeitblocker ({label})
          </header>
          <div className="px-4 pb-4 pt-2 text-xs text-zinc-700">
            <p className="text-[11px] font-semibold text-zinc-600">{timeLabel}</p>
            <div className="mt-3 flex items-center gap-3">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white"
                style={{ backgroundColor: staff?.color ?? "#9ca3af" }}
              >
                {staffInitial}
              </span>
              <div>
                <p className="text-sm font-medium text-zinc-900">{staffName}</p>
                {detailBody && <p className="text-xs text-zinc-500">{detailBody}</p>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppointmentCard({
  appointment,
  staffColor,
  day,
  preview,
  isDragging,
  displayStart,
  displayTotalMinutes,
  onPointerDown,
  onPointerUp,
  suppressClickRef,
  onOpenAppointment,
  compactLayout,
  laneIndex,
  laneCount,
  preferLeftTooltip = false,
}: {
  appointment: AppointmentBlock;
  staffColor: string;
  day: Date;
  preview: { start: Date; end: Date } | null;
  isDragging: boolean;
  displayStart: number;
  displayTotalMinutes: number;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  suppressClickRef: MutableRefObject<boolean>;
  onOpenAppointment?: (payload: { appointmentId: string; itemId?: string }) => void;
  compactLayout: boolean;
  laneIndex: number;
  laneCount: number;
  preferLeftTooltip?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const defaultTooltipOffsetRef = useRef(0);
  const [tooltipSide, setTooltipSide] = useState<"left" | "right">(preferLeftTooltip ? "left" : "right");
  const [tooltipOffset, setTooltipOffset] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
      if (!rect) return;
      const tooltipWidth = 280;
      const spaceRight = window.innerWidth - rect.right;
      const spaceLeft = rect.left;
      const shouldLeft = preferLeftTooltip || (spaceRight < tooltipWidth && spaceLeft > spaceRight);
      setTooltipSide(shouldLeft ? "left" : "right");

      const margin = 12;
      const viewportHeight = window.innerHeight;
      const idealTop = rect.top + rect.height / 2 - tooltipHeight / 2;
      const clampedTop = Math.max(margin, Math.min(idealTop, viewportHeight - tooltipHeight - margin));
      const offsetWithinCard = clampedTop - rect.top;
      defaultTooltipOffsetRef.current = offsetWithinCard;
      setTooltipOffset(offsetWithinCard);
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [preferLeftTooltip, appointment.startsAt, appointment.endsAt]);

  const baseStart = preview ? preview.start : appointment.startsAt;
  const baseEnd = preview ? preview.end : appointment.endsAt;

  const minutesFromMidnight = differenceInMinutes(baseStart, setTime(day, START_HOUR));
  const minutesFromStart = minutesFromMidnight - displayStart;
  const minutesDuration = Math.max(MIN_APPOINTMENT_MINUTES, differenceInMinutes(baseEnd, baseStart));

  const maxTop = Math.max(0, displayTotalMinutes - MIN_APPOINTMENT_MINUTES);
  const top = Math.max(0, Math.min(maxTop, minutesFromStart));
  const height = Math.max(MIN_APPOINTMENT_MINUTES, Math.min(minutesDuration, displayTotalMinutes - top));
  const laneSpan = Math.max(1, laneCount);
  const laneWidth = 100 / laneSpan;
  const laneLeft = laneIndex * laneWidth;
  const isCancelled = appointment.status === "CANCELLED";
  const blocksAvailability = !isCancelled;
  const baseColor = staffColor || "#e5e7eb";
  const cardBackgroundColor = isCancelled ? "#ffffff" : baseColor;
  const cardPrimaryText = isCancelled ? "#1f2937" : getReadableTextColor(cardBackgroundColor);
  const cardSecondaryText = isCancelled
    ? "rgba(17,24,39,0.75)"
    : cardPrimaryText === "#ffffff"
    ? "rgba(255,255,255,0.85)"
    : "rgba(55,65,81,0.8)";
  const cardTertiaryText = isCancelled
    ? "rgba(17,24,39,0.6)"
    : cardPrimaryText === "#ffffff"
    ? "rgba(255,255,255,0.7)"
    : "rgba(55,65,81,0.6)";
  const borderColor = isCancelled ? "rgba(17,24,39,0.35)" : toRgba(cardPrimaryText, 0.15);
  const cancelIconColor = "#111827";
  const timeLabel = `${format(baseStart, "HH:mm")} – ${format(baseEnd, "HH:mm")}`;

  const statusMeta = STATUS_META[appointment.status] ?? STATUS_META.PENDING;

  const insetLeftPx = 0;
  const isLastLane = laneIndex === laneCount - 1;
  const rightMarginPx = isLastLane ? 20 : 2;
  const laneGapPx = laneCount > 1 ? 0 : 0;
  const laneOffsetPx = laneIndex === 0 ? insetLeftPx : Math.max(0, insetLeftPx - laneGapPx);

  return (
    <div
      ref={containerRef}
      className="group/tooltip absolute z-[70] h-full overflow-visible"
      style={{
        top: `${minutesToPixels(top)}px`,
        height: `${minutesToPixels(height)}px`,
        left: `calc(${laneLeft}% + ${laneOffsetPx}px)`,
        width: `calc(${laneWidth}% - ${laneOffsetPx + rightMarginPx}px)`,
      }}
      onPointerLeave={() => setTooltipOffset(defaultTooltipOffsetRef.current)}
    >
      <div
        role="button"
        tabIndex={0}
        aria-disabled={isCancelled}
        onPointerDown={(event) => {
          if (isCancelled) {
            return;
          }
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // ignore browsers without pointer capture
          }
          onPointerDown(event);
        }}
        onPointerUp={(event) => {
          try {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          } catch {
            // ignore browsers that do not support pointer capture
          }
          onPointerUp();
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current) {
            return;
          }
          if (isCancelled) {
            onOpenAppointment?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
            return;
          }
          if (!isDragging) {
            onOpenAppointment?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenAppointment?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
          }
        }}
        data-appointment-card
        data-appointment-status={appointment.status}
        data-blocks-availability={blocksAvailability ? "true" : "false"}
        className={`relative h-full w-full overflow-hidden rounded-md px-2 pt-0.5 pb-1 text-left text-xs shadow-md transition ${
          isDragging ? "shadow-lg ring-2 ring-black/10" : "hover:shadow-lg"
        }`}
        style={{
          backgroundColor: cardBackgroundColor,
          color: cardPrimaryText,
          border: `1px solid ${borderColor}`,
          opacity: isCancelled ? 0.95 : isDragging ? 0.9 : 1,
        }}
        onPointerMove={(event) => {
          const rect = containerRef.current?.getBoundingClientRect();
          const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
          if (!rect || !tooltipHeight) return;
          const margin = 12;
          const viewportHeight = window.innerHeight;
          const cursorOffset = event.clientY - rect.top - tooltipHeight / 2;
          const absoluteTop = rect.top + cursorOffset;
          const clampedAbsoluteTop = Math.max(margin, Math.min(absoluteTop, viewportHeight - tooltipHeight - margin));
          setTooltipOffset(clampedAbsoluteTop - rect.top);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onOpenAppointment?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
        }}
      >
        {isCancelled && (
          <span
            className="pointer-events-none absolute right-1.5 top-0.5 z-20 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#4b4b4b]"
            aria-hidden="true"
          >
            <CancelledCalendarIcon className="h-4 w-4 text-white" />
          </span>
        )}
        <div className="relative z-10 space-y-0.5" style={{ paddingTop: "2px" }}>
          <p className="text-[11px] font-semibold leading-tight" style={{ color: cardPrimaryText }}>
            {appointment.displayLabel}
          </p>
          {appointment.note && (
            <p className="text-[11px] leading-tight" style={{ color: cardSecondaryText }}>
              {appointment.note}
            </p>
          )}
          {appointment.hasService && appointment.displayLabel !== appointment.serviceName && (
            <p className="text-[11px] leading-tight" style={{ color: cardSecondaryText }}>
              {appointment.serviceName}
            </p>
          )}
          {appointment.displayLabel !== appointment.timeLabel && (
            <p className="text-[11px] leading-tight" style={{ color: cardTertiaryText }}>
              {appointment.timeLabel}
            </p>
          )}
        </div>
        {isCancelled && <span className="sr-only">Storniert</span>}
      </div>
      <div
        ref={tooltipRef}
        className={`pointer-events-none absolute top-0 z-[99999] w-64 flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 text-left text-xs text-zinc-700 shadow-xl opacity-0 transition-opacity duration-100 invisible group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-within/tooltip:visible group-focus-within/tooltip:opacity-100 ${
          tooltipSide === "left" ? "right-full mr-3" : "left-full ml-3"
        }`}
        style={{ top: `${tooltipOffset}px` }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-zinc-900">{appointment.displayLabel}</p>
            {appointment.displayLabel !== appointment.timeLabel && (
              <p className="text-xs text-zinc-500">{appointment.timeLabel}</p>
            )}
          </div>
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${statusMeta.badgeClass}`}
          >
            {statusMeta.label}
          </span>
        </div>
        {appointment.note && (
          <p className="whitespace-pre-line text-xs text-zinc-600">{appointment.note}</p>
        )}
        <div className="space-y-1 text-xs">
          {appointment.hasService && appointment.displayLabel !== appointment.serviceName && (
            <p className="font-medium text-zinc-900">{appointment.serviceName}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function setTime(date: Date, hours: number): Date;

function setTime(date: Date, hours: number) {
  const clone = new Date(date);
  clone.setHours(hours, 0, 0, 0);
  return clone;
}

function blockerOverlapsDay(blocker: TimeBlockerBlock, day: Date) {
  const dayStart = setTime(day, START_HOUR);
  const dayEnd = addMinutes(dayStart, TOTAL_MINUTES);
  return blocker.startsAt < dayEnd && blocker.endsAt > dayStart;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (!ranges.length) return [];
  const sorted = [...ranges]
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return [];
  const merged: Array<{ start: number; end: number }> = [];
  let current = { ...sorted[0] };
  for (let index = 1; index < sorted.length; index += 1) {
    const range = sorted[index];
    if (range.start <= current.end) {
      current.end = Math.max(current.end, range.end);
    } else {
      merged.push(current);
      current = { ...range };
    }
  }
  merged.push(current);
  return merged;
}

function getAvailabilityRanges(
  availability: WeeklyCalendarProps["availability"],
  staffId: string,
  dayKey: string,
): Array<{ start: number; end: number }> {
  const base = availability?.[staffId]?.[dayKey];
  if (!base?.length) {
    return staffId === "unassigned" ? [{ start: 0, end: TOTAL_MINUTES }] : [];
  }
  return mergeRanges(base);
}

function clampRange(
  range: { start: number; end: number },
  start: number,
  end: number,
): { start: number; end: number } | null {
  const clampedStart = Math.max(range.start, start);
  const clampedEnd = Math.min(range.end, end);
  if (clampedEnd <= clampedStart) {
    return null;
  }
  return { start: clampedStart, end: clampedEnd };
}
type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER";

const TIME_BLOCKER_LABELS: Record<TimeBlockerReason, string> = {
  BREAK: "Pause",
  MEAL: "Mittagessen",
  VACATION: "Urlaub",
  SICK: "Krankheit",
  PRIVATE: "Privater Termin",
  OTHER: "Anderer Grund",
};
