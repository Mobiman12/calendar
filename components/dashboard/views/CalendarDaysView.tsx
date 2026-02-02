"use client";

import { createPortal } from "react-dom";
import { addMinutes, differenceInMinutes, format, isSameDay } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from "react";
import type { UIEvent, PointerEvent as ReactPointerEvent } from "react";

import { getReadableTextColor, toRgba } from "@/lib/color";
import { combineDateWithMinutesInTimeZone } from "@/lib/timezone";
import type { AppointmentStatus } from "@prisma/client";

const START_HOUR = 0;
const END_HOUR = 24;
const DEFAULT_SLOT_MINUTES = 30;
const SLOT_PIXEL_HEIGHT = 32;
const MIN_APPOINTMENT_MINUTES = 5;
const TOTAL_MINUTES = (END_HOUR - START_HOUR) * 60;
const CARD_DRAG_DELAY_MS = 500;
const TOOLTIP_OPEN_DELAY_MS = 120;
const TOOLTIP_CLOSE_DELAY_MS = 120;

type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER";

const TIME_BLOCKER_LABELS: Record<TimeBlockerReason, string> = {
  BREAK: "Pause",
  MEAL: "Mittagessen",
  VACATION: "Urlaub",
  SICK: "Krankheit",
  PRIVATE: "Privater Termin",
  OTHER: "Anderer Grund",
};

type StaffIndex = Map<string, { id: string; name: string; color: string }>;

const STATUS_META: Record<AppointmentStatus, { label: string; badgeClass: string }> = {
  PENDING: { label: "Offen", badgeClass: "bg-amber-100 text-amber-700 border-amber-200" },
  CONFIRMED: { label: "Bestätigt", badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  COMPLETED: { label: "Abgeschlossen", badgeClass: "bg-sky-100 text-sky-700 border-sky-200" },
  CANCELLED: { label: "Storniert", badgeClass: "bg-rose-100 text-rose-700 border-rose-200" },
  NO_SHOW: { label: "Nicht erschienen", badgeClass: "bg-zinc-200 text-zinc-600 border-zinc-300" },
};

const NEUTRAL_STAFF_STATUS = new Set(["verfügbar", "verfuegbar", "available"]);

function getDisplayStaffStatus(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (NEUTRAL_STAFF_STATUS.has(normalized)) return null;
  return trimmed;
}

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

export type CalendarAppointmentRecord = {
  id: string;
  appointmentId: string;
  serviceId?: string | null;
  staffId?: string | null;
  startsAt: Date;
  endsAt: Date;
  serviceName: string;
  confirmationCode: string;
  customerName: string;
  customerPhone?: string | null;
  displayLabel: string;
  hasCustomer: boolean;
  hasService: boolean;
  timeLabel: string;
  status: AppointmentStatus;
  note: string | null;
  internalNote: string | null;
  internalNoteIsTitle?: boolean | null;
  isOnline?: boolean;
  isColorRequest?: boolean;
};

type AppointmentRecord = CalendarAppointmentRecord;

type TimeBlockerRecord = {
  id: string;
  staffId?: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  reasonType?: TimeBlockerReason | null;
  customReason?: string | null;
  allStaff: boolean;
  isHold?: boolean;
  holdSource?: "online" | "staff";
  expiresAt?: Date | null;
  serviceNames?: string[];
  createdByName?: string | null;
  createdByStaffId?: string | null;
};

export interface CalendarDaysViewProps {
  days: Date[];
  location: {
    id: string;
    name: string;
    timezone: string;
  };
  appointments: AppointmentRecord[];
  timeBlockers?: TimeBlockerRecord[];
  staffIndex: StaffIndex;
  availability?: Record<string, Record<string, Array<{ start: number; end: number }>>>;
  staffStatus?: Record<string, Record<string, string>>;
  activeStaffIds?: string[];
  displayRange?: { start: number; end: number } | null;
  onSelectAppointment?: (payload: { appointmentId: string; itemId?: string }) => void;
  onSelectBlocker?: (payload: { blocker: TimeBlockerRecord; staff?: { id: string; name: string; color: string } }) => void;
  onCreateSlot?: (payload: { start: Date; end?: Date; staffId?: string | null }) => void;
  onMoveAppointment?: (payload: { appointment: AppointmentRecord; start: Date; end: Date; staffId?: string | null }) => void;
  onMoveBlocker?: (payload: { blocker: TimeBlockerRecord; start: Date; end: Date; staffId?: string | null; allStaff: boolean }) => void;
  viewportHeight?: string;
  slotIntervalMinutes?: number;
  activeSlotHighlight?: { start: Date; end: Date; staffId?: string | null };
  highlightedAppointmentId?: string | null;
}

type Placement = {
  appointment: AppointmentRecord;
  laneIndex: number;
  laneCount: number;
};

type BlockerPlacement = {
  blocker: TimeBlockerRecord;
  laneIndex: number;
  laneCount: number;
};

function normalizeStaffValue(value?: string | null): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value === "unassigned") return null;
  return value;
}

function getColumnStaffInfo(column?: ColumnConfig): { staffId: string | null | undefined; explicit: boolean } {
  if (!column || !column.staff) {
    return { staffId: undefined, explicit: false };
  }
  if (column.staff.id === "unassigned") {
    return { staffId: null, explicit: true };
  }
  return { staffId: column.staff.id, explicit: true };
}

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

type ColumnConfig = {
  key: string;
  day: Date;
  header: string;
  subHeader?: string;
  headerStatus?: string;
  staff?: { id: string; name: string; color: string };
  staffId?: string | null;
  placements: Placement[];
  blockerPlacements: BlockerPlacement[];
  availabilityRanges: Array<{ start: number; end: number }>;
  headerInitial?: { letter: string; color: string; textColor: string };
};

type CardDragContext = {
  pointerId: number;
  columnKey: string;
  columnDay: Date;
  staffId?: string | null;
  staffExplicit: boolean;
  durationMinutes: number;
  pointerOffsetMinutes: number;
  type: "appointment" | "blocker";
  sourceId: string;
  container: HTMLElement;
  originalStartMinutes: number;
  record:
    | ({ kind: "appointment"; data: AppointmentRecord; originalStaffId?: string | null })
    | ({ kind: "blocker"; data: TimeBlockerRecord; originalStaffId?: string | null; originalAllStaff: boolean });
};

type CardDragPreview = {
  columnKey: string;
  day: Date;
  staffId?: string | null;
  startMinutes: number;
  durationMinutes: number;
  type: "appointment" | "blocker";
  sourceId: string;
};

type PendingCardDrag = {
  pointerId: number;
  timeoutId: number;
  context: CardDragContext;
  preview: CardDragPreview;
  cancel: () => void;
};

type TooltipPosition = { top: number; left: number };

export function CalendarDaysView({
  days,
  location,
  appointments,
  timeBlockers = [],
  staffIndex,
  availability,
  staffStatus,
  activeStaffIds,
  displayRange,
  onSelectAppointment,
  onSelectBlocker,
  onCreateSlot,
  onMoveAppointment,
  onMoveBlocker,
  viewportHeight,
  slotIntervalMinutes = DEFAULT_SLOT_MINUTES,
  activeSlotHighlight,
  highlightedAppointmentId,
}: CalendarDaysViewProps) {
  const slotMinutes = Math.max(5, slotIntervalMinutes);
  const pixelsPerMinute = SLOT_PIXEL_HEIGHT / slotMinutes;
  const minutesToPixels = (value: number) => value * pixelsPerMinute;
  const displayStart = displayRange?.start ?? 0;
  const displayEnd = displayRange?.end ?? TOTAL_MINUTES;
  const displayTotalMinutes = Math.max(slotMinutes, displayEnd - displayStart);
  const normalizedDisplayEnd = displayStart + displayTotalMinutes;
  const slots = useMemo(
    () => Array.from({ length: displayTotalMinutes / slotMinutes }, (_, index) => displayStart + index * slotMinutes),
    [displayStart, displayTotalMinutes, slotMinutes],
  );
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const slotScrollRef = useRef<HTMLDivElement | null>(null);
  const isSyncingRef = useRef(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const AUTO_FOLLOW_ENABLED = true;
  const autoFollowRef = useRef(AUTO_FOLLOW_ENABLED);
  const autoFollowTimeoutRef = useRef<number | null>(null);
  const daySignature = useMemo(() => days.map((day) => day.toISOString()).join("|"), [days]);
  const dragContextRef = useRef<{
    pointerId: number;
    columnKey: string;
    day: Date;
    staffId?: string;
    container: HTMLElement;
    startMinutes: number;
  } | null>(null);
  const [dragPreview, setDragPreview] = useState<{
    columnKey: string;
    startMinutes: number;
    currentMinutes: number;
  } | null>(null);
  const columnRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const columnMetaRef = useRef<Map<string, ColumnConfig>>(new Map());
  const cardDragContextRef = useRef<CardDragContext | null>(null);
  const pendingCardDragRef = useRef<PendingCardDrag | null>(null);
  const [cardDragPreview, setCardDragPreview] = useState<CardDragPreview | null>(null);
  const recentCardDragRef = useRef<number>(0);
  const registerColumnRef = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
      if (node) {
        columnRefs.current.set(key, node);
      } else {
        columnRefs.current.delete(key);
      }
    },
    [],
  );

  const resolveColumnAtPoint = useCallback((clientX: number, clientY: number) => {
    for (const [key, node] of columnRefs.current.entries()) {
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        const column = columnMetaRef.current.get(key);
        if (column) {
          return { column, node };
        }
      }
    }
    return null;
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(new Date());
    }, 15000);
    return () => {
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (autoFollowTimeoutRef.current !== null) {
        window.clearTimeout(autoFollowTimeoutRef.current);
        autoFollowTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      pendingCardDragRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!AUTO_FOLLOW_ENABLED) {
      return;
    }
    autoFollowRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- AUTO_FOLLOW_ENABLED is static
  }, [daySignature]);

  const syncScroll = useCallback((source: "slots" | "timeline", value: number) => {
    const targetRef = source === "slots" ? timelineScrollRef : slotScrollRef;
    const target = targetRef.current;
    if (!target) return;
    if (Math.abs(target.scrollTop - value) < 1) {
      return;
    }
    target.scrollTop = value;
  }, []);

  const snapMinutes = useCallback(
    (value: number) => {
      const min = displayStart;
      const max = normalizedDisplayEnd - slotMinutes;
      const clamped = Math.max(min, Math.min(max, value));
      return Math.floor(clamped / slotMinutes) * slotMinutes;
    },
    [displayStart, normalizedDisplayEnd, slotMinutes],
  );

  const minutesFromClientY = useCallback(
    (clientY: number, container: HTMLElement) => {
      const rect = container.getBoundingClientRect();
      const relativeY = Math.max(0, Math.min(rect.height - 1, clientY - rect.top));
      const absoluteMinutes = displayStart + relativeY / pixelsPerMinute;
      return snapMinutes(absoluteMinutes);
    },
    [displayStart, snapMinutes, pixelsPerMinute],
  );

  const clampCardStart = useCallback(
    (startMinutes: number, durationMinutes: number) => {
      const min = displayStart;
      const max = normalizedDisplayEnd - durationMinutes;
      if (max <= min) return min;
      return Math.max(min, Math.min(max, startMinutes));
    },
    [displayStart, normalizedDisplayEnd],
  );

  const handleSlotsScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (isSyncingRef.current) return;
      if (AUTO_FOLLOW_ENABLED) {
        autoFollowRef.current = false;
        if (autoFollowTimeoutRef.current !== null) {
          window.clearTimeout(autoFollowTimeoutRef.current);
        }
        autoFollowTimeoutRef.current = window.setTimeout(() => {
          autoFollowRef.current = true;
          autoFollowTimeoutRef.current = null;
        }, 30000);
      }
      isSyncingRef.current = true;
      const value = event.currentTarget.scrollTop;
      syncScroll("slots", value);
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- AUTO_FOLLOW_ENABLED is static
    [syncScroll],
  );

  const handleTimelineScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (isSyncingRef.current) return;
      if (AUTO_FOLLOW_ENABLED) {
        autoFollowRef.current = false;
        if (autoFollowTimeoutRef.current !== null) {
          window.clearTimeout(autoFollowTimeoutRef.current);
        }
        autoFollowTimeoutRef.current = window.setTimeout(() => {
          autoFollowRef.current = true;
          autoFollowTimeoutRef.current = null;
        }, 30000);
      }
      isSyncingRef.current = true;
      const value = event.currentTarget.scrollTop;
      syncScroll("timeline", value);
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- AUTO_FOLLOW_ENABLED is static
    [syncScroll],
  );

  const handleSlotPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, column: ColumnConfig) => {
      if (!onCreateSlot || event.button !== 0 || cardDragPreview) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("[data-appointment-card]") || target.closest("[data-blocker-card]")) {
        return;
      }
      event.preventDefault();
      const container = event.currentTarget;
      const snappedMinutes = minutesFromClientY(event.clientY, container);
      const staffId = column.staff?.id && column.staff.id !== "unassigned" ? column.staff.id : undefined;
      dragContextRef.current = {
        pointerId: event.pointerId,
        columnKey: column.key,
        day: column.day,
        staffId,
        container,
        startMinutes: snappedMinutes,
      };
      setDragPreview({ columnKey: column.key, startMinutes: snappedMinutes, currentMinutes: snappedMinutes });
    },
    [cardDragPreview, minutesFromClientY, onCreateSlot],
  );

  const handleCardPointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      payload:
        | {
            type: "appointment";
            record: AppointmentRecord;
            columnKey: string;
            day: Date;
            staffId?: string | null;
          }
        | {
            type: "blocker";
            record: TimeBlockerRecord;
            columnKey: string;
            day: Date;
            staffId?: string | null;
          },
    ) => {
      if (event.button !== 0 || cardDragContextRef.current || pendingCardDragRef.current) {
        return;
      }
      const container = columnRefs.current.get(payload.columnKey);
      const column = columnMetaRef.current.get(payload.columnKey);
      if (!container || !column) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const pointerMinutes = minutesFromClientY(event.clientY, container);
      const recordStartMinutes = differenceInMinutes(
        payload.record.startsAt,
        setTime(payload.day, START_HOUR),
      );
      const baseDurationMinutes = differenceInMinutes(payload.record.endsAt, payload.record.startsAt);
      const durationMinutes =
        payload.type === "appointment"
          ? Math.max(MIN_APPOINTMENT_MINUTES, baseDurationMinutes)
          : Math.max(slotMinutes, baseDurationMinutes);
      const pointerOffsetMinutes = pointerMinutes - recordStartMinutes;
      const appointmentOriginalStaff =
        payload.type === "appointment" ? normalizeStaffValue(payload.record.staffId) ?? null : null;
      const blockerOriginalStaff =
        payload.type === "blocker"
          ? payload.record.allStaff
            ? null
            : normalizeStaffValue(payload.record.staffId) ?? null
          : null;
      const columnStaffInfo = getColumnStaffInfo(column);
      const context: CardDragContext = {
        pointerId: event.pointerId,
        columnKey: payload.columnKey,
        columnDay: column.day,
        staffId: columnStaffInfo.staffId,
        staffExplicit: columnStaffInfo.explicit,
        durationMinutes,
        pointerOffsetMinutes,
        type: payload.type,
        sourceId: payload.type === "appointment" ? payload.record.id : payload.record.id,
        container,
        originalStartMinutes: recordStartMinutes,
        record:
          payload.type === "appointment"
            ? { kind: "appointment", data: payload.record, originalStaffId: appointmentOriginalStaff }
            : {
                kind: "blocker",
                data: payload.record,
                originalStaffId: blockerOriginalStaff,
                originalAllStaff: payload.record.allStaff,
              },
      };
      const clampedStart = clampCardStart(recordStartMinutes, durationMinutes);
      const preview: CardDragPreview = {
        columnKey: payload.columnKey,
        day: column.day,
        staffId: columnStaffInfo.staffId,
        startMinutes: clampedStart,
        durationMinutes,
        type: payload.type,
        sourceId: payload.type === "appointment" ? payload.record.id : payload.record.id,
      };

      const pointerId = event.pointerId;
      function handlePendingPointerEnd(endEvent: PointerEvent) {
        if (endEvent.pointerId !== pointerId) {
          return;
        }
        const pending = pendingCardDragRef.current;
        if (!pending || pending.pointerId !== pointerId) {
          return;
        }
        window.clearTimeout(pending.timeoutId);
        window.removeEventListener("pointerup", handlePendingPointerEnd);
        window.removeEventListener("pointercancel", handlePendingPointerEnd);
        pendingCardDragRef.current = null;
      }

      const timeoutId = window.setTimeout(() => {
        const pending = pendingCardDragRef.current;
        if (!pending || pending.pointerId !== pointerId) {
          return;
        }
        window.removeEventListener("pointerup", handlePendingPointerEnd);
        window.removeEventListener("pointercancel", handlePendingPointerEnd);
        pendingCardDragRef.current = null;
        cardDragContextRef.current = pending.context;
        setCardDragPreview(pending.preview);
      }, CARD_DRAG_DELAY_MS);

      pendingCardDragRef.current = {
        pointerId,
        timeoutId,
        context,
        preview,
        cancel: () => {
          const pending = pendingCardDragRef.current;
          if (!pending || pending.pointerId !== pointerId) {
            return;
          }
          window.clearTimeout(pending.timeoutId);
          window.removeEventListener("pointerup", handlePendingPointerEnd);
          window.removeEventListener("pointercancel", handlePendingPointerEnd);
          pendingCardDragRef.current = null;
        },
      };

      window.addEventListener("pointerup", handlePendingPointerEnd);
      window.addEventListener("pointercancel", handlePendingPointerEnd);
    },
    [clampCardStart, minutesFromClientY, slotMinutes],
  );

  useEffect(() => {
    if (!dragPreview) return;
    const handlePointerMove = (event: PointerEvent) => {
      const context = dragContextRef.current;
      if (!context || event.pointerId !== context.pointerId) {
        return;
      }
      const nextMinutes = minutesFromClientY(event.clientY, context.container);
      setDragPreview((prev) =>
        prev && prev.columnKey === context.columnKey ? { ...prev, currentMinutes: nextMinutes } : prev,
      );
    };
    const handlePointerUp = (event: PointerEvent) => {
      const context = dragContextRef.current;
      if (!context || event.pointerId !== context.pointerId) {
        return;
      }
      event.preventDefault();
      const finalMinutes = minutesFromClientY(event.clientY, context.container);
      const startMinutes = Math.min(context.startMinutes, finalMinutes);
      const endMinutes = Math.max(context.startMinutes, finalMinutes) + slotMinutes;
      const startDate = combineDateWithMinutesInTimeZone(context.day, startMinutes, location.timezone);
      const endDate = combineDateWithMinutesInTimeZone(context.day, endMinutes, location.timezone);
      onCreateSlot?.({ start: startDate, end: endDate, staffId: context.staffId });
      dragContextRef.current = null;
      setDragPreview(null);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dragPreview, location.timezone, minutesFromClientY, onCreateSlot, slotMinutes]);

  useEffect(() => {
    if (!cardDragPreview) return;
    if (!cardDragContextRef.current) return;
    const handlePointerMove = (event: PointerEvent) => {
      const activeContext = cardDragContextRef.current;
      if (!activeContext || event.pointerId !== activeContext.pointerId) {
        return;
      }
      event.preventDefault();
      const resolved =
        resolveColumnAtPoint(event.clientX, event.clientY) ??
        (() => {
          const fallbackColumn = columnMetaRef.current.get(activeContext.columnKey);
          const fallbackNode = columnRefs.current.get(activeContext.columnKey);
          if (fallbackColumn && fallbackNode) {
            return { column: fallbackColumn, node: fallbackNode };
          }
          return null;
        })();
      if (!resolved) {
        return;
      }
      const pointerMinutes = minutesFromClientY(event.clientY, resolved.node);
      const rawStart = pointerMinutes - activeContext.pointerOffsetMinutes;
      const clampedStart = clampCardStart(rawStart, activeContext.durationMinutes);
      const staffInfo = getColumnStaffInfo(resolved.column);
      cardDragContextRef.current = {
        ...activeContext,
        columnKey: resolved.column.key,
        columnDay: resolved.column.day,
        staffId: staffInfo.staffId,
        staffExplicit: staffInfo.explicit,
        container: resolved.node,
      };
      setCardDragPreview({
        columnKey: resolved.column.key,
        day: resolved.column.day,
        staffId: staffInfo.staffId,
        startMinutes: clampedStart,
        durationMinutes: activeContext.durationMinutes,
        type: activeContext.type,
        sourceId: activeContext.sourceId,
      });
    };
    const handlePointerEnd = (event: PointerEvent) => {
      const activeContext = cardDragContextRef.current;
      if (!activeContext || event.pointerId !== activeContext.pointerId) {
        return;
      }
      event.preventDefault();
      const pointerMinutes = minutesFromClientY(event.clientY, activeContext.container);
      const rawStart = pointerMinutes - activeContext.pointerOffsetMinutes;
      const clampedStart = clampCardStart(rawStart, activeContext.durationMinutes);
      const startDate = combineDateWithMinutesInTimeZone(activeContext.columnDay, clampedStart, location.timezone);
      const endDate = addMinutes(startDate, activeContext.durationMinutes);
      const recordData = activeContext.record.data;
      const originalStartTime = recordData.startsAt;
      const originalEndTime = recordData.endsAt;
      const originalStaffId =
        activeContext.record.kind === "appointment"
          ? normalizeStaffValue(recordData.staffId) ?? null
          : activeContext.record.originalStaffId ?? null;
      const targetStaffId = activeContext.staffExplicit ? activeContext.staffId ?? null : originalStaffId;
      const startChanged = startDate.getTime() !== originalStartTime.getTime();
      const endChanged = endDate.getTime() !== originalEndTime.getTime();
      const staffChanged = targetStaffId !== originalStaffId;
      cardDragContextRef.current = null;
      setCardDragPreview(null);
      if (startChanged || endChanged || staffChanged) {
        recentCardDragRef.current = Date.now();
      }
      if (!startChanged && !endChanged && !staffChanged) {
        return;
      }
      if (activeContext.record.kind === "appointment") {
        onMoveAppointment?.({
          appointment: recordData as AppointmentRecord,
          start: startDate,
          end: endDate,
          staffId: targetStaffId,
        });
      } else {
        const targetAllStaff = activeContext.staffExplicit ? false : activeContext.record.originalAllStaff;
        onMoveBlocker?.({
          blocker: recordData as TimeBlockerRecord,
          start: startDate,
          end: endDate,
          staffId: targetStaffId,
          allStaff: targetAllStaff,
        });
      }
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [
    cardDragPreview,
    clampCardStart,
    minutesFromClientY,
    onMoveAppointment,
    onMoveBlocker,
    resolveColumnAtPoint,
    location.timezone,
  ]);
  const isSingleDay = days.length === 1;
  const groupedAppointments = useMemo(() => {
    const map = new Map<string, AppointmentRecord[]>();
    for (const day of days) {
      map.set(day.toISOString(), []);
    }
    for (const appointment of appointments) {
      for (const day of days) {
        if (isSameDay(appointment.startsAt, day)) {
          const key = day.toISOString();
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(appointment);
          break;
        }
      }
    }
    for (const [key, list] of map.entries()) {
      map.set(
        key,
        list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).map((item) => ({ ...item })),
      );
    }
    return map;
  }, [appointments, days]);

  const groupedBlockers = useMemo(() => {
    const map = new Map<string, TimeBlockerRecord[]>();
    for (const day of days) {
      map.set(day.toISOString(), []);
    }
    for (const blocker of timeBlockers) {
      for (const day of days) {
        if (blockerOverlapsDay(blocker, day)) {
          const key = day.toISOString();
          map.get(key)?.push(blocker);
        }
      }
    }
    for (const [key, list] of map.entries()) {
      map.set(
        key,
        list
          .slice()
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
      );
    }
    return map;
  }, [timeBlockers, days]);

  const staffIndexWithUnassigned = useMemo(() => {
    const map = new Map(staffIndex);
    if (!map.has("unassigned")) {
      map.set("unassigned", { id: "unassigned", name: "Nicht definiert", color: "#9ca3af" });
    }
    return map;
  }, [staffIndex]);

  const staffIdsForAvailability = useMemo(() => {
    const ids =
      activeStaffIds && activeStaffIds.length ? activeStaffIds : Array.from(staffIndexWithUnassigned.keys());
    return ids.filter((id) => id !== "unassigned");
  }, [activeStaffIds, staffIndexWithUnassigned]);

  const singleDayColumns = useMemo<ColumnConfig[]>(() => {
    if (!isSingleDay || !days.length) {
      return [];
    }
    const day = days[0];
    const dayKey = day.toISOString();
    const formattedDayKey = format(day, "yyyy-MM-dd");
    const appointmentsForDay = groupedAppointments.get(dayKey) ?? [];
    const blockersForDay = groupedBlockers.get(dayKey) ?? [];
    const ids =
      activeStaffIds && activeStaffIds.length
        ? activeStaffIds
        : Array.from(staffIndexWithUnassigned.keys());
    const orderedIds: string[] = [];
    for (const id of ids) {
      if (!orderedIds.includes(id)) {
        orderedIds.push(id);
      }
    }
    if (!orderedIds.length) {
      orderedIds.push("unassigned");
    }
    return orderedIds.map((staffId) => {
      const staff =
        staffIndexWithUnassigned.get(staffId) ??
        {
          id: staffId,
          name: staffId === "unassigned" ? "Nicht definiert" : "Unbekannt",
          color: staffId === "unassigned" ? "#9ca3af" : "#6b7280",
        };
      const staffAppointments = appointmentsForDay.filter(
        (appointment) => (appointment.staffId ?? "unassigned") === staffId,
      );
      const staffBlockers = blockersForDay.filter((blocker) => {
        if (blocker.allStaff) return true;
        const blockerStaffKey = blocker.staffId ?? "unassigned";
        return blockerStaffKey === staffId;
      });
      const layout = layoutColumnEvents(day, staffAppointments, staffBlockers);
      const availabilityRanges = mergeRanges(availability?.[staffId]?.[formattedDayKey] ?? [])
        .map((range) => clampRange(range, displayStart, displayEnd))
        .filter((range): range is { start: number; end: number } => Boolean(range));
      const statusLabel = getDisplayStaffStatus(staffStatus?.[staffId]?.[formattedDayKey]);
      const rawName = staff.name?.trim() ?? "";
      const fallbackName = staffId === "unassigned" ? "Nicht definiert" : rawName || "Unbekannt";
      const displayName = staffId === "unassigned" ? fallbackName : rawName || fallbackName;
      const initialLetter = displayName.trim().charAt(0).toUpperCase() || "•";
      const badgeColor = staff.color ?? "#9ca3af";
      const badgeTextColor = getReadableTextColor(badgeColor);
      return {
        key: `${dayKey}-${staffId}`,
        day,
        header: displayName,
        headerStatus: statusLabel ?? undefined,
        staff,
        staffId,
        placements: layout.appointmentPlacements,
        blockerPlacements: layout.blockerPlacements,
        availabilityRanges,
        headerInitial:
          staffId === "unassigned"
            ? undefined
            : { letter: initialLetter, color: badgeColor, textColor: badgeTextColor },
      };
    });
  }, [
    isSingleDay,
    days,
    groupedAppointments,
    groupedBlockers,
    activeStaffIds,
    staffIndexWithUnassigned,
    availability,
    staffStatus,
    displayStart,
    displayEnd,
  ]);

  const multiDayColumns = useMemo<ColumnConfig[]>(() => {
    return days.map((day) => {
      const key = day.toISOString();
      const appointmentsForDay = groupedAppointments.get(key) ?? [];
      const blockersForDay = groupedBlockers.get(key) ?? [];
      const layout = layoutColumnEvents(day, appointmentsForDay, blockersForDay);
      const formattedDayKey = format(day, "yyyy-MM-dd");
      const availabilityRanges = mergeRanges(
        staffIdsForAvailability.flatMap((id) => availability?.[id]?.[formattedDayKey] ?? []),
      )
        .map((range) => clampRange(range, displayStart, displayEnd))
        .filter((range): range is { start: number; end: number } => Boolean(range));
      return {
        key,
        day,
        header: format(day, "EEE, dd.MM."),
        placements: layout.appointmentPlacements,
        blockerPlacements: layout.blockerPlacements,
        availabilityRanges,
      };
    });
  }, [
    days,
    groupedAppointments,
    groupedBlockers,
    staffIdsForAvailability,
    availability,
    displayStart,
    displayEnd,
  ]);

  const columns = isSingleDay ? singleDayColumns : multiDayColumns;
  useEffect(() => {
    const map = new Map<string, ColumnConfig>();
    for (const column of columns) {
      map.set(column.key, column);
    }
    columnMetaRef.current = map;
  }, [columns]);

  const scrollStyle = { maxHeight: viewportHeight ?? "70vh" };
  const compactLayout = !isSingleDay && days.length > 1;
  const currentTimeInfo = useMemo(() => getCurrentTimeInfo(now, location.timezone), [now, location.timezone]);
  const currentTimePosition = useMemo(() => {
    if (!currentTimeInfo) {
      return null;
    }
    const hasMatchingDay = columns.some(
      (column) => format(column.day, "yyyy-MM-dd") === currentTimeInfo.dayKey,
    );
    if (!hasMatchingDay) {
      return null;
    }
    const top = currentTimeInfo.minutes - displayStart;
    if (top < 0 || top > displayTotalMinutes) {
      return null;
    }
    return { top, label: currentTimeInfo.label };
  }, [columns, currentTimeInfo, displayStart, displayTotalMinutes]);

  useEffect(() => {
    if (!AUTO_FOLLOW_ENABLED || !currentTimePosition || !autoFollowRef.current) {
      return;
    }
    const slotContainer = slotScrollRef.current;
    if (!slotContainer) {
      return;
    }
    const visibleHeight = slotContainer.clientHeight;
    if (visibleHeight <= 0) {
      return;
    }
    const contentHeight = slotContainer.scrollHeight;
    const desired = currentTimePosition.top * pixelsPerMinute - visibleHeight / 2;
    const clamped = Math.max(0, Math.min(contentHeight - visibleHeight, desired));
    if (Math.abs(slotContainer.scrollTop - clamped) < 1) {
      return;
    }
    const timelineContainer = timelineScrollRef.current;
    isSyncingRef.current = true;
    slotContainer.scrollTo({ top: clamped, behavior: "smooth" });
    timelineContainer?.scrollTo({ top: clamped, behavior: "smooth" });
    window.setTimeout(() => {
      isSyncingRef.current = false;
    }, 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- AUTO_FOLLOW_ENABLED is static
  }, [currentTimePosition, pixelsPerMinute]);

  const columnHeaders = columns.map((column, columnIndex) => {
    const headerTitle = <span className="truncate text-sm font-semibold text-zinc-900">{column.header}</span>;
    const headerStatus = column.headerStatus ? (
      <span className="self-center text-center text-xs font-semibold text-zinc-500">{column.headerStatus}</span>
    ) : null;
    const headerContent = column.headerInitial ? (
      <div className="flex items-center gap-2">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold uppercase shadow-sm"
          style={{ backgroundColor: column.headerInitial.color, color: column.headerInitial.textColor }}
        >
          {column.headerInitial.letter}
        </span>
        <div className="flex flex-col">
          {headerTitle}
          {headerStatus}
          {column.subHeader && <span className="text-xs font-medium text-zinc-500">{column.subHeader}</span>}
        </div>
      </div>
    ) : (
      <div className="flex flex-col">
        {headerTitle}
        {headerStatus}
        {column.subHeader && <span className="text-xs font-medium text-zinc-500">{column.subHeader}</span>}
      </div>
    );
    return (
      <div
        key={`${column.key}-header`}
        className={`flex h-12 flex-1 items-center bg-white px-4 ${columnIndex === 0 ? "" : "border-l border-zinc-200"}`}
      >
        {headerContent}
      </div>
    );
  });

  return (
    <section className="overflow-visible rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-max overflow-visible">
          <div className="flex overflow-visible">
            <div className="flex w-[4.5rem] flex-none flex-col border-r border-zinc-200 bg-white">
              <div className="h-12 border-b border-zinc-200 bg-white" />
              <div
                ref={timelineScrollRef}
                className="overflow-y-auto"
                style={scrollStyle}
                onScroll={handleTimelineScroll}
              >
                <div className="relative bg-white" style={{ height: `${minutesToPixels(displayTotalMinutes)}px` }}>
                  {slots.map((minute) => {
                    const hour = Math.floor(minute / 60) % 24;
                    const mins = minute % 60;
                    const label = mins === 0 ? `${hour.toString().padStart(2, "0")}:00` : "";
                    return (
                      <div
                        key={minute}
                        className={`relative flex items-start px-3 text-xs text-zinc-500 ${
                          mins === 0 ? "font-medium text-zinc-700" : ""
                        }`}
                        style={{ height: `${SLOT_PIXEL_HEIGHT}px` }}
                      >
                        {label && (
                          <span className="absolute -top-2 left-3 leading-none">
                            {label}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {currentTimePosition && (
                    <div
                      className="pointer-events-none absolute inset-x-0 z-[55]"
                      style={{ top: `${minutesToPixels(currentTimePosition.top)}px` }}
                    >
                      <span className="block -translate-y-1/2 rounded-full bg-white px-3 py-0.5 text-xs font-semibold text-zinc-900">
                        {currentTimePosition.label}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex border-b border-zinc-200">{columnHeaders}</div>
              <div
                ref={slotScrollRef}
                className="relative overflow-y-auto"
                style={scrollStyle}
                onScroll={handleSlotsScroll}
              >
                {currentTimePosition && (
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-[65]"
                    style={{ top: `${minutesToPixels(currentTimePosition.top)}px` }}
                  >
                    <div className="relative -translate-y-1/2">
                      <div className="h-px w-full bg-black/70" />
                    </div>
                  </div>
                )}
                <div className="flex">
                  {columns.map((column, columnIndex) => {
                  const { key, day, placements, blockerPlacements, availabilityRanges, staff } = column;
                  const dragHighlight =
                    dragPreview && dragPreview.columnKey === key
                      ? {
                          top: Math.min(dragPreview.startMinutes, dragPreview.currentMinutes) - displayStart,
                            height:
                              Math.max(
                                slotMinutes,
                                Math.abs(dragPreview.currentMinutes - dragPreview.startMinutes) + slotMinutes,
                              ),
                          }
                        : null;
                    const cardPreviewOverlay =
                      cardDragPreview && cardDragPreview.columnKey === key
                        ? (() => {
                            const top = Math.max(0, cardDragPreview.startMinutes - displayStart);
                            const maxHeight = displayTotalMinutes - top;
                            if (maxHeight <= 0) return null;
                            const previewMinHeight =
                              cardDragPreview.type === "appointment" ? MIN_APPOINTMENT_MINUTES : slotMinutes;
                            const height = Math.min(
                              Math.max(cardDragPreview.durationMinutes, previewMinHeight),
                              maxHeight,
                            );
                            return {
                              top,
                              height,
                              type: cardDragPreview.type,
                              startMinutes: cardDragPreview.startMinutes,
                              day: cardDragPreview.day,
                            };
                          })()
                        : null;
                    const slotHighlight =
                      activeSlotHighlight &&
                      isSameDay(activeSlotHighlight.start, day) &&
                      (!activeSlotHighlight.staffId || activeSlotHighlight.staffId === staff?.id)
                        ? (() => {
                            const startMinutes = differenceInMinutes(activeSlotHighlight.start, setTime(day, START_HOUR));
                            const endMinutes = differenceInMinutes(activeSlotHighlight.end, setTime(day, START_HOUR));
                            const top = Math.max(0, startMinutes - displayStart);
                            const height = Math.max(slotMinutes, endMinutes - startMinutes);
                            const color = staff?.color ?? "#0ea5e9";
                            return { top, height, color };
                          })()
                        : null;
                  return (
                    <div
                      key={key}
                      className={`flex-1 ${columnIndex === 0 ? "" : "border-l border-zinc-200"}`}
                      ref={registerColumnRef(key)}
                      >
                        <div
                          className="relative border-b border-zinc-200 bg-[#f9fafc]"
                          style={{ height: `${minutesToPixels(displayTotalMinutes)}px` }}
                          onPointerDown={(event) => handleSlotPointerDown(event, column)}
                        >
                          <div className="pointer-events-none absolute inset-0 z-0 bg-[repeating-linear-gradient(135deg,rgba(180,188,199,0.3)_0px,rgba(180,188,199,0.3)_5.5px,rgba(249,250,252,0.96)_5.5px,rgba(249,250,252,0.96)_12px)]" />
                          {availabilityRanges.map((range, index) => (
                            <div
                              key={`${key}-avail-${index}`}
                              className="pointer-events-none absolute left-0 right-0 z-10 bg-white calendar-free-slot"
                              style={{
                                backgroundColor: "#ffffff",
                                top: `${minutesToPixels(range.start - displayStart)}px`,
                                height: `${minutesToPixels(range.end - range.start)}px`,
                              }}
                            />
                          ))}
                          <div className="pointer-events-none absolute inset-0 z-20">
                            {slots.map((minute) => (
                              <div
                                key={`${key}-${minute}`}
                                className={`${minute % 60 === 0 ? "border-t border-zinc-200" : "border-t border-zinc-100"}`}
                                style={{ height: `${SLOT_PIXEL_HEIGHT}px` }}
                              />
                            ))}
                            <div className="absolute bottom-0 left-0 right-0 border-b border-zinc-200" />
                          </div>
                          {dragHighlight && (
                            <div
                              className="pointer-events-none absolute left-0 right-0 z-[60]"
                              style={{
                                top: `${minutesToPixels(dragHighlight.top)}px`,
                                height: `${minutesToPixels(dragHighlight.height)}px`,
                              }}
                            >
                              <div className="h-full rounded-md border border-sky-500 bg-sky-500/20" />
                            </div>
                          )}
                          {slotHighlight && (
                            <div
                              className="pointer-events-none absolute left-0 right-0 z-[58]"
                              style={{
                                top: `${minutesToPixels(slotHighlight.top)}px`,
                                height: `${minutesToPixels(slotHighlight.height)}px`,
                              }}
                            >
                              <div
                                className="h-full rounded-md border"
                                style={{ backgroundColor: slotHighlight.color, borderColor: slotHighlight.color, opacity: 0.18 }}
                              />
                            </div>
                          )}
                          {cardPreviewOverlay && (
                            <div
                              className="pointer-events-none absolute left-0 right-0 z-[70]"
                              style={{
                                top: `${minutesToPixels(cardPreviewOverlay.top)}px`,
                                height: `${minutesToPixels(cardPreviewOverlay.height)}px`,
                              }}
                            >
                              <div
                                className={`flex h-full items-center justify-between gap-3 rounded-md border px-3 text-xs font-semibold shadow-lg ${
                                  cardPreviewOverlay.type === "appointment"
                                    ? "border-emerald-500 bg-emerald-500/15 text-emerald-900"
                                    : "border-zinc-500 bg-zinc-500/15 text-zinc-900"
                                }`}
                              >
                                <span>
                                  {cardPreviewOverlay.type === "appointment" ? "Termin verschieben" : "Blocker verschieben"}
                                </span>
                                <span className="font-bold">
                                  {cardPreviewOverlay
                                    ? (() => {
                                        const mins = Number.isFinite(cardPreviewOverlay.startMinutes)
                                          ? cardPreviewOverlay.startMinutes
                                          : 0;
                                        const ts = combineDateWithMinutesInTimeZone(
                                          cardPreviewOverlay.day,
                                          mins,
                                          location.timezone,
                                        );
                                        if (Number.isNaN(ts.getTime())) return "";
                                        return format(ts, "HH:mm");
                                      })()
                                    : ""}
                                </span>
                              </div>
                            </div>
                          )}
                          <div className="relative overflow-visible">
                            {blockerPlacements.map(({ blocker, laneIndex, laneCount }) => (
                            <DayBlockerCard
                              key={blocker.id}
                              blocker={blocker}
                              day={day}
                              displayStart={displayStart}
                              displayTotalMinutes={displayTotalMinutes}
                              staff={
                                staff ??
                                (typeof blocker.staffId === "string" && blocker.staffId
                                  ? staffIndexWithUnassigned.get(blocker.staffId)
                                  : undefined)
                              }
                              onSelect={onSelectBlocker}
                              laneIndex={laneIndex}
                              laneCount={laneCount}
                              preferLeftTooltip={columnIndex === columns.length - 1}
                              slotMinutes={slotMinutes}
                              pixelsPerMinute={pixelsPerMinute}
                              dragging={
                                cardDragPreview?.type === "blocker" && cardDragPreview.sourceId === blocker.id
                              }
                              recentCardDragRef={recentCardDragRef}
                                onDragStart={(event) =>
                                  handleCardPointerDown(event, {
                                    type: "blocker",
                                    record: blocker,
                                    columnKey: key,
                                    day,
                                    staffId: staff?.id,
                                  })
                                }
                              />
                            ))}
                            {placements.map((placement) => (
                              <DayAppointmentCard
                                key={`${placement.appointment.id}-${placement.laneIndex}`}
                                appointment={placement.appointment}
                                laneIndex={placement.laneIndex}
                                laneCount={placement.laneCount}
                                recentCardDragRef={recentCardDragRef}
                                staffIndex={staffIndexWithUnassigned}
                                day={day}
                                displayStart={displayStart}
                                displayTotalMinutes={displayTotalMinutes}
                                slotMinutes={slotMinutes}
                                pixelsPerMinute={pixelsPerMinute}
                                onSelect={onSelectAppointment}
                                compactLayout={compactLayout}
                                currentTime={now}
                                preferLeftTooltip={columnIndex === columns.length - 1}
                                dragging={
                                  cardDragPreview?.type === "appointment" &&
                                  cardDragPreview.sourceId === placement.appointment.id
                                }
                                highlightedAppointmentId={highlightedAppointmentId}
                                onDragStart={(event) =>
                                  handleCardPointerDown(event, {
                                    type: "appointment",
                                    record: placement.appointment,
                                    columnKey: key,
                                    day,
                                    staffId: column.staffId,
                                  })
                                }
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

type CurrentTimeInfo = {
  dayKey: string;
  minutes: number;
  label: string;
};

function getCurrentTimeInfo(date: Date, timeZone: string): CurrentTimeInfo | null {
  try {
    const zone = timeZone && timeZone.length > 0 ? timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const record: Record<string, string> = {};
    for (const part of parts) {
      if (part.type === "literal") {
        continue;
      }
      if (!record[part.type]) {
        record[part.type] = part.value;
      }
    }
    const year = record.year;
    const month = record.month;
    const day = record.day;
    const hour = record.hour;
    const minute = record.minute;
    if (!year || !month || !day || !hour || !minute) {
      return null;
    }
    const minutes = Number.parseInt(hour, 10) * 60 + Number.parseInt(minute, 10);
    if (!Number.isFinite(minutes)) {
      return null;
    }
    return {
      dayKey: `${year}-${month}-${day}`,
      minutes,
      label: `${hour}:${minute}`,
    };
  } catch {
    return null;
  }
}

function DayBlockerCard({
  blocker,
  day,
  displayStart,
  displayTotalMinutes,
  slotMinutes,
  pixelsPerMinute,
  staff,
  onSelect,
  laneIndex,
  laneCount,
  preferLeftTooltip = false,
  dragging = false,
  onDragStart,
  recentCardDragRef,
}: {
  blocker: TimeBlockerRecord;
  day: Date;
  displayStart: number;
  displayTotalMinutes: number;
  slotMinutes: number;
  pixelsPerMinute: number;
  staff?: { id: string; name: string; color: string };
  onSelect?: (payload: { blocker: TimeBlockerRecord; staff?: { id: string; name: string; color: string } }) => void;
  laneIndex: number;
  laneCount: number;
  preferLeftTooltip?: boolean;
  dragging?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  recentCardDragRef?: React.MutableRefObject<number>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const defaultTooltipOffsetRef = useRef(0);
  const [tooltipOffset, setTooltipOffset] = useState(0);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>({ top: 0, left: 0 });
  const [tooltipSide, setTooltipSide] = useState<"left" | "right">(preferLeftTooltip ? "left" : "right");
  const pointerFine = usePointerFine();
  const [showTooltipBlocker, setShowTooltipBlocker] = useState(false);

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

  const geometry = computeBlockerGeometry(blocker, day, displayStart, displayTotalMinutes, slotMinutes);
  if (!geometry) {
    return null;
  }
  const timeLabel = `${format(geometry.start, "HH:mm")} – ${format(geometry.end, "HH:mm")}`;
  const staffName = staff?.name ?? "Nicht definiert";
  const staffInitial = staffName.trim().charAt(0).toUpperCase() || "•";
  const createdByNameRaw = typeof blocker.createdByName === "string" ? blocker.createdByName.trim() : "";
  const createdByDisplayName = createdByNameRaw.length ? createdByNameRaw : "Mitarbeiter";
  const createdByFirstName = createdByDisplayName.split(/\s+/)[0] || createdByDisplayName;
  const label = payloadLabel(blocker);
  const isHold = blocker.isHold === true;
  const holdSource = blocker.holdSource ?? "online";
  const shouldPulseHold = isHold && holdSource === "staff";
  const holdLabel =
    holdSource === "staff" ? `Reservierung durch ${createdByFirstName}` : "Online Reservierung in Arbeit";
  const displayLabel = isHold ? holdLabel : label;
  const holdExpiryLabel = blocker.expiresAt ? format(blocker.expiresAt, "HH:mm") : null;
  const holdServiceLabel =
    isHold && blocker.serviceNames?.length ? blocker.serviceNames.join(", ") : null;
  const detailBody = isHold
    ? holdExpiryLabel
      ? `Reserviert bis ${holdExpiryLabel} Uhr.`
      : holdSource === "staff"
        ? `Reservierung durch ${createdByFirstName} aktiv.`
        : "Online-Reservierung aktiv."
    : blocker.reasonType === "OTHER"
      ? blocker.customReason?.trim() || "Kein Grund hinterlegt."
      : blocker.reason?.trim() || label;

  const laneSpan = Math.max(1, laneCount);
  const laneWidth = 100 / laneSpan;
  const laneLeft = laneIndex * laneWidth;
  const insetLeftPx = 0;
  const isLastLane = laneIndex === laneCount - 1;
  const rightMarginPx = isLastLane ? 20 : 2;
  const laneGapPx = laneCount > 1 ? 0 : 0;
  const laneOffsetPx = laneIndex === 0 ? insetLeftPx : Math.max(0, insetLeftPx - laneGapPx);

  const topPx = geometry.top * pixelsPerMinute;
  const heightPx = geometry.height * pixelsPerMinute;

  return (
    <div
      ref={containerRef}
      className="absolute z-[40] h-full overflow-visible"
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        left: `calc(${laneLeft}% + ${laneOffsetPx}px)`,
        width: `calc(${laneWidth}% - ${laneOffsetPx + rightMarginPx}px)`,
      }}
      onPointerLeave={() => setTooltipOffset(defaultTooltipOffsetRef.current)}
      onPointerDown={(event) => {
        if (isHold || dragging) {
          event.preventDefault();
          return;
        }
        onDragStart?.(event);
      }}
    >
      <div
        className={`group/blocker relative flex h-full w-full items-start gap-3 rounded-md border px-3 py-1.5 text-left shadow-sm select-none ${
          isHold
            ? "border-dashed border-zinc-400 bg-zinc-200/80 text-zinc-700"
            : "border-[#727272] bg-[#8f8f8f] text-white"
        } ${dragging ? "cursor-grabbing" : isHold ? "cursor-default" : "cursor-grab"} ${shouldPulseHold ? "animate-pulse" : ""}`}
        data-blocker-card
        onClick={(event) => {
          event.stopPropagation();
          if (!dragging && !isHold) {
            if (recentCardDragRef && Date.now() - recentCardDragRef.current < 300) {
              return;
            }
            onSelect?.({ blocker, staff });
          }
        }}
        onPointerMove={(event) => {
          if (!pointerFine) return;
          const rect = containerRef.current?.getBoundingClientRect();
          const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
          const tooltipWidth = tooltipRef.current?.offsetWidth ?? 280;
          if (!rect || !tooltipHeight) return;
          const margin = 12;
          const viewportHeight = window.innerHeight;
          const cursorOffset = event.clientY - rect.top - tooltipHeight / 2;
          const absoluteTop = rect.top + cursorOffset;
          const clampedAbsoluteTop = Math.max(margin, Math.min(absoluteTop, viewportHeight - tooltipHeight - margin));
          setTooltipOffset(clampedAbsoluteTop - rect.top);
          const left = tooltipSide === "left" ? rect.left - tooltipWidth - 12 : rect.right + 12;
          setTooltipPosition({ top: clampedAbsoluteTop, left });
        }}
        onPointerEnter={() => {
          if (!pointerFine) return;
          setShowTooltipBlocker(true);
        }}
        onPointerLeave={() => {
          if (!pointerFine) return;
          setShowTooltipBlocker(false);
          setTooltipOffset(defaultTooltipOffsetRef.current);
        }}
      >
        {isHold ? (
          <div className="flex flex-1 items-center overflow-hidden text-xs">
            <span className="truncate text-[12px] font-semibold text-zinc-700">{displayLabel}</span>
          </div>
        ) : (
          <>
            <span
              className="mt-1 h-2.5 w-2.5 flex-shrink-0 self-start rounded-full"
              style={{ backgroundColor: staff?.color ?? "#6b7280" }}
            />
            <div className="flex flex-1 flex-col items-start gap-0.5 text-xs">
              <span className="text-[13px] font-semibold leading-tight text-white">{staffName}</span>
              <span className="text-[12px] font-medium text-zinc-100/80">{displayLabel}</span>
            </div>
            <span className="pointer-events-none absolute bottom-1.5 right-2 text-2xl font-bold leading-none text-zinc-100/70">
              ⦸
            </span>
          </>
        )}

      {typeof document !== "undefined" && pointerFine && showTooltipBlocker &&
        createPortal(
          <div
            ref={tooltipRef}
            className="pointer-events-none fixed z-[2147483640] w-64 flex-col gap-3 rounded-xl border border-zinc-200 bg-white shadow-xl"
            style={{ top: `${tooltipPosition.top}px`, left: `${tooltipPosition.left}px` }}
            >
              <header className="rounded-t-xl bg-zinc-500 px-4 py-2 text-sm font-semibold text-white">
                {isHold ? holdLabel : `Zeitblocker (${label})`}
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
                    {holdServiceLabel && <p className="text-xs text-zinc-600">Leistung: {holdServiceLabel}</p>}
                    {detailBody && <p className="text-xs text-zinc-500">{detailBody}</p>}
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}

type CombinedEntry =
  | { type: "appointment"; appointment: AppointmentRecord; start: Date; end: Date }
  | { type: "blocker"; blocker: TimeBlockerRecord; start: Date; end: Date };

function layoutColumnEvents(
  day: Date,
  appointments: AppointmentRecord[],
  blockers: TimeBlockerRecord[],
): { appointmentPlacements: Placement[]; blockerPlacements: BlockerPlacement[] } {
  const dayStart = setTime(day, START_HOUR);
  const dayEnd = addMinutes(dayStart, TOTAL_MINUTES);

  const entries: CombinedEntry[] = [];

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
  const laneAssignments: Array<{ entry: CombinedEntry; laneIndex: number }> = [];

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
  const appointmentPlacements: Placement[] = [];
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

function payloadLabel(blocker: TimeBlockerRecord): string {
  if (blocker.reasonType && TIME_BLOCKER_LABELS[blocker.reasonType]) {
    return TIME_BLOCKER_LABELS[blocker.reasonType];
  }
  if (blocker.reason) {
    return blocker.reason.replace(/^Zeitblocker\s*(·|:)\s*/, "").trim() || blocker.reason;
  }
  return "–";
}

function DayAppointmentCard({
  appointment,
  laneIndex,
  laneCount,
  staffIndex,
  day,
  displayStart,
  displayTotalMinutes,
  slotMinutes,
  pixelsPerMinute,
  onSelect,
  compactLayout,
  currentTime,
  preferLeftTooltip = false,
  dragging = false,
  onDragStart,
  recentCardDragRef,
  highlightedAppointmentId,
}: {
  appointment: AppointmentRecord;
  laneIndex: number;
  laneCount: number;
  staffIndex: StaffIndex;
  day: Date;
  displayStart: number;
  displayTotalMinutes: number;
  slotMinutes: number;
  pixelsPerMinute: number;
  onSelect?: (payload: { appointmentId: string; itemId?: string }) => void;
  compactLayout: boolean;
  currentTime: Date;
  preferLeftTooltip?: boolean;
  dragging?: boolean;
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  recentCardDragRef?: React.MutableRefObject<number>;
  highlightedAppointmentId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>({ top: 0, left: 0 });
  const pointerFine = usePointerFine();
  const [showTooltipAppt, setShowTooltipAppt] = useState(false);
  const openTooltipTimerRef = useRef<number | null>(null);
  const closeTooltipTimerRef = useRef<number | null>(null);

  const scheduleTooltipOpen = useCallback(() => {
    if (!pointerFine) return;
    if (closeTooltipTimerRef.current) {
      window.clearTimeout(closeTooltipTimerRef.current);
      closeTooltipTimerRef.current = null;
    }
    if (openTooltipTimerRef.current) {
      window.clearTimeout(openTooltipTimerRef.current);
      openTooltipTimerRef.current = null;
    }
    if (showTooltipAppt) return;
    openTooltipTimerRef.current = window.setTimeout(() => {
      setShowTooltipAppt(true);
    }, TOOLTIP_OPEN_DELAY_MS);
  }, [pointerFine, showTooltipAppt]);

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
    if (!showTooltipAppt) return;
    closeTooltipTimerRef.current = window.setTimeout(() => {
      setShowTooltipAppt(false);
    }, TOOLTIP_CLOSE_DELAY_MS);
  }, [pointerFine, showTooltipAppt]);

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

  const updateTooltipPosition = useCallback(
    (clientY?: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const tooltipHeight = tooltipRef.current?.offsetHeight ?? 0;
      const tooltipWidth = tooltipRef.current?.offsetWidth ?? 280;
      if (!rect || !tooltipHeight || !tooltipWidth) return;
      const spaceRight = window.innerWidth - rect.right;
      const spaceLeft = rect.left;
      const shouldPreferLeft = preferLeftTooltip || (spaceRight < tooltipWidth && spaceLeft > spaceRight);

      const margin = 12;
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      const cursorOffset = typeof clientY === "number"
        ? clientY - rect.top - tooltipHeight / 2
        : rect.height / 2 - tooltipHeight / 2;
      const absoluteTop = rect.top + cursorOffset;
      const clampedTop = Math.max(margin, Math.min(absoluteTop, viewportHeight - tooltipHeight - margin));
      const baseLeft = shouldPreferLeft ? rect.left - tooltipWidth - 12 : rect.right + 12;
      const clampedLeft = Math.max(margin, Math.min(baseLeft, viewportWidth - tooltipWidth - margin));
      setTooltipPosition({ top: clampedTop, left: clampedLeft });
    },
    [preferLeftTooltip],
  );

  useLayoutEffect(() => {
    if (!pointerFine || !showTooltipAppt) return;
    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
    };
  }, [pointerFine, showTooltipAppt, updateTooltipPosition, appointment.startsAt, appointment.endsAt]);

  const start = appointment.startsAt;
  const end = appointment.endsAt;
  const minutesFromMidnight = differenceInMinutes(start, setTime(day, START_HOUR));
  const minutesFromStart = minutesFromMidnight - displayStart;
  const duration = Math.max(MIN_APPOINTMENT_MINUTES, differenceInMinutes(end, start));
  const maxTop = Math.max(0, displayTotalMinutes - MIN_APPOINTMENT_MINUTES);
  const top = Math.max(0, Math.min(maxTop, minutesFromStart));
  const height = Math.max(MIN_APPOINTMENT_MINUTES, Math.min(duration, displayTotalMinutes - top));
  const topPx = top * pixelsPerMinute;
  const heightPx = height * pixelsPerMinute;
  const laneSpan = Math.max(1, laneCount);
  const laneWidth = 100 / laneSpan;
  const laneLeft = laneIndex * laneWidth;

  const staff = appointment.staffId ? staffIndex.get(appointment.staffId) : undefined;
  const isCancelled = appointment.status === "CANCELLED";
  const isNoShow = appointment.status === "NO_SHOW";
  const isPast = end.getTime() <= currentTime.getTime();
  const baseColor = isNoShow ? "#e5e7eb" : staff?.color ?? "#e5e7eb";
  const cardBackgroundColor = isCancelled ? "#ffffff" : isNoShow ? "#f3f4f6" : baseColor;
  const cardPrimaryText = isCancelled ? "#1f2937" : isNoShow ? "#111827" : getReadableTextColor(cardBackgroundColor);
  const cardSecondaryText = isCancelled
    ? "rgba(17,24,39,0.75)"
    : isNoShow
    ? "rgba(63,63,70,0.9)"
    : cardPrimaryText === "#ffffff"
    ? "rgba(255,255,255,0.85)"
    : "rgba(55,65,81,0.8)";
  const cardTertiaryText = isCancelled
    ? "rgba(17,24,39,0.6)"
    : isNoShow
    ? "rgba(63,63,70,0.7)"
    : cardPrimaryText === "#ffffff"
    ? "rgba(255,255,255,0.7)"
    : "rgba(55,65,81,0.6)";
  const borderColor = isCancelled
    ? "rgba(17,24,39,0.35)"
    : isNoShow
    ? "rgba(75,85,99,0.45)"
    : toRgba(cardPrimaryText, isPast ? 0.1 : 0.15);
  const cancelIconColor = "#111827";
  const timeLabel = `${format(start, "HH:mm")} – ${format(end, "HH:mm")}`;
  const statusMeta = STATUS_META[appointment.status] ?? STATUS_META.PENDING;
  const insetLeftPx = 0;
  const isLastLane = laneIndex === laneCount - 1;
  const rightMarginPx = isLastLane ? 20 : 2;
  const laneGapPx = laneCount > 1 ? 0 : 0;
  const laneOffsetPx = laneIndex === 0 ? insetLeftPx : Math.max(0, insetLeftPx - laneGapPx);
  const showInternalNote = Boolean(appointment.internalNote && !appointment.internalNoteIsTitle);
  const isOnlineBooking = Boolean(appointment.isOnline);
  const customerName = appointment.customerName?.trim() || appointment.displayLabel || "Kunde";
  const customerPhone = appointment.customerPhone?.trim() || "";
  const staffName = staff?.name ?? "Nicht definiert";
  const staffInitial = staffName.trim().charAt(0).toUpperCase() || "•";
  const bookingSourceLabel = isOnlineBooking ? "Online gebucht" : "Manuell gebucht";
  const staffSelectionLabel = isOnlineBooking
    ? "Vom Kunden ausgewählt"
    : staff
      ? "Vom Team ausgewählt"
      : "Nicht zugewiesen";
  const serviceLabel = appointment.serviceName?.trim() || appointment.displayLabel || "Service";
  const statusLabel = statusMeta.label;
  const headerLabel = `${statusLabel} (${timeLabel})`;
  const onlineBadgeOffsetClass = isCancelled || isNoShow ? "right-8" : "right-1.5";
  const isHighlighted =
    typeof highlightedAppointmentId === "string" &&
    highlightedAppointmentId.length > 0 &&
    (appointment.appointmentId === highlightedAppointmentId || appointment.id === highlightedAppointmentId);
  const highlightOutline = isHighlighted ? "2px solid #ef4444" : "none";
  const highlightOutlineOffset = isHighlighted ? "2px" : undefined;

  return (
    <div
      ref={containerRef}
      className="group/tooltip absolute z-[50] h-full overflow-visible"
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        left: `calc(${laneLeft}% + ${laneOffsetPx}px)`,
        width: `calc(${laneWidth}% - ${laneOffsetPx + rightMarginPx}px)`,
      }}
      onPointerDown={(event) => {
        if (dragging) {
          event.preventDefault();
          return;
        }
        onDragStart?.(event);
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (dragging) return;
          if (recentCardDragRef && Date.now() - recentCardDragRef.current < 300) {
            return;
          }
          onSelect?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!dragging) {
              onSelect?.({ appointmentId: appointment.appointmentId, itemId: appointment.id });
            }
          }
        }}
        className={`relative h-full w-full overflow-hidden rounded-md px-2 pt-0.5 pb-1 text-left text-xs shadow-sm ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        } select-none`}
        style={{
          backgroundColor: cardBackgroundColor,
          color: cardPrimaryText,
          border: `1px solid ${borderColor}`,
          outline: highlightOutline,
          outlineOffset: highlightOutlineOffset,
        }}
        data-appointment-card
        data-blocks-availability={(!isCancelled).toString()}
        data-appointment-status={appointment.status}
        onPointerMove={(event) => {
          if (!pointerFine || !showTooltipAppt) return;
          updateTooltipPosition(event.clientY);
        }}
        onPointerEnter={scheduleTooltipOpen}
        onPointerLeave={() => {
          scheduleTooltipClose();
        }}
        onFocus={scheduleTooltipOpen}
        onBlur={scheduleTooltipClose}
      >
        {isPast && (
          <div className="pointer-events-none absolute inset-0 rounded-md bg-white/20" style={{ zIndex: 0 }} />
        )}
        {isCancelled && (
          <span
            className="pointer-events-none absolute right-1.5 top-0.5 z-20 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#4b4b4b]"
            aria-hidden="true"
          >
            <CancelledCalendarIcon className="h-4 w-4 text-white" />
          </span>
        )}
        {isNoShow && (
          <span
            className="pointer-events-none absolute right-1 top-0 z-20 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-600 shadow shadow-rose-200"
            aria-hidden="true"
          >
            <span className="text-lg font-extrabold leading-none text-white">×</span>
          </span>
        )}
        {isOnlineBooking && (
          <span
            className={`absolute ${onlineBadgeOffsetClass} top-1 z-20 h-2.5 w-2.5 rounded-full bg-blue-600 shadow-sm`}
            title="Vom Kunden online gebucht"
          />
        )}
        <div style={{ paddingTop: "2px" }} className="relative z-10 space-y-0.5">
          <p className="line-clamp-1 text-[11px] font-semibold leading-tight" style={{ color: cardPrimaryText }}>
            {appointment.displayLabel}
          </p>
          {appointment.note && (
            <p className="line-clamp-2 text-[11px] leading-tight" style={{ color: cardSecondaryText }}>
              {appointment.note}
            </p>
          )}
          {showInternalNote && (
            <p className="line-clamp-2 text-[11px] leading-tight" style={{ color: cardSecondaryText }}>
              {appointment.internalNote}
            </p>
          )}
          {appointment.hasService && appointment.displayLabel !== appointment.serviceName && (
            <p className="line-clamp-1 text-[11px] leading-tight" style={{ color: cardSecondaryText }}>
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
      {typeof document !== "undefined" && pointerFine && showTooltipAppt &&
        createPortal(
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
        )}
    </div>
  );
}

function computeBlockerGeometry(
  blocker: TimeBlockerRecord,
  day: Date,
  displayStart: number,
  displayTotalMinutes: number,
  slotMinutes: number,
): { top: number; height: number; label: string; start: Date; end: Date } | null {
  const dayStart = setTime(day, START_HOUR);
  const dayEnd = addMinutes(dayStart, TOTAL_MINUTES);
  const intervalStart = blocker.startsAt > dayStart ? blocker.startsAt : dayStart;
  const intervalEnd = blocker.endsAt < dayEnd ? blocker.endsAt : dayEnd;
  if (!(intervalEnd > intervalStart)) {
    return null;
  }

  const absoluteStart = differenceInMinutes(intervalStart, dayStart);
  const absoluteEnd = differenceInMinutes(intervalEnd, dayStart);
  const clampedStart = Math.max(displayStart, absoluteStart);
  const clampedEnd = Math.min(displayStart + displayTotalMinutes, absoluteEnd);
  if (clampedEnd <= clampedStart) {
    return null;
  }

  const top = clampedStart - displayStart;
  const available = displayTotalMinutes - top;
  if (available <= 0) {
    return null;
  }

  const desired = clampedEnd - clampedStart;
  const minHeight = Math.min(slotMinutes, available);
  const height = Math.min(Math.max(desired, minHeight), available);

  return {
    top,
    height,
    label: payloadLabel(blocker),
    start: intervalStart,
    end: intervalEnd,
  };
}

function blockerOverlapsDay(blocker: TimeBlockerRecord, day: Date) {
  const dayStart = setTime(day, START_HOUR);
  const dayEnd = addMinutes(dayStart, TOTAL_MINUTES);
  return blocker.startsAt < dayEnd && blocker.endsAt > dayStart;
}

function setTime(date: Date, hours: number) {
  const clone = new Date(date);
  clone.setHours(hours, 0, 0, 0);
  return clone;
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
