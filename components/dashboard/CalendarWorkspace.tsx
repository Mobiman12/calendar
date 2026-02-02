"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addDays,
  addMinutes,
  addMonths,
  endOfDay,
  endOfMonth,
  format,
  getISOWeek,
  isSameDay,
  isSameWeek,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { CalendarToolbar } from "@/components/dashboard/CalendarToolbar";
import { NextFreeSlotsDialog } from "@/components/dashboard/NextFreeSlotsDialog";
import { CalendarDaysView } from "@/components/dashboard/views/CalendarDaysView";
import type { CalendarAppointmentRecord } from "@/components/dashboard/views/CalendarDaysView";
import { CalendarListView } from "@/components/dashboard/views/CalendarListView";
import { SchedulerDrawer, type SchedulerContext } from "@/components/dashboard/SchedulerDrawer";
import { AppointmentDetailDrawer } from "@/components/appointments/AppointmentDetailDrawer";
import type { AppointmentDetailPayload } from "@/components/appointments/types";
import { useBookingPinAuth } from "@/components/dashboard/useBookingPinAuth";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";
import { useToast } from "@/components/ui/ToastProvider";
import { loadUserPreferences, USER_PREFERENCES_EVENT, USER_PREFERENCES_STORAGE_KEY, type UserPreferences } from "@/lib/user-preferences";
import {
  SERVICE_ASSIGNMENT_NONE_KEY,
  buildServiceStaffAssignmentsFromItems,
} from "@/lib/appointments/service-assignments";

import type { AppointmentStatus } from "@prisma/client";

export type StaffOption = {
  id: string;
  name: string;
  color: string;
  hidden?: boolean;
  onlineBookable?: boolean;
};

type AppointmentRecord = {
  id: string;
  appointmentId: string;
  staffId: string | null | undefined;
  serviceId?: string | null;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  confirmationCode: string;
  customerName: string;
  customerPhone?: string | null;
  status: AppointmentStatus;
  note: string | null;
  internalNote: string | null;
  internalNoteIsTitle?: boolean | null;
  isOnline?: boolean;
  isColorRequest?: boolean;
};

type ServiceRecord = {
  id: string;
  name: string;
  duration: number;
  basePrice: number;
  currency: string;
  tags?: string[];
  steps: Array<{
    id: string;
    name: string;
    duration: number;
    requiresExclusiveResource: boolean;
    resources: Array<{
      id: string;
      resourceId: string;
      name: string;
    }>;
  }>;
};

type ResourceRecord = {
  id: string;
  name: string;
  type: string;
  color?: string | null;
};

type CustomerRecord = {
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
};

type TimeBlockerRecord = {
  id: string;
  staffId: string | null;
  reason: string | null;
  startsAt: string;
  endsAt: string;
  metadata?: {
    type?: string;
    customReason?: string | null;
    allStaff?: boolean;
    isHold?: boolean;
    holdSource?: "online" | "staff";
    expiresAt?: string | null;
    serviceNames?: string[];
    createdByName?: string | null;
    createdByStaffId?: string | null;
  } | null;
};

type NormalizedAppointment = CalendarAppointmentRecord;

type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER";

type NormalizedTimeBlocker = {
  id: string;
  staffId?: string | null;
  reason: string | null;
  reasonType?: TimeBlockerReason | null;
  customReason?: string | null;
  allStaff: boolean;
  startsAt: Date;
  endsAt: Date;
  isHold?: boolean;
  holdSource?: "online" | "staff";
  expiresAt?: Date | null;
  serviceNames?: string[];
  createdByName?: string | null;
  createdByStaffId?: string | null;
};

type ViewMode = "list" | "day" | "three" | "week";

const HOLD_POLL_INTERVAL_ACTIVE_MS = 5_000;
const HOLD_POLL_INTERVAL_IDLE_MS = 5_000;

interface CalendarWorkspaceProps {
  location: {
    id: string;
    name: string;
    timezone: string;
    slug: string;
  };
  slotIntervalOverride?: number | null;
  locationSchedule?: Array<{
    weekday: string;
    startsAt: number | null;
    endsAt: number | null;
  }> | null;
  initialWeekStart: string;
  staffOptions: StaffOption[];
  appointments: AppointmentRecord[];
  services: ServiceRecord[];
  resources: ResourceRecord[];
  customers: CustomerRecord[];
  timeBlockers: TimeBlockerRecord[];
  initialDayIso: string;
  initialActiveStaffIds?: string[];
  manualConfirmationMode?: import("@/lib/booking-preferences").ManualConfirmationMode;
}

const UNASSIGNED_STAFF_OPTION: StaffOption = {
  id: "unassigned",
  name: "Nicht definiert",
  color: "#9ca3af",
};

const WEEKDAY_INDEX = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

type WeekdayKey = (typeof WEEKDAY_INDEX)[number];

const isWeekdayKey = (value: string): value is WeekdayKey =>
  WEEKDAY_INDEX.includes(value as WeekdayKey);

const clampMinutes = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(24 * 60, Math.round(value)));
};

const parseTimeLabel = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return clampMinutes(hours * 60 + minutes);
};

const TIME_BLOCKER_REASON_VALUES: ReadonlyArray<TimeBlockerReason> = [
  "BREAK",
  "VACATION",
  "SICK",
  "MEAL",
  "PRIVATE",
  "OTHER",
];

const isTimeBlockerReason = (value: unknown): value is TimeBlockerReason =>
  typeof value === "string" && TIME_BLOCKER_REASON_VALUES.includes(value as TimeBlockerReason);

const TIME_BLOCKER_LABEL_VARIANTS: Record<TimeBlockerReason, string[]> = {
  BREAK: ["Zeitblocker · Pause", "Pause"],
  MEAL: ["Zeitblocker · Mittagessen", "Mittagessen"],
  VACATION: ["Zeitblocker · Urlaub", "Urlaub"],
  SICK: ["Zeitblocker · Krankmeldung", "Krankmeldung"],
  PRIVATE: ["Zeitblocker · Privater Termin", "Privater Termin"],
  OTHER: ["Zeitblocker", "Anderer Grund"],
};

const formatBlockerReason = (
  reasonType: TimeBlockerReason | null | undefined,
  fallback: string | null | undefined,
  customReason?: string | null,
): string | null => {
  if (reasonType === "OTHER") {
    const trimmed = customReason?.trim();
    return trimmed && trimmed.length
      ? `${TIME_BLOCKER_LABEL_VARIANTS.OTHER[0]}: ${trimmed}`
      : TIME_BLOCKER_LABEL_VARIANTS.OTHER[0];
  }
  if (reasonType && TIME_BLOCKER_LABEL_VARIANTS[reasonType]) {
    return TIME_BLOCKER_LABEL_VARIANTS[reasonType][0];
  }
  return fallback ?? TIME_BLOCKER_LABEL_VARIANTS.OTHER[0];
};

const inferTimeBlockerReason = (metadataType: unknown, reasonLabel: string | null | undefined): TimeBlockerReason | null => {
  if (isTimeBlockerReason(metadataType)) {
    return metadataType;
  }
  if (!reasonLabel) {
    return null;
  }
  const normalized = reasonLabel.trim().toLowerCase();
  for (const [key, variants] of Object.entries(TIME_BLOCKER_LABEL_VARIANTS) as Array<[TimeBlockerReason, string[]]>) {
    for (const variant of variants) {
      const lc = variant.toLowerCase();
      if (normalized === lc || normalized.includes(lc)) {
        return key;
      }
    }
  }
  if (normalized.startsWith("zeitblocker")) {
    return "OTHER";
  }
  return null;
};

const toDate = (value: string) => parseISO(value);
export function CalendarWorkspace({
  location,
  locationSchedule,
  initialWeekStart,
  staffOptions,
  appointments,
  services,
  resources,
  customers,
  timeBlockers,
  initialDayIso,
  initialActiveStaffIds = [],
  slotIntervalOverride,
  manualConfirmationMode,
}: CalendarWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { pushToast } = useToast();
  const {
    ensureBookingActor,
    actor: bookingActor,
    sessionSecondsRemaining,
    endSession,
    dialogElement,
  } = useBookingPinAuth({ locationSlug: location.slug });

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const param = searchParams?.get("view");
    if (param === "list" || param === "day" || param === "three" || param === "week") {
      return param;
    }
    return "week";
  });
  const [anchorDate, setAnchorDate] = useState(() => parseISO(initialDayIso));
  const lastInitialWeekStartRef = useRef(initialWeekStart);
  const anchorDateRef = useRef(anchorDate);
  const inactivityTimeoutRef = useRef<number | null>(null);
  const lastActivityRef = useRef(Date.now());
  const holdPollTimeoutRef = useRef<number | null>(null);
  const holdPollInFlightRef = useRef(false);
  const [activeStaffIds, setActiveStaffIds] = useState<string[]>(initialActiveStaffIds);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterTimeoutRef = useRef<number | null>(null);
  const [showAvailabilityOnly, setShowAvailabilityOnly] = useState(false);
  const [availability, setAvailability] = useState<Record<string, Record<string, Array<{ start: number; end: number }>>>>({});
  const [availabilityStatus, setAvailabilityStatus] = useState<Record<string, Record<string, string>>>({});
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const visibleStaffOptions = useMemo(() => staffOptions.filter((staff) => !staff.hidden), [staffOptions]);

  useEffect(() => {
    if (!activeStaffIds.length) return;
    const visibleIds = new Set(visibleStaffOptions.map((staff) => staff.id));
    const cleaned = activeStaffIds.filter((id) => id === "unassigned" || visibleIds.has(id));
    const unchanged =
      cleaned.length === activeStaffIds.length && cleaned.every((id, index) => id === activeStaffIds[index]);
    if (!unchanged) {
      setActiveStaffIds(cleaned);
    }
  }, [visibleStaffOptions, activeStaffIds]);

  const locationScheduleMap = useMemo(() => {
    if (!locationSchedule?.length) return null;
    const map = new Map<WeekdayKey, { startsAt: number | null; endsAt: number | null }>();
    for (const entry of locationSchedule) {
      const keyRaw = (entry.weekday ?? "").toUpperCase();
      if (!isWeekdayKey(keyRaw)) continue;
      const startsAt = clampMinutes(entry.startsAt);
      const endsAt = clampMinutes(entry.endsAt);
      if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
        map.set(keyRaw, { startsAt: null, endsAt: null });
      } else {
        map.set(keyRaw, { startsAt, endsAt });
      }
    }
    return map;
  }, [locationSchedule]);

  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [detail, setDetail] = useState<AppointmentDetailPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailReloadToken, setDetailReloadToken] = useState(0);
  const [activeAppointment, setActiveAppointment] = useState<{ appointmentId: string; itemId?: string } | null>(null);
  const [highlightedAppointmentId, setHighlightedAppointmentId] = useState<string | null>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const [slotIntervalMinutes, setSlotIntervalMinutes] = useState(() =>
    typeof slotIntervalOverride === "number" && slotIntervalOverride > 0 ? slotIntervalOverride : 30,
  );


  const [localTimeBlockers, setLocalTimeBlockers] = useState<TimeBlockerRecord[]>(timeBlockers);
  const [holdBlockers, setHoldBlockers] = useState<TimeBlockerRecord[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHoldReleased = (event: Event) => {
      const detail = (event as CustomEvent<{ slotKey?: string }>).detail;
      if (!detail?.slotKey) return;
      const id = `hold:${detail.slotKey}`;
      setHoldBlockers((previous) => previous.filter((blocker) => blocker.id !== id));
    };
    window.addEventListener("calendar.hold.released", handleHoldReleased);
    return () => window.removeEventListener("calendar.hold.released", handleHoldReleased);
  }, []);
  const [schedulerContext, setSchedulerContext] = useState<SchedulerContext | null>(null);
  const [nextFreeDialogOpen, setNextFreeDialogOpen] = useState(false);
  const [activeSlotHighlight, setActiveSlotHighlight] = useState<{ start: Date; end: Date; staffId?: string | null } | null>(
    null,
  );
  const drawerOpen = Boolean(schedulerContext);
  const isCreateAppointmentOpen = Boolean(
    schedulerContext && schedulerContext.mode === "create" && schedulerContext.entity === "appointment",
  );
  const preferencesRestoredRef = useRef(false);
  const midnightTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("cti.appointment.create", { detail: { open: isCreateAppointmentOpen } }),
    );
  }, [isCreateAppointmentOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    return () => {
      window.dispatchEvent(new CustomEvent("cti.appointment.create", { detail: { open: false } }));
    };
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
      if (midnightTimeoutRef.current) {
        window.clearTimeout(midnightTimeoutRef.current);
        midnightTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const scheduleMidnightReset = () => {
      if (midnightTimeoutRef.current) {
        window.clearTimeout(midnightTimeoutRef.current);
      }
      const now = new Date();
      const nextMidnight = startOfDay(addDays(now, 1));
      const delay = Math.max(1000, nextMidnight.getTime() - now.getTime());
      midnightTimeoutRef.current = window.setTimeout(() => {
        const today = new Date();
        if (!isSameDay(anchorDateRef.current, today)) {
          setAnchorDate(today);
        }
        scheduleMidnightReset();
      }, delay);
    };

    scheduleMidnightReset();
    return () => {
      if (midnightTimeoutRef.current) {
        window.clearTimeout(midnightTimeoutRef.current);
        midnightTimeoutRef.current = null;
      }
    };
  }, []);

  const handleActivitySelect = useCallback(
    (payload: { appointmentId: string; startsAt: Date }) => {
      setViewMode("day");
      setAnchorDate(startOfDay(payload.startsAt));
      setHighlightedAppointmentId(payload.appointmentId);
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = window.setTimeout(() => {
        setHighlightedAppointmentId(null);
        highlightTimeoutRef.current = null;
      }, 8000);
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const current = loadUserPreferences();
    if (typeof slotIntervalOverride === "number" && slotIntervalOverride > 0) {
      setSlotIntervalMinutes(slotIntervalOverride);
    } else {
      setSlotIntervalMinutes(current.calendarSlotIntervalMinutes);
    }

    const handleUpdate = (event: Event) => {
      if (typeof slotIntervalOverride === "number" && slotIntervalOverride > 0) {
        return;
      }
      const detail = (event as CustomEvent<UserPreferences>).detail;
      if (detail?.calendarSlotIntervalMinutes) {
        setSlotIntervalMinutes(detail.calendarSlotIntervalMinutes);
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== USER_PREFERENCES_STORAGE_KEY || !event.newValue) {
        return;
      }
      try {
        const parsed = JSON.parse(event.newValue) as Partial<UserPreferences>;
        if (!slotIntervalOverride && parsed && typeof parsed.calendarSlotIntervalMinutes === "number") {
          setSlotIntervalMinutes(parsed.calendarSlotIntervalMinutes);
        }
      } catch {
        // ignore malformed storage payloads
      }
    };

    window.addEventListener(USER_PREFERENCES_EVENT, handleUpdate as EventListener);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(USER_PREFERENCES_EVENT, handleUpdate as EventListener);
      window.removeEventListener("storage", handleStorage);
    };
  }, [slotIntervalOverride]);

  useEffect(() => {
    setLocalTimeBlockers((previous) => {
      if (previous === timeBlockers) {
        return previous;
      }
      const prevMap = new Map(previous.map((entry) => [entry.id, entry]));
      let changed = previous.length !== timeBlockers.length;
      if (!changed) {
        for (const item of timeBlockers) {
          const current = prevMap.get(item.id);
          if (!current) {
            changed = true;
            break;
          }
          if (
            current.startsAt !== item.startsAt ||
            current.endsAt !== item.endsAt ||
            current.reason !== item.reason ||
            current.staffId !== item.staffId
          ) {
            changed = true;
            break;
          }
        }
      }
      return changed ? timeBlockers : previous;
    });
  }, [timeBlockers]);

  useEffect(() => {
    if (bookingActor && sessionSecondsRemaining <= 0) {
      endSession();
    }
    if ((!bookingActor || sessionSecondsRemaining <= 0) && (detailDrawerOpen || schedulerContext)) {
      setDetailDrawerOpen(false);
      setDetail(null);
      setActiveAppointment(null);
      setDetailLoading(false);
      setDetailError(null);
      setSchedulerContext(null);
    }
  }, [bookingActor, sessionSecondsRemaining, detailDrawerOpen, schedulerContext, endSession]);

  const staffOptionsWithUnassigned = useMemo(
    () => [UNASSIGNED_STAFF_OPTION, ...visibleStaffOptions],
    [visibleStaffOptions],
  );

  const staffIndex = useMemo(() => {
    const map = new Map<string, StaffOption>();
    map.set(UNASSIGNED_STAFF_OPTION.id, UNASSIGNED_STAFF_OPTION);
    for (const staff of visibleStaffOptions) {
      map.set(staff.id, staff);
    }
    return map;
  }, [visibleStaffOptions]);

  useEffect(() => {
    if (lastInitialWeekStartRef.current === initialWeekStart) {
      return;
    }
    lastInitialWeekStartRef.current = initialWeekStart;
    setAnchorDate((current) => {
      const weekStartDate = parseISO(initialWeekStart);
      if (isSameWeek(current, weekStartDate, { weekStartsOn: 1 })) {
        return current;
      }
      return parseISO(initialDayIso);
    });
  }, [initialWeekStart, initialDayIso]);

  useEffect(() => {
    anchorDateRef.current = anchorDate;
  }, [anchorDate]);

  useEffect(() => {
    if (!searchParams) return;
    const params = new URLSearchParams(searchParams.toString());
    const currentWeek = searchParams.get("week");
    const nextWeek = format(anchorDate, "yyyy-MM-dd");
    const currentView = searchParams.get("view") ?? "week";
    if (currentWeek === nextWeek && currentView === viewMode) {
      return;
    }
    params.set("week", nextWeek);
    params.set("view", viewMode);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [anchorDate, viewMode, pathname, router, searchParams]);

  const scheduleInactivityReset = useCallback(() => {
    if (inactivityTimeoutRef.current) {
      window.clearTimeout(inactivityTimeoutRef.current);
    }
    inactivityTimeoutRef.current = window.setTimeout(() => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (idleMs < 60000) {
        scheduleInactivityReset();
        return;
      }
      const current = anchorDateRef.current;
      if (!isSameDay(current, new Date())) {
        setAnchorDate(new Date());
      }
    }, 60000);
  }, []);

  useEffect(() => {
    const markActive = () => {
      lastActivityRef.current = Date.now();
      scheduleInactivityReset();
    };

    scheduleInactivityReset();
    window.addEventListener("pointerdown", markActive, { passive: true });
    window.addEventListener("keydown", markActive);
    window.addEventListener("mousemove", markActive, { passive: true });
    window.addEventListener("touchstart", markActive, { passive: true });
    window.addEventListener("wheel", markActive, { passive: true });
    window.addEventListener("scroll", markActive, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", markActive);
      window.removeEventListener("keydown", markActive);
      window.removeEventListener("mousemove", markActive);
      window.removeEventListener("touchstart", markActive);
      window.removeEventListener("wheel", markActive);
      window.removeEventListener("scroll", markActive);
      if (inactivityTimeoutRef.current) {
        window.clearTimeout(inactivityTimeoutRef.current);
        inactivityTimeoutRef.current = null;
      }
    };
  }, [scheduleInactivityReset]);

  useEffect(() => {
    lastActivityRef.current = Date.now();
    scheduleInactivityReset();
  }, [anchorDate, scheduleInactivityReset]);

  useEffect(() => {
    if (!filtersOpen) {
      if (filterTimeoutRef.current) {
        window.clearTimeout(filterTimeoutRef.current);
        filterTimeoutRef.current = null;
      }
      return;
    }
    if (filterTimeoutRef.current) {
      window.clearTimeout(filterTimeoutRef.current);
    }
    filterTimeoutRef.current = window.setTimeout(() => {
      setFiltersOpen(false);
      filterTimeoutRef.current = null;
    }, 5000);
  }, [filtersOpen]);

  useEffect(() => {
    return () => {
      if (filterTimeoutRef.current) {
        window.clearTimeout(filterTimeoutRef.current);
      }
    };
  }, []);

  const preferenceStorageKey = useMemo(
    () => `calendar-preferences:${location.slug}`,
    [location.slug],
  );

  useEffect(() => {
    if (typeof window === "undefined" || preferencesRestoredRef.current) {
      return;
    }
    preferencesRestoredRef.current = true;
    try {
      const raw = window.localStorage.getItem(preferenceStorageKey);
      if (!raw) return;
      const pref = JSON.parse(raw) as {
        viewMode?: ViewMode;
        activeStaffIds?: string[];
        showAvailabilityOnly?: boolean;
      } | null;
      if (!pref || typeof pref !== "object") return;
      if (pref.viewMode && ["list", "day", "three", "week"].includes(pref.viewMode) && pref.viewMode !== viewMode) {
        setViewMode(pref.viewMode);
      }
      if (Array.isArray(pref.activeStaffIds) && pref.activeStaffIds.length) {
        setActiveStaffIds(pref.activeStaffIds.filter((id): id is string => typeof id === "string" && id.length > 0));
      }
      if (typeof pref.showAvailabilityOnly === "boolean") {
        setShowAvailabilityOnly(pref.showAvailabilityOnly);
      }
    } catch (error) {
      console.warn("[calendar] Konnte gespeicherte Einstellungen nicht laden", error);
    }
  }, [preferenceStorageKey, viewMode]);

  useEffect(() => {
    if (typeof window === "undefined" || !preferencesRestoredRef.current) {
      return;
    }
    const payload = {
      viewMode,
      activeStaffIds,
      showAvailabilityOnly,
    };
    try {
      window.localStorage.setItem(preferenceStorageKey, JSON.stringify(payload));
    } catch (error) {
      console.warn("[calendar] Konnte Kalender-Einstellungen nicht speichern", error);
    }
  }, [activeStaffIds, preferenceStorageKey, showAvailabilityOnly, viewMode]);

  const range = useMemo(() => {
    switch (viewMode) {
      case "day": {
        const start = startOfDay(anchorDate);
        return {
          rangeStart: start,
          rangeEnd: start,
          rangeLabel: format(start, "EEEE, dd.MM.yyyy"),
          weekLabel: `Kalenderwoche ${String(getISOWeek(start)).padStart(2, "0")}`,
          dateValue: format(start, "yyyy-MM-dd"),
          highlightedDates: [format(start, "yyyy-MM-dd")],
        };
      }
      case "three": {
        const start = startOfDay(anchorDate);
        const end = addDays(start, 2);
        return {
          rangeStart: start,
          rangeEnd: end,
          rangeLabel: `${format(start, "dd.MM.yyyy")} – ${format(end, "dd.MM.yyyy")}`,
          weekLabel: `Kalenderwoche ${String(getISOWeek(start)).padStart(2, "0")}`,
          dateValue: format(start, "yyyy-MM-dd"),
          highlightedDates: Array.from({ length: 3 }, (_, index) => format(addDays(start, index), "yyyy-MM-dd")),
        };
      }
      case "list": {
        const start = startOfMonth(anchorDate);
        const end = endOfMonth(anchorDate);
        return {
          rangeStart: start,
          rangeEnd: end,
          rangeLabel: format(start, "MMMM yyyy"),
          weekLabel: `Kalenderwoche ${String(getISOWeek(anchorDate)).padStart(2, "0")}`,
          dateValue: format(start, "yyyy-MM-01"),
          highlightedDates: [],
        };
      }
      case "week":
      default: {
        const start = startOfWeek(anchorDate, { weekStartsOn: 1 });
        const end = addDays(start, 6);
        return {
          rangeStart: start,
          rangeEnd: end,
          rangeLabel: `${format(start, "dd.MM.yyyy")} – ${format(end, "dd.MM.yyyy")}`,
          weekLabel: `Kalenderwoche ${String(getISOWeek(start)).padStart(2, "0")}`,
          dateValue: format(start, "yyyy-MM-dd"),
          highlightedDates: Array.from({ length: 7 }, (_, index) => format(addDays(start, index), "yyyy-MM-dd")),
        };
      }
    }
  }, [viewMode, anchorDate]);

  const rangeStartIso = useMemo(() => range.rangeStart.toISOString(), [range.rangeStart]);
  const rangeEndIso = useMemo(() => endOfDay(range.rangeEnd).toISOString(), [range.rangeEnd]);

  const visibleDays = useMemo(() => {
    const days: Date[] = [];
    let cursor = startOfDay(range.rangeStart);
    while (cursor <= range.rangeEnd) {
      days.push(cursor);
      cursor = addDays(cursor, 1);
    }
    return days;
  }, [range.rangeStart, range.rangeEnd]);

  const unassignedAvailability = useMemo<Record<string, Array<{ start: number; end: number }>>>(() => {
    const hasAnyOpeningHours =
      locationScheduleMap &&
      Array.from(locationScheduleMap.values()).some(
        (entry) => entry.startsAt !== null && entry.endsAt !== null && entry.endsAt > entry.startsAt,
      );
    const availabilityByDay: Record<string, Array<{ start: number; end: number }>> = {};
    let cursor = startOfDay(range.rangeStart);
    const endDate = startOfDay(range.rangeEnd);
    while (cursor <= endDate) {
      const key = format(cursor, "yyyy-MM-dd");
      if (!hasAnyOpeningHours) {
        // Keine Öffnungszeiten hinterlegt ⇒ 24/7 verfügbar (keine grauen Bereiche).
        availabilityByDay[key] = [{ start: 0, end: 24 * 60 }];
      } else if (locationScheduleMap) {
        const weekdayKey = WEEKDAY_INDEX[cursor.getDay()];
        const scheduleEntry = locationScheduleMap.get(weekdayKey);
        if (scheduleEntry && scheduleEntry.startsAt !== null && scheduleEntry.endsAt !== null && scheduleEntry.endsAt > scheduleEntry.startsAt) {
          availabilityByDay[key] = [{ start: scheduleEntry.startsAt, end: scheduleEntry.endsAt }];
        }
      }
      cursor = addDays(cursor, 1);
    }
    return availabilityByDay;
  }, [locationScheduleMap, range.rangeStart, range.rangeEnd]);

  const normalizedAppointments = useMemo<NormalizedAppointment[]>(() => {
    const windowEnd = addDays(range.rangeEnd, 1);
    return appointments
      .map<NormalizedAppointment>((record) => {
        const trimmedCustomer = record.customerName.trim();
        const hasCustomer = trimmedCustomer.length > 0;
        const hasService = Boolean(record.serviceName.trim());
        const startLabel = format(record.startsAt, "HH:mm");
        const endLabel = format(record.endsAt, "HH:mm");
        const timeRange = `${startLabel} – ${endLabel}`;
        const displayLabel = hasCustomer
          ? trimmedCustomer
          : hasService
            ? record.serviceName
            : timeRange;
        return {
          id: record.id,
          appointmentId: record.appointmentId,
          serviceId: record.serviceId ?? null,
          staffId: record.staffId ?? undefined,
          startsAt: toDate(record.startsAt),
          endsAt: toDate(record.endsAt),
          serviceName: record.serviceName,
          confirmationCode: record.confirmationCode,
          customerName: trimmedCustomer,
          customerPhone: record.customerPhone ?? null,
          displayLabel,
          hasCustomer,
          hasService,
          timeLabel: timeRange,
          status: record.status,
          note: record.note,
          internalNote: record.internalNote,
          internalNoteIsTitle: record.internalNoteIsTitle ?? false,
          isOnline: record.isOnline ?? false,
          isColorRequest: record.isColorRequest ?? false,
        };
      })
      .filter((record) => record.startsAt < windowEnd && record.endsAt > range.rangeStart)
      .filter((record) => {
        if (!activeStaffIds.length) return true;
        const staffKey = record.staffId ?? "unassigned";
        return activeStaffIds.includes(staffKey);
      });
  }, [appointments, range.rangeStart, range.rangeEnd, activeStaffIds]);

  const normalizedBlockers = useMemo<NormalizedTimeBlocker[]>(() => {
    const windowEnd = addDays(range.rangeEnd, 1);
    const now = Date.now();
    const combinedBlockers = [...localTimeBlockers, ...holdBlockers];
    return combinedBlockers
      .map<NormalizedTimeBlocker>((blocker) => {
        const metadata = blocker.metadata ?? {};
        const reasonType = inferTimeBlockerReason(metadata.type, blocker.reason ?? null);
        const customReason = typeof metadata.customReason === "string" ? metadata.customReason : null;
        const allStaff =
          typeof metadata.allStaff === "boolean" ? metadata.allStaff : blocker.staffId === null;
        const isHold = metadata.isHold === true;
        const holdSource =
          metadata.holdSource === "staff" || metadata.holdSource === "online" ? metadata.holdSource : undefined;
        const expiresAt =
          typeof metadata.expiresAt === "string" ? toDate(metadata.expiresAt) : null;
        const serviceNames = Array.isArray(metadata.serviceNames)
          ? metadata.serviceNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : undefined;
        const createdByName = typeof metadata.createdByName === "string" ? metadata.createdByName : null;
        const createdByStaffId = typeof metadata.createdByStaffId === "string" ? metadata.createdByStaffId : null;
        return {
          id: blocker.id,
          staffId: blocker.staffId ?? null,
          reason: formatBlockerReason(reasonType, blocker.reason ?? null, customReason),
          reasonType,
          customReason,
          allStaff,
          startsAt: toDate(blocker.startsAt),
          endsAt: toDate(blocker.endsAt),
          isHold,
          holdSource,
          expiresAt,
          serviceNames,
          createdByName,
          createdByStaffId,
        };
      })
      .filter((record) => {
        if (record.isHold && record.expiresAt && record.expiresAt.getTime() <= now) {
          return false;
        }
        if (record.isHold && !record.expiresAt && record.endsAt.getTime() <= now) {
          return false;
        }
        return true;
      })
      .filter((record) => record.startsAt < windowEnd && record.endsAt > range.rangeStart)
      .filter((record) => {
        if (!activeStaffIds.length) return true;
        const staffKey = record.staffId ?? "unassigned";
        return activeStaffIds.includes(staffKey);
      })
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }, [localTimeBlockers, holdBlockers, range.rangeStart, range.rangeEnd, activeStaffIds]);

  useEffect(() => {
    const controller = new AbortController();
    const loadAvailability = async () => {
      try {
        setAvailabilityLoading(true);
        const params = new URLSearchParams({ start: rangeStartIso, end: rangeEndIso });
        const response = await fetch(
          `/api/backoffice/${location.slug}/staff/availability?${params.toString()}`,
          {
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as {
          data?: Record<string, Record<string, Array<{ start: number; end: number }>>>;
          status?: Record<string, Record<string, string>>;
        };
        if (payload?.data && typeof payload.data === "object") {
          setAvailability(payload.data);
        } else {
          setAvailability({});
        }
        if (payload?.status && typeof payload.status === "object") {
          setAvailabilityStatus(payload.status);
        } else {
          setAvailabilityStatus({});
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        console.error("[calendar] Stundenliste-Verfügbarkeiten konnten nicht geladen werden.", error);
        setAvailability({});
        setAvailabilityStatus({});
      } finally {
        if (!controller.signal.aborted) {
          setAvailabilityLoading(false);
        }
      }
    };

    void loadAvailability();
    return () => controller.abort();
  }, [location.slug, rangeStartIso, rangeEndIso]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const pendingHoldStorageKey = `calendar.pendingHold:${location.slug}`;
    const holdBroadcastKey = `calendar.holds:${location.slug}`;
    const pollIntervalMs = drawerOpen ? HOLD_POLL_INTERVAL_ACTIVE_MS : HOLD_POLL_INTERVAL_IDLE_MS;
    const holdChannel =
      typeof window !== "undefined" && "BroadcastChannel" in window ? new BroadcastChannel(holdBroadcastKey) : null;
    const broadcastHoldSync = () => {
      if (typeof window === "undefined") return;
      if (holdChannel) {
        holdChannel.postMessage({ type: "holds.sync", timestamp: Date.now() });
      }
      try {
        window.localStorage.setItem(holdBroadcastKey, String(Date.now()));
      } catch {
        // ignore storage failures
      }
    };
    const cleanupPendingHold = async () => {
      if (typeof window === "undefined") return;
      if (drawerOpen) return;
      let pending: string | null = null;
      try {
        pending = window.sessionStorage.getItem(pendingHoldStorageKey);
      } catch {
        return;
      }
      if (!pending) return;
      try {
        const response = await fetch(`/api/backoffice/${location.slug}/booking-holds`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slotKey: pending }),
          signal: controller.signal,
        });
        if (!response.ok) return;
        window.sessionStorage.removeItem(pendingHoldStorageKey);
        window.dispatchEvent(new CustomEvent("calendar.hold.released", { detail: { slotKey: pending } }));
        broadcastHoldSync();
      } catch (error) {
        if (controller.signal.aborted) return;
      }
    };
    const fetchHolds = async (force = false) => {
      if (!active) return;
      void cleanupPendingHold();
      if (!force && typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      if (holdPollInFlightRef.current) {
        return;
      }
      holdPollInFlightRef.current = true;
      try {
        const params = new URLSearchParams({ start: rangeStartIso, end: rangeEndIso });
        const response = await fetch(
          `/api/backoffice/${location.slug}/booking-holds?${params.toString()}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { data?: TimeBlockerRecord[] };
        if (!active) return;
        if (Array.isArray(payload?.data)) {
          setHoldBlockers(payload.data);
        } else {
          setHoldBlockers([]);
        }
      } catch (error) {
        if (!active) return;
        setHoldBlockers([]);
      } finally {
        holdPollInFlightRef.current = false;
      }
    };

    const scheduleNext = () => {
      if (!active) return;
      if (holdPollTimeoutRef.current) {
        window.clearTimeout(holdPollTimeoutRef.current);
      }
      holdPollTimeoutRef.current = window.setTimeout(async () => {
        await fetchHolds();
        scheduleNext();
      }, pollIntervalMs);
    };

    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") {
        void fetchHolds(true);
      }
    };
    const handleLocalHoldSync = (event: Event) => {
      const detail = (event as CustomEvent<{ locationSlug?: string }>).detail;
      if (detail?.locationSlug && detail.locationSlug !== location.slug) return;
      broadcastHoldSync();
      void fetchHolds(true);
    };
    const handleBroadcastMessage = () => {
      void fetchHolds(true);
    };
    const handleStorage = (storageEvent: StorageEvent) => {
      if (storageEvent.key !== holdBroadcastKey) return;
      void fetchHolds(true);
    };

    void cleanupPendingHold();
    void fetchHolds(true);
    scheduleNext();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("calendar.hold.sync", handleLocalHoldSync);
    window.addEventListener("storage", handleStorage);
    if (holdChannel) {
      holdChannel.addEventListener("message", handleBroadcastMessage);
    }
    return () => {
      active = false;
      controller.abort();
      if (holdPollTimeoutRef.current) {
        window.clearTimeout(holdPollTimeoutRef.current);
      }
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("calendar.hold.sync", handleLocalHoldSync);
      window.removeEventListener("storage", handleStorage);
      if (holdChannel) {
        holdChannel.removeEventListener("message", handleBroadcastMessage);
        holdChannel.close();
      }
    };
  }, [drawerOpen, location.slug, rangeStartIso, rangeEndIso]);

  const filteredStaff = useMemo(() => {
    if (!activeStaffIds.length) {
      return visibleStaffOptions;
    }
    return visibleStaffOptions.filter((staff) => activeStaffIds.includes(staff.id));
  }, [visibleStaffOptions, activeStaffIds]);

  const effectiveStaffIds = useMemo(() => {
    const visibleStaff = visibleStaffOptions.map((staff) => staff.id);
    if (!activeStaffIds.length) {
      return ["unassigned", ...visibleStaff];
    }
    const ids = activeStaffIds.includes("unassigned") ? ["unassigned"] : [];
    return [...ids, ...filteredStaff.map((staff) => staff.id)];
  }, [activeStaffIds, filteredStaff, visibleStaffOptions]);


  const handlePrev = useCallback(() => {
    setAnchorDate((prev) => {
      switch (viewMode) {
        case "day":
          return addDays(prev, -1);
        case "three":
          return addDays(prev, -3);
        case "list":
          return addMonths(prev, -1);
        case "week":
        default:
          return addDays(prev, -7);
      }
    });
  }, [viewMode]);

  const handleNext = useCallback(() => {
    setAnchorDate((prev) => {
      switch (viewMode) {
        case "day":
          return addDays(prev, 1);
        case "three":
          return addDays(prev, 3);
        case "list":
          return addMonths(prev, 1);
        case "week":
        default:
          return addDays(prev, 7);
      }
    });
  }, [viewMode]);

  const handleToday = useCallback(() => {
    setAnchorDate(new Date());
  }, []);

  const handleDatePicked = useCallback((date: Date) => {
    setAnchorDate(date);
  }, []);

  const handleSlotCreate = useCallback(
    async ({ start, end, staffId }: { start: Date; end?: Date; staffId?: string | null }) => {
      try {
        await ensureBookingActor("Neuen Termin anlegen");
      } catch {
        return;
      }
      const fallbackEnd = end ?? addMinutes(start, slotIntervalMinutes || 30);
      setActiveSlotHighlight({ start, end: fallbackEnd, staffId });
      setDetailDrawerOpen(false);
      setActiveAppointment(null);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      setSchedulerContext({ mode: "create", entity: "appointment", start, end, staffId });
    },
    [ensureBookingActor, slotIntervalMinutes],
  );

  const handleAppointmentMoveRef = useRef<(args: { appointment: NormalizedAppointment; start: Date; end: Date; staffId?: string | null }) => Promise<void>>(async () => {});
  const handleBlockerMoveRef = useRef<(args: { blocker: NormalizedTimeBlocker; start: Date; end: Date; staffId?: string | null; allStaff: boolean }) => Promise<void>>(async () => {});

  const handlePinTest = useCallback(async () => {
    try {
      await ensureBookingActor();
    } catch (error) {
      console.error("[calendar] PIN dialog test failed", error);
    }
  }, [ensureBookingActor]);

  const toggleStaffFilter = useCallback((id: string) => {
    setActiveStaffIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return Array.from(next);
    });
  }, []);

  const resetStaffFilter = useCallback(() => {
    setActiveStaffIds([]);
    setFiltersOpen(false);
  }, []);

  const handleAppointmentSelect = useCallback(
    async (payload: { appointmentId: string; itemId?: string }) => {
      setActiveSlotHighlight(null);
      console.log("[calendar] appointment clicked", payload);
      try {
        await ensureBookingActor("Termin bearbeiten");
      } catch {
        console.warn("[calendar] booking PIN required, dialog should open");
        return;
      }

      // Direkt in den Bearbeiten-Dialog springen
      const params = new URLSearchParams();
      if (payload.itemId) {
        params.set("itemId", payload.itemId);
      }
      const query = params.toString();
      const response = await fetch(
        `/api/backoffice/${location.slug}/appointments/${payload.appointmentId}${query ? `?${query}` : ""}`,
        { cache: "no-store" },
      );
      const raw = await response.text();
      if (!response.ok) {
        console.warn("[calendar] appointment detail fetch failed", response.status, raw);
        return;
      }
      let detailPayload: AppointmentDetailPayload | null = null;
      try {
        detailPayload = JSON.parse(raw) as AppointmentDetailPayload;
      } catch (error) {
        console.error("[calendar] appointment detail parse failed", error);
        return;
      }
      const items = detailPayload.appointment.items ?? [];
      const fallbackItemId = payload.itemId ?? items[0]?.id ?? detailPayload.appointment.id;
      const item = items.find((candidate) => candidate.id === fallbackItemId) ?? items[0] ?? null;

      // Fallback auf Terminzeiten, wenn keine Items vorhanden (z.B. nur interne Notiz)
      const start = item ? new Date(item.startsAt) : new Date(detailPayload.appointment.startsAt);
      const end = item ? new Date(item.endsAt) : new Date(detailPayload.appointment.endsAt);

      const staffIds = items
        .map((entry) => entry.staff?.id)
        .filter((id): id is string => Boolean(id));
      if (!staffIds.length && detailPayload.appointment.metadata && typeof detailPayload.appointment.metadata === "object") {
        const maybeAssigned = (detailPayload.appointment.metadata as Record<string, unknown>).assignedStaffIds;
        if (Array.isArray(maybeAssigned)) {
          staffIds.push(
            ...maybeAssigned
              .map((value) => (typeof value === "string" && value.trim().length ? value.trim() : null))
              .filter((value): value is string => Boolean(value)),
          );
        }
      }

      const serviceIds = items
        .map((entry) => entry.service?.id)
        .filter((id): id is string => Boolean(id));
      const serviceStaffAssignments = buildServiceStaffAssignmentsFromItems(
        items.map((entry) => ({
          serviceId: entry.service?.id ?? null,
          staffId: entry.staff?.id ?? null,
        })),
      );

      setActiveAppointment(payload);
      setDetailDrawerOpen(false);
      setSchedulerContext({
        mode: "edit",
        entity: "appointment",
        appointment: {
          id: detailPayload.appointment.id,
          itemId: item?.id ?? fallbackItemId,
          startsAt: start,
          endsAt: end,
          staffIds: Array.from(new Set(staffIds)),
          serviceIds: Array.from(new Set(serviceIds)),
          customerId: detailPayload.appointment.customer?.id ?? undefined,
          customerName: detailPayload.appointment.customer?.name ?? null,
          note: detailPayload.appointment.note ?? null,
          internalNote: detailPayload.appointment.internalNote ?? null,
          status: detailPayload.appointment.status as AppointmentStatus,
          source: detailPayload.appointment.source ?? null,
          createdAt: detailPayload.appointment.createdAt ?? null,
          metadata:
            detailPayload.appointment.metadata && typeof detailPayload.appointment.metadata === "object"
              ? (detailPayload.appointment.metadata as Record<string, unknown>)
              : null,
          notifyCustomer: true,
          serviceStaffAssignments,
          auditTrail: Array.isArray(detailPayload.auditTrail) ? detailPayload.auditTrail : [],
        },
      });
    },
    [ensureBookingActor, location.slug],
  );

  const handleDetailRetry = useCallback(() => {
    if (!activeAppointment) return;
    setDetailReloadToken((value) => value + 1);
  }, [activeAppointment]);

  const handleDetailReload = useCallback(() => {
    setDetailReloadToken((value) => value + 1);
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (!detailDrawerOpen || !activeAppointment) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const { signal } = controller;
    setDetailLoading(true);
    setDetailError(null);

    const load = async () => {
      const attempts: Array<{ pathId: string; queryItemId?: string }> = [
        { pathId: activeAppointment.appointmentId, queryItemId: activeAppointment.itemId },
      ];
      if (
        activeAppointment.itemId &&
        activeAppointment.itemId !== activeAppointment.appointmentId &&
        !attempts.some((attempt) => attempt.pathId === activeAppointment.itemId)
      ) {
        attempts.push({ pathId: activeAppointment.itemId });
      }

      let lastError: string | null = null;

      for (const attempt of attempts) {
        try {
          const params = new URLSearchParams();
          if (attempt.queryItemId) {
            params.set("itemId", attempt.queryItemId);
          }
          const query = params.toString();
          const response = await fetch(
            `/api/backoffice/${location.slug}/appointments/${attempt.pathId}${query ? `?${query}` : ""}`,
            {
              cache: "no-store",
              signal,
            },
          );
          const raw = await response.text();
          if (!response.ok) {
            if (response.status >= 500) {
              throw new Error("Serverfehler");
            }
            const message =
              response.status === 404 ? "Termin nicht gefunden." : "Termindetails konnten nicht geladen werden.";
            lastError = message;
            continue;
          }
          let payload: AppointmentDetailPayload | null = null;
          try {
            payload = JSON.parse(raw) as AppointmentDetailPayload;
          } catch {
            lastError = "Antwort konnte nicht gelesen werden.";
            continue;
          }
          if (!cancelled) {
            setDetail(payload);
            setDetailError(null);
            setDetailLoading(false);
          }
          return;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          lastError = error instanceof Error ? error.message : "Termindetails konnten nicht geladen werden.";
        }
      }

      if (!cancelled) {
        setDetailError(lastError ?? "Termindetails konnten nicht geladen werden.");
        setDetailLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [detailDrawerOpen, activeAppointment, detailReloadToken, location.slug]);

  const handleDetailClose = useCallback(() => {
    setDetailDrawerOpen(false);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
    setActiveAppointment(null);
  }, []);

  const handleAppointmentEdit = useCallback(
    (payload: AppointmentDetailPayload) => {
      const fallbackItemId = payload.appointment.items[0]?.id;
      const itemId = activeAppointment?.itemId ?? fallbackItemId;
      const item = payload.appointment.items.find((candidate) => candidate.id === itemId) ?? payload.appointment.items[0];
      if (!item) return;
      const staffIds = payload.appointment.items
        .map((entry) => entry.staff?.id)
        .filter((id): id is string => Boolean(id));
      const serviceIds = payload.appointment.items
        .map((entry) => entry.service?.id)
        .filter((id): id is string => Boolean(id));
      const serviceStaffAssignments = buildServiceStaffAssignmentsFromItems(
        payload.appointment.items.map((entry) => ({
          serviceId: entry.service?.id ?? null,
          staffId: entry.staff?.id ?? null,
        })),
      );

      handleDetailClose();
      setSchedulerContext({
        mode: "edit",
        entity: "appointment",
        appointment: {
          id: payload.appointment.id,
          itemId: item.id,
          startsAt: new Date(item.startsAt),
          endsAt: new Date(item.endsAt),
          staffIds: Array.from(new Set(staffIds)),
          serviceIds: Array.from(new Set(serviceIds)),
          serviceStaffAssignments,
          customerId: payload.appointment.customer?.id ?? undefined,
          customerName: payload.appointment.customer?.name ?? null,
          note: payload.appointment.note ?? null,
          internalNote: payload.appointment.internalNote ?? null,
          source: payload.appointment.source ?? null,
          createdAt: payload.appointment.createdAt ?? null,
          notifyCustomer: true,
        },
      });
    },
    [activeAppointment, handleDetailClose],
  );

  const refreshScheduledRef = useRef(false);
  const refreshAppointments = useCallback(() => {
    if (refreshScheduledRef.current) return;
    refreshScheduledRef.current = true;
    const trigger = () => {
      refreshScheduledRef.current = false;
      setDetailReloadToken((value) => value + 1);
      router.refresh();
    };
    if (typeof window !== "undefined") {
      window.setTimeout(trigger, 0);
    } else {
      trigger();
    }
  }, [router]);

  const broadcastAppointmentSync = useCallback(() => {
    if (typeof window === "undefined") return;
    const broadcastKey = `calendar.appointments:${location.slug}`;
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(broadcastKey);
      channel.postMessage({ type: "appointments.sync", timestamp: Date.now() });
      channel.close();
    }
    try {
      window.localStorage.setItem(broadcastKey, String(Date.now()));
    } catch {
      // ignore storage failures
    }
  }, [location.slug]);

  const handleAppointmentUpdated = useCallback(() => {
    refreshAppointments();
    broadcastAppointmentSync();
  }, [broadcastAppointmentSync, refreshAppointments]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const broadcastKey = `calendar.appointments:${location.slug}`;
    const channel =
      typeof window !== "undefined" && "BroadcastChannel" in window ? new BroadcastChannel(broadcastKey) : null;

    const handleBroadcast = () => {
      refreshAppointments();
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== broadcastKey) return;
      refreshAppointments();
    };

    if (channel) {
      channel.addEventListener("message", handleBroadcast);
    }
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
      if (channel) {
        channel.removeEventListener("message", handleBroadcast);
        channel.close();
      }
    };
  }, [location.slug, refreshAppointments]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    const streamUrl = `/api/backoffice/${location.slug}/appointments/stream`;
    let needsRefresh = false;
    const source = new EventSource(streamUrl);

    const handleMessage = () => {
      refreshAppointments();
    };
    const handleOpen = () => {
      if (needsRefresh) {
        refreshAppointments();
      }
      needsRefresh = false;
    };
    const handleError = () => {
      needsRefresh = true;
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshAppointments();
      }
    };

    source.addEventListener("message", handleMessage);
    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleError);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      source.removeEventListener("message", handleMessage);
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleError);
      source.close();
    };
  }, [location.slug, refreshAppointments]);

  const handleOpenBlocker = useCallback(
    async (payload: {
      blocker: {
        id: string;
        staffId?: string | null;
        reason: string | null;
        reasonType?: TimeBlockerReason | null;
        customReason?: string | null;
        allStaff: boolean;
        startsAt: Date;
        endsAt: Date;
      };
      staff?: StaffOption;
    }) => {
      try {
        await ensureBookingActor("Zeitblocker ansehen");
      } catch {
        return;
      }

      setActiveSlotHighlight(null);
      setDetailDrawerOpen(false);
      setActiveAppointment(null);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      const normalizedReasonType =
        payload.blocker.reasonType ?? inferTimeBlockerReason(null, payload.blocker.reason ?? null) ?? "OTHER";
      const staffIds = payload.blocker.allStaff
        ? []
        : payload.blocker.staffId
          ? [payload.blocker.staffId]
          : [];
      setSchedulerContext({
        mode: "edit",
        entity: "blocker",
        blocker: {
          id: payload.blocker.id,
          startsAt: payload.blocker.startsAt,
          endsAt: payload.blocker.endsAt,
          allStaff: payload.blocker.allStaff,
          staffIds,
          reason: normalizedReasonType,
          customReason: payload.blocker.customReason ?? null,
        },
      });
    },
    [ensureBookingActor],
  );

  const handleOpenNextFreeDialog = useCallback(() => {
    setNextFreeDialogOpen(true);
  }, []);

  const availabilityByStaff = useMemo(
    () => ({
      ...availability,
      unassigned: unassignedAvailability,
    }),
    [availability, unassignedAvailability],
  );

  useEffect(() => {
    handleAppointmentMoveRef.current = async ({ appointment, start, end, staffId }) => {
      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor("Termin verschieben");
      } catch {
        return;
      }
      if (!appointment.serviceId) {
        pushToast({
          variant: "error",
          message: "Der Termin enthält keine Leistung und kann nicht verschoben werden.",
        });
        return;
      }
      try {
        const normalizedStaffId =
          staffId === undefined
            ? appointment.staffId && appointment.staffId !== "unassigned"
              ? appointment.staffId
              : null
            : staffId;
        const response = await fetch(`/api/backoffice/${location.slug}/appointments/${appointment.appointmentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: appointment.id,
            serviceId: appointment.serviceId,
            staffId: normalizedStaffId,
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
          throw new Error(payload?.error ?? "Termin konnte nicht verschoben werden.");
        }
        pushToast({ variant: "success", message: "Termin verschoben." });
        handleAppointmentUpdated();
        router.refresh();
      } catch (error) {
        pushToast({
          variant: "error",
          message: error instanceof Error ? error.message : "Termin konnte nicht verschoben werden.",
        });
      }
    };
  }, [ensureBookingActor, handleAppointmentUpdated, location.slug, pushToast, router]);

  useEffect(() => {
    handleBlockerMoveRef.current = async ({ blocker, start, end, staffId, allStaff }) => {
      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor("Zeitblocker verschieben");
      } catch {
        return;
      }
      try {
        let nextStaffId: string | null;
        if (staffId === undefined) {
          nextStaffId =
            blocker.staffId && blocker.staffId !== "unassigned" ? blocker.staffId : null;
        } else if (staffId === null || staffId === "unassigned") {
          nextStaffId = null;
        } else {
          nextStaffId = staffId;
        }
        const reason = blocker.reasonType ?? "OTHER";
        const normalizedCustomReason =
          reason === "OTHER" ? blocker.customReason?.trim() || undefined : undefined;
        const response = await fetch(`/api/backoffice/${location.slug}/time-blockers/${blocker.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            start: start.toISOString(),
            end: end.toISOString(),
            allStaff,
            staffIds: allStaff || !nextStaffId ? [] : [nextStaffId],
            reason,
            customReason: normalizedCustomReason,
            performedBy: {
              staffId: bookingActor.staffId,
              token: bookingActor.token,
            },
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Zeitblocker konnte nicht verschoben werden.");
        }
        pushToast({ variant: "success", message: "Zeitblocker verschoben." });
        handleAppointmentUpdated();
        router.refresh();
      } catch (error) {
        pushToast({
          variant: "error",
          message: error instanceof Error ? error.message : "Zeitblocker konnte nicht verschoben werden.",
        });
      }
    };
  }, [ensureBookingActor, handleAppointmentUpdated, location.slug, pushToast, router]);

  return (
    <div className="space-y-4">
      <CalendarToolbar
        locationSlug={location.slug}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        weekLabel={range.weekLabel}
        rangeLabel={range.rangeLabel}
        rangeStart={range.rangeStart}
        rangeEnd={range.rangeEnd}
        onToday={handleToday}
        onPrev={handlePrev}
        onNext={handleNext}
        onDatePick={handleDatePicked}
        dateValue={range.dateValue}
        highlightedDates={range.highlightedDates}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((prev) => !prev)}
        showAvailabilityOnly={showAvailabilityOnly}
        onToggleAvailability={() => setShowAvailabilityOnly((prev) => !prev)}
        onOpenNextFreeDialog={handleOpenNextFreeDialog}
        activeFilterCount={activeStaffIds.length}
        onSelectActivity={handleActivitySelect}
      />

      {availabilityLoading && (
        <div className="flex items-center gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          Verfügbarkeiten werden aktualisiert …
        </div>
      )}

      {filtersOpen && (
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-zinc-600">Mitarbeiter:</span>
            {staffOptionsWithUnassigned.map((staff) => {
              const selected = activeStaffIds.includes(staff.id) || (!activeStaffIds.length && staff.id !== "unassigned");
              return (
                <button
                  key={staff.id}
                  type="button"
                  onClick={() => toggleStaffFilter(staff.id)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1 transition ${
                    selected ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-700 hover:bg-zinc-100"
                  }`}
                >
                  <span className="inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: staff.color }} />
                  {staff.name}
                </button>
              );
            })}
            {activeStaffIds.length > 0 && (
              <button
                type="button"
                onClick={resetStaffFilter}
                className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:bg-zinc-100"
              >
                Filter zurücksetzen
              </button>
            )}
          </div>
        </div>
      )}

      {viewMode === "list" ? (
        <CalendarListView
          days={visibleDays}
          appointments={normalizedAppointments}
          staffIndex={staffIndex}
          onSelectAppointment={handleAppointmentSelect}
        />
      ) : (
      <CalendarDaysView
        days={visibleDays}
        location={location}
        appointments={normalizedAppointments}
        timeBlockers={normalizedBlockers}
        staffIndex={staffIndex}
        availability={availabilityByStaff}
        staffStatus={availabilityStatus}
        activeStaffIds={effectiveStaffIds}
        displayRange={showAvailabilityOnly ? { start: 8 * 60, end: 18 * 60 } : null}
        onSelectAppointment={handleAppointmentSelect}
        onSelectBlocker={handleOpenBlocker}
        onCreateSlot={handleSlotCreate}
        onMoveAppointment={(args) => handleAppointmentMoveRef.current(args)}
        onMoveBlocker={(args) => handleBlockerMoveRef.current(args)}
        slotIntervalMinutes={slotIntervalMinutes}
        activeSlotHighlight={activeSlotHighlight ?? undefined}
        highlightedAppointmentId={highlightedAppointmentId ?? undefined}
        viewportHeight="calc(100vh - 220px)"
      />
      )}

      <AppointmentDetailDrawer
        open={detailDrawerOpen}
        onClose={handleDetailClose}
        loading={detailLoading}
        error={detailError}
        detail={detail}
        onRetry={handleDetailRetry}
        locationSlug={location.slug}
        onReload={handleDetailReload}
        onDataChanged={handleAppointmentUpdated}
        onEdit={handleAppointmentEdit}
        activeItemId={activeAppointment?.itemId ?? null}
        ensureBookingActor={ensureBookingActor}
      />
      {detailDrawerOpen && detailLoading && (
        <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="rounded-full bg-white/80 p-4 shadow-lg">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-700" />
          </div>
        </div>
      )}
      {dialogElement}
      <SchedulerDrawer
        open={Boolean(schedulerContext)}
        onClose={() => {
          setSchedulerContext(null);
          setActiveSlotHighlight(null);
        }}
        context={schedulerContext}
        locationId={location.id}
        locationSlug={location.slug}
        timezone={location.timezone}
        manualConfirmationMode={manualConfirmationMode}
        staffOptions={visibleStaffOptions}
        services={services}
        resources={resources.map((resource) => ({
          id: resource.id,
          name: resource.name,
          type: resource.type,
          color: resource.color ?? undefined,
        }))}
        actorRole={bookingActor?.role ?? null}
        customers={customers.map((customer) => ({
          id: customer.id,
          firstName: customer.firstName,
          lastName: customer.lastName,
          email: customer.email ?? "",
          phone: customer.phone ?? "",
          appointmentCount: customer.appointmentCount,
          lastAppointment: customer.lastAppointment,
          lastAppointmentStatus: customer.lastAppointmentStatus,
          consents: customer.consents,
        }))}
        ensureBookingActor={ensureBookingActor}
        onCreated={() => {
          setSchedulerContext(null);
          setActiveSlotHighlight(null);
          handleAppointmentUpdated();
        }}
        onUpdated={() => {
          setSchedulerContext(null);
          setActiveSlotHighlight(null);
          handleAppointmentUpdated();
        }}
        onDeleted={() => {
          setSchedulerContext(null);
          setActiveSlotHighlight(null);
          handleAppointmentUpdated();
        }}
      />
      <NextFreeSlotsDialog
        open={nextFreeDialogOpen}
        onClose={() => setNextFreeDialogOpen(false)}
        timezone={location.timezone}
        locationSlug={location.slug}
        services={services.map((service) => ({ id: service.id, name: service.name }))}
        staffOptions={visibleStaffOptions.map((staff) => ({ id: staff.id, name: staff.name, color: staff.color }))}
        activeStaffIds={activeStaffIds}
      />
    </div>
  );
}
