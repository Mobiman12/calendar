"use client";

import { forwardRef, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { addMinutes, differenceInMinutes, formatDistanceToNow } from "date-fns";
import { de as localeDe } from "date-fns/locale";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useToast } from "@/components/ui/ToastProvider";
import {
  formatDateTimeLocalInput,
  parseDateTimeLocalInput,
  formatDateWithPatternInTimeZone,
  formatInTimeZone,
} from "@/lib/timezone";
import { useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";
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

interface AppointmentComposerDrawerProps {
  open: boolean;
  onClose: () => void;
  locationId: string;
  locationSlug: string;
  timezone: string;
  initialStart: Date;
  initialStaffId?: string;
  staffOptions: StaffOption[];
  services: ServiceOption[];
  resources: ResourceOption[];
  customers: CustomerOption[];
  onCreated?: () => void;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
  manualConfirmationMode?: ManualConfirmationMode;
}

const MAX_ATTACHMENTS = 5;
type TimeBlockerReason = "BREAK" | "VACATION" | "SICK" | "MEAL" | "PRIVATE" | "OTHER";

const TIME_BLOCKER_OPTIONS: Array<{ value: TimeBlockerReason; label: string }> = [
  { value: "BREAK", label: "Pause" },
  { value: "MEAL", label: "Mittagessen" },
  { value: "VACATION", label: "Urlaub" },
  { value: "SICK", label: "Krankheit" },
  { value: "PRIVATE", label: "Privater Termin" },
  { value: "OTHER", label: "Anderer Grund" },
];

export function AppointmentComposerDrawer({
  open,
  onClose,
  locationId,
  locationSlug,
  timezone,
  initialStart,
  initialStaffId,
  staffOptions,
  services,
  resources,
  customers,
  onCreated,
  ensureBookingActor,
  manualConfirmationMode,
}: AppointmentComposerDrawerProps) {
  const router = useRouter();
  const { pushToast } = useToast();
  const { registerActivity } = useBookingPinSession();
  const activityRef = useRef(registerActivity);
  const confirmationMode = manualConfirmationMode ?? "both";
  const singleChannelOnly = confirmationMode === "single";
  const summaryRef = useRef<HTMLDivElement | null>(null);

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
      summaryRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  const [composerMode, setComposerMode] = useState<"appointment" | "blocker">("appointment");
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(addMinutes(initialStart, services[0]?.duration ?? 30));
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>(() =>
    initialStaffId ? [initialStaffId] : [],
  );
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [selectedResourceIds, setSelectedResourceIds] = useState<string[]>([]);
  const [customerOptions, setCustomerOptions] = useState<CustomerOption[]>(customers);
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | undefined>(undefined);
  const [sendEmail, setSendEmail] = useState(false);
  const [sendSms, setSendSms] = useState(false);
  const [sendWhatsApp, setSendWhatsApp] = useState(false);
  const [whatsAppOptIn, setWhatsAppOptIn] = useState(false);
  const [note, setNote] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatFrequency, setRepeatFrequency] = useState<"DAILY" | "WEEKLY">("WEEKLY");
  const [repeatCount, setRepeatCount] = useState(1);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockerStaffIds, setBlockerStaffIds] = useState<string[]>(initialStaffId ? [initialStaffId] : []);
  const [blockerAllStaff, setBlockerAllStaff] = useState(false);
  const [blockerReason, setBlockerReason] = useState<TimeBlockerReason>("BREAK");
  const [blockerCustomReason, setBlockerCustomReason] = useState("");
  const [blockerStart, setBlockerStart] = useState(initialStart);
  const [blockerEnd, setBlockerEnd] = useState(addMinutes(initialStart, 30));
  const [blockerAllDay, setBlockerAllDay] = useState(false);
  const [blockerSubmitting, setBlockerSubmitting] = useState(false);
  const [blockerError, setBlockerError] = useState<string | null>(null);
  const previousBlockerRangeRef = useRef<{ start: Date; end: Date } | null>(null);
  const lastInitializationRef = useRef<{
    startMs: number;
    staffId?: string;
    serviceKey: string;
  } | null>(null);
  const customerSearchAbortRef = useRef<AbortController | null>(null);
  const customerSearchTimeoutRef = useRef<number | null>(null);
  const lastCustomerSearchRef = useRef<string>("");

  useEffect(() => {
    if (!selectedCustomerId && sendEmail) {
      setSendEmail(false);
    }
    if (!selectedCustomerId && sendSms) {
      setSendSms(false);
    }
  }, [selectedCustomerId, sendEmail, sendSms]);

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
  const selectedConsents = selectedCustomer?.consents ?? emptyConsents;

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
  }, [selectedCustomerId, selectedConsents.email, selectedConsents.sms, selectedConsents.whatsapp, singleChannelOnly]);

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
    if (!open) {
      lastInitializationRef.current = null;
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

    const config = {
      startMs: initialStart.getTime(),
      staffId: initialStaffId,
      serviceKey: services.map((service) => service.id).join("|"),
    };

    const shouldReset =
      lastInitializationRef.current === null ||
      lastInitializationRef.current.startMs !== config.startMs ||
      lastInitializationRef.current.staffId !== config.staffId ||
      lastInitializationRef.current.serviceKey !== config.serviceKey;

    if (!shouldReset) {
      return;
    }

    setComposerMode("appointment");
    setStart(initialStart);
    setSelectedServices([]);
    setSelectedResourceIds([]);
    const initialDuration = services[0]?.duration ?? 30;
    setEnd(addMinutes(initialStart, initialDuration || 30));
    setSelectedStaffIds(initialStaffId ? [initialStaffId] : []);
    setCustomerQuery("");
    setSelectedCustomerId(undefined);
    setSendEmail(false);
    setSendSms(false);
    setSendWhatsApp(false);
    setWhatsAppOptIn(false);
    setNote("");
    setInternalNote("");
    setRepeatEnabled(false);
    setRepeatFrequency("WEEKLY");
    setRepeatCount(4);
    setAttachments([]);
    setError(null);
    setIsSubmitting(false);
    setBlockerStaffIds(initialStaffId ? [initialStaffId] : []);
    setBlockerAllStaff(false);
    setBlockerReason("BREAK");
    setBlockerCustomReason("");
    setBlockerStart(initialStart);
    setBlockerEnd(addMinutes(initialStart, services[0]?.duration ?? 30));
    setBlockerAllDay(false);
    setBlockerSubmitting(false);
    setBlockerError(null);
    lastInitializationRef.current = config;
  }, [open, initialStart, initialStaffId, services, customers]);

  const totalDuration = useMemo(() => {
    return services
      .filter((service) => selectedServices.includes(service.id))
      .reduce((sum, service) => sum + service.duration, 0);
  }, [selectedServices, services]);

  useEffect(() => {
    if (!open) return;
    const fallbackDuration = services[0]?.duration ?? 30;
    const duration = selectedServices.length ? totalDuration || 30 : fallbackDuration;
    setEnd((previous) => {
      const next = addMinutes(start, duration);
      if (previous.getTime() === next.getTime()) {
        return previous;
      }
      return next;
    });
  }, [start, totalDuration, open, services, selectedServices]);

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

  const handleToggleService = (serviceId: string) => {
    setSelectedServices((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId],
    );
  };

  const handleAttachmentChange = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files).slice(0, MAX_ATTACHMENTS);
    setAttachments(next);
  };

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
        services: Array<{ id: string }>;
        customer: typeof customerPayload;
        sendEmail: boolean;
        sendSms: boolean;
        sendWhatsApp: boolean;
        whatsAppOptIn: boolean;
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
        resources: selectedResourceIds,
        services: selectedServices.map((id) => ({ id })),
        customer: customerPayload,
        sendEmail: customerPayload ? sendEmail : false,
        sendSms: customerPayload ? sendSms : false,
        sendWhatsApp: customerPayload ? sendWhatsApp : false,
        whatsAppOptIn: customerPayload ? whatsAppOptIn : false,
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

  const handleBlockerSubmit = async () => {
    if (blockerSubmitting) return;
    if (!blockerAllStaff && blockerStaffIds.length === 0) {
      setBlockerError("Bitte mindestens einen Mitarbeiter auswählen oder 'Alle Mitarbeiter' aktivieren.");
      return;
    }

    const startDate = blockerStart;
    const endDate = blockerEnd;
    if (!(startDate < endDate)) {
      setBlockerError("Endzeitpunkt muss nach dem Start liegen.");
      return;
    }

    setBlockerSubmitting(true);
    setBlockerError(null);

    try {
      let bookingActor: BookingActor;
      try {
        bookingActor = await ensureBookingActor();
      } catch {
        setBlockerSubmitting(false);
        setBlockerError("Aktion abgebrochen.");
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
          customReason: blockerReason === "OTHER" ? blockerCustomReason.trim() : undefined,
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

  if (!open) return null;

  const isBlockerMode = composerMode === "blocker";
  const primaryLoading = isBlockerMode ? blockerSubmitting : isSubmitting;
  const primaryAction = isBlockerMode ? handleBlockerSubmit : handleSubmit;
  const blockerPrimaryLabel = blockerSubmitting ? "Speichern…" : "Zeitblocker erstellen";
  const appointmentPrimaryLabel = isSubmitting ? "Speichern…" : "Termin erstellen";
  const appointmentHeaderLabel = isSubmitting ? "Speichern…" : "Neuer Termin";
  const headerPrimaryLabel = isBlockerMode ? blockerPrimaryLabel : appointmentHeaderLabel;
  const headerPrefix = isBlockerMode ? "Zeitblocker" : "Neuer Termin";
  const headerTitle = isBlockerMode ? "Zeitblocker erstellen" : "Termin anlegen";
  const headerRange = isBlockerMode
    ? `${formatDateTimeLabel(blockerStart)} – ${formatTimeLabel(blockerEnd)} (${timezone})`
    : `${formatDateTimeLabel(start)} – ${formatTimeLabel(end)} (${timezone})`;

  return (
    <div
      className="fixed inset-0 z-[1200] flex justify-end bg-black/30"
      onPointerDownCapture={handleInteraction}
      onKeyDownCapture={handleInteraction}
    >
      <div className="relative flex h-full w-full max-w-5xl flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
        <header className="flex flex-col gap-4 border-b border-zinc-200 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-3">
            <nav className="flex gap-3 text-sm">
              <button
                type="button"
                onClick={() => setComposerMode("appointment")}
                className={`rounded-full px-3 py-1 transition ${
                  !isBlockerMode ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
                }`}
              >
                Neuer Termin
              </button>
              <button
                type="button"
                onClick={() => setComposerMode("blocker")}
                className={`rounded-full px-3 py-1 transition ${
                  isBlockerMode ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
                }`}
              >
                Zeitblocker
              </button>
            </nav>
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-400">{headerPrefix}</p>
              <h2 className="text-2xl font-semibold text-zinc-900">{headerTitle}</h2>
              <p className="text-xs text-zinc-500">{headerRange}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={primaryAction}
              disabled={primaryLoading}
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
            >
              {headerPrimaryLabel}
            </button>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
          {isBlockerMode ? (
            <TimeBlockerForm
              staffOptions={staffOptions}
              staffIds={blockerStaffIds}
              onToggleStaff={handleBlockerStaffToggle}
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
              toDateTimeLocalValue={toDateTimeLocalValue}
              parseDateTimeLocalValue={parseDateTimeLocalValue}
            />
          ) : (
            <AppointmentFormLayout
              customerOptions={customerOptions}
              customerQuery={customerQuery}
              setCustomerQuery={setCustomerQuery}
              filteredCustomers={filteredCustomers}
              selectedCustomerId={selectedCustomerId}
              setSelectedCustomerId={setSelectedCustomerId}
              onClearCustomer={() => {
                setSelectedCustomerId(undefined);
                setCustomerQuery("");
              }}
              locationSlug={locationSlug}
              sendEmail={sendEmail}
              setSendEmail={setSendEmail}
              sendSms={sendSms}
              setSendSms={setSendSms}
              sendWhatsApp={sendWhatsApp}
              setSendWhatsApp={setSendWhatsApp}
              whatsAppOptIn={whatsAppOptIn}
              setWhatsAppOptIn={setWhatsAppOptIn}
              customerConsents={selectedConsents}
              note={note}
              setNote={setNote}
              internalNote={internalNote}
              setInternalNote={setInternalNote}
              attachments={attachments}
              onAttachmentsChange={handleAttachmentChange}
              start={start}
              end={end}
          setStart={setStart}
          setEnd={setEnd}
              staffOptions={staffOptions}
              selectedStaffIds={selectedStaffIds}
              onToggleStaff={(id) =>
                setSelectedStaffIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]))
              }
              onClearStaff={() => setSelectedStaffIds([])}
              services={services}
              selectedServices={selectedServices}
              toggleService={handleToggleService}
              resources={resources}
              selectedResources={selectedResourceIds}
              setSelectedResources={setSelectedResourceIds}
              repeatEnabled={repeatEnabled}
              setRepeatEnabled={setRepeatEnabled}
              repeatFrequency={repeatFrequency}
              setRepeatFrequency={setRepeatFrequency}
              repeatCount={repeatCount}
              setRepeatCount={setRepeatCount}
              totalDuration={totalDuration}
              error={error}
              summaryRef={summaryRef}
              toDateTimeLocalValue={toDateTimeLocalValue}
              parseDateTimeLocalValue={parseDateTimeLocalValue}
              formatTimeLabel={formatTimeLabel}
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
  );
}


function AppointmentFormLayout({
  customerOptions,
  customerQuery,
  setCustomerQuery,
  filteredCustomers,
  selectedCustomerId,
  setSelectedCustomerId,
  onClearCustomer,
  locationSlug,
  sendEmail,
  setSendEmail,
  sendSms,
  setSendSms,
  sendWhatsApp,
  setSendWhatsApp,
  whatsAppOptIn,
  setWhatsAppOptIn,
  customerConsents,
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
  selectedStaffIds,
  onToggleStaff,
  onClearStaff,
  services,
  selectedServices,
  toggleService,
  resources,
  selectedResources,
  setSelectedResources,
  repeatEnabled,
  setRepeatEnabled,
  repeatFrequency,
  setRepeatFrequency,
  repeatCount,
  setRepeatCount,
  totalDuration,
  error,
  summaryRef,
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
  formatTimeLabel,
}: {
  customerOptions: CustomerOption[];
  customerQuery: string;
  setCustomerQuery: (value: string) => void;
  filteredCustomers: CustomerOption[];
  selectedCustomerId?: string;
  setSelectedCustomerId: (id: string | undefined) => void;
  onClearCustomer: () => void;
  locationSlug: string;
  sendEmail: boolean;
  setSendEmail: (value: boolean) => void;
  sendSms: boolean;
  setSendSms: (value: boolean) => void;
  sendWhatsApp: boolean;
  setSendWhatsApp: (value: boolean) => void;
  whatsAppOptIn: boolean;
  setWhatsAppOptIn: (value: boolean) => void;
  customerConsents: { email: boolean; sms: boolean; whatsapp: boolean };
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
  selectedStaffIds: string[];
  onToggleStaff: (id: string) => void;
  onClearStaff: () => void;
  services: ServiceOption[];
  selectedServices: string[];
  toggleService: (id: string) => void;
  resources: ResourceOption[];
  selectedResources: string[];
  setSelectedResources: (ids: string[]) => void;
  repeatEnabled: boolean;
  setRepeatEnabled: (value: boolean) => void;
  repeatFrequency: "DAILY" | "WEEKLY";
  setRepeatFrequency: (value: "DAILY" | "WEEKLY") => void;
  repeatCount: number;
  setRepeatCount: (value: number) => void;
  totalDuration: number;
  error: string | null;
  summaryRef: RefObject<HTMLDivElement | null>;
  toDateTimeLocalValue: (value: Date) => string;
  parseDateTimeLocalValue: (value: string) => Date;
  formatTimeLabel: (value: Date) => string;
}) {
  const [activeTab, setActiveTab] = useState<"details" | "customer" | "notes">("details");
  const summaryStaff = useMemo(
    () => staffOptions.filter((option) => selectedStaffIds.includes(option.id)),
    [staffOptions, selectedStaffIds],
  );
  const summaryResources = useMemo(
    () => resources.filter((resource) => selectedResources.includes(resource.id)),
    [resources, selectedResources],
  );

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <nav className="mb-6 flex flex-wrap gap-2 text-sm">
          <button
            type="button"
            onClick={() => setActiveTab("details")}
            className={`rounded-full px-3 py-1 transition ${
              activeTab === "details" ? "bg-zinc-900 text-white" : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            Leistungen & Zeiten
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("customer")}
            className={`rounded-full px-3 py-1 transition ${
              activeTab === "customer" ? "bg-zinc-900 text-white" : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            Kunde & Kommunikation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("notes")}
            className={`rounded-full px-3 py-1 transition ${
              activeTab === "notes" ? "bg-zinc-900 text-white" : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            Notizen & Dateien
          </button>
        </nav>

        <div className="space-y-6">
          {activeTab === "details" && (
          <DetailsTab
            start={start}
            end={end}
            setStart={setStart}
            setEnd={setEnd}
            staffOptions={staffOptions}
            selectedStaffIds={selectedStaffIds}
            onToggleStaff={onToggleStaff}
            onClearStaff={onClearStaff}
            services={services}
            selectedServices={selectedServices}
            toggleService={toggleService}
            resources={resources}
            selectedResources={selectedResources}
              setSelectedResources={setSelectedResources}
              repeatEnabled={repeatEnabled}
              setRepeatEnabled={setRepeatEnabled}
              repeatFrequency={repeatFrequency}
              setRepeatFrequency={setRepeatFrequency}
              repeatCount={repeatCount}
              setRepeatCount={setRepeatCount}
              totalDuration={totalDuration}
              toDateTimeLocalValue={toDateTimeLocalValue}
              parseDateTimeLocalValue={parseDateTimeLocalValue}
            />
          )}
          {activeTab === "customer" && (
            <CustomerTab
              customerQuery={customerQuery}
              setCustomerQuery={setCustomerQuery}
              filteredCustomers={filteredCustomers}
              selectedCustomerId={selectedCustomerId}
              setSelectedCustomerId={setSelectedCustomerId}
              onClearSelection={onClearCustomer}
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
              customerConsents={customerConsents}
            />
          )}
          {activeTab === "notes" && (
            <NotesTab
              note={note}
              setNote={setNote}
              internalNote={internalNote}
              setInternalNote={setInternalNote}
              attachments={attachments}
              onAttachmentsChange={onAttachmentsChange}
            />
          )}
          {error && <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}
        </div>
      </div>
      <aside className="flex w-full flex-col gap-6 border-t border-zinc-200 bg-zinc-50 px-6 py-6 lg:w-80 lg:border-t-0 lg:border-l">
        <SummaryOverview
          ref={summaryRef}
          start={start}
          end={end}
          services={services.filter((service) => selectedServices.includes(service.id))}
          staff={summaryStaff}
          resources={summaryResources}
          repeatEnabled={repeatEnabled}
          repeatFrequency={repeatFrequency}
          repeatCount={repeatCount}
          formatTimeLabel={formatTimeLabel}
        />
        {selectedCustomerId && (
          <CustomerSummary customers={customerOptions} selectedCustomerId={selectedCustomerId} locationSlug={locationSlug} />
        )}
      </aside>
    </div>
  );
}

function TimeBlockerForm({
  staffOptions,
  staffIds,
  onToggleStaff,
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
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
}: {
  staffOptions: StaffOption[];
  staffIds: string[];
  onToggleStaff: (id: string) => void;
  allStaff: boolean;
  setAllStaff: (value: boolean) => void;
  reason: TimeBlockerReason;
  setReason: (value: TimeBlockerReason) => void;
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
  toDateTimeLocalValue: (value: Date) => string;
  parseDateTimeLocalValue: (value: string) => Date;
}) {
  const selectableStaff = useMemo(
    () => staffOptions.filter((option) => option.id !== "unassigned"),
    [staffOptions],
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Gilt für</h4>
        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input
            type="checkbox"
            checked={allStaff}
            onChange={(event) => setAllStaff(event.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
          />
          Alle Mitarbeiter
        </label>
        {!allStaff && (
          <div className="flex flex-wrap gap-2">
            {selectableStaff.map((staff) => {
              const selected = staffIds.includes(staff.id);
              return (
                <button
                  key={staff.id}
                  type="button"
                  onClick={() => onToggleStaff(staff.id)}
                  className={`rounded-full border px-3 py-1 text-sm transition ${
                    selected ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                  }`}
                  disabled={busy}
                >
                  {staff.name}
                </button>
              );
            })}
            {selectableStaff.length === 0 && <p className="text-xs text-zinc-500">Keine Mitarbeitenden verfügbar.</p>}
          </div>
        )}
      </section>

      <section className="mt-6 space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Grund</h4>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value as TimeBlockerReason)}
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
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Start</label>
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(start)}
              onChange={(event) => setStart(parseDateTimeLocalValue(event.target.value))}
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              disabled={busy || allDay}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Ende</label>
            <input
              type="datetime-local"
              value={toDateTimeLocalValue(end)}
              onChange={(event) => setEnd(parseDateTimeLocalValue(event.target.value))}
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              disabled={busy || allDay}
            />
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

      {error && <p className="mt-6 rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}
    </div>
  );
}

function DetailsTab({
  start,
  end,
  setStart,
  setEnd,
  staffOptions,
  selectedStaffIds,
  onToggleStaff,
  onClearStaff,
  services,
  selectedServices,
  toggleService,
  resources,
  selectedResources,
  setSelectedResources,
  repeatEnabled,
  setRepeatEnabled,
  repeatFrequency,
  setRepeatFrequency,
  repeatCount,
  setRepeatCount,
  totalDuration,
  toDateTimeLocalValue,
  parseDateTimeLocalValue,
}: {
  start: Date;
  end: Date;
  setStart: (date: Date) => void;
  setEnd: (date: Date) => void;
  staffOptions: StaffOption[];
  selectedStaffIds: string[];
  onToggleStaff: (id: string) => void;
  onClearStaff: () => void;
  services: ServiceOption[];
  selectedServices: string[];
  toggleService: (id: string) => void;
  resources: ResourceOption[];
  selectedResources: string[];
  setSelectedResources: (ids: string[]) => void;
  repeatEnabled: boolean;
  setRepeatEnabled: (value: boolean) => void;
  repeatFrequency: "DAILY" | "WEEKLY";
  setRepeatFrequency: (value: "DAILY" | "WEEKLY") => void;
  repeatCount: number;
  setRepeatCount: (value: number) => void;
  totalDuration: number;
  toDateTimeLocalValue: (value: Date) => string;
  parseDateTimeLocalValue: (value: string) => Date;
}) {
  const selectableStaff = useMemo(
    () => staffOptions.filter((option) => option.id !== "unassigned"),
    [staffOptions],
  );

  const [startDateValue, startTimeValue] = useMemo(() => {
    const local = toDateTimeLocalValue(start);
    const [datePart = "", timePart = "00:00"] = local.split("T");
    return [datePart, timePart];
  }, [start, toDateTimeLocalValue]);

  const [endDateValue, endTimeValue] = useMemo(() => {
    const local = toDateTimeLocalValue(end);
    const [datePart = "", timePart = "00:00"] = local.split("T");
    return [datePart, timePart];
  }, [end, toDateTimeLocalValue]);

  const ensureDuration = useCallback(
    (baseStart: Date, proposedEnd: Date) => {
      if (proposedEnd.getTime() > baseStart.getTime()) {
        return proposedEnd;
      }

      const durationMinutes = Math.max(
        5,
        Math.abs(differenceInMinutes(end, start)) || 30,
      );
      return addMinutes(baseStart, durationMinutes);
    },
    [end, start],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Leistungen</h4>
        <div className="grid gap-3 md:grid-cols-2">
          {services.map((service) => {
            const selected = selectedServices.includes(service.id);
            return (
              <button
                key={service.id}
                type="button"
                onClick={() => toggleService(service.id)}
                className={`flex flex-col rounded-xl border px-4 py-3 text-left shadow-sm transition ${
                  selected ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 hover:border-zinc-400"
                }`}
              >
                <span className="text-sm font-semibold">{service.name}</span>
                <span className="text-xs">
                  {service.duration} Min ·{" "}
                  {new Intl.NumberFormat("de-DE", { style: "currency", currency: service.currency }).format(service.basePrice)}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-zinc-500">
          Dauer gesamt: <span className="font-semibold text-zinc-700">{totalDuration} Minuten</span>
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Mitarbeiter:innen</label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onClearStaff}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                selectedStaffIds.length === 0
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
              }`}
            >
              Nicht zugewiesen
            </button>
            {selectableStaff.map((staff) => {
              const selected = selectedStaffIds.includes(staff.id);
              return (
                <button
                  key={staff.id}
                  type="button"
                  onClick={() => onToggleStaff(staff.id)}
                  className={`rounded-full border px-3 py-1 text-sm transition ${
                    selected
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {staff.name}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Ressourcen</label>
          <select
            multiple
            value={selectedResources}
            onChange={(event) => {
              const values = Array.from(event.target.selectedOptions).map((option) => option.value);
              setSelectedResources(values);
            }}
            className="mt-2 h-24 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          >
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} · {resource.type}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Zeiten</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Start</label>
            <div className="mt-2 flex gap-2">
              <input
                type="date"
                value={startDateValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const updated = parseDateTimeLocalValue(`${value}T${startTimeValue}`);
                  const durationAdjusted = ensureDuration(updated, end);
                  setStart(updated);
                  if (durationAdjusted !== end) {
                    setEnd(durationAdjusted);
                  }
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
              <input
                type="time"
                step={300}
                value={startTimeValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const updated = parseDateTimeLocalValue(`${startDateValue}T${value}`);
                  const durationAdjusted = ensureDuration(updated, end);
                  setStart(updated);
                  if (durationAdjusted !== end) {
                    setEnd(durationAdjusted);
                  }
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Ende</label>
            <div className="mt-2 flex gap-2">
              <input
                type="date"
                value={endDateValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const updated = parseDateTimeLocalValue(`${value}T${endTimeValue}`);
                  const adjusted = updated.getTime() <= start.getTime() ? ensureDuration(start, updated) : updated;
                  setEnd(adjusted);
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
              <input
                type="time"
                step={300}
                value={endTimeValue}
                onChange={(event) => {
                  const value = event.target.value;
                  if (!value) return;
                  const updated = parseDateTimeLocalValue(`${endDateValue}T${value}`);
                  const adjusted = updated.getTime() <= start.getTime() ? ensureDuration(start, updated) : updated;
                  setEnd(adjusted);
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              />
            </div>
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3">
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={repeatEnabled}
              onChange={(event) => setRepeatEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
            />
            Termin wiederholen
          </label>
          {repeatEnabled && (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Rhythmus</label>
                <select
                  value={repeatFrequency}
                  onChange={(event) => setRepeatFrequency(event.target.value as "DAILY" | "WEEKLY")}
                  className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
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
                  className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                />
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CustomerTab({
  customerQuery,
  setCustomerQuery,
  filteredCustomers,
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
}: {
  customerQuery: string;
  setCustomerQuery: (value: string) => void;
  filteredCustomers: CustomerOption[];
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
}) {
  const linkLabel = selectedCustomerId ? "Details anzeigen" : "Kunden anlegen";
  const linkHref = selectedCustomerId
    ? `/backoffice/${locationSlug}/customers?customer=${selectedCustomerId}`
    : `/backoffice/${locationSlug}/customers/new?source=calendar-composer`;
  const emailSmsConsentMissing = !customerConsents.email || !customerConsents.sms;
  const whatsappConsentMissing = !customerConsents.whatsapp;
  const singleChannelOnly = manualConfirmationMode === "single";
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

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Kunde auswählen</h4>
        <input
          type="text"
          value={customerQuery}
          onChange={(event) => setCustomerQuery(event.target.value)}
          placeholder="Suche nach Namen, E-Mail oder Telefonnummer"
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
        />
        <div className="max-h-48 overflow-y-auto rounded-md border border-zinc-200">
          {filteredCustomers.length === 0 ? (
            <p className="px-3 py-2 text-xs text-zinc-500">
              Keine Treffer. Über „Kunden anlegen“ kannst du einen neuen Kunden erstellen.
            </p>
          ) : (
            filteredCustomers.map((customer) => {
              const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.replace(/\s+/g, " ").trim() || "Unbekannt";
              const selected = selectedCustomerId === customer.id;
              const contactParts = [customer.phone, customer.email].filter(Boolean);
              const contact = contactParts.length ? contactParts.join(" · ") : "Keine Kontaktdaten";
              return (
                <button
                  key={customer.id}
                  type="button"
                  onClick={() => {
                    setSelectedCustomerId(customer.id);
                    setCustomerQuery(name);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition ${
                    selected ? "bg-zinc-900 text-white" : "hover:bg-zinc-100"
                  }`}
                >
                  <span>
                    {name}
                    <span className={`block text-xs ${selected ? "text-white/80" : "text-zinc-400"}`}>{contact}</span>
                  </span>
                  {selected && <span className="text-xs font-semibold uppercase tracking-widest">Ausgewählt</span>}
                </button>
              );
            })
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <a
            href={linkHref}
            className="font-semibold text-zinc-600 underline underline-offset-4"
            target="_blank"
            rel="noreferrer"
          >
            {linkLabel}
          </a>
          {selectedCustomerId && (
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
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Benachrichtigung</h4>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className={`text-sm font-medium ${emailSmsActive ? "text-zinc-900" : "text-zinc-500"}`}>
              Kunde per E-Mail/SMS informieren
            </p>
            {selectedCustomerId && emailSmsHint && <p className="text-xs text-rose-500">{emailSmsHint}</p>}
          </div>
          <button
            type="button"
            className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
              emailSmsActive ? "bg-emerald-500" : "bg-zinc-300"
            } ${!selectedCustomerId ? "cursor-not-allowed opacity-60" : ""}`}
            onClick={() => {
              if (!selectedCustomerId) return;
              const nextValue = !emailSmsActive;
              setSendEmail(nextValue);
              setSendSms(nextValue);
              if (singleChannelOnly && nextValue) {
                setSendWhatsApp(false);
              }
            }}
            aria-pressed={emailSmsActive}
            disabled={!selectedCustomerId}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                emailSmsActive ? "translate-x-[1.6rem]" : "translate-x-1"
              }`}
            />
          </button>
        </div>
        <div className="mt-2 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className={`text-sm font-medium ${sendWhatsApp ? "text-zinc-900" : "text-zinc-500"}`}>
                Kunde per WhatsApp informieren
              </p>
              {selectedCustomerId && whatsappHint && <p className="text-xs text-rose-500">{whatsappHint}</p>}
            </div>
            <button
              type="button"
              className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
                sendWhatsApp ? "bg-emerald-500" : "bg-zinc-300"
              } ${!selectedCustomerId ? "cursor-not-allowed opacity-60" : ""}`}
              onClick={() => {
                if (!selectedCustomerId) return;
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
              disabled={!selectedCustomerId}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  sendWhatsApp ? "translate-x-[1.6rem]" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <label className={`flex items-start gap-2 text-sm ${selectedCustomerId ? "text-zinc-700" : "text-zinc-400"}`}>
            <input
              type="checkbox"
              checked={whatsAppOptIn}
              onChange={(event) => {
                const nextValue = event.target.checked;
                setWhatsAppOptIn(nextValue);
                if (!nextValue) {
                  setSendWhatsApp(false);
                }
              }}
              disabled={!selectedCustomerId}
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 disabled:border-zinc-200 disabled:bg-zinc-100"
            />
            <span>
              <span className="font-medium text-zinc-900">hat Kunde explizit zugestimmt</span>
            </span>
          </label>
        </div>
        {!selectedCustomerId && (
          <p className="text-xs text-zinc-500">
            Wähle einen Kunden aus, um Benachrichtigungen zu versenden.
          </p>
        )}
      </section>
    </div>
  );
}

function NotesTab({
  note,
  setNote,
  internalNote,
  setInternalNote,
  attachments,
  onAttachmentsChange,
}: {
  note: string;
  setNote: (value: string) => void;
  internalNote: string;
  setInternalNote: (value: string) => void;
  attachments: File[];
  onAttachmentsChange: (files: FileList | null) => void;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Hinweis für Kunden</h4>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Diese Nachricht wird mit der Terminbestätigung gesendet"
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          rows={4}
        />
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Interne Notiz</h4>
        <textarea
          value={internalNote}
          onChange={(event) => setInternalNote(event.target.value)}
          placeholder="Nur für dein Team sichtbar"
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          rows={4}
        />
      </section>

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-zinc-900">Anhänge</h4>
        <input
          type="file"
          multiple
          accept=".jpg,.jpeg,.png,.pdf"
          onChange={(event) => onAttachmentsChange(event.target.files)}
          className="text-sm text-zinc-600"
        />
        {attachments.length > 0 && (
          <ul className="space-y-1 text-xs text-zinc-600">
            {attachments.map((file) => (
              <li key={file.name}>
                {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-zinc-500">Bis zu 5 Dateien (JPG, PNG oder PDF) mit maximal 5 MB pro Datei.</p>
      </section>
    </div>
  );
}

function CustomerSummary({
  customers,
  selectedCustomerId,
  locationSlug,
}: {
  customers: CustomerOption[];
  selectedCustomerId?: string;
  locationSlug: string;
}) {
  if (!selectedCustomerId) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-500">
        Kein Kunde ausgewählt.
      </div>
    );
  }

  const customer = customers.find((entry) => entry.id === selectedCustomerId);
  if (!customer) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        Kunde wird geladen …
      </div>
    );
  }

  const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.replace(/\s+/g, " ").trim() || "Kunde";
  const lastSeen = customer.lastAppointment
    ? formatDistanceToNow(new Date(customer.lastAppointment), { addSuffix: true, locale: undefined })
    : null;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-200 bg-white px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-zinc-900">{name}</p>
        <p className="text-xs text-zinc-500">E-Mail: {customer.email || "–"}</p>
        <p className="text-xs text-zinc-500">Telefon: {customer.phone || "–"}</p>
      </div>
      <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
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

type SummaryOverviewProps = {
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

const SummaryOverview = forwardRef<HTMLDivElement, SummaryOverviewProps>(function SummaryOverview(
  { start, end, services, staff, resources, repeatEnabled, repeatFrequency, repeatCount, formatTimeLabel },
  ref,
) {
  const totalAmount = services.reduce((sum, service) => sum + service.basePrice, 0);
  return (
    <div
      id="composer-summary-overview"
      tabIndex={-1}
      ref={ref}
      className="space-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs text-zinc-600 focus:outline-none"
    >
      <p>
        <span className="font-semibold text-zinc-900">Dauer:</span> {formatTimeLabel(start)} – {formatTimeLabel(end)}
      </p>
      <p>
        <span className="font-semibold text-zinc-900">Leistungen:</span> {services.map((service) => service.name).join(", ") || "–"}
      </p>
      <p>
        <span className="font-semibold text-zinc-900">Preis:</span> {new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(totalAmount)}
      </p>
      <p>
        <span className="font-semibold text-zinc-900">Mitarbeiter:innen:</span> {staff.length ? staff.map((item) => item.name).join(", ") : "Nicht zugewiesen"}
      </p>
      <p>
        <span className="font-semibold text-zinc-900">Ressourcen:</span> {resources.length ? resources.map((resource) => resource.name).join(", ") : "–"}
      </p>
      {repeatEnabled ? (
        <p>
          <span className="font-semibold text-zinc-900">Wiederholung:</span> Alle {repeatCount}{" "}
          {repeatFrequency === "DAILY" ? "Tage" : "Wochen"} · bis Jahresende
        </p>
      ) : (
        <p className="pointer-events-none select-none">
          <span className="font-semibold text-zinc-900">Wiederholung:</span> Keine
        </p>
      )}
    </div>
  );
});
