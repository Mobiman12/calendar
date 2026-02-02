"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useToast } from "@/components/ui/ToastProvider";

type CompanyLocation = {
  name: string;
  slug: string;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  timezone: string;
  bookingSchedule?: ScheduleEntry[];
  closures?: ClosureEntry[];
  absences?: AbsenceEntry[];
  staffOptions?: Array<{ id: string; name: string }>;
  profile?: CompanyProfile;
  shiftPlanEnabled?: boolean;
};

type SectionConfig = {
  id: string;
  title: string;
  description: string;
};

type ScheduleEntry = {
  weekday: string;
  label: string;
  isOpen: boolean;
  start: string;
  end: string;
};

type ClosureEntry = {
  id: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
};

type AbsenceEntry = {
  id: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  reason: string;
  staffId: string;
};

type CompanyProfile = {
  description: string;
  website: string;
  facebook: string;
  instagram: string;
  xProfile: string;
  newsletterText: string;
  imprint: string;
  customLegalText: boolean;
  terms: string;
  privacy: string;
  customName?: boolean;
  displayName?: string;
};

const NAV_SECTIONS: SectionConfig[] = [
  { id: "general", title: "Allgemeine Informationen", description: "Firmendaten, Anschrift und Kontakt" },
  { id: "booking", title: "Buchungszeiten", description: "Standard-Öffnungszeiten verwalten" },
  { id: "closures", title: "Schließtage und Abwesenheiten", description: "Geplante Auszeiten und Events" },
  { id: "profile", title: "Firmenprofil", description: "Logo, Farben und Kundenauftritt" },
  { id: "contract", title: "Vertrag", description: "Tarif & Abrechnung" },
  { id: "privacy", title: "Datenschutz & Sicherheit", description: "Richtlinien und Zugriffskontrolle" },
];

const WEEKDAYS = [
  { key: "MONDAY", label: "Montag" },
  { key: "TUESDAY", label: "Dienstag" },
  { key: "WEDNESDAY", label: "Mittwoch" },
  { key: "THURSDAY", label: "Donnerstag" },
  { key: "FRIDAY", label: "Freitag" },
  { key: "SATURDAY", label: "Samstag" },
  { key: "SUNDAY", label: "Sonntag" },
] as const;

export function CompanySettingsTabs({ location }: { location: CompanyLocation }) {
  const [activeSection, setActiveSection] = useState<string>(NAV_SECTIONS[0]?.id ?? "general");
  const renderContent = () => {
    switch (activeSection) {
      case "general":
        return <GeneralInfo location={location} />;
      case "booking":
        return <BookingTimesForm location={location} />;
      case "closures":
        return <ClosuresAbsencesPanel location={location} />;
      case "profile":
        return <CompanyProfileForm location={location} />;
      case "contract":
        return (
          <PlaceholderCard
            title="Vertrag"
            description="Tarif, Rechnungen und Ansprechpartner verwalten."
            buttonLabel="Abrechnung öffnen"
          />
        );
      case "privacy":
      default:
        return (
          <PlaceholderCard
            title="Datenschutz & Sicherheit"
            description="Zugriffskontrolle, AV-Verträge und Zwei-Faktor-Anmeldung verwalten."
            buttonLabel="Richtlinien prüfen"
          />
        );
    }
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <nav className="rounded-2xl border border-zinc-200 bg-white p-3 text-sm font-medium text-zinc-700 lg:w-64 lg:shrink-0">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">Bereiche</p>
        <div className="flex flex-col">
          {NAV_SECTIONS.map((section) => {
            const isActive = section.id === activeSection;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={`w-full rounded-xl px-4 py-3 text-left transition ${
                  isActive ? "bg-emerald-50 text-emerald-700 shadow-inner" : "hover:bg-zinc-50"
                }`}
              >
                <span className="block text-sm font-semibold">{section.title}</span>
                <span className="text-xs font-normal text-zinc-500">{section.description}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <div className="flex-1 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">{renderContent()}</div>
    </div>
  );
}

function GeneralInfo({ location }: { location: CompanyLocation }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: location.name ?? "",
    email: location.email ?? "",
    phone: location.phone ?? "",
    addressLine1: location.addressLine1 ?? "",
    addressLine2: location.addressLine2 ?? "",
    postalCode: location.postalCode ?? "",
    city: location.city ?? "",
    country: location.country ?? "Deutschland",
    timezone: location.timezone ?? "Europe/Berlin",
  });
  const [dirty, setDirty] = useState(false);
  const handleChange = (key: keyof typeof form, value: string) => {
    setForm((previous) => {
      if (previous[key] === value) {
        return previous;
      }
      setDirty(true);
      return { ...previous, [key]: value };
    });
  };
  const [saving, setSaving] = useState(false);
  const { pushToast } = useToast();

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const fallbackName = location.name?.trim().length ? location.name.trim() : location.slug;
      const safeName = form.name.trim().length ? form.name.trim() : fallbackName;
      if (!safeName) {
        throw new Error("Bitte gib einen Firmennamen an.");
      }
      const payload = {
        name: safeName,
        email: form.email.trim(),
        phone: form.phone.trim(),
        addressLine1: form.addressLine1.trim(),
        addressLine2: form.addressLine2.trim(),
        postalCode: form.postalCode.trim(),
        city: form.city.trim(),
        country: form.country.trim(),
        timezone: form.timezone.trim().length ? form.timezone.trim() : location.timezone ?? "Europe/Berlin",
      };
      const response = await fetch(`/api/backoffice/${location.slug}/company`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Änderungen konnten nicht gespeichert werden.");
      }
      router.refresh();
      setForm((previous) => ({ ...previous, ...payload }));
      setDirty(false);
      pushToast({ variant: "success", message: "Unternehmensdaten gespeichert." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speichern fehlgeschlagen.";
      pushToast({ variant: "error", message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-zinc-500">Unternehmen</p>
        <h2 className="text-2xl font-semibold text-zinc-900">Allgemeine Informationen</h2>
        <p className="text-sm text-zinc-500">
          Für <span className="font-semibold text-zinc-900">{location.name}</span>
        </p>
      </header>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <LabelValue label="Firmenname">
            <input
              value={form.name}
              onChange={(event) => handleChange("name", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="E-Mail">
            <input
              type="email"
              value={form.email}
              onChange={(event) => handleChange("email", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="Telefonnummer">
            <input
              value={form.phone}
              onChange={(event) => handleChange("phone", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="Zeitzone">
            <input
              value={form.timezone}
              onChange={(event) => handleChange("timezone", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <LabelValue label="Straße und Hausnummer">
            <input
              value={form.addressLine1}
              onChange={(event) => handleChange("addressLine1", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="Adresszusatz">
            <input
              value={form.addressLine2}
              onChange={(event) => handleChange("addressLine2", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="PLZ">
            <input
              value={form.postalCode}
              onChange={(event) => handleChange("postalCode", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="Ort">
            <input
              value={form.city}
              onChange={(event) => handleChange("city", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
          <LabelValue label="Land">
            <input
              value={form.country}
              onChange={(event) => handleChange("country", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none"
            />
          </LabelValue>
        </div>
      </div>
      {dirty && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Speichern…" : "Änderungen speichern"}
          </button>
        </div>
      )}
    </div>
  );
}

function PlaceholderCard({ title, description, buttonLabel }: { title: string; description: string; buttonLabel: string }) {
  return (
    <div className="space-y-4">
      <header>
        <p className="text-xs uppercase tracking-widest text-zinc-500">Unternehmen</p>
        <h2 className="text-2xl font-semibold text-zinc-900">{title}</h2>
        <p className="text-sm text-zinc-500">{description}</p>
      </header>
      <div className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-6 text-sm text-zinc-600">
        <p>
          Dieser Bereich wird demnächst interaktiv. Bis dahin kannst du Einstellungen direkt über den Support oder einzelne
          Standorte vornehmen.
        </p>
      </div>
      <div className="flex justify-end">
        <button className="rounded-full border border-zinc-200 px-5 py-2 text-sm font-semibold text-zinc-700 transition hover:border-zinc-300 hover:text-zinc-900">
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

function LabelValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold uppercase tracking-widest text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function BookingTimesForm({ location }: { location: CompanyLocation }) {
  const router = useRouter();
  const { pushToast } = useToast();
  const defaultSchedule: ScheduleEntry[] = WEEKDAYS.map((day) => ({
    weekday: day.key,
    label: day.label,
    isOpen: !["SATURDAY", "SUNDAY"].includes(day.key),
    start: day.key === "SATURDAY" ? "10:00" : "09:00",
    end: day.key === "SATURDAY" ? "14:00" : "18:00",
  }));
  const hydratedSchedule: ScheduleEntry[] = WEEKDAYS.map((day, index) => {
    const stored = location.bookingSchedule?.find((entry) => entry.weekday === day.key);
    if (!stored) {
      return defaultSchedule[index];
    }
    return {
      weekday: day.key,
      label: day.label,
      isOpen: Boolean(stored.isOpen),
      start: stored.start ?? defaultSchedule[index].start,
      end: stored.end ?? defaultSchedule[index].end,
    };
  });

  const [schedule, setSchedule] = useState<ScheduleEntry[]>(() => hydratedSchedule);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const shiftPlanEnabled = Boolean(location.shiftPlanEnabled);

  const updateSchedule = (weekday: string, updates: Partial<{ isOpen: boolean; start: string; end: string }>) => {
    if (shiftPlanEnabled) {
      return;
    }
    setSchedule((current) =>
      current.map((day) => {
        if (day.weekday !== weekday) return day;
        setDirty(true);
        return { ...day, ...updates };
      }),
    );
  };

  const handleSave = async () => {
    if (shiftPlanEnabled || saving) {
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/backoffice/${location.slug}/company/booking`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Buchungszeiten konnten nicht gespeichert werden.");
      }
      setDirty(false);
      router.refresh();
      pushToast({ variant: "success", message: "Buchungszeiten gespeichert." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speichern fehlgeschlagen.";
      pushToast({ variant: "error", message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-zinc-500">Unternehmen</p>
        <h2 className="text-2xl font-semibold text-zinc-900">Buchungszeiten</h2>
        <p className="text-sm text-zinc-500">Zeitzone: {location.timezone}</p>
      </header>
      {shiftPlanEnabled && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Die Buchungszeiten basieren auf dem Schichtplan und können nicht angepasst werden. Du kannst den Schichtplan in den
          Buchungseinstellungen deaktivieren.
        </div>
      )}
      <div className="space-y-2 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-xs text-zinc-500">
        <p>Aktiviere die Wochentage, an denen deine Standorte geöffnet sind, und hinterlege Zeitfenster für Online-Buchungen.</p>
      </div>
      <div className="space-y-3">
        {schedule.map((day) => (
          <div
            key={day.weekday}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700"
          >
            <div className="w-32 font-semibold text-zinc-900">{day.label}</div>
            <button
              type="button"
              className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
                day.isOpen ? "bg-emerald-500" : "bg-zinc-300"
              } ${shiftPlanEnabled ? "cursor-not-allowed opacity-60" : ""}`}
              onClick={() => updateSchedule(day.weekday, { isOpen: !day.isOpen })}
              aria-pressed={day.isOpen}
              disabled={shiftPlanEnabled}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  day.isOpen ? "translate-x-[1.6rem]" : "translate-x-1"
                }`}
              />
            </button>
            <span className={`text-xs font-semibold ${day.isOpen ? "text-emerald-700" : "text-zinc-500"}`}>
              {day.isOpen ? "Geöffnet" : "Geschlossen"}
            </span>
            <div className="flex items-center gap-2">
              <label className="text-xs uppercase tracking-widest text-zinc-400">Von</label>
              <input
                type="time"
                value={day.start}
                disabled={!day.isOpen || shiftPlanEnabled}
                onChange={(event) => updateSchedule(day.weekday, { start: event.target.value })}
                className="rounded-md border border-zinc-300 px-3 py-1 text-sm focus:border-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs uppercase tracking-widest text-zinc-400">Bis</label>
              <input
                type="time"
                value={day.end}
                disabled={!day.isOpen || shiftPlanEnabled}
                onChange={(event) => updateSchedule(day.weekday, { end: event.target.value })}
                className="rounded-md border border-zinc-300 px-3 py-1 text-sm focus:border-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100"
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || shiftPlanEnabled || saving}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {shiftPlanEnabled
            ? "Über Schichtplan gesteuert"
            : saving
              ? "Speichern…"
              : dirty
                ? "Änderungen speichern"
                : "Alles gespeichert"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
      </p>
    </div>
  );
}

function CompanyProfileForm({ location }: { location: CompanyLocation }) {
  const router = useRouter();
  const { pushToast } = useToast();
  const profile = location.profile ?? {
    description: "",
    website: "",
    facebook: "",
    instagram: "",
    xProfile: "",
    newsletterText: "",
    imprint: "",
    customLegalText: false,
    terms: "",
    privacy: "",
  };
  const [form, setForm] = useState(profile);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleChange = (key: keyof CompanyProfile, value: string | boolean) => {
    setForm((current) => {
      if (current[key] === value) return current;
      setDirty(true);
      return { ...current, [key]: value } as CompanyProfile;
    });
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/backoffice/${location.slug}/company/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Profil konnte nicht gespeichert werden.");
      }
      setDirty(false);
      router.refresh();
      pushToast({ variant: "success", message: "Firmenprofil gespeichert." });
    } catch (error) {
      pushToast({ variant: "error", message: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Firmenprofil</p>
        <h2 className="text-2xl font-semibold text-zinc-900">Darstellung auf der Buchungsseite</h2>
        <p className="text-sm text-zinc-500">
          Diese Beschreibung und Links sehen deine Kunden, wenn sie eine Buchung starten.
        </p>
      </header>
      <div className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <LabelValue label="Firmenbeschreibung">
          <textarea
            value={form.description}
            onChange={(event) => handleChange("description", event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            placeholder="Beschreibe dein Unternehmen in wenigen Sätzen…"
          />
        </LabelValue>
        <LabelValue label="Link zu deiner Website">
          <input
            value={form.website}
            onChange={(event) => handleChange("website", event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            placeholder="https://www.deine-domain.de"
          />
        </LabelValue>
        <LabelValue label="Link zu deinem Facebook Profil">
          <input
            value={form.facebook}
            onChange={(event) => handleChange("facebook", event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
        </LabelValue>
        <LabelValue label="Link zu deinem X Profil">
          <input
            value={form.xProfile}
            onChange={(event) => handleChange("xProfile", event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
        </LabelValue>
        <LabelValue label="Link zu deinem Instagram Profil">
          <input
            value={form.instagram}
            onChange={(event) => handleChange("instagram", event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
        </LabelValue>
        <LabelValue label="Eigener Text für die Newsletter-Anmeldung">
          <input
            value={form.newsletterText}
            onChange={(event) => handleChange("newsletterText", event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            placeholder="Bleib auf dem Laufenden ..."
          />
        </LabelValue>
        <LabelValue label="Link zu deinem Impressum">
          <input
            value={form.imprint}
            onChange={(event) => handleChange("imprint", event.target.value)}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          />
        </LabelValue>
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
          <label className="flex items-center gap-3 text-sm font-semibold text-zinc-900">
            <input
              type="checkbox"
              checked={form.customLegalText}
              onChange={(event) => handleChange("customLegalText", event.target.checked)}
              className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
            />
            Benutzerdefinierte AGB- und Datenschutzhinweise anzeigen
          </label>
          <p className="mt-1 text-xs text-zinc-500">
            Wenn aktiviert, verwenden wir deine Links anstelle der Standardtexte in der Buchungsmaske.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <LabelValue label="Link zu deinen AGB">
            <input
              value={form.terms}
              onChange={(event) => handleChange("terms", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              placeholder="https://…/agb"
            />
          </LabelValue>
          <LabelValue label="Link zu deinen Datenschutzhinweisen">
            <input
              value={form.privacy}
              onChange={(event) => handleChange("privacy", event.target.value)}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
              placeholder="https://…/datenschutz"
            />
          </LabelValue>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saving}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
        >
          {saving ? "Speichern…" : dirty ? "Änderungen speichern" : "Alles gespeichert"}
        </button>
      </div>
    </div>
  );
}

function ClosuresAbsencesPanel({ location }: { location: CompanyLocation }) {
  const router = useRouter();
  const { pushToast } = useToast();
  const staffOptions = location.staffOptions ?? [];
  const shiftPlanEnabled = Boolean(location.shiftPlanEnabled);
  const tabs = [
    { key: "closures", label: "Schließtage" },
    { key: "absences", label: "Abwesenheiten" },
  ] as const;
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]["key"]>("closures");
  const defaultClosure: ClosureEntry = {
    id: crypto.randomUUID(),
    startDate: new Date().toISOString().slice(0, 10),
    startTime: "09:00",
    endDate: new Date().toISOString().slice(0, 10),
    endTime: "18:00",
    reason: "Schließtag",
  };
  const defaultAbsence: AbsenceEntry = {
    id: crypto.randomUUID(),
    startDate: new Date().toISOString().slice(0, 10),
    startTime: "09:00",
    endDate: new Date().toISOString().slice(0, 10),
    endTime: "18:00",
    reason: "Abwesenheit",
    staffId: staffOptions[0]?.id ?? "",
  };
  const [closureEntries, setClosureEntries] = useState<ClosureEntry[]>(() =>
    location.closures && location.closures.length ? location.closures : [defaultClosure],
  );
  const [absenceEntries, setAbsenceEntries] = useState<AbsenceEntry[]>(() =>
    location.absences && location.absences.length ? location.absences : [defaultAbsence],
  );
  const [closureDirty, setClosureDirty] = useState(false);
  const [closureSaving, setClosureSaving] = useState(false);
  const [absenceDirty, setAbsenceDirty] = useState(false);
  const [absenceSaving, setAbsenceSaving] = useState(false);

  const addClosure = () => {
    if (shiftPlanEnabled) return;
    setClosureDirty(true);
    setClosureEntries((current) => [
      ...current,
      {
        ...defaultClosure,
        id: crypto.randomUUID(),
      },
    ]);
  };

  const removeClosure = (id: string) => {
    if (shiftPlanEnabled) return;
    setClosureDirty(true);
    setClosureEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const updateClosure = (id: string, patch: Partial<ClosureEntry>) => {
    if (shiftPlanEnabled) return;
    setClosureEntries((current) =>
      current.map((entry) => {
        if (entry.id === id) {
          setClosureDirty(true);
          return { ...entry, ...patch };
        }
        return entry;
      }),
    );
  };

  const handleSaveClosures = async () => {
    if (shiftPlanEnabled || closureSaving) return;
    setClosureSaving(true);
    try {
      const response = await fetch(`/api/backoffice/${location.slug}/company/closures`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ closures: closureEntries }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Schließtage konnten nicht gespeichert werden.");
      }
      setClosureDirty(false);
      router.refresh();
      pushToast({ variant: "success", message: "Schließtage gespeichert." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speichern fehlgeschlagen.";
      pushToast({ variant: "error", message });
    } finally {
      setClosureSaving(false);
    }
  };

  const addAbsence = () => {
    if (shiftPlanEnabled) return;
    setAbsenceDirty(true);
    setAbsenceEntries((current) => [
      ...current,
      {
        ...defaultAbsence,
        id: crypto.randomUUID(),
        staffId: staffOptions[0]?.id ?? "",
      },
    ]);
  };

  const removeAbsence = (id: string) => {
    if (shiftPlanEnabled) return;
    setAbsenceDirty(true);
    setAbsenceEntries((current) => current.filter((entry) => entry.id !== id));
  };

  const updateAbsence = (id: string, patch: Partial<AbsenceEntry>) => {
    if (shiftPlanEnabled) return;
    setAbsenceEntries((current) =>
      current.map((entry) => {
        if (entry.id === id) {
          setAbsenceDirty(true);
          return { ...entry, ...patch };
        }
        return entry;
      }),
    );
  };

  const handleSaveAbsences = async () => {
    if (shiftPlanEnabled || absenceSaving) return;
    setAbsenceSaving(true);
    try {
      const response = await fetch(`/api/backoffice/${location.slug}/company/absences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ absences: absenceEntries }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Abwesenheiten konnten nicht gespeichert werden.");
      }
      setAbsenceDirty(false);
      router.refresh();
      pushToast({ variant: "success", message: "Abwesenheiten gespeichert." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speichern fehlgeschlagen.";
      pushToast({ variant: "error", message });
    } finally {
      setAbsenceSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`flex-1 rounded-lg border px-4 py-2 text-center text-sm font-semibold transition ${
              activeTab === tab.key ? "border-emerald-500 bg-emerald-500 text-white" : "border-zinc-200 text-zinc-600"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "closures" ? (
        <div className="space-y-4">
          <header>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Schließtage</p>
            <h2 className="text-2xl font-semibold text-zinc-900">Filialweite Schließtage planen</h2>
            <p className="text-sm text-zinc-500">Trage Feiertage, Inventuren oder Team-Events ein.</p>
            {shiftPlanEnabled && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
                Die Buchungszeiten basieren auf dem Schichtplan und können nicht angepasst werden. Du kannst den Schichtplan in den
                Buchungseinstellungen deaktivieren.
              </div>
            )}
          </header>
          <div className="space-y-4">
            {closureEntries.map((entry) => (
              <div key={entry.id} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-zinc-900">Schließtag</p>
                  <button
                    type="button"
                    onClick={() => removeClosure(entry.id)}
                    disabled={shiftPlanEnabled}
                    className={`text-xs uppercase tracking-widest text-zinc-400 transition ${
                      shiftPlanEnabled ? "cursor-not-allowed opacity-50" : "hover:text-zinc-700"
                    }`}
                  >
                    Entfernen ×
                  </button>
                </div>
                <div className="grid gap-6 md:grid-cols-[120px_repeat(3,160px)]">
                  <div className="text-sm font-medium text-zinc-500">Geschlossen vom</div>
                  <LabelValue label="Datum">
                    <input
                      type="date"
                      value={entry.startDate}
                      onChange={(event) => updateClosure(entry.id, { startDate: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Uhrzeit">
                    <input
                      type="time"
                      value={entry.startTime}
                      onChange={(event) => updateClosure(entry.id, { startTime: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Grund">
                    <input
                      type="text"
                      value={entry.reason}
                      onChange={(event) => updateClosure(entry.id, { reason: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                      placeholder="Weihnachtsfeiertag"
                    />
                  </LabelValue>
                </div>
                <div className="grid gap-6 md:grid-cols-[120px_repeat(2,160px)]">
                  <div className="text-sm font-medium text-zinc-500">Bis</div>
                  <LabelValue label="Datum">
                    <input
                      type="date"
                      value={entry.endDate}
                      onChange={(event) => updateClosure(entry.id, { endDate: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Uhrzeit">
                    <input
                      type="time"
                      value={entry.endTime}
                      onChange={(event) => updateClosure(entry.id, { endTime: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addClosure}
              disabled={shiftPlanEnabled}
              className={`inline-flex items-center gap-2 rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition ${
                shiftPlanEnabled ? "cursor-not-allowed opacity-60" : "hover:border-zinc-300 hover:text-zinc-900"
              }`}
            >
              + Schließtag hinzufügen
            </button>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveClosures}
                disabled={shiftPlanEnabled || !closureDirty || closureSaving}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {shiftPlanEnabled
                  ? "Durch Schichtplan gesperrt"
                  : closureSaving
                    ? "Speichern…"
                    : closureDirty
                      ? "Änderungen speichern"
                      : "Alles gespeichert"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <header>
            <p className="text-xs uppercase tracking-widest text-zinc-500">Abwesenheiten</p>
            <h2 className="text-2xl font-semibold text-zinc-900">Personelle Abwesenheiten eintragen</h2>
            <p className="text-sm text-zinc-500">Definiere, welche Mitarbeitenden wann nicht verfügbar sind.</p>
            {shiftPlanEnabled && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
                Die Buchungszeiten basieren auf dem Schichtplan und können nicht angepasst werden. Du kannst den Schichtplan in den
                Buchungseinstellungen deaktivieren.
              </div>
            )}
          </header>
          <div className="space-y-4">
            {absenceEntries.map((entry) => (
              <div key={entry.id} className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-zinc-900">Abwesenheit</p>
                  <button
                    type="button"
                    onClick={() => removeAbsence(entry.id)}
                    disabled={shiftPlanEnabled}
                    className={`text-xs uppercase tracking-widest text-zinc-400 transition ${
                      shiftPlanEnabled ? "cursor-not-allowed opacity-50" : "hover:text-zinc-700"
                    }`}
                  >
                    Entfernen ×
                  </button>
                </div>
                <div className="grid gap-6 md:grid-cols-[120px_repeat(3,160px)]">
                  <div className="text-sm font-medium text-zinc-500">Abwesend vom</div>
                  <LabelValue label="Datum">
                    <input
                      type="date"
                      value={entry.startDate}
                      onChange={(event) => updateAbsence(entry.id, { startDate: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Uhrzeit">
                    <input
                      type="time"
                      value={entry.startTime}
                      onChange={(event) => updateAbsence(entry.id, { startTime: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Grund">
                    <input
                      type="text"
                      value={entry.reason}
                      onChange={(event) => updateAbsence(entry.id, { reason: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                      placeholder="Fortbildung"
                    />
                  </LabelValue>
                </div>
                <div className="grid gap-6 md:grid-cols-[120px_repeat(3,160px)]">
                  <div className="text-sm font-medium text-zinc-500">Bis</div>
                  <LabelValue label="Datum">
                    <input
                      type="date"
                      value={entry.endDate}
                      onChange={(event) => updateAbsence(entry.id, { endDate: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Uhrzeit">
                    <input
                      type="time"
                      value={entry.endTime}
                      onChange={(event) => updateAbsence(entry.id, { endTime: event.target.value })}
                      disabled={shiftPlanEnabled}
                      className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none ${
                        shiftPlanEnabled ? "bg-zinc-100 text-zinc-500" : ""
                      }`}
                    />
                  </LabelValue>
                  <LabelValue label="Ressource">
                    <select
                      value={entry.staffId}
                      onChange={(event) => updateAbsence(entry.id, { staffId: event.target.value })}
                      className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100 disabled:text-zinc-500"
                      disabled={!staffOptions.length || shiftPlanEnabled}
                    >
                      {staffOptions.length ? (
                        staffOptions.map((staff) => (
                          <option key={staff.id} value={staff.id}>
                            {staff.name}
                          </option>
                        ))
                      ) : (
                        <option value="">Kein Mitarbeiter verfügbar</option>
                      )}
                    </select>
                  </LabelValue>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addAbsence}
              disabled={shiftPlanEnabled}
              className={`inline-flex items-center gap-2 rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-700 transition ${
                shiftPlanEnabled ? "cursor-not-allowed opacity-60" : "hover:border-zinc-300 hover:text-zinc-900"
              }`}
            >
              + Abwesenheit hinzufügen
            </button>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveAbsences}
                disabled={shiftPlanEnabled || !absenceDirty || absenceSaving}
                className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                {shiftPlanEnabled
                  ? "Durch Schichtplan gesperrt"
                  : absenceSaving
                    ? "Speichern…"
                    : absenceDirty
                      ? "Änderungen speichern"
                      : "Alles gespeichert"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
