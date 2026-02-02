"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { addMinutes, differenceInMinutes, formatDistanceToNow } from "date-fns";
import { de as localeDe } from "date-fns/locale";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2, X as CloseIcon } from "lucide-react";

import { useToast } from "@/components/ui/ToastProvider";
import { extractColorMetadata, isColorPrecheckComplete } from "@/lib/color-consultation";
import {
  formatDateTimeLocalInput,
  parseDateTimeLocalInput,
  formatDateWithPatternInTimeZone,
  formatInTimeZone,
} from "@/lib/timezone";
import { useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";
import type { AppointmentStatus } from "@prisma/client";
import { DatePicker } from "@/components/ui/DatePicker";
import { SERVICE_ASSIGNMENT_NONE_KEY } from "@/lib/appointments/service-assignments";
import { extractRepeatSeries } from "@/lib/appointments/repeat";
import type { AppointmentDetailPayload } from "@/components/appointments/types";
import type { ManualConfirmationMode } from "@/lib/booking-preferences";

type StaffOption = {
  id: string;
  name: string;
  color: string;
  onlineBookable?: boolean;
};

type ServiceOption = {
  id: string;
  name: string;
  duration: number;
  basePrice: number;
  currency: string;
  tags?: string[];
  popularityScore?: number;
  steps?: Array<{
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

type ResourceOption = {
  id: string;
  name: string;
  type: string;
  color?: string;
};

type CustomerOption = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  appointmentCount: number;
  lastAppointment: string | null;
  lastAppointmentStatus: string | null;
  consents: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
  };
};

type CustomerCreatedMessage = {
  type: "calendar.customer.created";
  customer: {
    id: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
};

type CtiApplyEventDetail = {
  customerId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
};

type RepeatScope = "single" | "following";

type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER" | "UE_ABBAU";
type TimeBlockerReasonValue = TimeBlockerReason | "";

const createEntryKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? (crypto.randomUUID as () => string)()
    : Math.random().toString(36).slice(2);

const createEmptyServiceEntry = (serviceId: string | null = null, staffIds: string[] = []): ServiceEntryState => ({
  key: createEntryKey(),
  serviceId,
  durationOverride: null,
  staffIds,
});

type ServiceEntryState = {
  key: string;
  serviceId: string | null;
  durationOverride: number | null;
  staffIds: string[];
};

type ColorSummaryEntry = {
  term: string;
  description: string;
};

export type SchedulerContext =
  | {
      mode: "create";
      entity: "appointment";
      start: Date;
      end?: Date;
      staffId?: string | null;
    }
  | {
      mode: "create";
      entity: "blocker";
      start: Date;
      end?: Date;
      staffId?: string | null;
    }
  | {
      mode: "edit";
      entity: "appointment";
      appointment: {
        id: string;
        itemId?: string;
        startsAt: Date;
        endsAt: Date;
        staffIds: string[];
        serviceIds: string[];
        serviceStaffAssignments?: Record<string, string[]>;
        customerId?: string | null;
        customerName?: string | null;
        note?: string | null;
        internalNote?: string | null;
        status?: AppointmentStatus;
        source?: string | null;
        createdAt?: string | null;
        metadata?: Record<string, unknown> | null;
        notifyCustomer?: boolean;
        auditTrail?: AppointmentDetailPayload["auditTrail"];
      };
    }
  | {
      mode: "edit";
      entity: "blocker";
      blocker: {
        id: string;
        startsAt: Date;
        endsAt: Date;
        allStaff: boolean;
        staffIds: string[];
        reason: TimeBlockerReason;
        customReason?: string | null;
      };
    };

interface SchedulerDrawerProps {
  open: boolean;
  onClose: () => void;
  context: SchedulerContext | null;
  locationId: string;
  locationSlug: string;
  timezone: string;
  actorRole: string | null;
  staffOptions: StaffOption[];
  services: ServiceOption[];
  resources: ResourceOption[];
  customers: CustomerOption[];
  onCreated?: () => void;
  onUpdated?: () => void;
  onDeleted?: () => void;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
  manualConfirmationMode?: ManualConfirmationMode;
}

const MAX_ATTACHMENTS = 5;

const TIME_BLOCKER_REASON_LABELS: Record<TimeBlockerReason, string> = {
  BREAK: "Pause",
  MEAL: "Mittagessen",
  VACATION: "Urlaub",
  SICK: "Krankmeldung",
  PRIVATE: "Privater Termin",
  OTHER: "Anderer Grund",
  UE_ABBAU: "Ü-Abbau",
};

type TimeBlockerAuditEntry = {
  id: string;
  action: string;
  actorType: string;
  actorName: string | null;
  createdAt: string;
  diff: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
};

type TimeBlockerDetailResponse = {
  id: string;
  staffId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  reasonType?: TimeBlockerReason | null;
  customReason?: string | null;
  allStaff?: boolean;
  metadata?: unknown;
  auditTrail?: TimeBlockerAuditEntry[];
  error?: string;
};

const TIME_BLOCKER_OPTIONS: Array<{ value: TimeBlockerReason; label: string }> = [
  { value: "BREAK", label: "Pause" },
  { value: "MEAL", label: "Mittagessen" },
  { value: "VACATION", label: "Urlaub" },
  { value: "SICK", label: "Krankheit" },
  { value: "PRIVATE", label: "Privater Termin" },
  { value: "OTHER", label: "Anderer Grund" },
  { value: "UE_ABBAU", label: "Ü-Abbau" },
];

const TIME_ROWS = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  slots: Array.from({ length: 12 }, (_, slot) => {
    const minutes = hour * 60 + slot * 5;
    const mins = slot * 5;
    const label = `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
    return { minutes, label };
  }),
}));
function mergeDateWithTime(datePart: Date, timeSource: Date): Date {
  const merged = new Date(datePart);
  merged.setHours(timeSource.getHours(), timeSource.getMinutes(), 0, 0);
  return merged;
}

function setTimeFromMinutes(date: Date, minutes: number): Date {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const updated = new Date(date);
  updated.setHours(hours, mins, 0, 0);
  return updated;
}

function formatTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function parseTimeInputValue(value: string): number | null {
  if (!value) return null;
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatDateLabel(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatTimeLabelLocal(date: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function useOutsideClose(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent | PointerEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("pointerdown", handlePointer);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("pointerdown", handlePointer);
    };
  }, [open, onClose, ref]);
}

export function SchedulerDrawer({
  open,
  onClose,
  context,
  locationId,
  locationSlug,
  timezone,
  actorRole,
  staffOptions,
  services,
  resources,
  customers,
  onCreated,
  onUpdated,
  onDeleted,
  ensureBookingActor,
  manualConfirmationMode,
}: SchedulerDrawerProps) {
  const router = useRouter();
  const { pushToast } = useToast();
  const { registerActivity, actor } = useBookingPinSession();
  const activityRef = useRef(registerActivity);

  const derivedMode = useMemo<"appointment" | "blocker">(() => {
    if (!context) return "appointment";
    return context.entity === "blocker" ? "blocker" : "appointment";
  }, [context]);
  const confirmationMode = manualConfirmationMode ?? "both";
  const singleChannelOnly = confirmationMode === "single";

  const derivedStart = useMemo(() => {
    if (!context) return new Date();
    if (context.mode === "create") {
      return context.start;
    }
    if (context.entity === "appointment") {
      return context.appointment.startsAt;
    }
    return context.blocker.startsAt;
  }, [context]);

  const derivedEnd = useMemo(() => {
    const defaultDuration = services[0]?.duration ?? 30;
    if (!context) {
      return addMinutes(derivedStart, defaultDuration);
    }
    if (context.mode === "create") {
      return context.end ?? addMinutes(context.start, defaultDuration);
    }
    if (context.entity === "appointment") {
      return context.appointment.endsAt;
    }
    return context.blocker.endsAt;
  }, [context, derivedStart, services]);

  const derivedStaffIds = useMemo(() => {
    if (!context) return [];
    if (context.mode === "create") {
      return context.staffId ? [context.staffId] : [];
    }
    if (context.entity === "appointment") {
      return context.appointment.staffIds.length ? context.appointment.staffIds : [];
    }
    if (context.blocker.allStaff) {
      return [];
    }
    return context.blocker.staffIds;
  }, [context]);

  const derivedCustomerId = useMemo(() => {
    if (!context || context.entity !== "appointment" || context.mode !== "edit") {
      return undefined;
    }
    return context.appointment.customerId ?? undefined;
  }, [context]);
  const derivedCustomerName = useMemo(() => {
    if (!context || context.entity !== "appointment" || context.mode !== "edit") {
      return null;
    }
    return context.appointment.customerName ?? null;
  }, [context]);

  const derivedNotifyCustomer = useMemo(() => {
    if (!context || context.entity !== "appointment" || context.mode !== "edit") {
      return true;
    }
    return context.appointment.notifyCustomer ?? false;
  }, [context]);

  const derivedCustomerRecord = useMemo(() => {
    if (!derivedCustomerId) return null;
    return customers.find((customer) => customer.id === derivedCustomerId) ?? null;
  }, [customers, derivedCustomerId]);

  const initialAppointmentCustomerId =
    context?.mode === "edit" && context.entity === "appointment"
      ? context.appointment.customerId ?? null
      : null;

  const derivedBlockerAllStaff = useMemo(() => {
    if (!context || context.entity !== "blocker" || context.mode !== "edit") {
      return false;
    }
    return context.blocker.allStaff;
  }, [context]);

  const derivedBlockerReason = useMemo<TimeBlockerReasonValue>(() => {
    if (!context || context.entity !== "blocker" || context.mode !== "edit") {
      return "";
    }
    return context.blocker.reason ?? "OTHER";
  }, [context]);

  const derivedBlockerCustomReason = useMemo(() => {
    if (!context || context.entity !== "blocker" || context.mode !== "edit") {
      return "";
    }
    return context.blocker.customReason ?? "";
  }, [context]);

  const derivedServiceIds = useMemo(() => {
    if (!context || context.entity !== "appointment" || context.mode !== "edit") {
      return [];
    }
    return context.appointment.serviceIds ?? [];
  }, [context]);

  const derivedServiceAssignments = useMemo(() => {
    if (!context || context.entity !== "appointment" || context.mode !== "edit") {
      return {};
    }
    const raw = context.appointment.serviceStaffAssignments ?? {};
    const normalized: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!Array.isArray(value)) continue;
      const filtered = Array.from(
        new Set(
          value
            .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
            .filter((entry): entry is string => entry.length > 0),
        ),
      );
      if (filtered.length) {
        normalized[key] = filtered;
      }
    }
    return normalized;
  }, [context]);

  const repeatSeries = useMemo(() => {
    if (!context || context.entity !== "appointment" || context.mode !== "edit") {
      return null;
    }
    return extractRepeatSeries(context.appointment.metadata ?? null);
  }, [context]);

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

  const [composerMode, setComposerMode] = useState<"appointment" | "blocker">(derivedMode);
  const [start, setStartState] = useState(derivedStart);
  const [end, setEnd] = useState(derivedEnd);
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>(() =>
    derivedStaffIds.length ? [...derivedStaffIds] : [],
  );
  const [calendarHold, setCalendarHold] = useState<{ slotKey: string; expiresAt: string } | null>(null);
  const holdStorageKey = useMemo(() => `calendar.pendingHold:${locationSlug}`, [locationSlug]);
  const dispatchHoldSync = useCallback(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("calendar.hold.sync", { detail: { locationSlug } }));
  }, [locationSlug]);
  const storePendingHold = useCallback(
    (slotKey: string) => {
      if (typeof window === "undefined") return;
      try {
        window.sessionStorage.setItem(holdStorageKey, slotKey);
      } catch {
        // ignore storage failures
      }
    },
    [holdStorageKey],
  );
  const clearPendingHold = useCallback(
    (slotKey?: string | null) => {
      if (typeof window === "undefined") return;
      try {
        const stored = window.sessionStorage.getItem(holdStorageKey);
        if (!stored) return;
        if (slotKey && stored !== slotKey) return;
        window.sessionStorage.removeItem(holdStorageKey);
      } catch {
        // ignore storage failures
      }
    },
    [holdStorageKey],
  );
  const holdSignatureRef = useRef<string | null>(null);
  const getServiceStaffPreset = useCallback(
    (serviceId: string | null) => {
      const key = serviceId ?? SERVICE_ASSIGNMENT_NONE_KEY;
      const assigned = derivedServiceAssignments[key];
      if (assigned?.length) {
        return [...assigned];
      }
      return derivedStaffIds.length ? [...derivedStaffIds] : [];
    },
    [derivedServiceAssignments, derivedStaffIds],
  );
  const [serviceEntries, setServiceEntries] = useState<ServiceEntryState[]>(() => {
    if (derivedServiceIds.length > 0) {
      return derivedServiceIds.map((id) => createEmptyServiceEntry(id ?? null, getServiceStaffPreset(id ?? null)));
    }
    return [createEmptyServiceEntry(null, getServiceStaffPreset(null))];
  });
  useEffect(() => {
    const union: string[] = [];
    for (const entry of serviceEntries) {
      for (const staffId of entry.staffIds) {
        if (staffId && !union.includes(staffId)) {
          union.push(staffId);
        }
      }
    }
    setSelectedStaffIds((prev) => {
      if (prev.length === union.length && prev.every((id, index) => id === union[index])) {
        return prev;
      }
      return union;
    });
  }, [serviceEntries]);
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>(customers);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerDropdownOpen, setCustomerDropdownOpen] = useState(false);
  const [customerCreateOpen, setCustomerCreateOpen] = useState(false);
  const [customerCreateLoading, setCustomerCreateLoading] = useState(false);
  const [customerCreateError, setCustomerCreateError] = useState<string | null>(null);
  const [customerCreatePreset, setCustomerCreatePreset] = useState<{ firstName: string; lastName: string; email: string; phone: string }>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
  });
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(() => derivedCustomerId);
  const [customerProfileId, setCustomerProfileId] = useState<string | null>(null);
  const [sendEmail, setSendEmail] = useState(false);
  const [sendSms, setSendSms] = useState(false);
  const [sendWhatsApp, setSendWhatsApp] = useState(false);
  const [whatsAppOptIn, setWhatsAppOptIn] = useState(false);
  const releaseCalendarHold = useCallback(
    async (slotKey?: string | null) => {
      const key = slotKey ?? calendarHold?.slotKey;
      if (!key) return;
      const response = await fetch(`/api/backoffice/${locationSlug}/booking-holds`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotKey: key }),
      }).catch(() => null);
      if (response?.ok && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("calendar.hold.released", { detail: { slotKey: key } }));
        clearPendingHold(key);
        dispatchHoldSync();
      }
      if (key === calendarHold?.slotKey) {
        setCalendarHold(null);
      }
    },
    [calendarHold?.slotKey, clearPendingHold, dispatchHoldSync, locationSlug],
  );
  const isAdmin = (() => {
    const normalized = (actorRole ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return new Set(["2", "admin", "administrator", "superadmin", "super-admin", "owner"]).has(normalized);
  })();
  const nonOnlineStaffOptions = useMemo(
    () => staffOptions.filter((staff) => staff.onlineBookable === false),
    [staffOptions],
  );
  const vipStaffOptions = useMemo(
    () => nonOnlineStaffOptions.map((staff) => ({ id: staff.id, name: staff.name })),
    [nonOnlineStaffOptions],
  );
  const nonOnlineStaffIds = useMemo(
    () => new Set(nonOnlineStaffOptions.map((staff) => staff.id)),
    [nonOnlineStaffOptions],
  );
  const selectedNonOnlineStaffIds = useMemo(
    () =>
      selectedStaffIds.filter(
        (staffId) => staffId !== "unassigned" && nonOnlineStaffIds.has(staffId),
      ),
    [selectedStaffIds, nonOnlineStaffIds],
  );
  const [vipStaffIds, setVipStaffIds] = useState<string[]>([]);
  const vipTouchedRef = useRef(false);
  useEffect(() => {
    if (!selectedCustomerId) {
      vipTouchedRef.current = false;
      setVipStaffIds([]);
      return;
    }
    if (!selectedNonOnlineStaffIds.length) {
      vipTouchedRef.current = false;
      setVipStaffIds([]);
      return;
    }
    if (!vipTouchedRef.current) {
      setVipStaffIds(selectedNonOnlineStaffIds);
    }
  }, [selectedCustomerId, selectedNonOnlineStaffIds]);
  const showVipPermission = isAdmin && Boolean(selectedCustomerId) && nonOnlineStaffOptions.length > 0;
  const handleVipStaffToggle = useCallback((staffId: string) => {
    vipTouchedRef.current = true;
    setVipStaffIds((current) =>
      current.includes(staffId) ? current.filter((id) => id !== staffId) : [...current, staffId],
    );
  }, []);
  const [note, setNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [markNoShow, setMarkNoShow] = useState(
    context?.mode === "edit" && context.entity === "appointment" ? context.appointment.status === "NO_SHOW" : false,
  );
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatFrequency, setRepeatFrequency] = useState<"DAILY" | "WEEKLY">("WEEKLY");
  const [repeatCount, setRepeatCount] = useState(1);
  const [repeatScopeDialog, setRepeatScopeDialog] = useState<{
    actionLabel: string;
    resolve: (scope: RepeatScope | null) => void;
  } | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);

  const requestRepeatScope = useCallback(
    (actionLabel: string) => {
      if (!repeatSeries) {
        return Promise.resolve<RepeatScope | null>("single");
      }
      return new Promise<RepeatScope | null>((resolve) => {
        setRepeatScopeDialog({ actionLabel, resolve });
      });
    },
    [repeatSeries],
  );

  const resolveRepeatScope = useCallback((scope: RepeatScope | null) => {
    setRepeatScopeDialog((current) => {
      current?.resolve(scope);
      return null;
    });
  }, []);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [requestAction, setRequestAction] = useState<"CANCEL" | "DELETE" | null>(null);
  const [requestReason, setRequestReason] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requestSending, setRequestSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manualEndStateRef = useRef<{ active: boolean }>({ active: false });
  const lastUserStartRef = useRef<Date | null>(null);
  const [blockerStaffIds, setBlockerStaffIds] = useState<string[]>(() =>
    derivedBlockerAllStaff ? [] : derivedStaffIds.length ? [...derivedStaffIds] : [],
  );
  const [blockerAllStaff, setBlockerAllStaff] = useState(derivedBlockerAllStaff);
  const [blockerReason, setBlockerReason] = useState<TimeBlockerReasonValue>("");
  const [blockerCustomReason, setBlockerCustomReason] = useState(derivedBlockerCustomReason);
  const [blockerStart, setBlockerStart] = useState(derivedStart);
  const [blockerEnd, setBlockerEnd] = useState(derivedEnd);
  const [blockerAllDay, setBlockerAllDay] = useState(false);
  const [blockerSubmitting, setBlockerSubmitting] = useState(false);
  const [blockerError, setBlockerError] = useState<string | null>(null);
  const [blockerDeleting, setBlockerDeleting] = useState(false);
  const previousBlockerRangeRef = useRef<{ start: Date; end: Date } | null>(null);
  const [blockerAuditTrail, setBlockerAuditTrail] = useState<TimeBlockerAuditEntry[]>([]);
  const [blockerAuditLoading, setBlockerAuditLoading] = useState(false);
  const [blockerAuditError, setBlockerAuditError] = useState<string | null>(null);
  const lastInitializationRef = useRef<{
    startMs: number;
    endMs: number;
    staffKey: string;
    serviceKey: string;
    assignmentKey: string;
    mode: "create" | "edit" | "idle";
    entity: "appointment" | "blocker" | "none";
  } | null>(null);
  const lastContextRef = useRef<SchedulerContext | null>(null);
  const pendingCustomerFetchRef = useRef<Set<string>>(new Set());
  const customerSearchAbortRef = useRef<AbortController | null>(null);
  const customerSearchTimeoutRef = useRef<number | null>(null);
  const lastCustomerSearchRef = useRef<string>("");

  if (!open) {
    lastInitializationRef.current = null;
    lastUserStartRef.current = null;
    lastContextRef.current = null;
  }

  useEffect(() => {
    if (!open) {
      setCustomerProfileId(null);
    }
  }, [open]);

  useEffect(() => {
    if (!selectedCustomerId && customerProfileId) {
      setCustomerProfileId(null);
    }
  }, [selectedCustomerId, customerProfileId]);

  useEffect(() => {
    if (selectedCustomerId) return;
    setSendEmail(false);
    setSendSms(false);
    setSendWhatsApp(false);
    setWhatsAppOptIn(false);
  }, [selectedCustomerId]);

  const emptyConsents = useMemo(() => ({ email: false, sms: false, whatsapp: false }), []);
  const selectedCustomer = useMemo(
    () => customerOptions.find((customer) => customer.id === selectedCustomerId) ?? null,
    [customerOptions, selectedCustomerId],
  );
  const customerProfileName = useMemo(() => {
    if (!customerProfileId) return null;
    const match = customers.find((customer) => customer.id === customerProfileId);
    const name = match
      ? `${match.firstName ?? ""} ${match.lastName ?? ""}`.replace(/\s+/g, " ").trim()
      : "";
    const fallback = derivedCustomerName?.trim() ?? "";
    return name || fallback || "Kundenprofil";
  }, [customerProfileId, customers, derivedCustomerName]);
  const customerProfileUrl = customerProfileId
    ? `/backoffice/${locationSlug}/customers?customer=${customerProfileId}&embed=1`
    : null;
  const selectedConsents = selectedCustomer?.consents ?? emptyConsents;
  const isAppointmentEdit = context?.mode === "edit" && context?.entity === "appointment";
  const isCreateAppointment = open && context?.mode === "create" && context?.entity === "appointment";

  useEffect(() => {
    if (!open) return;
    if (!selectedCustomerId || selectedCustomer) return;
    const pending = pendingCustomerFetchRef.current;
    if (pending.has(selectedCustomerId)) return;

    const targetCustomerId = selectedCustomerId;
    pending.add(targetCustomerId);
    const controller = new AbortController();

    const fetchCustomer = async () => {
      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/customers/${encodeURIComponent(targetCustomerId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          return;
        }
        const data = await response.json().catch(() => null);
        const customer = data?.customer;
        if (!customer?.id) {
          return;
        }
        const normalized: CustomerOption = {
          id: customer.id,
          firstName: customer.firstName ?? "",
          lastName: customer.lastName ?? "",
          email: customer.email ?? "",
          phone: customer.phone ?? "",
          appointmentCount: customer.appointmentCount ?? 0,
          lastAppointment: customer.lastAppointment ?? null,
          lastAppointmentStatus: customer.lastAppointmentStatus ?? null,
          consents: customer.consents ?? { email: false, sms: false, whatsapp: false },
        };
        setCustomerOptions((current) => {
          const existingIndex = current.findIndex((entry) => entry.id === normalized.id);
          if (existingIndex >= 0) {
            const next = [...current];
            next[existingIndex] = { ...next[existingIndex], ...normalized };
            return next;
          }
          return [normalized, ...current];
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      } finally {
        pending.delete(targetCustomerId);
      }
    };

    fetchCustomer();

    return () => {
      controller.abort();
      pending.delete(targetCustomerId);
    };
  }, [open, selectedCustomerId, selectedCustomer, locationSlug]);

  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    const query = customerQuery.trim();
    if (query.length < 2) return;
    if (lastCustomerSearchRef.current === query) return;

    if (customerSearchTimeoutRef.current) {
      window.clearTimeout(customerSearchTimeoutRef.current);
    }
    customerSearchAbortRef.current?.abort();
    const controller = new AbortController();
    customerSearchAbortRef.current = controller;

    const timeoutId = window.setTimeout(async () => {
      lastCustomerSearchRef.current = query;
      try {
        const params = new URLSearchParams({ q: query });
        const response = await fetch(
          `/api/backoffice/${locationSlug}/customers/search?${params.toString()}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const data = await response.json().catch(() => null);
        const results = Array.isArray(data?.customers) ? data.customers : [];
        if (!results.length) return;
        setCustomerOptions((current) => {
          const byId = new Map(current.map((entry) => [entry.id, entry]));
          for (const entry of results) {
            const normalized: CustomerOption = {
              id: entry.id,
              firstName: entry.firstName ?? "",
              lastName: entry.lastName ?? "",
              email: entry.email ?? "",
              phone: entry.phone ?? "",
              appointmentCount: entry.appointmentCount ?? 0,
              lastAppointment: entry.lastAppointment ?? null,
              lastAppointmentStatus: entry.lastAppointmentStatus ?? null,
              consents: entry.consents ?? { email: false, sms: false, whatsapp: false },
            };
            byId.set(entry.id, { ...byId.get(entry.id), ...normalized });
          }
          return Array.from(byId.values());
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
      }
    }, 250);

    customerSearchTimeoutRef.current = timeoutId;

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [open, customerQuery, locationSlug]);

  useEffect(() => {
    if (!selectedCustomerId) return;
    if (isAppointmentEdit) {
      setSendEmail(false);
      setSendSms(false);
      setSendWhatsApp(false);
      setWhatsAppOptIn(selectedConsents.whatsapp);
      return;
    }
    const emailSmsAllowed = selectedConsents.email && selectedConsents.sms;
    if (singleChannelOnly) {
      if (selectedConsents.whatsapp) {
        setSendEmail(false);
        setSendSms(false);
        setSendWhatsApp(true);
        setWhatsAppOptIn(true);
        return;
      }
      setSendEmail(emailSmsAllowed);
      setSendSms(emailSmsAllowed);
      setSendWhatsApp(false);
      setWhatsAppOptIn(false);
      return;
    }
    setSendEmail(emailSmsAllowed);
    setSendSms(emailSmsAllowed);
    setSendWhatsApp(selectedConsents.whatsapp);
    setWhatsAppOptIn(selectedConsents.whatsapp);
  }, [
    selectedCustomerId,
    selectedConsents.email,
    selectedConsents.sms,
    selectedConsents.whatsapp,
    singleChannelOnly,
    isAppointmentEdit,
  ]);
  useEffect(() => {
    if (!isAppointmentEdit || !selectedCustomerId) return;
    setWhatsAppOptIn(selectedConsents.whatsapp);
  }, [context?.appointment?.status, isAppointmentEdit, selectedCustomerId, selectedConsents.whatsapp]);

  const normalizedRole = (actorRole ?? "").trim().toLowerCase();
  const isRole1 = normalizedRole === "1";
  const isRole2 = normalizedRole === "2" || normalizedRole === "admin";
  const hasCustomer = Boolean(context?.mode === "edit" && context.entity === "appointment" && context.appointment.customerId);
  const showNoShowToggle =
    context?.mode === "edit" && context.entity === "appointment" && hasCustomer && start <= new Date();
  const appointmentAuditTrail =
    isAppointmentEdit && context?.entity === "appointment" && Array.isArray(context.appointment.auditTrail)
      ? context.appointment.auditTrail
      : [];
  const isCancelled = isAppointmentEdit ? context?.appointment.status === "CANCELLED" : false;
  const endRef = isAppointmentEdit ? context.appointment.endsAt ?? context.appointment.startsAt ?? null : null;
  const within24h =
    endRef === null ? true : new Date().getTime() <= new Date(endRef).getTime() + 24 * 60 * 60 * 1000;
  // Stornieren: nur binnen 24h nach Terminende (bzw. ohne Endzeit).
  // Löschen: nur nach Storno und binnen 24h nach Terminende.
  const canCancel = Boolean(isAppointmentEdit && !isCancelled && (within24h || isRole2));
  const canDelete = Boolean(isAppointmentEdit && isCancelled && isRole2);
  const canRestore = Boolean(isAppointmentEdit && isCancelled && (within24h || isRole2));
  const allowRequestCancel = Boolean(isAppointmentEdit && !isCancelled && !within24h && !isRole2);
  const allowRequestDelete = Boolean(isAppointmentEdit && !isRole2);

  const openRequestAction = useCallback((action: "CANCEL" | "DELETE") => {
    setRequestError(null);
    setRequestAction(action);
  }, []);

  const dismissRequestAction = useCallback(() => {
    setRequestAction(null);
    setRequestReason("");
    setRequestError(null);
  }, []);

  useEffect(() => {
    setMarkNoShow(
      context?.mode === "edit" && context.entity === "appointment" ? context.appointment.status === "NO_SHOW" : false,
    );
  }, [context]);

  useEffect(() => {
    if (!showNoShowToggle && markNoShow) {
      setMarkNoShow(false);
    }
  }, [showNoShowToggle, markNoShow]);

  useEffect(() => {
    dismissRequestAction();
    setRequestSending(false);
  }, [context?.mode, context?.entity, context?.appointment?.id, dismissRequestAction]);

  const applyStart = useCallback(
    (nextStart: Date, reason: string) => {
      if (process.env.NODE_ENV !== "production") {
        console.info("[Scheduler] Start aktualisiert (%s): %s", reason, nextStart.toISOString());
      }
      setStartState(nextStart);
    },
    [setStartState],
  );

  const formatDateTimeLabel = useCallback(
    (value: Date) => formatDateWithPatternInTimeZone(value, "datetime", timezone),
    [timezone],
  );
  const formatTimeLabel = useCallback(
    (value: Date) => formatInTimeZone(value, timezone, { hour: "2-digit", minute: "2-digit", hour12: false }),
    [timezone],
  );
  const toDateTimeLocalValue = useCallback((value: Date) => formatDateTimeLocalInput(value, timezone), [timezone]);
  const parseDateTimeLocalValue = useCallback((value: string) => parseDateTimeLocalInput(value, timezone), [timezone]);

  useEffect(() => {
    if (!open) return;
    if (typeof window === "undefined") return;
    const expectedOrigin = window.location.origin;
    const handleMessage = (event: MessageEvent<CustomerCreatedMessage>) => {
      if (event.origin !== expectedOrigin) return;
      const payload = event.data;
      if (!payload || payload.type !== "calendar.customer.created" || !payload.customer?.id) {
        return;
      }
      const { customer } = payload;
      setCustomerOptions((current) => {
        const normalized: CustomerOption = {
          id: customer.id,
          firstName: customer.firstName ?? "",
          lastName: customer.lastName ?? "",
          email: customer.email ?? "",
          phone: customer.phone ?? "",
          appointmentCount: 0,
          lastAppointment: null,
          lastAppointmentStatus: null,
          consents: { email: false, sms: false, whatsapp: false },
        };
        const existingIndex = current.findIndex((entry) => entry.id === customer.id);
        if (existingIndex >= 0) {
          const next = [...current];
          next[existingIndex] = { ...next[existingIndex], ...normalized };
          return next;
        }
        return [normalized, ...current];
      });
      setSelectedCustomerId(customer.id);
      setCustomerQuery("");
      pushToast({ variant: "success", message: "Kunde übernommen." });
      router.refresh();
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [open, pushToast, router]);

  useEffect(() => {
    if (!open || !isCreateAppointment) return;
    if (typeof window === "undefined") return;
    const handleApply = (event: Event) => {
      const detail = (event as CustomEvent<CtiApplyEventDetail>).detail;
      if (!detail) return;

      if (detail.customerId) {
        const firstName = detail.firstName ?? "";
        const lastName = detail.lastName ?? "";
        const mergedName =
          detail.name ?? `${firstName} ${lastName}`.replace(/\s+/g, " ").trim();

        setCustomerOptions((current) => {
          if (current.some((entry) => entry.id === detail.customerId)) {
            return current;
          }
          const normalized: CustomerOption = {
            id: detail.customerId,
            firstName,
            lastName,
            email: "",
            phone: detail.phone ?? "",
            appointmentCount: 0,
            lastAppointment: null,
            lastAppointmentStatus: null,
            consents: { email: false, sms: false, whatsapp: false },
          };
          return [normalized, ...current];
        });
        setSelectedCustomerId(detail.customerId);
        if (mergedName) {
          setCustomerQuery(mergedName);
        }
        setCustomerDropdownOpen(false);
        setCustomerCreateOpen(false);
        setCustomerCreatePreset({ firstName: "", lastName: "", email: "", phone: "" });
        return;
      }

      if (detail.phone) {
        setCustomerCreatePreset({ firstName: "", lastName: "", email: "", phone: detail.phone });
        setCustomerCreateError(null);
        setCustomerCreateOpen(true);
        setCustomerDropdownOpen(false);
      }
    };

    window.addEventListener("cti.apply", handleApply);
    return () => window.removeEventListener("cti.apply", handleApply);
  }, [isCreateAppointment, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setCustomerOptions((current) => {
      const seen = new Set<string>();
      const merged: CustomerOption[] = [];
      for (const entry of customers) {
        merged.push(entry);
        seen.add(entry.id);
      }
      for (const entry of current) {
        if (!seen.has(entry.id)) {
          merged.push(entry);
          seen.add(entry.id);
        }
      }
      return merged;
    });

    const serviceKey = services.map((service) => service.id).join("|");
    const staffKey = derivedStaffIds.join("|");
    const assignmentKey = Object.entries(derivedServiceAssignments)
      .map(([key, list]) => `${key}:${list.join(",")}`)
      .sort()
      .join("|");
    const configMode: "create" | "edit" | "idle" = context?.mode ?? "idle";
    const configEntity: "appointment" | "blocker" = context?.entity ?? "appointment";
    const config = {
      startMs: derivedStart.getTime(),
      endMs: derivedEnd.getTime(),
      staffKey,
      serviceKey,
      assignmentKey,
      mode: configMode,
      entity: configEntity,
    };

    const previous = lastInitializationRef.current;
    const isNewContext = lastContextRef.current !== context;
    const shouldReset =
      isNewContext ||
      previous === null ||
      previous.startMs !== config.startMs ||
      previous.endMs !== config.endMs ||
      previous.staffKey !== config.staffKey ||
      previous.serviceKey !== config.serviceKey ||
      previous.assignmentKey !== config.assignmentKey ||
      previous.mode !== config.mode ||
      previous.entity !== config.entity;

    if (!shouldReset) {
      return;
    }

    setComposerMode(derivedMode);
    applyStart(derivedStart, "initialisierung");
    lastUserStartRef.current = null;
    setEnd(derivedEnd);
    manualEndStateRef.current.active = context?.mode === "edit" && context.entity === "appointment";
    if (context?.mode === "edit" && context.entity === "appointment" && context.appointment.serviceIds.length) {
      setServiceEntries(
        context.appointment.serviceIds.map((serviceId) =>
          createEmptyServiceEntry(serviceId ?? null, getServiceStaffPreset(serviceId ?? null)),
        ),
      );
    } else {
      setServiceEntries([createEmptyServiceEntry(null, getServiceStaffPreset(null))]);
    }
    const customerName =
      derivedCustomerRecord && derivedCustomerId
        ? `${derivedCustomerRecord.firstName ?? ""} ${derivedCustomerRecord.lastName ?? ""}`.replace(/\s+/g, " ").trim()
        : derivedCustomerName ?? "";
    setCustomerQuery(customerName);
    setSelectedCustomerId(derivedCustomerId);
    setSendEmail(false);
    setSendSms(false);
    setSendWhatsApp(false);
    setWhatsAppOptIn(false);
    setNote(
      context?.mode === "edit" && context.entity === "appointment" ? context.appointment.note ?? "" : "",
    );
    setInternalNote(
      context?.mode === "edit" && context.entity === "appointment" ? context.appointment.internalNote ?? "" : "",
    );
    setRepeatEnabled(false);
    setRepeatFrequency("WEEKLY");
    setRepeatCount(4);
    setAttachments([]);
    setError(null);
    setIsSubmitting(false);

    setBlockerStaffIds(derivedBlockerAllStaff ? [] : derivedStaffIds.length ? [...derivedStaffIds] : []);
    setBlockerAllStaff(derivedBlockerAllStaff);
    setBlockerReason(derivedBlockerReason);
    setBlockerCustomReason(derivedBlockerCustomReason);
    setBlockerStart(derivedStart);
    setBlockerEnd(derivedEnd);
    setBlockerAllDay(false);
    setBlockerSubmitting(false);
    setBlockerError(null);

    lastInitializationRef.current = {
      startMs: config.startMs,
      endMs: config.endMs,
      staffKey: config.staffKey,
      serviceKey: config.serviceKey,
      assignmentKey: config.assignmentKey,
      mode: config.mode,
      entity: config.entity,
    };
    lastContextRef.current = context;
  }, [
    open,
    context,
    customers,
    services,
    derivedServiceAssignments,
    derivedMode,
    derivedStart,
    derivedEnd,
    derivedStaffIds,
    derivedCustomerId,
    derivedCustomerRecord,
    derivedNotifyCustomer,
    derivedBlockerAllStaff,
    derivedBlockerReason,
    derivedBlockerCustomReason,
    getServiceStaffPreset,
    applyStart,
  ]);

  const servicesById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);

  const selectedServices = useMemo(
    () => serviceEntries.map((entry) => entry.serviceId).filter((id): id is string => Boolean(id)),
    [serviceEntries],
  );
  const holdServiceNames = useMemo(
    () =>
      selectedServices
        .map((serviceId) => servicesById.get(serviceId)?.name)
        .filter((name): name is string => Boolean(name && name.trim().length > 0)),
    [selectedServices, servicesById],
  );
  const holdStaffId = useMemo(() => {
    if (!open) return null;
    if (context?.mode !== "create" || context.entity !== "appointment") return null;
    if (selectedStaffIds.length !== 1) return null;
    const staffId = selectedStaffIds[0];
    if (!staffId || staffId === "unassigned") return null;
    return staffId;
  }, [open, context?.mode, context?.entity, selectedStaffIds]);
  const holdCreatedBy = useMemo(() => {
    const staffId = actor?.staffId ?? null;
    const staffName = actor?.staffName?.trim() ?? "";
    const name = staffName.length ? staffName : null;
    if (!staffId && !name) return null;
    return { staffId, name };
  }, [actor?.staffId, actor?.staffName]);
  const holdSignature = useMemo(() => {
    if (!holdStaffId) return null;
    const creatorKey = holdCreatedBy?.staffId ?? holdCreatedBy?.name ?? "unknown";
    return `${holdStaffId}|${start.toISOString()}|${end.toISOString()}|${selectedServices.join(",")}|${creatorKey}`;
  }, [holdStaffId, start, end, selectedServices, holdCreatedBy]);

  useEffect(() => {
    let active = true;
    const syncHold = async () => {
      if (!holdSignature || !holdStaffId) {
        if (calendarHold) {
          await releaseCalendarHold(calendarHold.slotKey);
        }
        holdSignatureRef.current = null;
        return;
      }
      if (holdSignatureRef.current === holdSignature && calendarHold) return;

      if (calendarHold) {
        await releaseCalendarHold(calendarHold.slotKey);
      }
      const response = await fetch(`/api/backoffice/${locationSlug}/booking-holds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staffId: holdStaffId,
          start: start.toISOString(),
          end: end.toISOString(),
          serviceNames: holdServiceNames,
          createdByStaffId: holdCreatedBy?.staffId ?? undefined,
          createdByName: holdCreatedBy?.name ?? undefined,
        }),
      }).catch(() => null);
      if (!response || !response.ok) {
        holdSignatureRef.current = null;
        return;
      }
      const payload = (await response.json().catch(() => null)) as { slotKey?: string; expiresAt?: string } | null;
      if (!payload?.slotKey || !payload?.expiresAt) {
        holdSignatureRef.current = null;
        return;
      }
      if (!active) {
        await releaseCalendarHold(payload.slotKey);
        return;
      }
      storePendingHold(payload.slotKey);
      dispatchHoldSync();
      setCalendarHold({ slotKey: payload.slotKey, expiresAt: payload.expiresAt });
      holdSignatureRef.current = holdSignature;
    };
    void syncHold();
    return () => {
      active = false;
    };
  }, [
    holdSignature,
    holdStaffId,
    start,
    end,
    holdServiceNames,
    calendarHold,
    releaseCalendarHold,
    locationSlug,
    storePendingHold,
  ]);

  const totalDuration = useMemo(() => {
    return serviceEntries.reduce((sum, entry) => {
      if (!entry.serviceId) return sum;
      const service = servicesById.get(entry.serviceId);
      if (!service) return sum;
      const duration = entry.durationOverride ?? service.duration;
      return sum + (Number.isFinite(duration) ? duration : 0);
    }, 0);
  }, [serviceEntries, servicesById]);

  useEffect(() => {
    if (blockerAllDay) {
      previousBlockerRangeRef.current = { start: blockerStart, end: blockerEnd };
      const startOfDay = new Date(blockerStart);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setHours(23, 59, 59, 999);
      setBlockerStart(startOfDay);
      setBlockerEnd(endOfDay);
    } else if (previousBlockerRangeRef.current) {
      setBlockerStart(previousBlockerRangeRef.current.start);
      setBlockerEnd(previousBlockerRangeRef.current.end);
      previousBlockerRangeRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockerAllDay]);

  const filteredCustomers = useMemo(() => {
    const query = customerQuery.trim().toLowerCase();
    if (!query) return customerOptions;
    return customerOptions.filter((customer) => {
      const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.toLowerCase();
      return (
        name.includes(query) ||
        (customer.email ?? "").toLowerCase().includes(query) ||
        (customer.phone ?? "").includes(query)
      );
    });
  }, [customerQuery, customerOptions]);
  const limitedCustomers = useMemo(() => filteredCustomers.slice(0, 20), [filteredCustomers]);

  const customerDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!customerDropdownOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!customerDropdownRef.current) return;
      if (!customerDropdownRef.current.contains(event.target as Node)) {
        setCustomerDropdownOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [customerDropdownOpen]);

  useEffect(() => {
    if (!customerCreateOpen) {
      setCustomerCreateError(null);
    }
  }, [customerCreateOpen]);

  const handleAttachmentChange = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files).slice(0, MAX_ATTACHMENTS);
    setAttachments(next);
  };

  const handleServiceEntryChange = useCallback((key: string, updates: Partial<ServiceEntryState>) => {
    setServiceEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...updates } : entry)),
    );
  }, []);

  const handleAddServiceEntry = useCallback(
    (initialServiceId: string | null = null) => {
      const entry = createEmptyServiceEntry(initialServiceId, getServiceStaffPreset(initialServiceId));
      setServiceEntries((current) => [...current, entry]);
      return entry.key;
    },
    [getServiceStaffPreset],
  );

  const handleRemoveServiceEntry = useCallback((key: string) => {
    setServiceEntries((current) => {
      if (current.length <= 1) {
        return [createEmptyServiceEntry()];
      }
      const next = current.filter((entry) => entry.key !== key);
      return next.length ? next : [createEmptyServiceEntry()];
    });
  }, []);

  const handleServiceEntryStaffToggle = useCallback((key: string, staffId: string) => {
    setServiceEntries((current) =>
      current.map((entry) => {
        if (entry.key !== key) return entry;
        const exists = entry.staffIds.includes(staffId);
        return {
          ...entry,
          staffIds: exists ? entry.staffIds.filter((id) => id !== staffId) : [...entry.staffIds, staffId],
        };
      }),
    );
  }, []);

  const handleServiceEntryStaffClear = useCallback((key: string) => {
    setServiceEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, staffIds: [] } : entry)),
    );
  }, []);

  const handleReorderServiceEntry = useCallback((key: string, delta: number) => {
    setServiceEntries((current) => {
      const index = current.findIndex((entry) => entry.key === key);
      if (index < 0) return current;
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }, []);

  const handleMoveServiceEntryUp = useCallback(
    (key: string) => handleReorderServiceEntry(key, -1),
    [handleReorderServiceEntry],
  );
  const handleMoveServiceEntryDown = useCallback(
    (key: string) => handleReorderServiceEntry(key, 1),
    [handleReorderServiceEntry],
  );

  const handleBlockerStaffToggle = (staffId: string) => {
    setBlockerStaffIds((current) => {
      if (current.includes(staffId)) {
        return current.filter((id) => id !== staffId);
      }
      return [...current, staffId];
    });
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    const preparedEntries = serviceEntries.filter(
      (entry): entry is ServiceEntryState & { serviceId: string } => Boolean(entry.serviceId),
    );
    const isAppointmentEdit = context?.mode === "edit" && context.entity === "appointment";
    if (!preparedEntries.length && !isAppointmentEdit) {
      setError("Bitte mindestens eine Leistung auswählen.");
      return;
    }
    if (isAppointmentEdit) {
      setIsSubmitting(true);
      setError(null);

      const normalizedNote = note.trim();
      const normalizedInternal = internalNote.trim();

      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor("Termin bearbeiten");
      } catch {
        setIsSubmitting(false);
        setError("Aktion abgebrochen.");
        return;
      }

      try {
        const repeatScope = await requestRepeatScope("ändern");
        if (!repeatScope) {
          setIsSubmitting(false);
          setError("Aktion abgebrochen.");
          return;
        }

        const response = await fetch(
          `/api/backoffice/${locationSlug}/appointments/${context.appointment.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              services: preparedEntries.map((entry) => ({
                id: entry.serviceId,
                durationOverride: entry.durationOverride ?? undefined,
                staffIds: entry.staffIds,
              })),
              customerId: selectedCustomerId ?? null,
              startsAt: start.toISOString(),
              endsAt: end.toISOString(),
              note: normalizedNote.length ? normalizedNote : null,
              internalMessage: normalizedInternal.length ? normalizedInternal : null,
              sendSms,
              sendWhatsApp,
              whatsAppOptIn,
              repeatScope,
              performedBy: {
                staffId: bookingActor.staffId,
                token: bookingActor.token,
              },
            }),
          },
        );

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Termin konnte nicht aktualisiert werden.");
        }

        const updateAppointmentStatus = async (status: "NO_SHOW" | "CONFIRMED") => {
          const statusResponse = await fetch(
            `/api/backoffice/${locationSlug}/appointments/${context.appointment.id}/status`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                status,
                performedBy: {
                  staffId: bookingActor.staffId,
                  token: bookingActor.token,
                },
              }),
            },
          );
          const statusPayload = await statusResponse.json().catch(() => ({}));
          if (!statusResponse.ok) {
            throw new Error(statusPayload?.error ?? "Status konnte nicht aktualisiert werden.");
          }
        };

        const previousStatus = context.appointment.status;
        if (markNoShow && previousStatus !== "NO_SHOW") {
          await updateAppointmentStatus("NO_SHOW");
        } else if (!markNoShow && previousStatus === "NO_SHOW" && !isCancelled) {
          await updateAppointmentStatus("CONFIRMED");
        }

        pushToast({ variant: "success", message: "Termin aktualisiert." });
        onClose();
        onUpdated?.();
        router.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Termin konnte nicht aktualisiert werden.";
        setError(message);
        pushToast({ variant: "error", message });
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor();
      } catch {
        setIsSubmitting(false);
        setError("Aktion abgebrochen.");
        return;
      }

      const customerPayload = selectedCustomerId ? { mode: "existing" as const, customerId: selectedCustomerId } : null;
      const payload: {
        locationId: string;
        locationSlug: string;
        startsAt: string;
        endsAt: string;
        staffId?: string;
        staffIds: string[];
        resources: string[];
        services: Array<{ id: string; durationOverride?: number; staffIds?: string[] }>;
        customer: typeof customerPayload;
        sendEmail: boolean;
        sendSms: boolean;
        sendWhatsApp: boolean;
        whatsAppOptIn: boolean;
        vipStaffIds?: string[];
        note?: string;
        internalMessage?: string;
        repeat:
          | {
              enabled: true;
              frequency: "DAILY" | "WEEKLY";
              count: number;
            }
          | undefined;
        performedBy: {
          staffId: string;
          token: string;
        };
      } = {
        locationId,
        locationSlug,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        staffId: selectedStaffIds[0] ?? undefined,
        staffIds: selectedStaffIds,
        resources: [],
        services: preparedEntries.map((entry) => {
          const staffIds = Array.from(
            new Set(entry.staffIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)),
          );
          return {
            id: entry.serviceId,
            durationOverride: entry.durationOverride ?? undefined,
            staffIds: staffIds.length ? staffIds : undefined,
          };
        }),
        customer: customerPayload,
        sendEmail: customerPayload ? sendEmail : false,
        sendSms: customerPayload ? sendSms : false,
        sendWhatsApp: customerPayload ? sendWhatsApp : false,
        whatsAppOptIn: customerPayload ? whatsAppOptIn : false,
        vipStaffIds:
          customerPayload && showVipPermission && vipStaffIds.length ? [...vipStaffIds] : undefined,
        note: note || undefined,
        internalMessage: internalNote || undefined,
        repeat: repeatEnabled
          ? {
              enabled: true,
              frequency: repeatFrequency,
              count: repeatCount,
            }
          : undefined,
        performedBy: {
          staffId: bookingActor.staffId,
          token: bookingActor.token,
        },
      };

      const formData = new FormData();
      formData.append("payload", JSON.stringify(payload));
      attachments.forEach((file) => {
        formData.append("attachments", file, file.name);
      });

      const response = await fetch("/api/appointments", {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "Termin konnte nicht erstellt werden.");
      }
      await releaseCalendarHold(calendarHold?.slotKey);
      pushToast({ variant: "success", message: "Termin erstellt." });
      onClose();
      onCreated?.();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Termin konnte nicht erstellt werden.";
      setError(message);
      pushToast({ variant: "error", message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!context || context.mode !== "edit" || context.entity !== "appointment") return;
    if (isDeleting) return;
    setIsDeleting(true);
    setError(null);
    let bookingActor: BookingActor;
    try {
      bookingActor = await ensureBookingActor("Termin löschen");
    } catch (error) {
      setIsDeleting(false);
      return;
    }
    try {
      const repeatScope = await requestRepeatScope("löschen");
      if (!repeatScope) {
        setIsDeleting(false);
        setError("Aktion abgebrochen.");
        return;
      }

      const response = await fetch(`/api/backoffice/${locationSlug}/appointments/${context.appointment.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repeatScope,
          performedBy: {
            staffId: bookingActor.staffId,
            token: bookingActor.token,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Termin konnte nicht gelöscht werden.");
      }
      pushToast({ variant: "success", message: "Termin gelöscht." });
      onClose();
      onUpdated?.();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Termin konnte nicht gelöscht werden.";
      setError(message);
      pushToast({ variant: "error", message });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCancelAppointment = async () => {
    if (!context || context.mode !== "edit" || context.entity !== "appointment") return;
    if (isCancelling) return;
    setIsCancelling(true);
    setError(null);
    let bookingActor: BookingActor;
    try {
      bookingActor = await ensureBookingActor("Termin stornieren");
    } catch (error) {
      setIsCancelling(false);
      return;
    }
    try {
      const repeatScope = await requestRepeatScope("stornieren");
      if (!repeatScope) {
        setIsCancelling(false);
        setError("Aktion abgebrochen.");
        return;
      }

      const response = await fetch(
        `/api/backoffice/${locationSlug}/appointments/${context.appointment.id}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "CANCELLED",
            reason: "Storniert (Kalender)",
            repeatScope,
            performedBy: {
              staffId: bookingActor.staffId,
              token: bookingActor.token,
            },
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Termin konnte nicht storniert werden.");
      }
      pushToast({ variant: "success", message: "Termin storniert." });
      onClose();
      onUpdated?.();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Termin konnte nicht storniert werden.";
      setError(message);
      pushToast({ variant: "error", message });
    } finally {
      setIsCancelling(false);
    }
  };

  const handleSendRequest = async () => {
    if (!context || context.mode !== "edit" || context.entity !== "appointment") return;
    if (!requestAction || requestSending) return;
    const trimmedReason = requestReason.trim();
    if (!trimmedReason.length) {
      setRequestError("Bitte gib einen Grund an.");
      return;
    }
    setRequestSending(true);
    setRequestError(null);
    let bookingActor: BookingActor;
    try {
      bookingActor = await ensureBookingActor(
        requestAction === "DELETE" ? "Löschung anfragen" : "Stornierung anfragen",
      );
    } catch {
      setRequestSending(false);
      return;
    }
    try {
      const response = await fetch(
        `/api/backoffice/${locationSlug}/appointments/${context.appointment.id}/request`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: requestAction,
            reason: trimmedReason,
            performedBy: {
              staffId: bookingActor.staffId,
              token: bookingActor.token,
            },
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Anfrage konnte nicht gesendet werden.");
      }
      const successMessage =
        requestAction === "DELETE"
          ? "Deine Löschanfrage wird dem Admin weitergeleitet."
          : "Deine Stornierungsanfrage wird dem Admin weitergeleitet.";
      pushToast({ variant: "success", message: successMessage });
      dismissRequestAction();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Anfrage konnte nicht gesendet werden.";
      setRequestError(message);
      pushToast({ variant: "error", message });
    } finally {
      setRequestSending(false);
    }
  };

  const handleRestoreAppointment = async () => {
    if (!context || context.mode !== "edit" || context.entity !== "appointment") return;
    if (isCancelling) return;
    setIsCancelling(true);
    setError(null);
    let bookingActor: BookingActor;
    try {
      bookingActor = await ensureBookingActor("Storno zurücknehmen");
    } catch (error) {
      setIsCancelling(false);
      return;
    }
    try {
      const response = await fetch(
        `/api/backoffice/${locationSlug}/appointments/${context.appointment.id}/status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "CONFIRMED",
            performedBy: {
              staffId: bookingActor.staffId,
              token: bookingActor.token,
            },
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Stornierung konnte nicht zurückgenommen werden.");
      }
      pushToast({ variant: "success", message: "Stornierung zurückgenommen." });
      onUpdated?.();
      router.refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Stornierung konnte nicht zurückgenommen werden.";
      setError(message);
      pushToast({ variant: "error", message });
    } finally {
      setIsCancelling(false);
    }
  };

  const handleBlockerSubmit = async () => {
    if (blockerSubmitting) return;
    const isBlockerEdit = context?.mode === "edit" && context.entity === "blocker";
    const startDate = blockerStart;
    const endDate = blockerEnd;
    if (!(startDate < endDate)) {
      setBlockerError("Endzeitpunkt muss nach dem Start liegen.");
      return;
    }
    if (!blockerReason) {
      setBlockerError("Bitte einen Grund auswählen.");
      return;
    }

    setBlockerSubmitting(true);
    setBlockerError(null);

    try {
      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor(isBlockerEdit ? "Zeitblocker bearbeiten" : undefined);
      } catch {
        setBlockerSubmitting(false);
        setBlockerError("Aktion abgebrochen.");
        return;
      }

      if (isBlockerEdit) {
        if (!context.blocker.id) {
          setBlockerSubmitting(false);
          setBlockerError("Zeitblocker konnte nicht ermittelt werden.");
          return;
        }

        const response = await fetch(
          `/api/backoffice/${locationSlug}/time-blockers/${context.blocker.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start: startDate.toISOString(),
              end: endDate.toISOString(),
              allDay: blockerAllDay,
              allStaff: blockerAllStaff,
              staffIds: blockerAllStaff ? [] : blockerStaffIds,
              reason: blockerReason,
              customReason:
                blockerReason === "OTHER"
                  ? blockerCustomReason.trim() || undefined
                  : undefined,
              performedBy: {
                staffId: bookingActor.staffId,
                token: bookingActor.token,
              },
            }),
          },
        );

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Zeitblocker konnte nicht aktualisiert werden.");
        }

        pushToast({ variant: "success", message: "Zeitblocker aktualisiert." });
        onClose();
        onUpdated?.();
        router.refresh();
        return;
      }

      const response = await fetch(`/api/backoffice/${locationSlug}/time-blockers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId,
          start: startDate.toISOString(),
          end: endDate.toISOString(),
          allDay: blockerAllDay,
          allStaff: blockerAllStaff,
          staffIds: blockerAllStaff ? [] : blockerStaffIds,
          reason: blockerReason,
          customReason:
            blockerReason === "OTHER"
              ? blockerCustomReason.trim() || undefined
              : undefined,
          performedBy: {
            staffId: bookingActor.staffId,
            token: bookingActor.token,
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "Zeitblocker konnte nicht erstellt werden.");
      }

      pushToast({ variant: "success", message: "Zeitblocker erstellt." });
      onClose();
      onCreated?.();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zeitblocker konnte nicht erstellt werden.";
      setBlockerError(message);
      pushToast({ variant: "error", message });
    } finally {
      setBlockerSubmitting(false);
    }
  };

  const handleBlockerDelete = async () => {
    if (!context || context.mode !== "edit" || context.entity !== "blocker") return;
    if (blockerDeleting) return;

    setBlockerDeleting(true);
    setBlockerError(null);
    try {
      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor("Zeitblocker löschen");
      } catch {
        setBlockerDeleting(false);
        setBlockerError("Aktion abgebrochen.");
        return;
      }

      const response = await fetch(`/api/backoffice/${locationSlug}/time-blockers/${context.blocker.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          performedBy: {
            staffId: bookingActor.staffId,
            token: bookingActor.token,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Zeitblocker konnte nicht gelöscht werden.");
      }

      pushToast({ variant: "success", message: "Zeitblocker gelöscht." });
      onClose();
      onDeleted?.();
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Zeitblocker konnte nicht gelöscht werden.";
      setBlockerError(message);
      pushToast({ variant: "error", message });
    } finally {
      setBlockerDeleting(false);
    }
  };

  const isBlockerMode = composerMode === "blocker";
  const getAutoDuration = useCallback(() => {
    const fallback = services[0]?.duration ?? 30;
    const durationSource = selectedServices.length ? totalDuration || fallback : fallback;
    return Math.max(durationSource, 5);
  }, [services, selectedServices, totalDuration]);

  const handleManualEndChange = useCallback(() => {
    manualEndStateRef.current.active = true;
  }, []);

  const handleToggleComposerMode = useCallback(
    (mode: "appointment" | "blocker") => {
      setComposerMode(mode);
      setCustomerDropdownOpen(false);
      if (mode === "appointment") {
        setBlockerError(null);
      } else {
        setError(null);
      }
    },
    [],
  );

  const handleStartChange = useCallback(
    (nextStart: Date) => {
      lastUserStartRef.current = nextStart;
      applyStart(nextStart, "interaktion");
      if (isBlockerMode) return;
      manualEndStateRef.current.active = false;
      const duration = getAutoDuration();
      setEnd((currentEnd) => {
        const nextEnd = addMinutes(nextStart, duration);
        return currentEnd.getTime() === nextEnd.getTime() ? currentEnd : nextEnd;
      });
    },
    [applyStart, getAutoDuration, isBlockerMode],
  );

  useEffect(() => {
    if (!open || isBlockerMode) return;
    if (manualEndStateRef.current.active) return;
    if (selectedServices.length === 0) return;
    const duration = getAutoDuration();
    setEnd((currentEnd) => {
      const nextEnd = addMinutes(start, duration);
      return currentEnd.getTime() === nextEnd.getTime() ? currentEnd : nextEnd;
    });
  }, [getAutoDuration, isBlockerMode, open, selectedServices.length, start]);
  useEffect(() => {
    if (!open) return;
    if (!lastUserStartRef.current) return;
    if (start.getTime() === lastUserStartRef.current.getTime()) return;
    applyStart(lastUserStartRef.current, "wiederherstellung");
  }, [applyStart, open, start]);

  useEffect(() => {
    if (!open || !context || context.entity !== "blocker" || context.mode !== "edit") {
      setBlockerAuditTrail([]);
      setBlockerAuditError(null);
      setBlockerAuditLoading(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    const loadAuditTrail = async () => {
      setBlockerAuditLoading(true);
      setBlockerAuditError(null);
      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/time-blockers/${context.blocker.id}`,
          {
            method: "GET",
            signal: controller.signal,
          },
        );
        const payload = (await response.json()) as TimeBlockerDetailResponse;
        if (!response.ok) {
          throw new Error(payload.error ?? "Audit-Verlauf konnte nicht geladen werden.");
        }
        if (!cancelled) {
          setBlockerAuditTrail(Array.isArray(payload.auditTrail) ? payload.auditTrail : []);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setBlockerAuditTrail([]);
        setBlockerAuditError(error instanceof Error ? error.message : "Audit-Verlauf konnte nicht geladen werden.");
      } finally {
        if (!cancelled) {
          setBlockerAuditLoading(false);
        }
      }
    };
    loadAuditTrail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, context, locationSlug]);
  useEffect(() => {
    if (context?.mode === "edit" && context.entity === "appointment") {
      setCustomerDropdownOpen(false);
    }
  }, [context]);

  if (!open || !context) return null;

  const isEditMode = context.mode === "edit";
  const primaryLoading = isBlockerMode ? blockerSubmitting : isSubmitting;
  const primaryAction = isBlockerMode ? handleBlockerSubmit : handleSubmit;
  const isBlockerEdit = isEditMode && context.entity === "blocker";
  const blockerPrimaryLabel = blockerSubmitting ? "Speichern…" : isBlockerEdit ? "Zeitblocker aktualisieren" : "Zeitblocker erstellen";
  const appointmentPrimaryLabel = isSubmitting ? "Speichern…" : isAppointmentEdit ? "Termin aktualisieren" : "Termin erstellen";
  const appointmentHeaderLabel = isSubmitting ? "Speichern…" : isAppointmentEdit ? "Bestätigter Termin" : "Neuer Termin";
  const primaryLabel = isBlockerMode ? blockerPrimaryLabel : appointmentPrimaryLabel;
  const headerPrimaryLabel = isBlockerMode ? blockerPrimaryLabel : appointmentHeaderLabel;
  const isAppointmentConfirmedView = !isBlockerMode && isEditMode && context.entity === "appointment";
  const headerPrefix = isAppointmentConfirmedView ? "" : isBlockerMode ? "Zeitblocker" : "Termin";
  const headerTitle = isBlockerMode
    ? isEditMode && context.entity === "blocker"
      ? "Zeitblocker bearbeiten"
      : "Zeitblocker anlegen"
    : isAppointmentEdit
      ? "Bestätigter Termin"
      : "Termin anlegen";
  const headerRange = isBlockerMode
    ? `${formatDateTimeLabel(blockerStart)} – ${formatTimeLabel(blockerEnd)}`
    : `${formatDateTimeLabel(start)} – ${formatTimeLabel(end)}`;
  const headerDescription = isBlockerMode
    ? "Blockiere Verfügbarkeiten für dein Team – z. B. Urlaub, Meetings oder Pausen."
    : isAppointmentEdit
      ? ""
      : "Lege einen neuen Termin an, wähle Leistungen und ordne Mitarbeitende sowie Ressourcen zu.";
  const toggleLabel = isBlockerMode ? "Termin" : "Zeitblocker";
  const containerWidthClass = "max-w-lg";

  return (
    <>
      <div
        className="fixed inset-0 z-[1200] flex bg-black/15"
        onPointerDownCapture={handleInteraction}
        onKeyDownCapture={handleInteraction}
      >
        <CustomerProfilePanel
          open={Boolean(customerProfileId)}
          customerId={customerProfileId}
          customerName={customerProfileName}
          locationSlug={locationSlug}
          onClose={() => setCustomerProfileId(null)}
        />
        <div className={`relative ml-auto flex h-full w-full flex-shrink-0 ${containerWidthClass} flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl`}>
        <header className="border-b border-zinc-200 bg-white px-6 pt-5">
          <div className="flex items-center justify-between">
            {!isEditMode ? (
              <div className="flex items-center gap-6">
                <button
                  type="button"
                  onClick={() => handleToggleComposerMode("appointment")}
                  className={`pb-3 text-base font-semibold ${
                    !isBlockerMode ? "text-zinc-900" : "text-zinc-500"
                  }`}
                >
                  Neuer Termin
                  {!isBlockerMode && <span className="mt-2 block h-[2px] w-full rounded bg-teal-400" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleComposerMode("blocker")}
                  className={`pb-3 text-base font-semibold ${
                    isBlockerMode ? "text-zinc-900" : "text-zinc-500"
                  }`}
                >
                  Zeitblocker
                  {isBlockerMode && <span className="mt-2 block h-[2px] w-full rounded bg-teal-400" />}
                </button>
              </div>
            ) : (
              <div className="space-y-1 pb-3">
                {headerPrefix && (
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{headerPrefix}</p>
                )}
                <h2 className="text-2xl font-semibold text-zinc-900">{headerTitle}</h2>
                {headerDescription && <p className="text-sm text-zinc-500">{headerDescription}</p>}
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
              aria-label="Fenster schließen"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {isBlockerMode ? (
            <TimeBlockerForm
              staffOptions={staffOptions}
              staffIds={blockerStaffIds}
              onToggleStaff={handleBlockerStaffToggle}
              onClearStaff={() => setBlockerStaffIds([])}
              allStaff={blockerAllStaff}
              setAllStaff={setBlockerAllStaff}
              reason={blockerReason}
              setReason={setBlockerReason}
              customReason={blockerCustomReason}
              setCustomReason={setBlockerCustomReason}
              start={blockerStart}
              setStart={setBlockerStart}
              end={blockerEnd}
              setEnd={setBlockerEnd}
              allDay={blockerAllDay}
              setAllDay={setBlockerAllDay}
              error={blockerError}
              busy={blockerSubmitting}
              onSubmit={handleBlockerSubmit}
              submitLabel={
                blockerSubmitting
                  ? "Speichern…"
                  : isEditMode && context.entity === "blocker"
                    ? "Aktualisieren"
                    : "Erstellen"
              }
              isEditMode={isEditMode && context.entity === "blocker"}
              onDelete={isEditMode && context.entity === "blocker" ? handleBlockerDelete : undefined}
              auditTrail={blockerAuditTrail}
              auditLoading={blockerAuditLoading}
              auditError={blockerAuditError}
              formatDateTimeLabel={formatDateTimeLabel}
              onEndManualChange={handleManualEndChange}
            />
          ) : (
            <AppointmentFormLayout
              customerOptions={customerOptions}
              customerQuery={customerQuery}
              setCustomerQuery={setCustomerQuery}
              displayedCustomers={limitedCustomers}
              dropdownOpen={customerDropdownOpen}
              setDropdownOpen={setCustomerDropdownOpen}
              dropdownRef={customerDropdownRef}
              selectedCustomerId={selectedCustomerId}
              setSelectedCustomerId={setSelectedCustomerId}
              onClearCustomer={() => {
                setSelectedCustomerId(undefined);
                setCustomerQuery("");
              }}
              locationSlug={locationSlug}
              manualConfirmationMode={confirmationMode}
              sendEmail={sendEmail}
              setSendEmail={setSendEmail}
              sendSms={sendSms}
              setSendSms={setSendSms}
              sendWhatsApp={sendWhatsApp}
              setSendWhatsApp={setSendWhatsApp}
              whatsAppOptIn={whatsAppOptIn}
              setWhatsAppOptIn={setWhatsAppOptIn}
              customerConsents={selectedConsents}
              isAdmin={isAdmin}
              showVipPermission={showVipPermission}
              vipStaffOptions={vipStaffOptions}
              vipStaffIds={vipStaffIds}
              onVipStaffToggle={handleVipStaffToggle}
              note={note}
              setNote={setNote}
              internalNote={internalNote}
              setInternalNote={setInternalNote}
              attachments={attachments}
              onAttachmentsChange={handleAttachmentChange}
              start={start}
              end={end}
              setStart={handleStartChange}
              setEnd={setEnd}
              staffOptions={staffOptions}
              services={services}
              serviceEntries={serviceEntries}
              onChangeServiceEntry={handleServiceEntryChange}
              onAddServiceEntry={handleAddServiceEntry}
              onRemoveServiceEntry={handleRemoveServiceEntry}
              onToggleEntryStaff={handleServiceEntryStaffToggle}
              onClearEntryStaff={handleServiceEntryStaffClear}
              onMoveEntryUp={handleMoveServiceEntryUp}
              onMoveEntryDown={handleMoveServiceEntryDown}
              repeatEnabled={repeatEnabled}
              setRepeatEnabled={setRepeatEnabled}
              repeatFrequency={repeatFrequency}
              setRepeatFrequency={setRepeatFrequency}
              repeatCount={repeatCount}
              setRepeatCount={setRepeatCount}
              totalDuration={totalDuration}
              onEndManualChange={handleManualEndChange}
              isEditMode={isAppointmentEdit}
              isAppointmentEdit={isAppointmentEdit}
              initialAppointmentCustomerId={initialAppointmentCustomerId}
              customerLocked={Boolean(isAppointmentEdit && initialAppointmentCustomerId)}
              error={error}
              markNoShow={markNoShow}
              setMarkNoShow={setMarkNoShow}
              showNoShowToggle={showNoShowToggle}
              canDelete={canDelete}
              canCancel={canCancel}
              canRestore={canRestore}
              allowRequestCancel={allowRequestCancel}
              allowRequestDelete={allowRequestDelete}
              requestAction={requestAction}
              requestReason={requestReason}
              setRequestReason={setRequestReason}
              requestError={requestError}
              requestSending={requestSending}
              onRequestOpen={openRequestAction}
              onRequestDismiss={dismissRequestAction}
              onRequestSubmit={handleSendRequest}
              onDelete={handleDelete}
              onCancel={handleCancelAppointment}
              onRestore={handleRestoreAppointment}
              metadata={
                context?.mode === "edit" && context.entity === "appointment" ? context.appointment.metadata ?? null : null
              }
              appointmentSource={
                context?.mode === "edit" && context.entity === "appointment" ? context.appointment.source ?? null : null
              }
              appointmentCreatedAt={
                context?.mode === "edit" && context.entity === "appointment" ? context.appointment.createdAt ?? null : null
              }
              auditTrail={appointmentAuditTrail}
              toDateTimeLocalValue={toDateTimeLocalValue}
              parseDateTimeLocalValue={parseDateTimeLocalValue}
              formatDateTimeLabel={formatDateTimeLabel}
              formatTimeLabel={formatTimeLabel}
              onCreateCustomer={(initialName) => {
                const trimmed = initialName.trim();
                let first = "";
                let last = "";
                let emailPreset = "";
                let phonePreset = "";
                const classifySingleName = (value: string): "first" | "last" => {
                  const normalized = value
                    .normalize("NFKD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .toLowerCase();
                  const KNOWN_FIRST_NAMES = new Set([
                    "alex",
                    "alexander",
                    "alexandra",
                    "anna",
                    "anne",
                    "anika",
                    "ben",
                    "benjamin",
                    "chris",
                    "christian",
                    "claudia",
                    "cindy",
                    "david",
                    "eva",
                    "frank",
                    "gentlemen",
                    "hanna",
                    "hannah",
                    "jan",
                    "johanna",
                    "julia",
                    "kai",
                    "klaudia",
                    "laura",
                    "leonie",
                    "lilli",
                    "lisa",
                    "lukas",
                    "malte",
                    "mark",
                    "marc",
                    "marcel",
                    "maria",
                    "martina",
                    "max",
                    "maximilian",
                    "mia",
                    "michael",
                    "moritz",
                    "nadine",
                    "nils",
                    "nicole",
                    "nancy",
                    "oliver",
                    "paul",
                    "paula",
                    "peter",
                    "philipp",
                    "romy",
                    "sarah",
                    "sandra",
                    "sebastian",
                    "sophia",
                    "sven",
                    "tanja",
                    "theresa",
                    "thomas",
                    "tobias",
                    "vanessa",
                    "victoria",
                    "wolfgang",
                    "tester",
                    "yvonne",
                  ]);
                  const SURNAME_SUFFIXES = [
                    "mann",
                    "sen",
                    "son",
                    "ski",
                    "sky",
                    "czyk",
                    "berg",
                    "stein",
                    "rich",
                    "wald",
                    "hoff",
                    "bauer",
                    "meyer",
                    "meier",
                    "schmidt",
                    "schmitt",
                    "schneider",
                    "mueller",
                    "muller",
                  ];
                  const KNOWN_LAST_NAMES = new Set([
                    "meier",
                    "meyer",
                    "schmidt",
                    "schmitt",
                    "schneider",
                    "fischer",
                    "weber",
                    "wagner",
                    "becker",
                    "schulz",
                    "hoffmann",
                    "zimmermann",
                    "keller",
                    "lehmann",
                    "schumacher",
                    "mustermann",
                  ]);
                  if (KNOWN_LAST_NAMES.has(normalized)) {
                    return "last";
                  }
                  if (KNOWN_FIRST_NAMES.has(normalized)) {
                    return "first";
                  }
                  if (SURNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
                    return "last";
                  }
                  if (normalized.length <= 3) {
                    return "first";
                  }
                  return "last";
                };
                const formatNamePart = (input: string): string => {
                  if (!input) return "";
                  return input
                    .toLowerCase()
                    .split(/([\s\-]+)/)
                    .map((segment) => {
                      if (!segment.trim() || segment === "-" || segment === " ") {
                        return segment;
                      }
                      return segment.charAt(0).toUpperCase() + segment.slice(1);
                    })
                    .join("");
                };
                if (trimmed) {
                  const tokens = trimmed.split(/\s+/);
                  const nameTokens: string[] = [];
                  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                  const phoneRegex = /^\+?[0-9()[\]\-\/\s]{5,}$/;
                  for (const token of tokens) {
                    if (!emailPreset && emailRegex.test(token)) {
                      emailPreset = token.toLowerCase();
                    } else if (!phonePreset && phoneRegex.test(token)) {
                      phonePreset = token;
                    } else {
                      nameTokens.push(token);
                    }
                  }
                  if (nameTokens.length === 1) {
                    const classification = classifySingleName(nameTokens[0]);
                    if (classification === "first") {
                      first = formatNamePart(nameTokens[0]);
                    } else {
                      last = formatNamePart(nameTokens[0]);
                    }
                  } else if (nameTokens.length > 1) {
                    first = formatNamePart(nameTokens[0]);
                    last = formatNamePart(nameTokens.slice(1).join(" "));
                  }
                }
                setCustomerCreatePreset({ firstName: first, lastName: last, email: emailPreset, phone: phonePreset });
                setCustomerCreateOpen(true);
              }}
              onOpenCustomerProfile={(customerId) => setCustomerProfileId(customerId)}
              primaryAction={primaryAction}
              primaryLabel={primaryLabel}
              primaryDisabled={primaryLoading}
            />
          )}
        </div>
        {primaryLoading && (
          <div className="absolute inset-0 z-[1210] flex items-center justify-center rounded-l-3xl bg-white/75 backdrop-blur-[1px]">
            <div className="rounded-full bg-white/90 p-4 shadow-lg">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-700" />
            </div>
          </div>
        )}
        </div>
      </div>
      <CustomerCreateModal
        open={customerCreateOpen}
        loading={customerCreateLoading}
        error={customerCreateError}
        initialFirstName={customerCreatePreset.firstName}
        initialLastName={customerCreatePreset.lastName}
        initialEmail={customerCreatePreset.email}
        initialPhone={customerCreatePreset.phone}
        onClose={() => {
          if (!customerCreateLoading) {
            setCustomerCreateOpen(false);
            setCustomerCreatePreset({ firstName: "", lastName: "", email: "", phone: "" });
          }
        }}
        onSubmit={async (payload) => {
          setCustomerCreateLoading(true);
          setCustomerCreateError(null);
          try {
            const response = await fetch(`/api/backoffice/${locationSlug}/customers`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error((data as { error?: string }).error ?? "Kunde konnte nicht gespeichert werden.");
            }
            const customer = (data as { customer: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null } }).customer;
            if (!customer?.id) {
              throw new Error("Unerwartete Antwort vom Server.");
            }
            const formatted: CustomerOption = {
              id: customer.id,
              firstName: customer.firstName ?? "",
              lastName: customer.lastName ?? "",
              email: customer.email ?? "",
              phone: customer.phone ?? "",
              appointmentCount: 0,
              lastAppointment: null,
              lastAppointmentStatus: null,
              consents: { email: false, sms: false, whatsapp: false },
            };
            setCustomerOptions((current) => {
              const exists = current.some((entry) => entry.id === formatted.id);
              if (exists) {
                return current;
              }
              return [formatted, ...current];
            });
            const fullName = `${formatted.firstName} ${formatted.lastName}`.trim();
            setSelectedCustomerId(formatted.id);
            setCustomerQuery(fullName);
            setCustomerDropdownOpen(false);
            setCustomerCreateOpen(false);
            setCustomerCreatePreset({ firstName: "", lastName: "", email: "", phone: "" });
          } catch (error) {
            setCustomerCreateError(error instanceof Error ? error.message : "Kunde konnte nicht gespeichert werden.");
          } finally {
            setCustomerCreateLoading(false);
          }
        }}
      />
      {repeatScopeDialog && (
        <div
          className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={() => resolveRepeatScope(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white px-6 py-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-zinc-900">Wiederholender Termin</h3>
            <p className="mt-2 text-sm text-zinc-600">
              Möchtest du nur diesen Termin {repeatScopeDialog.actionLabel} oder diesen und alle Folgetermine?
            </p>
            <div className="mt-4 grid gap-2">
              <button
                type="button"
                onClick={() => resolveRepeatScope("single")}
                className="w-full rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50"
              >
                Nur diesen Termin {repeatScopeDialog.actionLabel}
              </button>
              <button
                type="button"
                onClick={() => resolveRepeatScope("following")}
                className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
              >
                Diesen und alle Folgetermine {repeatScopeDialog.actionLabel}
              </button>
            </div>
            <button
              type="button"
              onClick={() => resolveRepeatScope(null)}
              className="mt-3 w-full rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-600 transition hover:bg-zinc-50"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </>
  );
}


function AppointmentFormLayout({
  customerOptions,
  customerQuery,
  setCustomerQuery,
  displayedCustomers,
  dropdownOpen,
  setDropdownOpen,
  dropdownRef,
  selectedCustomerId,
  setSelectedCustomerId,
  onClearCustomer,
  locationSlug,
  manualConfirmationMode,
  sendEmail,
  setSendEmail,
  sendSms,
  setSendSms,
  sendWhatsApp,
  setSendWhatsApp,
  whatsAppOptIn,
  setWhatsAppOptIn,
  customerConsents,
  isAdmin,
  showVipPermission,
  vipStaffOptions,
  vipStaffIds,
  onVipStaffToggle,
  note,
  setNote,
  internalNote,
  setInternalNote,
  attachments,
  onAttachmentsChange,
  start,
  end,
  setStart,
  setEnd,
  staffOptions,
  services,
  serviceEntries,
  onChangeServiceEntry,
  onAddServiceEntry,
  onRemoveServiceEntry,
  onToggleEntryStaff,
  onClearEntryStaff,
  onMoveEntryUp,
  onMoveEntryDown,
  repeatEnabled,
  setRepeatEnabled,
  repeatFrequency,
  setRepeatFrequency,
  repeatCount,
  setRepeatCount,
  isEditMode,
  isAppointmentEdit: appointmentEdit,
  initialAppointmentCustomerId,
  customerLocked,
  totalDuration,
  error,
  markNoShow,
  setMarkNoShow,
  showNoShowToggle,
  canDelete,
  canCancel,
  canRestore,
  allowRequestCancel,
  allowRequestDelete,
  requestAction,
  requestReason,
  setRequestReason,
  requestError,
  requestSending,
  onRequestOpen,
  onRequestDismiss,
  onRequestSubmit,
  onDelete,
  onCancel,
  onRestore,
  metadata,
  appointmentSource,
  appointmentCreatedAt,
  auditTrail,
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
  formatDateTimeLabel,
  formatTimeLabel,
  onCreateCustomer,
  onOpenCustomerProfile,
  onEndManualChange,
  primaryAction,
  primaryLabel,
  primaryDisabled,
}: {
  customerOptions: CustomerOption[];
  customerQuery: string;
  setCustomerQuery: (value: string) => void;
  displayedCustomers: CustomerOption[];
  dropdownOpen: boolean;
  setDropdownOpen: (value: boolean) => void;
  dropdownRef: RefObject<HTMLDivElement | null>;
  selectedCustomerId?: string;
  setSelectedCustomerId: (id: string | undefined) => void;
  onClearCustomer: () => void;
  locationSlug: string;
  manualConfirmationMode: ManualConfirmationMode;
  sendEmail: boolean;
  setSendEmail: (value: boolean) => void;
  sendSms: boolean;
  setSendSms: (value: boolean) => void;
  sendWhatsApp: boolean;
  setSendWhatsApp: (value: boolean) => void;
  whatsAppOptIn: boolean;
  setWhatsAppOptIn: (value: boolean) => void;
  customerConsents: { email: boolean; sms: boolean; whatsapp: boolean };
  isAdmin: boolean;
  showVipPermission: boolean;
  vipStaffOptions: Array<{ id: string; name: string }>;
  vipStaffIds: string[];
  onVipStaffToggle: (staffId: string) => void;
  note: string;
  setNote: (value: string) => void;
  internalNote: string;
  setInternalNote: (value: string) => void;
  attachments: File[];
  onAttachmentsChange: (files: FileList | null) => void;
  start: Date;
  end: Date;
  setStart: (date: Date) => void;
  setEnd: (date: Date) => void;
  staffOptions: StaffOption[];
  services: ServiceOption[];
  serviceEntries: ServiceEntryState[];
  onChangeServiceEntry: (key: string, updates: Partial<ServiceEntryState>) => void;
  onAddServiceEntry: (initialServiceId?: string | null) => string;
  onRemoveServiceEntry: (key: string) => void;
  onToggleEntryStaff: (key: string, staffId: string) => void;
  onClearEntryStaff: (key: string) => void;
  onMoveEntryUp: (key: string) => void;
  onMoveEntryDown: (key: string) => void;
  repeatEnabled: boolean;
  setRepeatEnabled: (value: boolean) => void;
  repeatFrequency: "DAILY" | "WEEKLY";
  setRepeatFrequency: (value: "DAILY" | "WEEKLY") => void;
  repeatCount: number;
  setRepeatCount: (value: number) => void;
  isEditMode: boolean;
  isAppointmentEdit: boolean;
  initialAppointmentCustomerId?: string | null;
  customerLocked: boolean;
  totalDuration: number;
  error: string | null;
  markNoShow: boolean;
  setMarkNoShow: (value: boolean) => void;
  showNoShowToggle: boolean;
  canDelete: boolean;
  canCancel: boolean;
  canRestore: boolean;
  allowRequestCancel: boolean;
  allowRequestDelete: boolean;
  requestAction: "CANCEL" | "DELETE" | null;
  requestReason: string;
  setRequestReason: (value: string) => void;
  requestError: string | null;
  requestSending: boolean;
  onRequestOpen: (action: "CANCEL" | "DELETE") => void;
  onRequestDismiss: () => void;
  onRequestSubmit: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
  onRestore?: () => void;
  metadata?: Record<string, unknown> | null;
  appointmentSource?: string | null;
  appointmentCreatedAt?: string | null;
  auditTrail?: AppointmentDetailPayload["auditTrail"];
  toDateTimeLocalValue: (value: Date) => string;
  parseDateTimeLocalValue: (value: string) => Date;
  formatDateTimeLabel: (value: Date) => string;
  formatTimeLabel: (value: Date) => string;
  onCreateCustomer: (initialName: string) => void;
  onOpenCustomerProfile?: (customerId: string) => void;
  onEndManualChange: () => void;
  primaryAction: () => void;
  primaryLabel: string;
  primaryDisabled: boolean;
}) {
  return (
    <>
      <div className="flex h-full min-h-0 flex-col lg:flex-row">
        <div className="flex h-full min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="space-y-6">
              <CustomerSection
                customerLocked={appointmentEdit && Boolean(initialAppointmentCustomerId)}
                customerQuery={customerQuery}
                setCustomerQuery={setCustomerQuery}
                displayedCustomers={displayedCustomers}
                dropdownOpen={dropdownOpen}
                setDropdownOpen={setDropdownOpen}
                dropdownRef={dropdownRef}
                selectedCustomerId={selectedCustomerId}
                setSelectedCustomerId={setSelectedCustomerId}
                onClearSelection={onClearCustomer}
                locationSlug={locationSlug}
                manualConfirmationMode={manualConfirmationMode}
                sendEmail={sendEmail}
                setSendEmail={setSendEmail}
                sendSms={sendSms}
                setSendSms={setSendSms}
                sendWhatsApp={sendWhatsApp}
                setSendWhatsApp={setSendWhatsApp}
                whatsAppOptIn={whatsAppOptIn}
                setWhatsAppOptIn={setWhatsAppOptIn}
                customerConsents={customerConsents}
                isAdmin={isAdmin}
                showVipPermission={showVipPermission}
                vipStaffOptions={vipStaffOptions}
                vipStaffIds={vipStaffIds}
                onVipStaffToggle={onVipStaffToggle}
                onCreateCustomer={onCreateCustomer}
                onOpenCustomerProfile={onOpenCustomerProfile}
              />
              <DetailsTab
                start={start}
                end={end}
                setStart={setStart}
                setEnd={setEnd}
                staffOptions={staffOptions}
                services={services}
                serviceEntries={serviceEntries}
                onChangeServiceEntry={onChangeServiceEntry}
                onAddServiceEntry={onAddServiceEntry}
                onRemoveServiceEntry={onRemoveServiceEntry}
                onToggleEntryStaff={onToggleEntryStaff}
                onClearEntryStaff={onClearEntryStaff}
                onMoveEntryUp={onMoveEntryUp}
                onMoveEntryDown={onMoveEntryDown}
                repeatEnabled={repeatEnabled}
                setRepeatEnabled={setRepeatEnabled}
                repeatFrequency={repeatFrequency}
                setRepeatFrequency={setRepeatFrequency}
                repeatCount={repeatCount}
                setRepeatCount={setRepeatCount}
                repeatDisabled={isEditMode}
                totalDuration={totalDuration}
                toDateTimeLocalValue={toDateTimeLocalValue}
                parseDateTimeLocalValue={parseDateTimeLocalValue}
                onEndManualChange={onEndManualChange}
                internalNote={internalNote}
                setInternalNote={setInternalNote}
                metadata={metadata}
              />
              <div className="space-y-4">
                <TotalAmountField services={services} serviceEntries={serviceEntries} />
                <NotesSection
                  note={note}
                  setNote={setNote}
                  attachments={attachments}
                  onAttachmentsChange={onAttachmentsChange}
                  isEditMode={isEditMode}
                  metadata={metadata}
                  appointmentSource={appointmentSource}
                  appointmentCreatedAt={appointmentCreatedAt}
                  auditTrail={auditTrail}
                  staffOptions={staffOptions}
                  services={services}
                  formatDateTimeLabel={formatDateTimeLabel}
                />
              </div>
            </div>
        </div>
        <div className="border-t border-zinc-200 bg-white px-6 py-4 shadow-[0_-6px_12px_rgba(15,23,42,0.05)]">
          {error ? (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>
          ) : null}
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {showNoShowToggle && (
                <div className="flex items-center gap-3 text-sm text-zinc-700">
                  <span className="font-medium">Nicht erschienen</span>
                  <button
                    type="button"
                    className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
                      markNoShow ? "bg-rose-500" : "bg-zinc-300"
                    }`}
                    onClick={() => setMarkNoShow(!markNoShow)}
                    aria-pressed={markNoShow}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                        markNoShow ? "translate-x-[1.6rem]" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              )}
              <div className="flex w-full flex-col items-end gap-2 sm:ml-auto sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
                {canDelete && onDelete && (
                  <button
                    type="button"
                    onClick={onDelete}
                    disabled={primaryDisabled}
                    className="rounded-full border border-rose-500 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Löschen
                  </button>
                )}
                {canRestore && onRestore && (
                  <button
                    type="button"
                    onClick={onRestore}
                    disabled={primaryDisabled}
                    className="rounded-full border border-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-600 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Storno zurücknehmen
                  </button>
                )}
                {allowRequestDelete && (
                  <button
                    type="button"
                    onClick={() => onRequestOpen("DELETE")}
                    disabled={primaryDisabled || requestSending}
                    className="rounded-full border border-rose-400 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Löschung anfragen
                  </button>
                )}
                {canCancel && onCancel && (
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={primaryDisabled}
                    className="flex items-center gap-2 rounded-full border border-amber-400 bg-white px-4 py-2 text-sm font-semibold text-amber-600 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-extrabold text-white">
                      ×
                    </span>
                    Stornieren
                  </button>
                )}
                {allowRequestCancel && (
                  <button
                    type="button"
                    onClick={() => onRequestOpen("CANCEL")}
                    disabled={primaryDisabled || requestSending}
                    className="flex items-center gap-2 rounded-full border border-amber-400 bg-white px-4 py-2 text-sm font-semibold text-amber-600 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-extrabold text-white">
                      !
                    </span>
                    Stornierung anfragen
                  </button>
                )}
                <button
                  type="button"
                  onClick={primaryAction}
                  disabled={primaryDisabled}
                  className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
                >
                  {primaryLabel}
                </button>
              </div>
            </div>
            {requestAction && (
              <div className="mt-4 space-y-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">
                    {requestAction === "DELETE" ? "Löschanfrage" : "Stornierungsanfrage"}
                  </p>
                  <p className="text-xs text-amber-700">
                    {requestAction === "DELETE"
                      ? "Deine Löschanfrage wird dem Admin weitergeleitet. Anfrage senden?"
                      : "Deine Stornierungsanfrage wird dem Admin weitergeleitet. Anfrage senden?"}
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-widest text-amber-700">Grund</label>
                  <textarea
                    value={requestReason}
                    onChange={(event) => setRequestReason(event.target.value)}
                    className="w-full rounded-md border border-amber-200 px-3 py-2 text-sm text-amber-900 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
                    placeholder="Kurze Begründung"
                    rows={3}
                  />
                </div>
                {requestError && (
                  <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                    {requestError}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={onRequestSubmit}
                    disabled={requestSending}
                    className="rounded-full bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-400"
                  >
                    {requestSending ? "Senden…" : "Ja, Anfrage senden"}
                  </button>
                  <button
                    type="button"
                    onClick={onRequestDismiss}
                    disabled={requestSending}
                    className="rounded-full border border-amber-200 px-3 py-1 text-xs font-semibold text-amber-700 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:text-amber-300"
                  >
                    Nein
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function TimeBlockerForm({
  staffOptions,
  staffIds,
  onToggleStaff,
  onClearStaff,
  allStaff,
  setAllStaff,
  reason,
  setReason,
  customReason,
  setCustomReason,
  start,
  setStart,
  end,
  setEnd,
  allDay,
  setAllDay,
  error,
  busy,
  onSubmit,
  submitLabel,
  isEditMode,
  onDelete,
  auditTrail = [],
  auditLoading = false,
  auditError = null,
  formatDateTimeLabel,
  onEndManualChange,
}: {
  staffOptions: StaffOption[];
  staffIds: string[];
  onToggleStaff: (id: string) => void;
  onClearStaff: () => void;
  allStaff: boolean;
  setAllStaff: (value: boolean) => void;
  reason: TimeBlockerReasonValue;
  setReason: (value: TimeBlockerReasonValue) => void;
  customReason: string;
  setCustomReason: (value: string) => void;
  start: Date;
  setStart: (date: Date) => void;
  end: Date;
  setEnd: (date: Date) => void;
  allDay: boolean;
  setAllDay: (value: boolean) => void;
  error: string | null;
  busy: boolean;
  onSubmit: () => void;
  submitLabel: string;
  isEditMode: boolean;
  onDelete?: () => void;
  auditTrail?: TimeBlockerAuditEntry[];
  auditLoading?: boolean;
  auditError?: string | null;
  formatDateTimeLabel: (value: Date) => string;
  onEndManualChange?: () => void;
}) {
  const selectableStaff = useMemo(
    () => staffOptions.filter((option) => option.id !== "unassigned"),
    [staffOptions],
  );
  const staffNameIndex = useMemo(() => {
    const map = new Map<string, string>();
    staffOptions.forEach((staff) => {
      map.set(staff.id, staff.name);
    });
    return map;
  }, [staffOptions]);
  const staffDropdownRef = useRef<HTMLDivElement | null>(null);
  const [staffDropdownOpen, setStaffDropdownOpen] = useState(false);
  const selectedStaffMembers = useMemo(
    () => selectableStaff.filter((staff) => staffIds.includes(staff.id)),
    [selectableStaff, staffIds],
  );
  const renderStaffSummary = () => {
    if (!selectedStaffMembers.length) {
      return <span className="text-zinc-400">Nicht zugewiesen</span>;
    }
    return selectedStaffMembers.map((staff) => (
      <span
        key={staff.id}
        className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
      >
        <span className="inline-flex h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: staff.color }} />
        {staff.name}
      </span>
    ));
  };

  useEffect(() => {
    if (!staffDropdownOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!staffDropdownRef.current) return;
      if (!staffDropdownRef.current.contains(event.target as Node)) {
        setStaffDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [staffDropdownOpen]);

  useEffect(() => {
    if (allStaff) {
      setStaffDropdownOpen(false);
    }
  }, [allStaff]);

  const startDateRef = useRef<HTMLDivElement | null>(null);
  const endDateRef = useRef<HTMLDivElement | null>(null);
  const startTimeRef = useRef<HTMLDivElement | null>(null);
  const endTimeRef = useRef<HTMLDivElement | null>(null);
  const startTimeListRef = useRef<HTMLDivElement | null>(null);
  const endTimeListRef = useRef<HTMLDivElement | null>(null);
  const [startDateOpen, setStartDateOpen] = useState(false);
  const [endDateOpen, setEndDateOpen] = useState(false);
  const [startTimeOpen, setStartTimeOpen] = useState(false);
  const [endTimeOpen, setEndTimeOpen] = useState(false);

  const randomizedReasonOptions = useMemo(() => {
    const options = [...TIME_BLOCKER_OPTIONS];
    if (reason && !options.some((option) => option.value === reason)) {
      const label = TIME_BLOCKER_REASON_LABELS[reason as TimeBlockerReason] ?? reason;
      options.push({ value: reason as TimeBlockerReason, label });
    }
    for (let i = options.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }
    return options;
  }, [reason]);

  useOutsideClose(startDateRef, startDateOpen, () => setStartDateOpen(false));
  useOutsideClose(endDateRef, endDateOpen, () => setEndDateOpen(false));
  useOutsideClose(startTimeRef, startTimeOpen, () => setStartTimeOpen(false));
  useOutsideClose(endTimeRef, endTimeOpen, () => setEndTimeOpen(false));

  const startTotalMinutes = start.getHours() * 60 + start.getMinutes();
  const endTotalMinutes = end.getHours() * 60 + end.getMinutes();

  useEffect(() => {
    if (!startTimeOpen || !startTimeListRef.current) return;
    const selectedEl = startTimeListRef.current.querySelector<HTMLButtonElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "center" });
  }, [startTimeOpen]);

  useEffect(() => {
    if (!endTimeOpen || !endTimeListRef.current) return;
    const selectedEl = endTimeListRef.current.querySelector<HTMLButtonElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "center" });
  }, [endTimeOpen]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Gilt für</h4>
        {!allStaff ? (
          <div className="relative space-y-1.5 text-lg" ref={staffDropdownRef}>
            <button
              type="button"
              onClick={() => setStaffDropdownOpen((prev) => !prev)}
              className={`flex w-full items-center justify-between rounded-md border bg-white px-3 py-2 text-sm transition ${
                staffDropdownOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover:border-zinc-500"
              }`}
              disabled={busy || selectableStaff.length === 0}
            >
              <span className="flex flex-1 flex-wrap items-center gap-2 text-left text-zinc-800">
                {renderStaffSummary()}
              </span>
            </button>
            {staffDropdownOpen && (
              <div className="absolute z-[1500] mt-1 w-full overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
                <div className="max-h-56 overflow-y-auto">
                  {selectableStaff.map((staff) => {
                    const selected = staffIds.includes(staff.id);
                    return (
                      <label
                        key={staff.id}
                        className={`flex cursor-pointer items-start gap-3 px-4 py-3 text-sm transition ${
                          selected ? "bg-zinc-900 text-white" : "hover:bg-zinc-50"
                        }`}
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            onToggleStaff(staff.id);
                            setStaffDropdownOpen(false);
                          }}
                          className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                          disabled={busy}
                        />
                        <span className="flex-1">
                          <span className="block font-medium">{staff.name}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-4 py-3 text-xs">
                  <span className="text-zinc-500">
                    {selectedStaffMembers.length
                      ? `${selectedStaffMembers.length} Mitarbeitende ausgewählt`
                      : "Nicht zugewiesen"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (busy) return;
                      onClearStaff();
                      setStaffDropdownOpen(false);
                    }}
                    className="rounded-full border border-zinc-300 px-3 py-1 font-semibold text-zinc-600 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy || staffIds.length === 0}
                  >
                    Auswahl löschen
                  </button>
                </div>
              </div>
            )}
            {selectableStaff.length === 0 && <p className="text-xs text-zinc-500">Keine Mitarbeitenden verfügbar.</p>}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-500">
            Alle Mitarbeitenden ausgewählt
          </div>
        )}
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={allStaff}
            onChange={(event) => setAllStaff(event.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
          />
          Alle Mitarbeiter
        </label>
      </section>

      <section className="mt-6 space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Grund</h4>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as TimeBlockerReasonValue)}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          disabled={busy}
        >
          <option value="" disabled>
            Grund auswählen …
          </option>
          {randomizedReasonOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {reason === "OTHER" && (
          <input
            type="text"
            value={customReason}
            onChange={(event) => setCustomReason(event.target.value)}
            placeholder="Grund angeben"
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            maxLength={120}
            disabled={busy}
          />
        )}
      </section>

      <section className="mt-6 space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Zeitraum</h4>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Von</label>
            <div className="grid grid-cols-2 gap-2">
              <div className="relative space-y-1.5" ref={startDateRef}>
                <button
                  type="button"
                  onClick={() => !busy && !allDay && setStartDateOpen((prev) => !prev)}
                  className={`flex w/full items-center justify-between rounded-md border bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition ${
                    startDateOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover:border-zinc-500"
                  } ${busy || allDay ? "cursor-not-allowed opacity-60" : ""}`}
                  disabled={busy || allDay}
                >
                  {formatDateLabel(start)}
                </button>
                {startDateOpen && !allDay && (
                  <div className="absolute z-[1500] mt-2 w-[320px] rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl">
                  <DatePicker
                    value={start}
                    onChange={(date) => {
                      const updated = mergeDateWithTime(date, start);
                      setStart(updated);
                      setStartDateOpen(false);
                    }}
                    onMonthChange={(date) => {
                      const updated = mergeDateWithTime(date, start);
                      setStart(updated);
                    }}
                  />
                </div>
              )}
              </div>
              <div className="relative space-y-1.5" ref={startTimeRef}>
                <button
                  type="button"
                  onClick={() => !busy && !allDay && setStartTimeOpen((prev) => !prev)}
                  className={`flex w/full items-center justify-between rounded-md border bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition ${
                    startTimeOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover-border-zinc-500"
                  } ${busy || allDay ? "cursor-not-allowed opacity-60" : ""}`}
                  disabled={busy || allDay}
                >
                  {formatTimeLabelLocal(start)}
                </button>
                {startTimeOpen && !allDay && (
                  <div className="absolute z-[1500] mt-2 max-h-64 w/full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl">
                    <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                      <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Direkte Eingabe</label>
                      <input
                        type="time"
                        step={60}
                        value={formatTimeInputValue(start)}
                        onChange={(event) => {
                          const minutes = parseTimeInputValue(event.target.value);
                          if (minutes === null) return;
                          const updated = setTimeFromMinutes(start, minutes);
                          setStart(updated);
                          setStartTimeOpen(false);
                        }}
                        className="mt-2 w/full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto px-3 py-2" ref={startTimeListRef}>
                      {TIME_ROWS.map((row) => (
                        <div key={`blocker-start-row-${row.hour}`} className="mb-1 flex items-start gap-2">
                          <span className="w-10 text-xs font-semibold text-zinc-500">{String(row.hour).padStart(2, "0")}h</span>
                          <div className="flex flex-wrap gap-1">
                            {row.slots.map((option) => {
                              const isSelected = option.minutes === startTotalMinutes;
                              return (
                                <button
                                  type="button"
                                  key={`blocker-start-${option.minutes}`}
                                  onClick={() => {
                                    const updated = setTimeFromMinutes(start, option.minutes);
                                    setStart(updated);
                                    setStartTimeOpen(false);
                                  }}
                                  className={`rounded-md px-2 py-1 text-xs transition ${
                                    isSelected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
                                  }`}
                                  data-selected={isSelected ? "true" : "false"}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Bis</label>
            <div className="grid grid-cols-2 gap-2">
              <div className="relative space-y-1.5" ref={endDateRef}>
                <button
                  type="button"
                  onClick={() => !busy && !allDay && setEndDateOpen((prev) => !prev)}
                  className={`flex w/full items-center justify-between rounded-md border bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition ${
                    endDateOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover-border-zinc-500"
                  } ${busy || allDay ? "cursor-not-allowed opacity-60" : ""}`}
                  disabled={busy || allDay}
                >
                  {formatDateLabel(end)}
                </button>
                {endDateOpen && !allDay && (
                  <div className="absolute z-[1500] mt-2 w-[320px] rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl">
                  <DatePicker
                    value={end}
                    onChange={(date) => {
                      const updated = mergeDateWithTime(date, end);
                      setEnd(updated);
                      onEndManualChange?.();
                      setEndDateOpen(false);
                    }}
                    onMonthChange={(date) => {
                      const updated = mergeDateWithTime(date, end);
                      setEnd(updated);
                      onEndManualChange?.();
                    }}
                  />
                </div>
              )}
              </div>
              <div className="relative space-y-1.5" ref={endTimeRef}>
                <button
                  type="button"
                  onClick={() => !busy && !allDay && setEndTimeOpen((prev) => !prev)}
                  className={`flex w/full items-center justify-between rounded-md border bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition ${
                    endTimeOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover-border-zinc-500"
                  } ${busy || allDay ? "cursor-not-allowed opacity-60" : ""}`}
                  disabled={busy || allDay}
                >
                  {formatTimeLabelLocal(end)}
                </button>
                {endTimeOpen && !allDay && (
                  <div className="absolute z-[1500] mt-2 max-h-64 w/full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl">
                    <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                      <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Direkte Eingabe</label>
                      <input
                        type="time"
                        step={60}
                        value={formatTimeInputValue(end)}
                        onChange={(event) => {
                          const minutes = parseTimeInputValue(event.target.value);
                          if (minutes === null) return;
                          const updated = setTimeFromMinutes(end, minutes);
                          setEnd(updated);
                          onEndManualChange?.();
                          setEndTimeOpen(false);
                        }}
                        className="mt-2 w/full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto px-3 py-2" ref={endTimeListRef}>
                      {TIME_ROWS.map((row) => (
                        <div key={`blocker-end-row-${row.hour}`} className="mb-1 flex items-start gap-2">
                          <span className="w-10 text-xs font-semibold text-zinc-500">{String(row.hour).padStart(2, "0")}h</span>
                          <div className="flex flex-wrap gap-1">
                            {row.slots.map((option) => {
                              const isSelected = option.minutes === endTotalMinutes;
                              return (
                                <button
                                  type="button"
                                  key={`blocker-end-${option.minutes}`}
                                  onClick={() => {
                                    const updated = setTimeFromMinutes(end, option.minutes);
                                    setEnd(updated);
                                    onEndManualChange?.();
                                    setEndTimeOpen(false);
                                  }}
                                  className={`rounded-md px-2 py-1 text-xs transition ${
                                    isSelected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
                                  }`}
                                  data-selected={isSelected ? "true" : "false"}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(event) => setAllDay(event.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
            disabled={busy}
          />
          Ganzer Tag
        </label>
        <p className="text-xs text-zinc-500">
          Zeitblocker werden im Kalender als reservierte Slots angezeigt. Bei „Anderer Grund“ erscheint der eingegebene Text direkt im Slot.
        </p>
      </section>

      {isEditMode && (
        <section className="mt-8 space-y-3 border-t border-zinc-200 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Verlauf</p>
              <p className="text-sm text-zinc-500">Letzte Änderungen am Zeitblocker.</p>
            </div>
            {auditLoading && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
          </div>
          {auditError ? (
            <p className="text-sm text-rose-600">{auditError}</p>
          ) : auditTrail && auditTrail.length ? (
            <ol className="space-y-3">
              {auditTrail.map((entry) => {
                const actorLabel = resolveBlockerActor(entry);
                return (
                  <li key={entry.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-zinc-900">
                        {formatAuditAction(entry.action)} · {actorLabel}
                      </span>
                      <span className="text-xs text-zinc-500">Zeitblocker</span>
                    </div>
                    <span className="text-xs text-zinc-500">{formatDateTimeLabel(new Date(entry.createdAt))}</span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-zinc-500">Es wurden noch keine Aktivitäten aufgezeichnet.</p>
          )}
        </section>
      )}

      <section className="sticky bottom-0 left-0 right-0 z-[80] mt-8 flex flex-col gap-3 border-t border-zinc-200 bg-white pt-4 pb-4">
        <div className="flex items-center justify-between gap-3">
          {error ? (
            <p className="text-sm text-rose-600">{error}</p>
          ) : (
            <span className="text-xs text-zinc-500">Änderungen werden sofort im Kalender sichtbar.</span>
          )}
          {busy && <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isEditMode && onDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="rounded-full border border-rose-200 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Löschen
            </button>
          )}
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
          >
            {submitLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function formatAuditAction(action: string) {
  switch (action) {
    case "CREATE":
      return "Erstellt";
    case "UPDATE":
      return "Aktualisiert";
    case "DELETE":
      return "Gelöscht";
    default:
      return action;
  }
}

type DiffRecord = Record<string, { previous?: unknown; next?: unknown } | undefined>;
type BlockerChangeRow = {
  key: string;
  label: string;
  previous?: string | null;
  next?: string | null;
  description?: string;
};

function formatDiffValue(
  key: string,
  value: unknown,
  staffNameIndex: Map<string, string>,
  formatDateTimeLabel: (value: Date) => string,
) {
  if (value === null || value === undefined) {
    return "—";
  }
  switch (key) {
    case "startsAt":
    case "endsAt":
      if (typeof value === "string" || value instanceof Date) {
        const dateValue = typeof value === "string" ? new Date(value) : value;
        if (!Number.isNaN(dateValue.getTime())) {
          return formatDateTimeLabel(dateValue);
        }
      }
      break;
    case "staffId":
      if (value === null) return "Nicht zugewiesen";
      if (typeof value === "string") {
        return staffNameIndex.get(value) ?? "Mitarbeiter";
      }
      break;
    case "reasonType":
      if (typeof value === "string" && value in TIME_BLOCKER_REASON_LABELS) {
        return TIME_BLOCKER_REASON_LABELS[value as TimeBlockerReason];
      }
      break;
    case "customReason":
      if (typeof value === "string") {
        return value.trim().length ? value.trim() : "—";
      }
      break;
    case "allStaff":
      if (typeof value === "boolean") {
        return value ? "Alle" : "Ausgewählte";
      }
      break;
    default:
      break;
  }
  if (typeof value === "boolean") {
    return value ? "Ja" : "Nein";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function extractBlockerDiffDetails(
  diff: unknown,
  staffNameIndex: Map<string, string>,
  formatDateTimeLabel: (value: Date) => string,
): BlockerChangeRow[] {
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) {
    return [];
  }
  const typedDiff = diff as DiffRecord;
  const rows: BlockerChangeRow[] = [];
  const pushRow = (key: string, label: string) => {
    const entry = typedDiff[key];
    if (!entry) return;
    const previous = formatDiffValue(key, entry.previous ?? null, staffNameIndex, formatDateTimeLabel);
    const next = formatDiffValue(key, entry.next ?? null, staffNameIndex, formatDateTimeLabel);
    if (previous === next) return;
    rows.push({ key, label, previous, next });
  };
  pushRow("startsAt", "Startzeit");
  pushRow("endsAt", "Endzeit");
  pushRow("staffId", "Mitarbeiter");
  pushRow("reasonType", "Grund");
  pushRow("customReason", "Anmerkung");
  pushRow("allStaff", "Gilt für");

  const staffIdsEntry = typedDiff.staffIds;
  if (staffIdsEntry) {
    const formatStaffList = (value: unknown) => {
      if (!Array.isArray(value)) return null;
      const names = value
        .map((id) => (typeof id === "string" ? staffNameIndex.get(id) ?? null : null))
        .filter((name): name is string => Boolean(name));
      if (names.length) {
        return names.join(", ");
      }
      return Array.isArray(value) && value.length === 0 ? "Keine Auswahl" : null;
    };
    rows.push({
      key: "staffIds",
      label: "Betroffene Mitarbeitende",
      previous: formatStaffList(staffIdsEntry.previous) ?? null,
      next: formatStaffList(staffIdsEntry.next) ?? null,
    });
  }
  return rows;
}

function resolveBlockerActor(entry: TimeBlockerAuditEntry) {
  if (entry.actorName && entry.actorName.trim().length) {
    return entry.actorName;
  }
  const performed = extractBlockerPerformer(entry.context);
  if (performed) {
    return performed;
  }
  return entry.actorType === "SYSTEM" ? "System" : "Unbekannt";
}

function extractBlockerPerformer(context: unknown) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const record = context as Record<string, unknown>;
  const performed = record.performedBy;
  if (!performed || typeof performed !== "object" || Array.isArray(performed)) {
    return null;
  }
  const performedRecord = performed as Record<string, unknown>;
  const staffName = performedRecord.staffName;
  return typeof staffName === "string" && staffName.trim().length ? staffName.trim() : null;
}

function extractBlockerContextDescription(context: unknown) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return null;
  }
  const record = context as Record<string, unknown>;
  const source = typeof record.source === "string" ? record.source : null;
  if (!source) return null;
  const SOURCE_LABELS: Record<string, string> = {
    calendar_time_blocker: "Über den Kalender angepasst",
  };
  return SOURCE_LABELS[source] ?? null;
}

const COLOR_PRECHECK_LABELS = {
  hairLength: {
    short: "Kurz",
    medium: "Mittel",
    long: "Lang",
  },
  hairDensity: {
    fine: "Fein",
    normal: "Normal",
    thick: "Kraeftig",
  },
  hairState: {
    natural: "Natur",
    colored: "Gefaerbt",
    blonded: "Blondiert",
  },
  desiredResult: {
    refresh: "Auffrischen",
    change: "Veraendern",
  },
  yesNo: {
    yes: "Ja",
    no: "Nein",
  },
} as const;

function buildColorConsultationEntries(metadata?: Record<string, unknown> | null): ColorSummaryEntry[] {
  const { request, precheck } = extractColorMetadata(metadata);
  if (!request && !precheck) {
    return [];
  }

  const readText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const entries: ColorSummaryEntry[] = [];
  const modeValue = readText(request?.mode);
  const modeLabel =
    modeValue === "consultation" ? "Farbberatung" : modeValue === "direct" ? "Direkter Farbtermin" : "";
  if (modeLabel) {
    entries.push({ term: "Modus", description: modeLabel });
  }
  const consultationServiceName = readText(request?.consultationServiceName);
  if (consultationServiceName) {
    entries.push({ term: "Beratungstermin", description: consultationServiceName });
  }
  const requestedServiceName = readText(request?.requestedServiceName);
  if (requestedServiceName) {
    entries.push({ term: "Gewuenschte Farbe", description: requestedServiceName });
  }

  const precheckEntries: ColorSummaryEntry[] = [];
  if (precheck?.hairLength) {
    precheckEntries.push({
      term: "Haarlaenge",
      description: COLOR_PRECHECK_LABELS.hairLength[precheck.hairLength] ?? precheck.hairLength,
    });
  }
  if (precheck?.hairDensity) {
    precheckEntries.push({
      term: "Haardichte",
      description: COLOR_PRECHECK_LABELS.hairDensity[precheck.hairDensity] ?? precheck.hairDensity,
    });
  }
  if (precheck?.hairState) {
    precheckEntries.push({
      term: "Aktueller Zustand",
      description: COLOR_PRECHECK_LABELS.hairState[precheck.hairState] ?? precheck.hairState,
    });
  }
  if (precheck?.desiredResult) {
    precheckEntries.push({
      term: "Gewuenschtes Ergebnis",
      description: COLOR_PRECHECK_LABELS.desiredResult[precheck.desiredResult] ?? precheck.desiredResult,
    });
  }
  if (precheck?.allergies) {
    precheckEntries.push({
      term: "Allergien",
      description: COLOR_PRECHECK_LABELS.yesNo[precheck.allergies] ?? precheck.allergies,
    });
  }
  if (precheck?.returning) {
    precheckEntries.push({
      term: "Bereits Kund:in",
      description: COLOR_PRECHECK_LABELS.yesNo[precheck.returning] ?? precheck.returning,
    });
  }

  const precheckStatus = precheckEntries.length
    ? isColorPrecheckComplete(precheck)
      ? "Vollstaendig"
      : "Unvollstaendig"
    : "Noch nicht ausgefuellt";
  entries.push({ term: "Vorerfassung", description: precheckStatus });
  entries.push(...precheckEntries);

  return entries;
}

function DetailsTab({
  start,
  end,
  setStart,
  setEnd,
  staffOptions,
  services,
  serviceEntries,
  onChangeServiceEntry,
  onAddServiceEntry,
  onRemoveServiceEntry,
  onToggleEntryStaff,
  onClearEntryStaff,
  onMoveEntryUp,
  onMoveEntryDown,
  repeatEnabled,
  setRepeatEnabled,
  repeatFrequency,
  setRepeatFrequency,
  repeatCount,
  setRepeatCount,
  repeatDisabled,
  totalDuration,
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
  onEndManualChange,
  internalNote,
  setInternalNote,
  metadata,
}: {
  start: Date;
  end: Date;
  setStart: (date: Date) => void;
  setEnd: (date: Date) => void;
  staffOptions: StaffOption[];
  services: ServiceOption[];
  serviceEntries: ServiceEntryState[];
  onChangeServiceEntry: (key: string, updates: Partial<ServiceEntryState>) => void;
  onAddServiceEntry: (initialServiceId?: string | null) => string;
  onRemoveServiceEntry: (key: string) => void;
  onToggleEntryStaff: (key: string, staffId: string) => void;
  onClearEntryStaff: (key: string) => void;
  onMoveEntryUp: (key: string) => void;
  onMoveEntryDown: (key: string) => void;
  repeatEnabled: boolean;
  setRepeatEnabled: (value: boolean) => void;
  repeatFrequency: "DAILY" | "WEEKLY";
  setRepeatFrequency: (value: "DAILY" | "WEEKLY") => void;
  repeatCount: number;
  setRepeatCount: (value: number) => void;
  repeatDisabled: boolean;
  totalDuration: number;
  toDateTimeLocalValue: (value: Date) => string;
  parseDateTimeLocalValue: (value: string) => Date;
  onEndManualChange: () => void;
  internalNote: string;
  setInternalNote: (value: string) => void;
  metadata?: Record<string, unknown> | null;
}) {
  const startDateRef = useRef<HTMLDivElement | null>(null);
  const endDateRef = useRef<HTMLDivElement | null>(null);
  const startTimeRef = useRef<HTMLDivElement | null>(null);
  const endTimeRef = useRef<HTMLDivElement | null>(null);
  const startTimeListRef = useRef<HTMLDivElement | null>(null);
  const endTimeListRef = useRef<HTMLDivElement | null>(null);
  const [startDateOpen, setStartDateOpen] = useState(false);
  const [endDateOpen, setEndDateOpen] = useState(false);
  const [startTimeOpen, setStartTimeOpen] = useState(false);
  const [endTimeOpen, setEndTimeOpen] = useState(false);

  useOutsideClose(startDateRef, startDateOpen, () => setStartDateOpen(false));
  useOutsideClose(endDateRef, endDateOpen, () => setEndDateOpen(false));
  useOutsideClose(startTimeRef, startTimeOpen, () => setStartTimeOpen(false));
  useOutsideClose(endTimeRef, endTimeOpen, () => setEndTimeOpen(false));
  const startTotalMinutes = start.getHours() * 60 + start.getMinutes();
  const endTotalMinutes = end.getHours() * 60 + end.getMinutes();

  useEffect(() => {
    if (!startTimeOpen || !startTimeListRef.current) return;
    const selectedEl = startTimeListRef.current.querySelector<HTMLButtonElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "center" });
  }, [startTimeOpen]);

  useEffect(() => {
    if (!endTimeOpen || !endTimeListRef.current) return;
    const selectedEl = endTimeListRef.current.querySelector<HTMLButtonElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "center" });
  }, [endTimeOpen]);

  useEffect(() => {
    if (repeatDisabled && repeatEnabled) {
      setRepeatEnabled(false);
    }
  }, [repeatDisabled, repeatEnabled, setRepeatEnabled]);

  const servicesById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const colorEntries = useMemo(() => buildColorConsultationEntries(metadata), [metadata]);
  const hasSelectedServices = useMemo(() => serviceEntries.some((entry) => Boolean(entry.serviceId)), [serviceEntries]);
  const [pendingServicePickerKey, setPendingServicePickerKey] = useState<string | null>(null);

  return (
    <div id="scheduler-section-details" className="space-y-4">
      <section className="rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-4 space-y-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Leistungen</p>
              <p className="text-sm text-zinc-600">Wähle eine oder mehrere Leistungen und passe die Dauer an.</p>
            </div>
          </div>
          <div className="space-y-2.5">
            {serviceEntries.map((entry, index) => {
              const service = entry.serviceId ? servicesById.get(entry.serviceId) ?? null : null;
              return (
                <ServiceEntryCard
                  key={entry.key}
                  entry={entry}
                  service={service}
                  serviceEntriesCount={serviceEntries.length}
                  services={services}
                  canRemove={serviceEntries.length > 1 || Boolean(service)}
                  onChange={(updates) => onChangeServiceEntry(entry.key, updates)}
                  onRemove={() => onRemoveServiceEntry(entry.key)}
                  autoOpen={pendingServicePickerKey === entry.key}
                  onAutoOpenHandled={() =>
                    setPendingServicePickerKey((current) => (current === entry.key ? null : current))
                  }
                  staffOptions={staffOptions}
                  onToggleStaff={onToggleEntryStaff}
                  onClearStaff={onClearEntryStaff}
                  canMoveUp={index > 0}
                  canMoveDown={index < serviceEntries.length - 1}
                  onMoveUp={() => onMoveEntryUp(entry.key)}
                  onMoveDown={() => onMoveEntryDown(entry.key)}
                />
              );
            })}
          </div>
        </div>
      </section>
      {hasSelectedServices && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => {
              const key = onAddServiceEntry();
              setPendingServicePickerKey(key);
            }}
            className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-600 transition hover:text-emerald-700"
          >
            <Plus className="h-4 w-4" />
            Leistung hinzufügen
          </button>
        </div>
      )}
      {colorEntries.length > 0 && (
        <section className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Farbberatung & Planung</p>
            <p className="text-sm text-zinc-600">Angaben aus der Online-Buchung.</p>
          </div>
          <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
            {colorEntries.map((entry) => (
              <div key={`${entry.term}-${entry.description}`} className="space-y-1">
                <dt className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{entry.term}</dt>
                <dd className="text-sm text-zinc-700">{entry.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <div className="border-b border-zinc-200 -mx-6" />

      <section className="space-y-1">
        <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Interne Notiz</label>
        <textarea
          value={internalNote}
          onChange={(event) => setInternalNote(event.target.value)}
          className="h-20 w-full rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
        />
      </section>

      <section className="space-y-2">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Von</label>
            <div className="grid grid-cols-2 gap-2">
              <div className="relative" ref={startDateRef}>
                <button
                  type="button"
                  onClick={() => setStartDateOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition hover:border-zinc-500"
                >
                  {formatDateLabel(start)}
                    </button>
              {startDateOpen && (
                <div className="absolute z-[1500] mt-2 w-[320px] rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl">
                  <DatePicker
                    value={start}
                    onChange={(date) => {
                      const updated = mergeDateWithTime(date, start);
                        setStart(updated);
                        setStartDateOpen(false);
                      }}
                    onMonthChange={(date) => {
                      const updated = mergeDateWithTime(date, start);
                      setStart(updated);
                    }}
                    />
                  </div>
                )}
              </div>
              <div className="relative" ref={startTimeRef}>
                <button
                  type="button"
                  onClick={() => setStartTimeOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition hover:border-zinc-500"
                >
                  {formatTimeLabelLocal(start)}
                    </button>
                {startTimeOpen && (
                  <div className="absolute z-[1500] mt-2 max-h-64 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl">
                    <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                      <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">
                        Direkte Eingabe
                      </label>
                      <input
                        type="time"
                        step={60}
                        value={formatTimeInputValue(start)}
                        onChange={(event) => {
                          const minutes = parseTimeInputValue(event.target.value);
                          if (minutes === null) return;
                          const updated = setTimeFromMinutes(start, minutes);
                          setStart(updated);
                          setStartTimeOpen(false);
                        }}
                        className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto px-3 py-2" ref={startTimeListRef}>
                      {TIME_ROWS.map((row) => (
                        <div key={`start-row-${row.hour}`} className="mb-1 flex items-start gap-2">
                          <span className="w-10 text-xs font-semibold text-zinc-500">{String(row.hour).padStart(2, "0")}h</span>
                          <div className="flex flex-wrap gap-1">
                            {row.slots.map((option) => {
                              const isSelected = option.minutes === startTotalMinutes;
                              return (
                                <button
                                  type="button"
                                  key={`start-${option.minutes}`}
                                  onClick={() => {
                                    const updated = setTimeFromMinutes(start, option.minutes);
                                    if (process.env.NODE_ENV !== "production") {
                                      console.info("[Scheduler] Quickselect Start", option.label, "→", updated.toISOString());
                                    }
                                    setStart(updated);
                                    setStartTimeOpen(false);
                                  }}
                                  className={`rounded-md px-2 py-1 text-xs transition ${
                                    isSelected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
                                  }`}
                                  data-selected={isSelected ? "true" : "false"}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Bis</label>
            <div className="grid grid-cols-2 gap-2">
              <div className="relative" ref={endDateRef}>
                <button
                  type="button"
                  onClick={() => setEndDateOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition hover:border-zinc-500"
                >
                  {formatDateLabel(end)}
                    </button>
              {endDateOpen && (
                <div className="absolute z-[1500] mt-2 w-[320px] rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl">
                  <DatePicker
                    value={end}
                    onChange={(date) => {
                      const updated = mergeDateWithTime(date, end);
                        setEnd(updated);
                        onEndManualChange();
                        setEndDateOpen(false);
                      }}
                    onMonthChange={(date) => {
                      const updated = mergeDateWithTime(date, end);
                      setEnd(updated);
                      onEndManualChange();
                    }}
                    />
                  </div>
                )}
              </div>
              <div className="relative" ref={endTimeRef}>
                <button
                  type="button"
                  onClick={() => setEndTimeOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-4 py-2 text-left text-sm font-medium text-zinc-900 shadow-sm transition hover:border-zinc-500"
                >
                  {formatTimeLabelLocal(end)}
                    </button>
                {endTimeOpen && (
                  <div className="absolute z-[1500] mt-2 max-h-64 w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl">
                    <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                      <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">
                        Direkte Eingabe
                      </label>
                      <input
                        type="time"
                        step={60}
                        value={formatTimeInputValue(end)}
                        onChange={(event) => {
                          const minutes = parseTimeInputValue(event.target.value);
                          if (minutes === null) return;
                          const updated = setTimeFromMinutes(end, minutes);
                          setEnd(updated);
                          onEndManualChange();
                          setEndTimeOpen(false);
                        }}
                        className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto px-3 py-2" ref={endTimeListRef}>
                      {TIME_ROWS.map((row) => (
                        <div key={`end-row-${row.hour}`} className="mb-1 flex items-start gap-2">
                          <span className="w-10 text-xs font-semibold text-zinc-500">{String(row.hour).padStart(2, "0")}h</span>
                          <div className="flex flex-wrap gap-1">
                            {row.slots.map((option) => {
                              const isSelected = option.minutes === endTotalMinutes;
                              return (
                                <button
                                  type="button"
                                  key={`end-${option.minutes}`}
                                  onClick={() => {
                                    const updated = setTimeFromMinutes(end, option.minutes);
                                    setEnd(updated);
                                    onEndManualChange();
                                    setEndTimeOpen(false);
                                  }}
                                  className={`rounded-md px-2 py-1 text-xs transition ${
                                    isSelected ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100"
                                  }`}
                                  data-selected={isSelected ? "true" : "false"}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3">
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={repeatEnabled}
              onChange={(event) => setRepeatEnabled(event.target.checked)}
              disabled={repeatDisabled}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 disabled:border-zinc-200 disabled:bg-zinc-100"
            />
            Termin wiederholen
          </label>
          {repeatDisabled && (
            <p className="mt-2 text-xs text-zinc-500">
              Wiederholungen können bei bestehenden Terminen nicht angepasst werden.
            </p>
          )}
          {repeatEnabled && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Rhythmus</label>
                <select
                  value={repeatFrequency}
                  onChange={(event) => setRepeatFrequency(event.target.value as "DAILY" | "WEEKLY")}
                  disabled={repeatDisabled}
                  className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 disabled:border-zinc-200 disabled:bg-zinc-100"
                >
                  <option value="DAILY">Täglich</option>
                  <option value="WEEKLY">Wöchentlich</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Intervall</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={repeatCount}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    setRepeatCount(Number.isFinite(nextValue) && nextValue >= 1 ? nextValue : 1);
                  }}
                  disabled={repeatDisabled}
                  className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 disabled:border-zinc-200 disabled:bg-zinc-100"
                />
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

type ServiceEntryCardProps = {
  entry: ServiceEntryState;
  service: ServiceOption | null;
  serviceEntriesCount: number;
  services: ServiceOption[];
  canRemove: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onChange: (updates: Partial<ServiceEntryState>) => void;
  onRemove: () => void;
  autoOpen: boolean;
  onAutoOpenHandled: () => void;
  staffOptions: StaffOption[];
  onToggleStaff: (key: string, staffId: string) => void;
  onClearStaff: (key: string) => void;
  onMoveUp: (key: string) => void;
  onMoveDown: (key: string) => void;
};

function ServiceEntryCard({
  entry,
  service,
  serviceEntriesCount,
  services,
  canRemove,
  canMoveUp,
  canMoveDown,
  onChange,
  onRemove,
  autoOpen,
  onAutoOpenHandled,
  staffOptions,
  onToggleStaff,
  onClearStaff,
  onMoveUp,
  onMoveDown,
}: ServiceEntryCardProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const staffDropdownRef = useRef<HTMLDivElement | null>(null);
  const [staffDropdownOpen, setStaffDropdownOpen] = useState(false);

  useOutsideClose(pickerRef, pickerOpen, () => setPickerOpen(false));
  useOutsideClose(staffDropdownRef, staffDropdownOpen, () => setStaffDropdownOpen(false));

  useEffect(() => {
    if (!autoOpen) return;
    setPickerOpen(true);
    const handle = setTimeout(() => {
      searchInputRef.current?.focus();
      onAutoOpenHandled();
    }, 0);
    return () => clearTimeout(handle);
  }, [autoOpen, onAutoOpenHandled]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handle = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
    return () => clearTimeout(handle);
  }, [pickerOpen]);

  const filteredServices = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return services;
    return services.filter((option) => {
      const nameMatch = option.name.toLowerCase().includes(query);
      const tagMatch = (option.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
      return nameMatch || tagMatch;
    });
  }, [searchTerm, services]);
  const rankedServices = useMemo(() => {
    const list = [...filteredServices];
    list.sort((a, b) => {
      const scoreA = a.popularityScore ?? 0;
      const scoreB = b.popularityScore ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return a.name.localeCompare(b.name, "de");
    });
    return list;
  }, [filteredServices]);
  const selectableStaff = useMemo(
    () => staffOptions.filter((option) => option.id !== "unassigned"),
    [staffOptions],
  );
  const selectedStaffMembers = useMemo(
    () => selectableStaff.filter((staff) => entry.staffIds.includes(staff.id)),
    [selectableStaff, entry.staffIds],
  );

  const handleSelect = (serviceId: string) => {
    onChange({ serviceId, durationOverride: null });
    setPickerOpen(false);
    setSearchTerm("");
  };

  const durationValue = service ? entry.durationOverride ?? service.duration : "";
  const showDuration = serviceEntriesCount > 1 && Boolean(service);

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Leistung</p>
          <div className="relative" ref={pickerRef}>
            <button
              type="button"
              onClick={() => setPickerOpen((prev) => !prev)}
              className={`flex w-full items-center justify-between rounded-xl border bg-white px-3 py-2 text-left text-sm transition ${
                pickerOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover:border-zinc-500"
              }`}
            >
              <span className="flex-1">
                {service ? (
                  <>
                    <span className="block font-semibold text-zinc-900">{service.name}</span>
                  </>
                ) : (
                  <span className="text-sm text-zinc-400">Leistung auswählen</span>
                )}
              </span>
              <ChevronDown className="h-4 w-4 text-zinc-500" />
            </button>
            {pickerOpen && (
              <div className="absolute z-[1500] mt-2 w-full max-w-[360px] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl">
                <div className="border-b border-zinc-100 bg-zinc-50 px-4 py-3">
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.target.value)}
                    placeholder="Leistung oder Tag suchen"
                    className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {rankedServices.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-zinc-500">Keine passenden Leistungen gefunden.</div>
                  ) : (
                    rankedServices.map((option) => (
                      <button
                        type="button"
                        key={option.id}
                        onClick={() => handleSelect(option.id)}
                        className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left text-sm transition hover:bg-zinc-50"
                      >
                        <span className="font-medium text-zinc-900">{option.name}</span>
                        <span className="text-xs text-zinc-500">
                          {option.duration} Min ·{" "}
                          {new Intl.NumberFormat("de-DE", { style: "currency", currency: option.currency }).format(
                            option.basePrice,
                          )}
                        </span>
                        {option.tags?.length ? (
                          <span className="text-[10px] uppercase tracking-widest text-zinc-400">
                            #{option.tags.join("  #")}
                          </span>
                        ) : null}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col items-center gap-1">
            <button
              type="button"
              onClick={() => onMoveUp(entry.key)}
              disabled={!canMoveUp}
              className="rounded-full border border-zinc-200 p-1 text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Leistung nach oben verschieben"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onMoveDown(entry.key)}
              disabled={!canMoveDown}
              className="rounded-full border border-zinc-200 p-1 text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Leistung nach unten verschieben"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          {canRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="rounded-full border border-zinc-200 p-2 text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-900"
              aria-label="Leistung entfernen"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Mitarbeiter:innen</p>
        <div className="relative space-y-1.5" ref={staffDropdownRef}>
          <button
            type="button"
            onClick={() => setStaffDropdownOpen((prev) => !prev)}
            className={`flex w-full items-center justify-between rounded-md border bg-white px-3 py-2 text-sm transition ${
              staffDropdownOpen ? "border-zinc-900 ring-2 ring-zinc-900/10" : "border-zinc-300 hover:border-zinc-500"
            }`}
          >
            <span className="flex flex-1 flex-wrap items-center gap-2 text-left text-zinc-800">
                  {selectedStaffMembers.length ? (
                    selectedStaffMembers.map((staff) => (
                      <span
                        key={staff.id}
                        className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700"
                  >
                    <span className="inline-flex h-2 w-2 flex-shrink-0 rounded-full" style={{ backgroundColor: staff.color }} />
                    {staff.name}
                  </span>
                ))
              ) : (
                <span className="text-zinc-400">Nicht zugewiesen</span>
              )}
            </span>
          </button>
                  {staffDropdownOpen && (
                    <div className="absolute z-[1500] mt-1 w-full overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl">
                      <div className="max-h-64 overflow-y-auto">
                        {selectableStaff.map((staff) => {
                          const selected = entry.staffIds.includes(staff.id);
                          return (
                            <button
                              type="button"
                              key={staff.id}
                              onClick={() => {
                                onToggleStaff(entry.key, staff.id);
                                setStaffDropdownOpen(false);
                              }}
                              className={`flex w-full items-start gap-3 px-4 py-3 text-left text-sm transition ${
                            selected ? "bg-zinc-900 text-white" : "hover:bg-zinc-50"
                          }`}
                        >
                          <span className="flex-1">
                            <span className="block font-medium">{staff.name}</span>
                          </span>
                          {selected && <span className="text-[10px] uppercase tracking-widest">Aktiv</span>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between border-t border-zinc-200 bg-zinc-50 px-4 py-3 text-xs">
                    <span className="text-zinc-500">
                      {selectedStaffMembers.length
                        ? `${selectedStaffMembers.length} Mitarbeiter${selectedStaffMembers.length === 1 ? "" : ":innen"} ausgewählt`
                        : "Nicht zugewiesen"}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onClearStaff(entry.key);
                        setStaffDropdownOpen(false);
                      }}
                      className="rounded-full border border-zinc-300 px-3 py-1 font-semibold text-zinc-600 transition hover:bg-white"
                      disabled={entry.staffIds.length === 0}
                    >
                      Auswahl löschen
                    </button>
                  </div>
            </div>
          )}
        </div>
      </div>
      {showDuration && (
        <div className="mt-3 space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Dauer</label>
          <div className="flex w-40 items-center gap-2 rounded-xl border border-zinc-300 bg-white px-3 py-2">
            <input
              type="number"
              min={5}
              max={600}
              step={5}
              value={durationValue}
              onChange={(event) => {
                const raw = Number(event.target.value);
                if (!Number.isFinite(raw)) {
                  onChange({ durationOverride: null });
                  return;
                }
                const normalized = Math.min(600, Math.max(5, Math.trunc(raw)));
                if (service && normalized === service.duration) {
                  onChange({ durationOverride: null });
                } else {
                  onChange({ durationOverride: normalized });
                }
              }}
              className="w-14 border-none bg-transparent text-right text-sm font-semibold text-zinc-900 focus:outline-none"
            />
            <span className="text-xs text-zinc-500">Min</span>
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerProfilePanel({
  open,
  customerId,
  customerName,
  locationSlug,
  onClose,
}: {
  open: boolean;
  customerId: string | null;
  customerName: string | null;
  locationSlug: string;
  onClose: () => void;
}) {
  if (!open || !customerId) return null;
  const profileUrl = `/backoffice/${locationSlug}/customers?customer=${encodeURIComponent(customerId)}&embed=1`;
  const title = customerName?.trim().length ? customerName : "Kundenprofil";

  return (
    <aside className="relative mr-auto flex h-full flex-1 min-w-0 max-w-[920px] flex-col border-r border-zinc-200 bg-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Kundenprofil</p>
          <h3 className="text-lg font-semibold text-zinc-900">{title}</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full p-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
          aria-label="Kundenprofil schließen"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </header>
      <div className="flex-1 overflow-hidden bg-white">
        <iframe
          key={customerId}
          src={profileUrl}
          title={`Kundenprofil ${title}`}
          className="h-full w-full border-0"
        />
      </div>
    </aside>
  );
}

function CustomerSection({
  customerLocked,
  customerQuery,
  setCustomerQuery,
  displayedCustomers,
  selectedCustomerId,
  setSelectedCustomerId,
  onClearSelection,
  locationSlug,
  manualConfirmationMode,
  sendEmail,
  setSendEmail,
  sendSms,
  setSendSms,
  sendWhatsApp,
  setSendWhatsApp,
  whatsAppOptIn,
  setWhatsAppOptIn,
  customerConsents,
  isAdmin,
  showVipPermission,
  vipStaffOptions,
  vipStaffIds,
  onVipStaffToggle,
  dropdownOpen,
  setDropdownOpen,
  dropdownRef,
  onCreateCustomer,
  onOpenCustomerProfile,
}: {
  customerLocked: boolean;
  customerQuery: string;
  setCustomerQuery: (value: string) => void;
  displayedCustomers: CustomerOption[];
  selectedCustomerId?: string;
  setSelectedCustomerId: (id: string | undefined) => void;
  onClearSelection: () => void;
  locationSlug: string;
  manualConfirmationMode: ManualConfirmationMode;
  sendEmail: boolean;
  setSendEmail: (value: boolean) => void;
  sendSms: boolean;
  setSendSms: (value: boolean) => void;
  sendWhatsApp: boolean;
  setSendWhatsApp: (value: boolean) => void;
  whatsAppOptIn: boolean;
  setWhatsAppOptIn: (value: boolean) => void;
  customerConsents: { email: boolean; sms: boolean; whatsapp: boolean };
  isAdmin: boolean;
  showVipPermission: boolean;
  vipStaffOptions: Array<{ id: string; name: string }>;
  vipStaffIds: string[];
  onVipStaffToggle: (staffId: string) => void;
  dropdownOpen: boolean;
  setDropdownOpen: (value: boolean) => void;
  dropdownRef: RefObject<HTMLDivElement | null>;
  onCreateCustomer: (initialName: string) => void;
  onOpenCustomerProfile?: (customerId: string) => void;
}) {
  const linkLabel = selectedCustomerId ? "Details anzeigen" : "Kunden anlegen";
  const linkHref = selectedCustomerId
    ? `/backoffice/${locationSlug}/customers?customer=${selectedCustomerId}`
    : `/backoffice/${locationSlug}/customers/new?source=calendar-composer`;
  const selectionDisabled = customerLocked;
  const singleChannelOnly = manualConfirmationMode === "single";
  const emailSmsLabel = "Kunde per E-Mail/SMS informieren";
  const emailSmsConsentMissing = !customerConsents.email || !customerConsents.sms;
  const whatsappConsentMissing = !customerConsents.whatsapp;
  const emailSmsActive = sendEmail && sendSms;
  const emailSmsHint = emailSmsConsentMissing
    ? emailSmsActive
      ? "Zustimmung wird beim Speichern erfasst."
      : "Einwilligung fehlt. Aktivieren erfasst die Zustimmung."
    : null;
  const whatsappHint = whatsappConsentMissing
    ? whatsAppOptIn
      ? "Zustimmung wird beim Speichern erfasst."
      : "Einwilligung fehlt."
    : null;
  const whatsappOptInLocked = selectionDisabled && customerConsents.whatsapp;
  const effectiveWhatsAppOptIn = whatsappOptInLocked ? true : whatsAppOptIn;
  useEffect(() => {
    if (selectionDisabled) {
      setDropdownOpen(false);
    }
  }, [selectionDisabled, setDropdownOpen]);

  return (
    <section className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Kunde</p>
      <div className="space-y-1" ref={dropdownRef}>
        <div className="relative">
          <input
            type="text"
            value={customerQuery}
            onFocus={() => {
              if (selectionDisabled) return;
              setDropdownOpen(true);
            }}
            onClick={() => {
              if (selectionDisabled) return;
              setDropdownOpen(true);
            }}
            onChange={(event) => {
              if (selectionDisabled) return;
              setCustomerQuery(event.target.value);
              setDropdownOpen(true);
            }}
            disabled={selectionDisabled}
            placeholder="Suche nach Namen, E-Mail oder Telefonnummer"
            className={`w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 ${
              selectionDisabled ? "cursor-not-allowed bg-zinc-100 text-zinc-500" : ""
            }`}
          />
          {dropdownOpen && (
            <div className="absolute top-full z-50 mt-2 max-h-56 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg">
              {displayedCustomers.length === 0 ? (
                <div className="space-y-1.5 px-3 py-3 text-xs">
                  <p className="text-zinc-500">Keine Treffer gefunden.</p>
                  <button
                    type="button"
                    disabled={selectionDisabled}
                    onClick={() => {
                      if (selectionDisabled) return;
                      setDropdownOpen(false);
                      onCreateCustomer(customerQuery.trim());
                    }}
                    className={`inline-flex items-center gap-1 rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 transition ${
                      selectionDisabled ? "cursor-not-allowed opacity-60" : "hover:bg-zinc-100"
                    }`}
                  >
                    Kunden anlegen
                  </button>
                </div>
              ) : (
                displayedCustomers.map((customer) => {
                  const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.replace(/\s+/g, " ").trim() || "Unbekannt";
                  const selected = selectedCustomerId === customer.id;
                  const contactParts = [customer.phone, customer.email].filter(Boolean);
                  const contact = contactParts.length ? contactParts.join(" · ") : "Keine Kontaktdaten";
                  return (
                    <button
                      key={customer.id}
                      type="button"
                      disabled={selectionDisabled}
                      onClick={() => {
                        if (selectionDisabled) return;
                        setSelectedCustomerId(customer.id);
                        setCustomerQuery(name);
                        setDropdownOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition ${
                        selected
                          ? "bg-zinc-900 text-white"
                          : selectionDisabled
                            ? "cursor-not-allowed opacity-60"
                            : "hover:bg-zinc-100"
                      }`}
                    >
                      <span>
                        {name}
                        <span className={`block text-xs ${selected ? "text-white/80" : "text-zinc-400"}`}>{contact}</span>
                      </span>
                      {selected && (
                        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-semibold uppercase tracking-widest">Ausgewählt</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {selectedCustomerId ? (
            <button
              type="button"
              onClick={() => {
                if (onOpenCustomerProfile) {
                  onOpenCustomerProfile(selectedCustomerId);
                  return;
                }
                window.open(linkHref, "_blank", "noopener,noreferrer");
              }}
              className="font-semibold text-zinc-600 underline underline-offset-4"
            >
              {linkLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onCreateCustomer(customerQuery.trim())}
              disabled={selectionDisabled}
              className={`font-semibold underline underline-offset-4 transition ${
                selectionDisabled ? "cursor-not-allowed text-zinc-400" : "text-zinc-600 hover:text-zinc-900"
              }`}
            >
              Kunden anlegen
            </button>
          )}
          {selectedCustomerId && !selectionDisabled && (
            <button
              type="button"
              onClick={() => {
                onClearSelection();
                setCustomerQuery("");
              }}
              className="text-zinc-500 transition hover:text-zinc-700"
            >
              Auswahl entfernen
            </button>
          )}
        </div>
        {selectionDisabled && (
          <p className="text-xs text-zinc-500">Der Kunde kann bei bestehenden Terminen nicht geändert werden.</p>
        )}
      </div>
      {selectedCustomerId && (
        <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className={`text-sm font-medium ${emailSmsActive ? "text-zinc-900" : "text-zinc-500"}`}>{emailSmsLabel}</p>
              {emailSmsHint && <p className="text-xs text-rose-500">{emailSmsHint}</p>}
            </div>
            <button
              type="button"
              className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
                emailSmsActive ? "bg-emerald-500" : "bg-zinc-300"
              }`}
              onClick={() => {
                const nextValue = !emailSmsActive;
                setSendEmail(nextValue);
                setSendSms(nextValue);
                if (singleChannelOnly && nextValue) {
                  setSendWhatsApp(false);
                }
              }}
              aria-pressed={emailSmsActive}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  emailSmsActive ? "translate-x-[1.6rem]" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <div className="mt-4 space-y-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className={`text-sm font-medium ${sendWhatsApp ? "text-zinc-900" : "text-zinc-500"}`}>
                  Kunde per WhatsApp informieren
                </p>
                {whatsappHint && <p className="text-xs text-rose-500">{whatsappHint}</p>}
              </div>
            <button
              type="button"
              className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
                sendWhatsApp ? "bg-emerald-500" : "bg-zinc-300"
              }`}
              onClick={() => {
                const nextValue = !sendWhatsApp;
                setSendWhatsApp(nextValue);
                if (nextValue) {
                  setWhatsAppOptIn(true);
                  if (singleChannelOnly) {
                    setSendSms(false);
                    setSendEmail(false);
                  }
                }
              }}
              aria-pressed={sendWhatsApp}
            >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                    sendWhatsApp ? "translate-x-[1.6rem]" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
            <label className="flex items-start gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                checked={effectiveWhatsAppOptIn}
                disabled={whatsappOptInLocked}
                onChange={(event) => {
                  if (whatsappOptInLocked) return;
                  const nextValue = event.target.checked;
                  setWhatsAppOptIn(nextValue);
                  if (!nextValue) {
                    setSendWhatsApp(false);
                  }
                }}
                className={`mt-0.5 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 ${
                  whatsappOptInLocked ? "cursor-not-allowed opacity-60" : ""
                }`}
              />
              <span>
                <span className="font-medium text-zinc-900">hat Kunde explizit zugestimmt</span>
              </span>
            </label>
            {showVipPermission && (
              <div className="mt-4 border-t border-zinc-200 pt-3">
                <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
                  Kunde darf MA online buchen
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {vipStaffOptions.map((staff) => {
                    const selected = vipStaffIds.includes(staff.id);
                    return (
                      <button
                        key={staff.id}
                        type="button"
                        onClick={() => onVipStaffToggle(staff.id)}
                        className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                          selected
                            ? "border-emerald-200 bg-emerald-100 text-emerald-700"
                            : "border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                        }`}
                      >
                        {staff.name}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-xs text-zinc-500">Bestätigungslink wird per E-Mail versendet.</p>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="border-b border-zinc-200 mt-4 -mx-6" />
    </section>
  );
}

function NotesSection({
  note,
  setNote,
  attachments,
  onAttachmentsChange,
  isEditMode,
  metadata,
  appointmentSource,
  appointmentCreatedAt,
  auditTrail,
  staffOptions,
  services,
  formatDateTimeLabel,
  sectionId = "scheduler-section-notes",
}: {
  note: string;
  setNote: (value: string) => void;
  attachments: File[];
  onAttachmentsChange: (files: FileList | null) => void;
  isEditMode: boolean;
  metadata?: Record<string, unknown> | null;
  appointmentSource?: string | null;
  appointmentCreatedAt?: string | null;
  auditTrail?: AppointmentDetailPayload["auditTrail"];
  staffOptions: StaffOption[];
  services: ServiceOption[];
  formatDateTimeLabel: (value: Date) => string;
  sectionId?: string;
}) {
  const activityEntries = buildActivityEntries({
    metadata,
    appointmentSource,
    appointmentCreatedAt,
    auditTrail,
    staffOptions,
    services,
    formatDateTimeLabel,
  });

  return (
    <section className="space-y-4" id={sectionId}>
      <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Anhänge</p>
            <p className="text-sm text-zinc-700">Fotos oder Dokumente zum Termin hochladen</p>
          </div>
          <label className="inline-flex cursor-pointer items-center rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-zinc-700 transition hover:bg-zinc-100">
            Datei wählen
            <input type="file" multiple onChange={(event) => onAttachmentsChange(event.target.files)} className="hidden" />
          </label>
        </div>
        {attachments.length > 0 ? (
          <ul className="space-y-1.5 text-sm text-zinc-600">
            {attachments.map((file) => (
              <li key={`${file.name}-${file.size}`} className="flex items-center justify-between rounded-lg border border-zinc-200 px-3 py-2">
                <span className="truncate">{file.name}</span>
                <span className="text-xs text-zinc-400">{Math.round(file.size / 1024)} KB</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">
            Du kannst bis zu fünf Dateien hinzufügen. Wir speichern sie verschlüsselt und zeigen sie nur intern an.
          </p>
        )}
        {isEditMode && (
          <p className="text-xs text-zinc-500">
            Anhänge lassen sich nach dem Speichern im Terminverlauf wieder herunterladen oder ersetzen.
          </p>
        )}
      </div>
      {isEditMode && (
        <div className="space-y-3 rounded-2xl border border-zinc-200 bg-white px-4 py-4 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Aktivitäten</p>
            <p className="text-sm text-zinc-700">Wer hat den Termin zuletzt bearbeitet?</p>
          </div>
          {activityEntries.length ? (
            <ol className="space-y-3">
              {activityEntries.map((entry) => (
                <li key={entry.id} className="rounded-xl border border-zinc-100/80 bg-zinc-50/60 px-3 py-2">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-zinc-900">{entry.title}</p>
                      {entry.actor && <p className="text-xs text-zinc-500">{entry.actor}</p>}
                      {entry.description && <p className="text-xs text-zinc-500">{entry.description}</p>}
                    </div>
                    <div className="text-right">
                      {entry.timestamp && <p className="text-xs text-zinc-500">{entry.timestamp}</p>}
                      {entry.relative && <p className="text-[11px] text-zinc-400">{entry.relative}</p>}
                    </div>
                  </div>
                  {entry.changes && entry.changes.length > 0 && (
                    <ul className="mt-3 space-y-2 text-xs text-zinc-600">
                      {entry.changes.map((change) => (
                        <li key={`${entry.id}-${change.key}`} className="rounded-lg border border-white/80 bg-white px-3 py-2 shadow-sm">
                          <p className="text-xs font-semibold text-zinc-800">{change.label}</p>
                          {change.description ? (
                            <p className="mt-1 whitespace-pre-line text-xs text-zinc-600">{change.description}</p>
                          ) : (
                            <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-zinc-600">
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Vorher</p>
                                <p className="whitespace-pre-line">{change.previous ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Nachher</p>
                                <p className="whitespace-pre-line">{change.next ?? "—"}</p>
                              </div>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-zinc-500">Noch keine Aktivitäten erfasst.</p>
          )}
        </div>
      )}
    </section>
  );
}

type ActivityEntry = {
  id: string;
  title: string;
  actor?: string;
  timestamp?: string;
  relative?: string;
  description?: string;
  changes?: ActivityChange[];
  action?: string;
};

type ActivityChange = {
  key: string;
  label: string;
  previous?: string;
  next?: string;
  description?: string;
};

function buildActivityEntries({
  metadata,
  appointmentSource,
  appointmentCreatedAt,
  auditTrail,
  staffOptions,
  services,
  formatDateTimeLabel,
}: {
  metadata?: Record<string, unknown> | null;
  appointmentSource?: string | null;
  appointmentCreatedAt?: string | null;
  auditTrail?: AppointmentDetailPayload["auditTrail"];
  staffOptions: StaffOption[];
  services: ServiceOption[];
  formatDateTimeLabel: (value: Date) => string;
}): ActivityEntry[] {
  const describeTimestamp = (value?: string | null) => {
    if (!value || typeof value !== "string") {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return {
      absolute: formatDateTimeLabel(date),
      relative: formatDistanceToNow(date, { addSuffix: true, locale: localeDe }),
    };
  };
  const staffIndex = new Map(staffOptions.map((staff) => [staff.id, staff.name]));
  const serviceIndex = new Map(services.map((service) => [service.id, service.name]));
  const defaultCurrency = services.find((service) => Boolean(service.currency))?.currency ?? "EUR";

  const metadataEntries = buildMetadataEntries(metadata, describeTimestamp);
  const onlineEntry = buildOnlineBookingEntry(appointmentSource, appointmentCreatedAt, describeTimestamp);

  if (Array.isArray(auditTrail) && auditTrail.length) {
    let entries: ActivityEntry[] = auditTrail.map((entry) => {
      const timestamp = describeTimestamp(entry.createdAt);
      const actorName = resolveAuditActor(entry, staffIndex);
      const changes = extractAppointmentDiffDetails(entry.diff, {
        staffIndex,
        serviceIndex,
        currency: defaultCurrency,
        formatDateTimeLabel,
      });
      const description = extractActivityContextDescription(entry.context);
      return {
        id: entry.id,
        title: formatAuditAction(entry.action),
        actor: actorName ?? undefined,
        timestamp: timestamp?.absolute,
        relative: timestamp?.relative,
        description: description ?? undefined,
        changes,
        action: entry.action,
      };
    });

    const creationEntry = metadataEntries.find((entry) => entry.id === "meta-created");
    const hasCreationAudit = entries.some((entry) => entry.action === "CREATE");
    if (creationEntry && !hasCreationAudit) {
      entries = [creationEntry, ...entries];
    }
    if (onlineEntry && !entries.some((entry) => entry.id === onlineEntry.id)) {
      entries = [onlineEntry, ...entries];
    }

    return entries;
  }

  return onlineEntry ? [onlineEntry, ...metadataEntries] : metadataEntries;
}

function buildOnlineBookingEntry(
  source: string | null | undefined,
  createdAt: string | null | undefined,
  describeTimestamp: (value?: string | null) => { absolute: string; relative: string } | null,
): ActivityEntry | null {
  if (source !== "WEB") {
    return null;
  }
  const timestamp = describeTimestamp(createdAt);
  if (!timestamp) {
    return null;
  }
  return {
    id: "meta-online-booking",
    title: "Online gebucht",
    actor: "Kunde",
    timestamp: timestamp.absolute,
    relative: timestamp.relative,
    description: "Vom Kunden online gebucht",
    action: "META_ONLINE_BOOKING",
  };
}

function buildMetadataEntries(
  metadata: Record<string, unknown> | null | undefined,
  describeTimestamp: (value?: string | null) => { absolute: string; relative: string } | null,
): ActivityEntry[] {
  if (!isPlainObject(metadata)) {
    return [];
  }
  const record = metadata as Record<string, unknown>;
  const fallback: ActivityEntry[] = [];

  const createdLabel = extractStaffLabel(record.createdByStaff);
  if (createdLabel) {
    const createdTimestamp = describeTimestamp(
      typeof record.createdAt === "string" ? record.createdAt : undefined,
    );
    fallback.push({
      id: "meta-created",
      title: "Angelegt",
      actor: createdLabel,
      timestamp: createdTimestamp?.absolute,
      relative: createdTimestamp?.relative,
      changes: [],
      action: "META_CREATE",
    });
  }

  const updatedLabel = extractStaffLabel(record.lastUpdatedByStaff);
  const updateTimestamp = describeTimestamp(
    typeof record.lastUpdatedAt === "string" ? record.lastUpdatedAt : undefined,
  );
  if (updatedLabel || updateTimestamp) {
    fallback.push({
      id: "meta-updated",
      title: "Zuletzt bearbeitet",
      actor: updatedLabel ?? undefined,
      timestamp: updateTimestamp?.absolute,
      relative: updateTimestamp?.relative,
      changes: [],
      action: "META_UPDATE",
    });
  }

  return fallback;
}

function resolveAuditActor(
  entry: AppointmentDetailPayload["auditTrail"][number],
  staffIndex: Map<string, string>,
) {
  if (entry.actorType === "CUSTOMER") {
    return "Kund:in";
  }
  const direct =
    entry.actor?.name?.trim() ||
    entry.actor?.email?.trim();
  if (direct?.length) {
    return direct;
  }
  if (entry.actor?.id && staffIndex.has(entry.actor.id)) {
    return staffIndex.get(entry.actor.id);
  }
  const contextRecord = isPlainObject(entry.context) ? (entry.context as Record<string, unknown>) : null;
  const contextActor = contextRecord ? extractStaffLabel(contextRecord.performedByStaff) : null;
  if (contextActor) {
    return contextActor;
  }
  const diffRecord = isPlainObject(entry.diff) ? (entry.diff as Record<string, unknown>) : null;
  const diffActor = diffRecord ? extractStaffLabel(diffRecord.performedByStaff) : null;
  if (diffActor) {
    return diffActor;
  }
  return entry.actorType === "SYSTEM" ? "System" : undefined;
}

const AUDIT_SOURCE_LABELS: Record<string, string> = {
  backoffice_update: "Über den Kalender aktualisiert",
  backoffice_update_full: "Termin komplett neu geplant",
  backoffice_status_update: "Status direkt im Kalender geändert",
  backoffice_note_update: "Notizen bearbeitet",
  backoffice_payment_status_update: "Zahlungsstatus angepasst",
  booking_manage_cancel: "Vom Kunden storniert",
};

function extractActivityContextDescription(context: unknown) {
  if (!isPlainObject(context)) return null;
  const source = typeof context.source === "string" ? context.source : null;
  if (!source) return null;
  return AUDIT_SOURCE_LABELS[source] ?? null;
}

const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Offen",
  CONFIRMED: "Bestätigt",
  COMPLETED: "Abgeschlossen",
  CANCELLED: "Storniert",
  NO_SHOW: "Nicht erschienen",
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  UNPAID: "Offen",
  AUTHORIZED: "Autorisiert",
  PAID: "Bezahlt",
  REFUNDED: "Erstattet",
  PARTIALLY_REFUNDED: "Teilweise erstattet",
  PARTIALLY_PAID: "Teilweise bezahlt",
  FAILED: "Fehlgeschlagen",
};

function extractAppointmentDiffDetails(
  diff: unknown,
  helpers: {
    staffIndex: Map<string, string>;
    serviceIndex: Map<string, string>;
    currency: string;
    formatDateTimeLabel: (value: Date) => string;
  },
): ActivityChange[] {
  if (!isPlainObject(diff)) {
    return [];
  }
  const record = diff as Record<string, unknown>;
  const rows: ActivityChange[] = [];
  const scopeName =
    isPlainObject(record.itemLabel) && typeof (record.itemLabel as Record<string, unknown>).serviceName === "string"
      ? ((record.itemLabel as Record<string, unknown>).serviceName as string)
      : null;
  const scopedLabel = (label: string) => (scopeName ? `${scopeName} · ${label}` : label);
  const asRecord = (value: unknown) => (isPlainObject(value) ? (value as Record<string, unknown>) : null);
  const formatDateValue = (value: unknown) => {
    if (typeof value === "string" || value instanceof Date) {
      const date = typeof value === "string" ? new Date(value) : value;
      if (!Number.isNaN(date.getTime())) {
        return helpers.formatDateTimeLabel(date);
      }
    }
    return undefined;
  };
  const formatRange = (start: unknown, end: unknown) => {
    const startLabel = formatDateValue(start);
    const endLabel = formatDateValue(end);
    if (startLabel && endLabel) {
      return `${startLabel} – ${endLabel}`;
    }
    return startLabel ?? endLabel;
  };
  const valueText = (value: unknown) => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length ? trimmed : "—";
    }
    if (typeof value === "number") {
      return new Intl.NumberFormat("de-DE", {
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value);
    }
    if (typeof value === "boolean") {
      return value ? "Ja" : "Nein";
    }
    return String(value);
  };
  const staffLabel = (id: unknown, fallback?: unknown) => {
    if (typeof fallback === "string" && fallback.trim().length) {
      return fallback.trim();
    }
    if (typeof id === "string" && id.trim().length) {
      return helpers.staffIndex.get(id) ?? id;
    }
    if (id === null) {
      return "Nicht zugewiesen";
    }
    return undefined;
  };
  const serviceLabel = (id: unknown, fallback?: unknown) => {
    if (typeof fallback === "string" && fallback.trim().length) {
      return fallback.trim();
    }
    if (typeof id === "string" && id.trim().length) {
      return helpers.serviceIndex.get(id) ?? id;
    }
    return undefined;
  };
  const addChange = (key: string, label: string, previous?: string | null, next?: string | null) => {
    rows.push({
      key,
      label,
      previous: previous ?? "—",
      next: next ?? "—",
    });
  };

  const serviceDiff = asRecord(record.service);
  if (serviceDiff) {
    const previousName = serviceLabel(serviceDiff.previousServiceId, serviceDiff.previousServiceName);
    const nextName = serviceLabel(serviceDiff.newServiceId, serviceDiff.newServiceName);
    addChange("service", scopedLabel("Leistung"), previousName ?? "—", nextName ?? "—");
  }

  const staffDiff = asRecord(record.staff);
  if (staffDiff) {
    const previousStaff = staffLabel(staffDiff.previousStaffId, staffDiff.previousStaffName);
    const nextStaff = staffLabel(staffDiff.newStaffId, staffDiff.newStaffName);
    addChange("staff", scopedLabel("Mitarbeiter"), previousStaff ?? "Nicht zugewiesen", nextStaff ?? "Nicht zugewiesen");
  }

  const itemTimingDiff = asRecord(record.itemTiming);
  if (itemTimingDiff) {
    const previousRange = formatRange(itemTimingDiff.previousStartsAt, itemTimingDiff.previousEndsAt);
    const nextRange = formatRange(itemTimingDiff.newStartsAt, itemTimingDiff.newEndsAt);
    addChange("itemTiming", scopedLabel("Zeitfenster"), previousRange ?? "—", nextRange ?? "—");
  }

  const appointmentStarts = asRecord(record.appointmentStartsAt);
  if (appointmentStarts && ("previous" in appointmentStarts || "next" in appointmentStarts)) {
    addChange(
      "appointmentStart",
      "Terminbeginn",
      formatDateValue(appointmentStarts.previous) ?? valueText(appointmentStarts.previous ?? null),
      formatDateValue(appointmentStarts.next) ?? valueText(appointmentStarts.next ?? null),
    );
  }

  const appointmentEnds = asRecord(record.appointmentEndsAt);
  if (appointmentEnds && ("previous" in appointmentEnds || "next" in appointmentEnds)) {
    addChange(
      "appointmentEnd",
      "Terminende",
      formatDateValue(appointmentEnds.previous) ?? valueText(appointmentEnds.previous ?? null),
      formatDateValue(appointmentEnds.next) ?? valueText(appointmentEnds.next ?? null),
    );
  }

  const structuredNote = asRecord(record.note);
  if (structuredNote && ("previous" in structuredNote || "next" in structuredNote)) {
    addChange(
      "note",
      "Kundennotiz",
      valueText(structuredNote.previous ?? null),
      valueText(structuredNote.next ?? null),
    );
  } else if (typeof record.note === "string" && record.note.trim().length) {
    rows.push({
      key: "note-text",
      label: "Nachricht",
      description: record.note.trim(),
    });
  }

  if ("previousNote" in record || "newNote" in record) {
    addChange(
      "note-legacy",
      "Kundennotiz",
      "previousNote" in record ? valueText(record.previousNote) : undefined,
      "newNote" in record ? valueText(record.newNote) : undefined,
    );
  }

  if ("previousInternalNote" in record || "newInternalNote" in record) {
    addChange(
      "internal-note",
      "Interne Notiz",
      "previousInternalNote" in record ? valueText(record.previousInternalNote) : undefined,
      "newInternalNote" in record ? valueText(record.newInternalNote) : undefined,
    );
  }

  if ("previousStatus" in record || "newStatus" in record) {
    const previousStatusLabel = formatStatusValue(record.previousStatus);
    const nextStatusLabel = formatStatusValue(record.newStatus);
    const isPaymentStatus =
      (typeof record.previousStatus === "string" && record.previousStatus in PAYMENT_STATUS_LABELS) ||
      (typeof record.newStatus === "string" && record.newStatus in PAYMENT_STATUS_LABELS);
    addChange(
      "status",
      isPaymentStatus ? "Zahlungsstatus" : "Status",
      previousStatusLabel ?? valueText(record.previousStatus ?? null),
      nextStatusLabel ?? valueText(record.newStatus ?? null),
    );
  }

  if (typeof record.reason === "string" && record.reason.trim().length) {
    rows.push({
      key: "reason",
      label: "Grund",
      description: record.reason.trim(),
    });
  }

  if (Array.isArray(record.services) && record.services.length) {
    const names = record.services
      .map((serviceId) => serviceLabel(serviceId, undefined) ?? (typeof serviceId === "string" ? serviceId : null))
      .filter((value): value is string => Boolean(value && value.length));
    if (names.length) {
      rows.push({
        key: "services",
        label: "Ausgewählte Leistungen",
        description: names.join(", "),
      });
    }
  }

  if (Array.isArray(record.assignedStaffIds) && record.assignedStaffIds.length) {
    const names = record.assignedStaffIds
      .map((staffId) => staffLabel(staffId, undefined) ?? (typeof staffId === "string" ? staffId : null))
      .filter((value): value is string => Boolean(value && value.length));
    if (names.length) {
      rows.push({
        key: "assigned-staff",
        label: "Zugewiesene Mitarbeitende",
        description: names.join(", "),
      });
    }
  }

  const resultingItem = asRecord(record.resultingItem);
  if (resultingItem) {
    const serviceName = typeof resultingItem.serviceName === "string"
      ? resultingItem.serviceName
      : serviceLabel(resultingItem.serviceId, undefined);
    const staffName = staffLabel(resultingItem.staffId ?? null, resultingItem.staffName);
    const range = formatRange(resultingItem.startsAt, resultingItem.endsAt);
    rows.push({
      key: "resulting-item",
      label: scopedLabel("Aktueller Stand"),
      description: [serviceName, staffName, range].filter(Boolean).join(" · "),
    });
  }

  if (typeof record.amount === "number" && !Number.isNaN(record.amount)) {
    rows.push({
      key: "amount",
      label: "Betrag",
      description: new Intl.NumberFormat("de-DE", { style: "currency", currency: helpers.currency }).format(record.amount),
    });
  }

  if (typeof record.pinVerified === "boolean") {
    rows.push({
      key: "pin",
      label: "Buchungs-PIN",
      description: record.pinVerified ? "Geprüft" : "Nicht geprüft",
    });
  }

  return rows;
}

function formatStatusValue(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  if (value in APPOINTMENT_STATUS_LABELS) {
    return APPOINTMENT_STATUS_LABELS[value];
  }
  if (value in PAYMENT_STATUS_LABELS) {
    return PAYMENT_STATUS_LABELS[value];
  }
  return value;
}

function extractStaffLabel(value: unknown) {
  if (!isPlainObject(value)) return null;
  const name = typeof value.staffName === "string" ? value.staffName.trim() : "";
  const id = typeof value.staffId === "string" ? value.staffId.trim() : "";
  if (name.length) return name;
  if (id.length) return `ID ${id}`;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function TotalAmountField({
  services,
  serviceEntries,
}: {
  services: ServiceOption[];
  serviceEntries: ServiceEntryState[];
}) {
  const servicesById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);

  const selectedServices = serviceEntries
    .map((entry) => (entry.serviceId ? servicesById.get(entry.serviceId) ?? null : null))
    .filter((service): service is ServiceOption => Boolean(service));

  if (!selectedServices.length) {
    return null;
  }

  const total = selectedServices.reduce((sum, service) => sum + (service.basePrice ?? 0), 0);
  const currency = selectedServices[0]?.currency ?? services[0]?.currency ?? "EUR";
  const formattedTotal = new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(total);

  return (
    <section className="space-y-1 rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Gesamtbetrag</p>
      <p className="text-2xl font-semibold text-zinc-900">{formattedTotal}</p>
    </section>
  );
}

function CustomerSummaryCard({
  customers,
  selectedCustomerId,
  locationSlug,
}: {
  customers: CustomerOption[];
  selectedCustomerId?: string;
  locationSlug: string;
}) {
  if (!selectedCustomerId) {
    return null;
  }

  const customer = customers.find((entry) => entry.id === selectedCustomerId);
  if (!customer) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-xs text-amber-800">
        Kunde wird geladen …
      </div>
    );
  }

  const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.replace(/\s+/g, " ").trim() || "Kunde";
  const lastSeen = customer.lastAppointment
    ? formatDistanceToNow(new Date(customer.lastAppointment), { addSuffix: true, locale: undefined })
    : null;

  return (
    <div className="space-y-4 rounded-2xl border border-zinc-200 bg-white px-5 py-4 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-zinc-900">{name}</p>
        <p className="text-xs text-zinc-500">E-Mail: {customer.email || "–"}</p>
        <p className="text-xs text-zinc-500">Telefon: {customer.phone || "–"}</p>
      </div>
      <div className="rounded-xl bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
        <p>Termine gesamt: {customer.appointmentCount}</p>
        <p>
          Letzter Termin: {lastSeen ? `${lastSeen} (${customer.lastAppointmentStatus ?? "–"})` : "Noch kein Termin"}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <a
          href={`/backoffice/${locationSlug}/customers?customer=${customer.id}`}
          className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 transition hover:bg-zinc-100"
          target="_blank"
          rel="noreferrer"
        >
          Stammdaten öffnen
        </a>
        {customer.email && (
          <a
            href={`mailto:${customer.email}`}
            className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 transition hover:bg-zinc-100"
          >
            E-Mail senden
          </a>
        )}
        {customer.phone && (
          <a
            href={`tel:${customer.phone}`}
            className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 transition hover:bg-zinc-100"
          >
            Anrufen
          </a>
        )}
      </div>
    </div>
  );
}

type CustomerCreatePayload = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

type CustomerCreateModalProps = {
  open: boolean;
  loading: boolean;
  error: string | null;
  initialFirstName: string;
  initialLastName: string;
  initialEmail: string;
  initialPhone: string;
  onClose: () => void;
  onSubmit: (payload: CustomerCreatePayload) => Promise<void>;
};

function CustomerCreateModal({
  open,
  loading,
  error,
  onClose,
  onSubmit,
  initialFirstName,
  initialLastName,
  initialEmail,
  initialPhone,
}: CustomerCreateModalProps) {
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFirstName(initialFirstName);
      setLastName(initialLastName);
      setEmail(initialEmail);
      setPhone(initialPhone);
      setLocalError(null);
    }
  }, [open, initialFirstName, initialLastName, initialEmail, initialPhone]);

  if (!open) return null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (!trimmedFirst) {
      setLocalError("Vorname ist erforderlich.");
      return;
    }
    if (!trimmedLast) {
      setLocalError("Nachname ist erforderlich.");
      return;
    }
    setLocalError(null);
    await onSubmit({
      firstName: trimmedFirst,
      lastName: trimmedLast,
      email: email.trim().toLowerCase(),
      phone: phone.trim(),
    });
  };

  return (
    <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-zinc-200 bg-white px-6 py-6 shadow-2xl">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-zinc-900">Neuen Kunden anlegen</h3>
            <p className="text-xs text-zinc-500">Erfasse die Stammdaten, um den Kunden sofort für Termine auszuwählen.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100"
            disabled={loading}
          >
            Schließen
          </button>
        </header>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm font-medium text-zinc-700">
              Vorname
              <input
                type="text"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                placeholder="Max"
                disabled={loading}
                required
              />
            </label>
            <label className="space-y-1 text-sm font-medium text-zinc-700">
              Nachname
              <input
                type="text"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                placeholder="Mustermann"
                disabled={loading}
                required
              />
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1 text-sm font-medium text-zinc-700">
              E-Mail
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="kunde@example.com"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                disabled={loading}
              />
            </label>
            <label className="space-y-1 text-sm font-medium text-zinc-700">
              Telefon
              <input
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+49 …"
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                disabled={loading}
              />
            </label>
          </div>
          {(localError || error) && (
            <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {localError ?? error}
            </p>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100"
              disabled={loading}
            >
              Abbrechen
            </button>
            <button
              type="submit"
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
              disabled={loading}
            >
              {loading ? "Speichern …" : "Kunde speichern"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type AppointmentSummaryProps = {
  start: Date;
  end: Date;
  services: ServiceOption[];
  staff: StaffOption[];
  resources: ResourceOption[];
  repeatEnabled: boolean;
  repeatFrequency: "DAILY" | "WEEKLY";
  repeatCount: number;
  formatTimeLabel: (value: Date) => string;
};

const AppointmentSummary = forwardRef<HTMLDivElement, AppointmentSummaryProps>(function AppointmentSummary(
  { start, end, services, staff, resources, repeatEnabled, repeatFrequency, repeatCount, formatTimeLabel },
  ref,
) {
  const totalMinutes = Math.max(5, Math.abs(differenceInMinutes(end, start)));
  const totalAmount = services.reduce((sum, service) => sum + service.basePrice, 0);
  const currency = services[0]?.currency ?? "EUR";

  return (
    <div
      id="composer-summary-overview"
      tabIndex={-1}
      ref={ref}
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white px-5 py-5 text-sm text-zinc-600 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
    >
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Zusammenfassung</p>
        <h4 className="text-lg font-semibold text-zinc-900">{formatTimeLabel(start)} – {formatTimeLabel(end)}</h4>
        <p className="text-xs text-zinc-500">Gesamtdauer {totalMinutes} Minuten</p>
      </header>
      <dl className="space-y-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Leistungen</dt>
          <dd className="mt-1 text-zinc-800">
            {services.length
              ? services.map((service) => service.name).join(", ")
              : "Noch keine Leistung ausgewählt"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Team</dt>
          <dd className="mt-1 flex flex-wrap gap-2">
            {staff.length ? (
              staff.map((member) => (
                <span
                  key={member.id}
                  className="flex items-center gap-2 rounded-full border border-zinc-200 px-2 py-1 text-xs text-zinc-700"
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: member.color }} />
                  {member.name}
                </span>
              ))
            ) : (
              <span className="text-zinc-500">Nicht zugewiesen</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Ressourcen</dt>
          <dd className="mt-1 text-zinc-800">
            {resources.length ? resources.map((entry) => entry.name).join(", ") : "Keine Ressourcen ausgewählt"}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Honorare</dt>
          <dd className="mt-1 text-zinc-800">
            {new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(totalAmount)}
          </dd>
        </div>
      </dl>
      {repeatEnabled && (
        <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          Wiederholung: Alle {repeatCount} {repeatFrequency === "DAILY" ? "Tage" : "Wochen"} · bis Jahresende
        </div>
      )}
    </div>
  );
});
