"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useToast } from "@/components/ui/ToastProvider";
import { SUPPORTED_TIMEZONES } from "@/lib/timezones";
import type { CancellationPolicy, DepositPolicy, NoShowPolicy } from "@/lib/policies/types";

const WEEKDAYS = [
  { label: "Montag", value: "MONDAY" },
  { label: "Dienstag", value: "TUESDAY" },
  { label: "Mittwoch", value: "WEDNESDAY" },
  { label: "Donnerstag", value: "THURSDAY" },
  { label: "Freitag", value: "FRIDAY" },
  { label: "Samstag", value: "SATURDAY" },
  { label: "Sonntag", value: "SUNDAY" },
] as const;

const DEFAULT_OPEN_START = 9 * 60;
const DEFAULT_OPEN_END = 18 * 60;

type ScheduleState = Record<string, { startsAt: number | null; endsAt: number | null }>;

type PolicyState = {
  cancellation: CancellationPolicy | null;
  deposit: DepositPolicy | null;
  noShow: NoShowPolicy | null;
};

type ScheduleRuleInput = {
  weekday: string;
  startsAt: number | null;
  endsAt: number | null;
};

type ServiceSummary = {
  id: string;
  name: string;
  duration: number;
  price: number;
  currency: string;
};

interface LocationSettingsPanelProps {
  location: {
    slug: string;
    name: string;
    addressLine1: string;
    city: string;
    timezone: string;
  };
  policies: PolicyState;
  schedule: ScheduleRuleInput[];
  services: ServiceSummary[];
}

export function LocationSettingsPanel({ location, policies, schedule, services }: LocationSettingsPanelProps) {
  const router = useRouter();
  const { pushToast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [locationForm, setLocationForm] = useState(() => ({
    name: location.name,
    addressLine1: location.addressLine1,
    city: location.city,
    timezone: location.timezone,
  }));

  const timezoneOptions = useMemo(() => {
    const options = new Set<string>(SUPPORTED_TIMEZONES);
    if (locationForm.timezone && !options.has(locationForm.timezone)) {
      options.add(locationForm.timezone);
    }
    return Array.from(options);
  }, [locationForm.timezone]);

  const [cancellationEnabled, setCancellationEnabled] = useState(Boolean(policies.cancellation));
  const [cancellationWindow, setCancellationWindow] = useState(policies.cancellation?.windowHours ?? 12);
  const [cancellationKind, setCancellationKind] = useState(policies.cancellation?.penalty.kind ?? "percentage");
  const [cancellationValue, setCancellationValue] = useState(policies.cancellation?.penalty.value ?? 50);

  const [noShowEnabled, setNoShowEnabled] = useState(Boolean(policies.noShow));
  const [noShowKind, setNoShowKind] = useState(policies.noShow?.charge.kind ?? "flat");
  const [noShowValue, setNoShowValue] = useState(policies.noShow?.charge.value ?? 25);
  const [noShowGraceMinutes, setNoShowGraceMinutes] = useState(policies.noShow?.graceMinutes ?? 10);

  const [depositEnabled, setDepositEnabled] = useState(Boolean(policies.deposit));
  const [depositType, setDepositType] = useState<"percentage" | "flat">(
    policies.deposit?.percentage !== undefined ? "percentage" : "flat",
  );
  const [depositValue, setDepositValue] = useState(policies.deposit?.percentage ?? policies.deposit?.flatAmount ?? 30);
  const [depositThreshold, setDepositThreshold] = useState(policies.deposit?.thresholdAmount ?? 0);

  const initialScheduleState = useMemo(() => {
    const base: ScheduleState = {};
    WEEKDAYS.forEach((day) => {
      const rule = schedule.find((entry) => entry.weekday === day.value);
      base[day.value] = {
        startsAt: rule?.startsAt ?? null,
        endsAt: rule?.endsAt ?? null,
      };
    });
    return base;
  }, [schedule]);

  const [scheduleState, setScheduleState] = useState<ScheduleState>(initialScheduleState);

  const handleScheduleTimeChange = (weekday: string, field: "startsAt" | "endsAt", value: string) => {
    setScheduleState((prev) => {
      const current = prev[weekday] ?? { startsAt: null, endsAt: null };
      const minutes = value ? timeStringToMinutes(value) : null;
      return {
        ...prev,
        [weekday]: {
          ...current,
          [field]: minutes,
        },
      };
    });
  };

  const handleScheduleClosedToggle = (weekday: string, closed: boolean) => {
    setScheduleState((prev) => ({
      ...prev,
      [weekday]: closed
        ? { startsAt: null, endsAt: null }
        : { startsAt: DEFAULT_OPEN_START, endsAt: DEFAULT_OPEN_END },
    }));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving || isPending) return;

    try {
      const schedulePayload: ScheduleRuleInput[] = WEEKDAYS.map((day) => {
        const entry = scheduleState[day.value];
        const startsAt = entry?.startsAt ?? null;
        const endsAt = entry?.endsAt ?? null;
        if ((startsAt === null) !== (endsAt === null)) {
          throw new Error(`${day.label}: Bitte Start- und Endzeit angeben oder als geschlossen markieren.`);
        }
        if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
          throw new Error(`${day.label}: Endzeit muss nach der Startzeit liegen.`);
        }
        return {
          weekday: day.value,
          startsAt,
          endsAt,
        };
      });

      const payload = {
        location: {
          name: locationForm.name.trim(),
          addressLine1: locationForm.addressLine1.trim(),
          city: locationForm.city.trim(),
          timezone: locationForm.timezone,
        },
        policies: {
          cancellation: cancellationEnabled
            ? {
                windowHours: Number(cancellationWindow),
                penaltyKind: cancellationKind,
                penaltyValue: Number(cancellationValue),
              }
            : null,
          noShow: noShowEnabled
            ? {
                chargeKind: noShowKind,
                chargeValue: Number(noShowValue),
                graceMinutes: Number(noShowGraceMinutes),
              }
            : null,
          deposit: depositEnabled
            ? {
                type: depositType,
                value: Number(depositValue),
                thresholdAmount: depositThreshold ? Number(depositThreshold) : null,
              }
            : null,
        },
        schedule: schedulePayload,
      };

      setIsSaving(true);
      const response = await fetch(`/api/backoffice/${location.slug}/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Speichern fehlgeschlagen");
      }

      pushToast({ variant: "success", message: "Einstellungen gespeichert." });
      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speichern fehlgeschlagen";
      pushToast({ variant: "error", message });
    } finally {
      setIsSaving(false);
    }
  };

  const saving = isSaving || isPending;

  return (
    <div className="grid gap-8 lg:grid-cols-[2fr,1fr]">
      <form onSubmit={handleSubmit} className="space-y-8 rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-zinc-200">
        <section className="space-y-4">
          <h3 className="text-lg font-semibold text-white">Standortdaten</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Name</span>
              <input
                type="text"
                value={locationForm.name}
                onChange={(event) => setLocationForm((prev) => ({ ...prev, name: event.target.value }))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                required
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Zeitzone</span>
              <select
                value={locationForm.timezone}
                onChange={(event) => setLocationForm((prev) => ({ ...prev, timezone: event.target.value }))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              >
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 md:col-span-2">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Adresse</span>
              <input
                type="text"
                value={locationForm.addressLine1}
                onChange={(event) => setLocationForm((prev) => ({ ...prev, addressLine1: event.target.value }))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                placeholder="Straße & Hausnummer"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Stadt</span>
              <input
                type="text"
                value={locationForm.city}
                onChange={(event) => setLocationForm((prev) => ({ ...prev, city: event.target.value }))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
              />
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Stornierungsrichtlinie</h3>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={cancellationEnabled}
                onChange={(event) => setCancellationEnabled(event.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              Aktiv
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Fenster (Stunden)</span>
              <input
                type="number"
                min={1}
                max={168}
                value={cancellationWindow}
                onChange={(event) => setCancellationWindow(Number(event.target.value))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!cancellationEnabled}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Strafe</span>
              <select
                value={cancellationKind}
                onChange={(event) => setCancellationKind(event.target.value as "percentage" | "flat")}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!cancellationEnabled}
              >
                <option value="percentage">Prozent</option>
                <option value="flat">Fixbetrag (€)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Wert</span>
              <input
                type="number"
                min={0}
                max={cancellationKind === "percentage" ? 100 : 1000}
                value={cancellationValue}
                onChange={(event) => setCancellationValue(Number(event.target.value))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!cancellationEnabled}
              />
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">No-Show-Richtlinie</h3>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={noShowEnabled}
                onChange={(event) => setNoShowEnabled(event.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              Aktiv
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Kulanz (Minuten)</span>
              <input
                type="number"
                min={0}
                max={240}
                value={noShowGraceMinutes}
                onChange={(event) => setNoShowGraceMinutes(Number(event.target.value))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!noShowEnabled}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Gebühr</span>
              <select
                value={noShowKind}
                onChange={(event) => setNoShowKind(event.target.value as "percentage" | "flat")}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!noShowEnabled}
              >
                <option value="flat">Fixbetrag (€)</option>
                <option value="percentage">Prozent</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Wert</span>
              <input
                type="number"
                min={0}
                max={noShowKind === "percentage" ? 100 : 1000}
                value={noShowValue}
                onChange={(event) => setNoShowValue(Number(event.target.value))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!noShowEnabled}
              />
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">Anzahlung</h3>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={depositEnabled}
                onChange={(event) => setDepositEnabled(event.target.checked)}
                className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
              />
              Aktiv
            </label>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Typ</span>
              <select
                value={depositType}
                onChange={(event) => setDepositType(event.target.value as "percentage" | "flat")}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!depositEnabled}
              >
                <option value="percentage">Prozent</option>
                <option value="flat">Fixbetrag (€)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Wert</span>
              <input
                type="number"
                min={0}
                max={depositType === "percentage" ? 100 : 1000}
                value={depositValue}
                onChange={(event) => setDepositValue(Number(event.target.value))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!depositEnabled}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-widest text-zinc-500">Schwelle (€)</span>
              <input
                type="number"
                min={0}
                max={5000}
                value={depositThreshold}
                onChange={(event) => setDepositThreshold(Number(event.target.value))}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                disabled={!depositEnabled}
              />
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <h3 className="text-lg font-semibold text-white">Öffnungszeiten</h3>
          <div className="space-y-3">
            {WEEKDAYS.map((day) => {
              const entry = scheduleState[day.value];
              const closed = !entry || entry.startsAt === null || entry.endsAt === null;
              return (
                <div key={day.value} className="grid gap-3 rounded-xl border border-white/10 bg-black/30 p-4 md:grid-cols-[120px,1fr,1fr,auto] md:items-center">
                  <span className="text-sm font-medium text-white">{day.label}</span>
                  <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-zinc-500">
                    Start
                    <input
                      type="time"
                      value={minutesToTimeString(closed ? null : entry?.startsAt ?? null)}
                      onChange={(event) => handleScheduleTimeChange(day.value, "startsAt", event.target.value)}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                      disabled={closed}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs uppercase tracking-widest text-zinc-500">
                    Ende
                    <input
                      type="time"
                      value={minutesToTimeString(closed ? null : entry?.endsAt ?? null)}
                      onChange={(event) => handleScheduleTimeChange(day.value, "endsAt", event.target.value)}
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900"
                      disabled={closed}
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={closed}
                      onChange={(event) => handleScheduleClosedToggle(day.value, event.target.checked)}
                      className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                    />
                    Geschlossen
                  </label>
                </div>
              );
            })}
          </div>
        </section>

        <div className="flex justify-end">
          <button
            type="submit"
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
            disabled={saving}
          >
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </form>

      <aside className="space-y-4">
        <section className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-zinc-200">
          <h3 className="text-lg font-semibold text-white">Services</h3>
          <p className="text-xs text-zinc-500">Bearbeitungsdialoge folgen in einer späteren Iteration.</p>
          <ul className="mt-4 space-y-3">
            {services.map((service) => (
              <li key={service.id} className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-200">
                <div>
                  <p className="font-medium text-white">{service.name}</p>
                  <p className="text-zinc-400">
                    {service.duration} min · {formatPrice(service.price, service.currency)}
                  </p>
                </div>
                <button
                  type="button"
                  disabled
                  className="cursor-not-allowed rounded-full border border-zinc-600 px-3 py-1 text-[11px] uppercase tracking-widest text-zinc-500"
                >
                  Bald
                </button>
              </li>
            ))}
            {services.length === 0 && (
              <li className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-300">Noch keine aktiven Services.</li>
            )}
          </ul>
        </section>
      </aside>
    </div>
  );
}

function minutesToTimeString(value: number | null) {
  if (value === null || Number.isNaN(value)) {
    return "";
  }
  const hours = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function timeStringToMinutes(value: string): number | null {
  if (!value) return null;
  const [hours, minutes] = value.split(":");
  const parsed = Number(hours) * 60 + Number(minutes ?? "0");
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function formatPrice(value: number, currency: string) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(value);
}
