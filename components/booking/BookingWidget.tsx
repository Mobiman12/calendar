"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, format, isSameDay, startOfDay } from "date-fns";

type ServiceOption = {
  id: string;
  name: string;
  description?: string | null;
  duration: number;
  price: number;
  currency: string;
};

type StaffOption = {
  id: string;
  name: string;
  color?: string;
};

type PolicySummary = {
  cancellation: {
    windowHours: number;
    deadline?: string | null;
    penalty: {
      kind: string;
      value: number;
    };
  } | null;
  deposit: {
    thresholdAmount?: number;
    percentage?: number;
    flatAmount?: number;
  } | null;
  noShow: {
    graceMinutes: number;
    charge: {
      kind: string;
      value: number;
    };
  } | null;
};

type SlotOption = {
  slotKey: string;
  start: string;
  end: string;
  staffId?: string;
  serviceId?: string;
  isSmart?: boolean;
};

type CustomerFormState = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
  termsAccepted: boolean;
  marketingOptIn: boolean;
};

interface BookingWidgetProps {
  location: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
  };
  services: ServiceOption[];
  staff: StaffOption[];
  policies: PolicySummary;
  tenantSlug?: string;
}

const STEP_CONFIG = [
  { id: "service", title: "Dienstleistung wählen" },
  { id: "staff", title: "Mitarbeiter wählen" },
  { id: "slot", title: "Terminzeit wählen" },
  { id: "details", title: "Kontaktdaten & Bestätigung" },
];

export function BookingWidget({ location, services, staff, policies, tenantSlug }: BookingWidgetProps) {
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(services[0]?.id ?? null);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [referenceDate, setReferenceDate] = useState(() => startOfDay(new Date()));
  const [selectedDayIso, setSelectedDayIso] = useState(() => startOfDay(new Date()).toISOString());
  const [slotGroups, setSlotGroups] = useState<Array<{ dateIso: string; slots: SlotOption[] }>>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<SlotOption | null>(null);
  const [customerDetails, setCustomerDetails] = useState<CustomerFormState>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    notes: "",
    termsAccepted: false,
    marketingOptIn: false,
  });

  const activeStep = STEP_CONFIG[activeStepIndex];

  const nextStep = () => {
    setActiveStepIndex((index) => Math.min(index + 1, STEP_CONFIG.length - 1));
  };

  const previousStep = () => {
    setActiveStepIndex((index) => Math.max(index - 1, 0));
  };

  const selectedService = services.find((service) => service.id === selectedServiceId) ?? null;
  const filteredStaff = useMemo(() => staff, [staff]);
  const currentStaffMember = selectedStaffId ? staff.find((member) => member.id === selectedStaffId) ?? null : null;
  const selectedDayGroup = slotGroups.find((group) => group.dateIso === selectedDayIso) ?? null;
  const isFinalStep = activeStepIndex === STEP_CONFIG.length - 1;
  const isDetailsValid = Boolean(
    customerDetails.firstName.trim() &&
      customerDetails.lastName.trim() &&
      customerDetails.email.trim() &&
      customerDetails.termsAccepted &&
      selectedSlot,
  );

  const primaryButtonLabel = isFinalStep ? "Buchung abschließen" : "Weiter";
  const primaryDisabled =
    (activeStep.id === "service" && !selectedServiceId) ||
    (activeStep.id === "staff" && filteredStaff.length > 0 && selectedStaffId === null) ||
    (activeStep.id === "slot" && !selectedSlot) ||
    (activeStep.id === "details" && !isDetailsValid);

  const handlePrimaryAction = () => {
    if (activeStep.id === "details") {
      if (!isDetailsValid) return;
      if (typeof window !== "undefined") {
        window.alert("Die finale Buchungsbestätigung folgt im nächsten Schritt.");
      }
      return;
    }
    if (primaryDisabled) return;
    nextStep();
  };



  const loadSlots = useCallback(
    async (baseDate: Date) => {
      if (!selectedServiceId) {
        setSlotGroups([]);
        setSelectedSlot(null);
        return;
      }

      setSlotsLoading(true);
      setSlotsError(null);
      const from = startOfDay(baseDate);
      const to = addDays(from, 6);
      const params = new URLSearchParams();
      params.set("from", from.toISOString());
      params.set("to", to.toISOString());
      params.append("service", selectedServiceId);
      if (selectedStaffId) {
        params.set("staffId", selectedStaffId);
      }

      try {
        const basePath = tenantSlug ? `/book/${tenantSlug}/${location.slug}` : `/book/${location.slug}`;
        const response = await fetch(`${basePath}/availability?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Wir konnten die freien Slots gerade nicht laden.");
        }
        const payload = await response.json();
        const data = Array.isArray(payload.data) ? payload.data : [];

        const map = new Map<string, SlotOption[]>();
        for (const slot of data) {
          const dayIso = startOfDay(new Date(slot.start)).toISOString();
          if (!map.has(dayIso)) {
            map.set(dayIso, []);
          }
          map.get(dayIso)!.push({
            slotKey: slot.slotKey,
            start: slot.start,
            end: slot.end,
            staffId: slot.staffId,
            serviceId: slot.services?.[0]?.serviceId,
          });
        }

        const groups = Array.from(map.entries())
          .map(([dateIso, slots]) => ({
            dateIso,
            slots: slots.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()),
          }))
          .sort((a, b) => new Date(a.dateIso).getTime() - new Date(b.dateIso).getTime());

        setSlotGroups(groups);
        setSelectedSlot((current) => (current && map.get(startOfDay(new Date(current.start)).toISOString()) ? current : null));
        setSelectedDayIso((current) => {
          if (!groups.length) {
            return from.toISOString();
          }
          if (current && groups.some((group) => group.dateIso === current)) {
            return current;
          }
          return groups[0].dateIso;
        });
      } catch (error) {
        console.error(error);
        setSlotsError(error instanceof Error ? error.message : "Unbekannter Fehler beim Laden der Slots.");
        setSlotGroups([]);
        setSelectedSlot(null);
      } finally {
        setSlotsLoading(false);
      }
    },
    [location.slug, selectedServiceId, selectedStaffId],
  );

  const handlePrevWeek = () => {
    const newDate = addDays(referenceDate, -7);
    setReferenceDate(newDate);
    setSelectedDayIso(startOfDay(newDate).toISOString());
  };

  const handleNextWeek = () => {
    const newDate = addDays(referenceDate, 7);
    setReferenceDate(newDate);
    setSelectedDayIso(startOfDay(newDate).toISOString());
  };

  const stepIndicator = useMemo(
    () =>
      STEP_CONFIG.map((step, index) => ({
        ...step,
        status: index === activeStepIndex ? "current" : index < activeStepIndex ? "done" : "upcoming",
      })),
    [activeStepIndex],
  );

  useEffect(() => {
    if (activeStep.id === "slot") {
      loadSlots(referenceDate);
    }
  }, [activeStep.id, referenceDate, loadSlots]);

  useEffect(() => {
    setReferenceDate(startOfDay(new Date()));
    setSelectedDayIso(startOfDay(new Date()).toISOString());
    setSelectedSlot(null);
    setSlotGroups([]);
  }, [selectedServiceId, selectedStaffId]);

  return (
    <div className="relative flex min-h-[70vh] flex-col rounded-3xl border border-zinc-200 bg-white shadow-xl lg:flex-row">
      <aside className="flex-1 border-b border-zinc-200 px-6 py-6 lg:flex-initial lg:w-72 lg:border-b-0 lg:border-r">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-widest text-zinc-400">Dein Termin bei</p>
            <h2 className="text-xl font-semibold text-zinc-900">{location.name}</h2>
            <p className="text-xs text-zinc-500">Zeitzone: {location.timezone}</p>
          </div>
          <ol className="space-y-2">
            {stepIndicator.map((step) => (
              <li
                key={step.id}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${
                  step.status === "current"
                    ? "bg-zinc-900 text-white"
                    : step.status === "done"
                      ? "bg-zinc-100 text-zinc-700"
                      : "text-zinc-500"
                }`}
              >
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs ${
                    step.status === "current"
                      ? "border-white bg-white text-zinc-900"
                      : step.status === "done"
                        ? "border-zinc-500 bg-white text-zinc-600"
                        : "border-zinc-300"
                  }`}
                >
                  {STEP_CONFIG.findIndex((config) => config.id === step.id) + 1}
                </span>
                <span>{step.title}</span>
              </li>
            ))}
          </ol>
        <div className="rounded-xl bg-zinc-50 px-4 py-3 text-xs text-zinc-600">
          <p className="font-semibold text-zinc-900">Stornoregeln</p>
            {policies.cancellation ? (
              <p>
                Kostenfreie Stornierung bis {policies.cancellation.windowHours}h vorher, danach{" "}
                {policies.cancellation.penalty.kind === "percentage"
                  ? `${policies.cancellation.penalty.value}%`
                  : `${policies.cancellation.penalty.value} €`}
                .
              </p>
            ) : (
              <p>Keine besonderen Stornoregeln hinterlegt.</p>
            )}
            {policies.deposit && (
              <p className="mt-2">
                Anzahlung:{" "}
                {policies.deposit.percentage
                  ? `${policies.deposit.percentage}%`
                  : policies.deposit.flatAmount
                    ? `${policies.deposit.flatAmount} €`
                    : "erforderlich"}
              </p>
            )}
            {policies.noShow && (
              <p className="mt-2">
                No-Show Fee nach {policies.noShow.graceMinutes} Minuten Verspätung:{" "}
                {policies.noShow.charge.kind === "percentage"
                  ? `${policies.noShow.charge.value}%`
                  : `${policies.noShow.charge.value} €`}
              </p>
            )}
          </div>
        </div>
      </aside>

      <section className="flex-1 px-6 py-8 lg:px-10">
        <header className="mb-6 space-y-2">
          <p className="text-xs uppercase tracking-widest text-zinc-500">Schritt {activeStepIndex + 1} von {STEP_CONFIG.length}</p>
          <h3 className="text-2xl font-semibold text-zinc-900">{activeStep.title}</h3>
        </header>

        <div className="min-h-[320px] rounded-2xl border border-zinc-200 bg-white px-6 py-6 shadow-inner">
          {activeStep.id === "service" && (
            <ServiceStep
              services={services}
              selectedServiceId={selectedServiceId}
              onSelect={(id) => {
                setSelectedServiceId(id);
                setSelectedStaffId(null);
              }}
            />
          )}
          {activeStep.id === "staff" && (
            <StaffStep
              staff={filteredStaff}
              selectedStaffId={selectedStaffId}
              selectedService={selectedService}
              onSelect={setSelectedStaffId}
            />
          )}
          {activeStep.id === "slot" && (
            <SlotStep
              referenceDate={referenceDate}
              slotGroups={slotGroups}
              selectedDayIso={selectedDayIso}
              onSelectDay={setSelectedDayIso}
              onPrevWeek={handlePrevWeek}
              onNextWeek={handleNextWeek}
              selectedSlot={selectedSlot}
              onSelectSlot={setSelectedSlot}
              loading={slotsLoading}
              error={slotsError}
              timezone={location.timezone}
            />
          )}
          {activeStep.id === "details" && (
            <DetailsStep
              service={selectedService}
              staffMember={currentStaffMember}
              slot={selectedSlot}
              customer={customerDetails}
              onUpdate={(changes) => setCustomerDetails((prev) => ({ ...prev, ...changes }))}
            />
          )}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={previousStep}
            disabled={activeStepIndex === 0}
            className="rounded-full border border-zinc-300 px-5 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:border-zinc-200 disabled:text-zinc-400"
          >
            Zurück
          </button>
          <button
            type="button"
            onClick={() => {
              if (activeStep.id === "service" && !selectedServiceId) return;
              if (activeStep.id === "staff" && filteredStaff.length && selectedStaffId === null) return;
              nextStep();
            }}
            disabled={
              activeStepIndex === STEP_CONFIG.length - 1 ||
              (activeStep.id === "service" && !selectedServiceId) ||
              (activeStep.id === "staff" && filteredStaff.length > 0 && selectedStaffId === null)
            }
            className="rounded-full bg-zinc-900 px-6 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
          >
            Weiter
          </button>
        </div>
      </section>
    </div>
  );
}

function PlaceholderStep({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-3 text-sm text-zinc-600">
      <p className="text-base font-semibold text-zinc-800">{title}</p>
      <p>{description}</p>
    </div>
  );
}

function StaffStep({
  staff,
  selectedStaffId,
  selectedService,
  onSelect,
}: {
  staff: StaffOption[];
  selectedStaffId: string | null;
  selectedService: ServiceOption | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-600">
        {selectedService
          ? `Für ${selectedService.name} kannst du einen Wunschmitarbeiter wählen – oder lass uns automatisch zuweisen.`
          : "Bitte zunächst eine Dienstleistung wählen."}
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`rounded-2xl border px-4 py-3 text-left shadow-sm transition ${
            selectedStaffId === null ? "border-blue-600 bg-blue-50 text-blue-900" : "border-zinc-200 hover:border-zinc-400"
          }`}
        >
          <p className="text-sm font-semibold">Beliebig</p>
          <p className="text-xs text-zinc-500">Schnellster freier Slot mit passendem Team.</p>
        </button>
        {staff.map((member) => {
          const selected = selectedStaffId === member.id;
          return (
            <button
              key={member.id}
              type="button"
              onClick={() => onSelect(member.id)}
              className={`rounded-2xl border px-4 py-3 text-left shadow-sm transition ${
                selected ? "border-blue-600 bg-blue-50 text-blue-900" : "border-zinc-200 hover:border-zinc-400"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: member.color ?? "#2563eb" }} />
                <p className="text-sm font-semibold">{member.name}</p>
              </div>
              <p className="mt-1 text-xs text-zinc-500">Experte für deine ausgewählte Dienstleistung.</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ServiceStep({
  services,
  selectedServiceId,
  onSelect,
}: {
  services: ServiceOption[];
  selectedServiceId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {services.map((service) => {
          const selected = selectedServiceId === service.id;
          return (
            <button
              key={service.id}
              type="button"
              onClick={() => onSelect(service.id)}
              className={`flex flex-col gap-2 rounded-2xl border px-5 py-4 text-left shadow-sm transition ${
                selected ? "border-blue-600 bg-blue-50 text-blue-900" : "border-zinc-200 hover:border-zinc-400"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-base font-semibold">{service.name}</p>
                  {service.description && <p className="text-xs text-zinc-500">{service.description}</p>}
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-blue-700">{formatDuration(service.duration)}</span>
              </div>
              <p className="text-sm text-zinc-600">{formatPrice(service.price, service.currency)}</p>
            </button>
          );
        })}
      </div>
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-500">
        <p>
          Tipp: Du kannst mehrere Leistungen kombinieren. Die Gesamtzeit berechnet sich automatisch über die Dauer der einzelnen Services.
        </p>
      </div>
    </div>
  );
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} Std`;
  return `${hours} Std ${rest} Min`;
}

function formatPrice(value: number, currency: string) {
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function SlotStep({
  referenceDate,
  slotGroups,
  selectedDayIso,
  onSelectDay,
  onPrevWeek,
  onNextWeek,
  selectedSlot,
  onSelectSlot,
  loading,
  error,
  timezone,
}: {
  referenceDate: Date;
  slotGroups: Array<{ dateIso: string; slots: SlotOption[] }>;
  selectedDayIso: string;
  onSelectDay: (iso: string) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  selectedSlot: SlotOption | null;
  onSelectSlot: (slot: SlotOption) => void;
  loading: boolean;
  error: string | null;
  timezone: string;
}) {
  const selectedGroup = slotGroups.find((group) => group.dateIso === selectedDayIso) ?? null;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrevWeek}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100"
          >
            ← Woche zurück
          </button>
          <button
            type="button"
            onClick={() => onSelectDay(startOfDay(new Date()).toISOString())}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100"
          >
            Heute
          </button>
          <button
            type="button"
            onClick={onNextWeek}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100"
          >
            Woche vor →
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          Zeitraum {format(referenceDate, "dd.MM.")} – {format(addDays(referenceDate, 6), "dd.MM.yyyy")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {slotGroups.map((group) => {
          const date = new Date(group.dateIso);
          const active = group.dateIso === selectedDayIso;
          return (
            <button
              key={group.dateIso}
              type="button"
              onClick={() => onSelectDay(group.dateIso)}
              className={`rounded-full px-3 py-1 text-sm transition ${
                active ? "bg-zinc-900 text-white" : "border border-zinc-200 text-zinc-600 hover:border-zinc-400"
              }`}
            >
              {format(date, "eee, dd.MM.")}
            </button>
          );
        })}
        {!slotGroups.length && <p className="text-xs text-zinc-500">Keine freien Tage im gewählten Zeitraum.</p>}
      </div>

      {loading ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-10 text-center text-sm text-zinc-500">
          Lade freie Termine …
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-700">
          {error}
        </div>
      ) : selectedGroup && selectedGroup.slots.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {selectedGroup.slots.map((slot) => {
            const startDate = new Date(slot.start);
            const endDate = new Date(slot.end);
            const isSelected = selectedSlot?.slotKey === slot.slotKey;
            return (
              <button
                key={slot.slotKey}
                type="button"
                onClick={() => onSelectSlot(slot)}
                className={`rounded-2xl border px-4 py-3 text-left shadow-sm transition ${
                  isSelected ? "border-blue-600 bg-blue-50 text-blue-900" : "border-zinc-200 hover:border-zinc-400"
                }`}
              >
                <p className="text-sm font-semibold">{format(startDate, "HH:mm")} – {format(endDate, "HH:mm")}</p>
                <p className="text-xs text-zinc-500">{format(startDate, "eeee, dd.MM.")}</p>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-10 text-center text-sm text-zinc-500">
          Keine freien Slots für den ausgewählten Tag. Bitte andere Zeit oder Woche wählen.
        </div>
      )}
    </div>
  );
}

function DetailsStep({
  service,
  staffMember,
  slot,
  customer,
  onUpdate,
}: {
  service: ServiceOption | null;
  staffMember: StaffOption | null;
  slot: SlotOption | null;
  customer: CustomerFormState;
  onUpdate: (changes: Partial<CustomerFormState>) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-2xl border border-zinc-200 bg-zinc-50 px-5 py-4 text-sm text-zinc-600">
        <p className="text-base font-semibold text-zinc-800">Zusammenfassung</p>
        <p>
          <span className="font-semibold text-zinc-900">Service:</span> {service ? service.name : "Bitte zurück und Leistung wählen"}
        </p>
        <p>
          <span className="font-semibold text-zinc-900">Team:</span> {staffMember ? staffMember.name : "Beliebig"}
        </p>
        <p>
          <span className="font-semibold text-zinc-900">Termin:</span>{" "}
          {slot ? `${format(new Date(slot.start), "eeee, dd.MM.yyyy HH:mm")} – ${format(new Date(slot.end), "HH:mm")}` : "Noch kein Slot gewählt"}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Vorname *</label>
          <input
            type="text"
            value={customer.firstName}
            onChange={(event) => onUpdate({ firstName: event.target.value })}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Nachname *</label>
          <input
            type="text"
            value={customer.lastName}
            onChange={(event) => onUpdate({ lastName: event.target.value })}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">E-Mail *</label>
          <input
            type="email"
            value={customer.email}
            onChange={(event) => onUpdate({ email: event.target.value })}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Telefon</label>
          <input
            type="tel"
            value={customer.phone}
            onChange={(event) => onUpdate({ phone: event.target.value })}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Anmerkung (optional)</label>
        <textarea
          value={customer.notes}
          onChange={(event) => onUpdate({ notes: event.target.value })}
          className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          rows={4}
          placeholder="Informationen für das Team"
        />
      </div>

      <div className="space-y-2 text-xs text-zinc-600">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={customer.termsAccepted}
            onChange={(event) => onUpdate({ termsAccepted: event.target.checked })}
            className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
          />
          <span>
            Ich akzeptiere die Buchungsbedingungen und Datenschutzbestimmungen. Diese Information wird in der nächsten Ausbaustufe verlinkt.
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={customer.marketingOptIn}
            onChange={(event) => onUpdate({ marketingOptIn: event.target.checked })}
            className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
          />
          <span>Ich möchte Neuigkeiten und Angebote per E-Mail erhalten.</span>
        </label>
      </div>
    </div>
  );
}
