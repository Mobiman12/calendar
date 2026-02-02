"use client";

import Image from "next/image";
import Link from "next/link";
import type { ChangeEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ServiceStatus, StaffStatus } from "@prisma/client";

import { useToast } from "@/components/ui/ToastProvider";

type StaffMetadata = {
  profileImageUrl?: string | null;
  onlineBookingEnabled?: boolean;
  serviceIds?: string[];
};

type StaffDetail = {
  id: string;
  code: string | null;
  locationId: string;
  locationIds: string[];
  firstName: string;
  lastName: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  color: string | null;
  status: StaffStatus;
  bio: string | null;
  metadata: StaffMetadata;
  createdAt: string;
  updatedAt: string;
  locationName: string | null;
  assignedServiceIds: string[];
};

type LocationOption = {
  id: string;
  slug: string;
  name: string;
};

type ServiceOption = {
  id: string;
  name: string;
  duration: number;
  status: ServiceStatus;
};

type FormState = {
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string;
  color: string;
  status: StaffStatus;
  locationIds: string[];
  onlineBookingEnabled: boolean;
  serviceIds: string[];
  profileImageUrl: string | null;
};

const STATUS_LABELS: Partial<Record<StaffStatus, string>> = {
  [StaffStatus.ACTIVE]: "Aktiv",
  [StaffStatus.INVITED]: "Onboarding",
  [StaffStatus.LEAVE]: "Abwesend",
  [StaffStatus.INACTIVE]: "Inaktiv",
};

const STATUS_STYLES: Partial<Record<StaffStatus, string>> = {
  [StaffStatus.ACTIVE]: "bg-emerald-50 text-emerald-700 border-emerald-100",
  [StaffStatus.INVITED]: "bg-sky-50 text-sky-700 border-sky-100",
  [StaffStatus.LEAVE]: "bg-amber-50 text-amber-700 border-amber-100",
  [StaffStatus.INACTIVE]: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

const AVAILABLE_STATUSES: StaffStatus[] = (() => {
  const values = Object.values(StaffStatus) as StaffStatus[];
  const invited = (StaffStatus as Record<string, StaffStatus | undefined>).INVITED;
  return invited ? values.filter((value) => value !== invited) : values;
})();

const MAX_IMAGE_SIZE = 6 * 1024 * 1024; // 6MB

interface StaffDetailViewProps {
  locationSlug: string;
  staff: StaffDetail;
  locations: LocationOption[];
  services: ServiceOption[];
  lockStammdaten?: boolean;
}

export default function StaffDetailView({
  locationSlug,
  staff,
  locations,
  services,
  lockStammdaten = false,
}: StaffDetailViewProps) {
  const router = useRouter();
  const { pushToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [formState, setFormState] = useState<FormState>(() => createFormState(staff));
  const [baselineState, setBaselineState] = useState<FormState>(() => createFormState(staff));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    const nextState = createFormState(staff);
    setFormState(nextState);
    setBaselineState(nextState);
  }, [staff]);

  const isDirty = useMemo(() => !isFormEqual(formState, baselineState), [formState, baselineState]);

  const selectedLocations = useMemo(
    () => locations.filter((entry) => formState.locationIds.includes(entry.id)),
    [formState.locationIds, locations],
  );
  const activeLocation =
    selectedLocations.find((entry) => entry.slug === locationSlug) ?? selectedLocations[0] ?? null;
  const statusOptions = AVAILABLE_STATUSES;

  const activeServices = useMemo(
    () =>
      services.map((service) => ({
        ...service,
        isSelected: formState.serviceIds.includes(service.id),
      })),
    [formState.serviceIds, services],
  );

  const initials = getInitials(
    formState.displayName?.trim().length
      ? formState.displayName
      : `${formState.firstName} ${formState.lastName}`.trim(),
  );

  const handleFieldChange = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    if (lockStammdaten && ["firstName", "lastName", "displayName", "email", "phone"].includes(field as string)) {
      return;
    }
    setFormState((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleServiceToggle = (serviceId: string) => {
    setFormState((current) => {
      const set = new Set(current.serviceIds);
      if (set.has(serviceId)) {
        set.delete(serviceId);
      } else {
        set.add(serviceId);
      }
      return { ...current, serviceIds: Array.from(set) };
    });
  };

  const handleLocationToggle = (locationId: string) => {
    setFormState((current) => {
      const next = new Set(current.locationIds);
      if (next.has(locationId)) {
        if (next.size === 1) {
          pushToast({ variant: "error", message: "Mindestens ein Standort muss ausgewählt bleiben." });
          return current;
        }
        next.delete(locationId);
      } else {
        next.add(locationId);
      }
      return { ...current, locationIds: Array.from(next) };
    });
  };

  const handleSave = async () => {
    const trimmed: FormState = {
      ...formState,
      firstName: formState.firstName.trim(),
      lastName: formState.lastName.trim(),
      displayName: formState.displayName.trim(),
      email: formState.email.trim(),
      phone: formState.phone.trim(),
      color: formState.color.trim(),
      locationIds: formState.locationIds.filter((id) => id.trim().length > 0),
    };

    setSaving(true);
    try {
      const response = await fetch(`/api/backoffice/${locationSlug}/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: trimmed.firstName,
          lastName: trimmed.lastName,
          displayName: trimmed.displayName.length ? trimmed.displayName : null,
          email: trimmed.email,
          phone: trimmed.phone,
          color: trimmed.color,
          status: trimmed.status,
          locationIds: trimmed.locationIds,
          metadata: {
            profileImageUrl: trimmed.profileImageUrl,
            onlineBookingEnabled: trimmed.onlineBookingEnabled,
            serviceIds: trimmed.serviceIds,
          },
        }),
      });
      const payload = await parseJsonResponse(response);
      if (!payload) throw new Error("Änderungen konnten nicht gespeichert werden.");
      if (!response.ok) throw new Error(payload.error ?? "Änderungen konnten nicht gespeichert werden.");

      const payloadData = (payload.data ?? {}) as Partial<StaffDetail> & {
        metadata?: StaffMetadata;
        locationId?: string;
        status?: StaffStatus;
        color?: string | null;
        displayName?: string | null;
        email?: string | null;
        phone?: string | null;
        locationIds?: string[];
      };

      const nextMetadata: StaffMetadata = {
        profileImageUrl:
          payloadData.metadata?.profileImageUrl ?? trimmed.profileImageUrl ?? null,
        onlineBookingEnabled:
          payloadData.metadata?.onlineBookingEnabled ?? trimmed.onlineBookingEnabled,
        serviceIds: payloadData.metadata?.serviceIds ?? trimmed.serviceIds,
      };

      const nextState: FormState = {
        firstName: payloadData.firstName ?? trimmed.firstName,
        lastName: payloadData.lastName ?? trimmed.lastName,
        displayName: payloadData.displayName ?? trimmed.displayName,
        email: payloadData.email ?? trimmed.email,
        phone: payloadData.phone ?? trimmed.phone,
        color: payloadData.color ?? trimmed.color,
        status: payloadData.status ?? trimmed.status,
        locationIds: payloadData.locationIds ?? trimmed.locationIds,
        onlineBookingEnabled: nextMetadata.onlineBookingEnabled ?? false,
        serviceIds: nextMetadata.serviceIds ?? [],
        profileImageUrl: nextMetadata.profileImageUrl ?? null,
      };

      setBaselineState(nextState);
      setFormState(nextState);
      pushToast({ variant: "success", message: "Änderungen gespeichert." });
      router.refresh();
    } catch (error) {
      pushToast({
        variant: "error",
        message: error instanceof Error ? error.message : "Änderungen konnten nicht gespeichert werden.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleUploadPhoto = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      pushToast({ variant: "error", message: "Bitte wähle eine Bilddatei aus." });
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      pushToast({ variant: "error", message: "Das Bild darf maximal 6 MB groß sein." });
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(
        `/api/backoffice/${locationSlug}/staff/${staff.id}/profile-image`,
        {
          method: "POST",
          body: formData,
        },
      );

      const payload = await parseJsonResponse(response);
      if (!payload) throw new Error("Profilbild konnte nicht aktualisiert werden.");
      if (!response.ok) throw new Error(payload.error ?? "Profilbild konnte nicht aktualisiert werden.");

      const nextUrl: string | null = payload.data?.profileImageUrl ?? null;
      setFormState((current) => ({ ...current, profileImageUrl: nextUrl }));
      setBaselineState((current) => ({ ...current, profileImageUrl: nextUrl }));
      pushToast({ variant: "success", message: "Profilbild aktualisiert." });
      router.refresh();
    } catch (error) {
      pushToast({
        variant: "error",
        message: error instanceof Error ? error.message : "Profilbild konnte nicht aktualisiert werden.",
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleRemovePhoto = async () => {
    setUploading(true);
    try {
      const response = await fetch(
        `/api/backoffice/${locationSlug}/staff/${staff.id}/profile-image`,
        {
          method: "DELETE",
        },
      );
      const payload = await parseJsonResponse(response);
      if (!payload) throw new Error("Profilbild konnte nicht entfernt werden.");
      if (!response.ok) throw new Error(payload.error ?? "Profilbild konnte nicht entfernt werden.");

      setFormState((current) => ({ ...current, profileImageUrl: null }));
      setBaselineState((current) => ({ ...current, profileImageUrl: null }));
      pushToast({ variant: "success", message: "Profilbild entfernt." });
      router.refresh();
    } catch (error) {
      pushToast({
        variant: "error",
        message: error instanceof Error ? error.message : "Profilbild konnte nicht entfernt werden.",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-2">
          <Link
            href={`/backoffice/${locationSlug}/staff`}
            className="inline-flex items-center gap-2 text-sm text-zinc-500 transition hover:text-zinc-900"
          >
            <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4">
              <path
                fill="currentColor"
                fillRule="evenodd"
                d="M12.78 4.22a.75.75 0 0 1 0 1.06L8.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06l-5.25-5.25-.07-.08a.75.75 0 0 1 .07-.98l5.25-5.25a.75.75 0 0 1 1.06 0"
                clipRule="evenodd"
              />
            </svg>
            Zurück zur Übersicht
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-zinc-900">
              {formState.displayName?.trim().length
                ? formState.displayName
                : `${formState.firstName} ${formState.lastName}`.trim()}
            </h1>
            <StatusBadge status={formState.status} />
            {activeLocation ? (
              <span className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600">
                {selectedLocations.length > 1
                  ? `${activeLocation.name} +${selectedLocations.length - 1}`
                  : activeLocation.name}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-zinc-500">
            Details wie Profilbild, Farbe, Filiale und buchbare Leistungen verwaltest du hier.
          </p>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
            saving || !isDirty
              ? "cursor-not-allowed border border-transparent bg-zinc-200 text-zinc-500"
              : "border border-transparent bg-zinc-900 text-white hover:bg-zinc-800"
          }`}
        >
          {saving ? "Speichere …" : "Änderungen speichern"}
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px,1fr]">
        <aside className="space-y-6">
          <article className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col items-center gap-4">
              <div
                className="relative flex h-32 w-32 items-center justify-center overflow-hidden rounded-full border border-zinc-200 bg-zinc-100"
                style={formState.color ? { borderColor: formState.color } : undefined}
              >
                {formState.profileImageUrl ? (
                  <Image
                    src={formState.profileImageUrl}
                    alt={`${formState.firstName} ${formState.lastName}`}
                    fill
                    sizes="128px"
                    className="object-cover"
                  />
                ) : (
                  <span
                    className="text-3xl font-semibold"
                    style={formState.color ? { color: formState.color } : undefined}
                  >
                    {initials}
                  </span>
                )}
              </div>

              <div className="flex flex-col items-center gap-2 text-sm text-zinc-500">
                <p>Profilbild (1:1, max. 6&nbsp;MB)</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-sm font-medium text-zinc-700 transition hover:border-zinc-400 hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {uploading ? "Lade hoch …" : "Foto ändern"}
                  </button>
                  {formState.profileImageUrl && (
                    <button
                      type="button"
                      onClick={handleRemovePhoto}
                      disabled={uploading}
                      className="rounded-full border border-transparent px-3 py-1 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Entfernen
                    </button>
                  )}
                </div>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => handleUploadPhoto(event.target.files?.[0] ?? null)}
              />
            </div>
          </article>

          <article className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <header>
              <h2 className="text-sm font-semibold text-zinc-900">Farbe im Kalender</h2>
              <p className="text-xs text-zinc-500">
                Wird für Terminkarten verwendet. Wähle eine klare, kontrastreiche Farbe.
              </p>
            </header>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={formState.color}
                onChange={(event) => handleFieldChange("color", event.target.value)}
                className="h-12 w-20 cursor-pointer rounded border border-zinc-200 bg-white"
                aria-label="Farbe auswählen"
              />
              <input
                type="text"
                value={formState.color}
                onChange={(event) => handleFieldChange("color", event.target.value)}
                className="w-full rounded-full border border-zinc-200 px-4 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none"
              />
            </div>
          </article>

          <article className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-6 text-sm text-zinc-500 shadow-sm">
            <div className="flex items-center justify-between">
              <span>Mitarbeiter-ID</span>
              <span className="font-medium text-zinc-700">{staff.code ?? "–"}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Profil erstellt</span>
              <span className="font-medium text-zinc-700">{formatDate(staff.createdAt)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Zuletzt aktualisiert</span>
              <span className="font-medium text-zinc-700">{formatRelativeDate(staff.updatedAt)}</span>
            </div>
          </article>
        </aside>

        <div className="space-y-6">
          <article className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <header>
              <h2 className="text-base font-semibold text-zinc-900">Stammdaten</h2>
              {lockStammdaten && (
                <p className="mt-2 text-xs text-amber-700">
                  Stammdaten sind schreibgeschützt. Bitte im Tenant-Dashboard bearbeiten.
                </p>
              )}
            </header>
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label="Vorname"
                value={formState.firstName}
                disabled={lockStammdaten}
                onChange={(event) => handleFieldChange("firstName", event.target.value)}
              />
              <Field
                label="Nachname"
                value={formState.lastName}
                disabled={lockStammdaten}
                onChange={(event) => handleFieldChange("lastName", event.target.value)}
              />
              <Field
                label="Anzeigename"
                value={formState.displayName}
                disabled={lockStammdaten}
                onChange={(event) => handleFieldChange("displayName", event.target.value)}
                helper="Optional. Wird im Backoffice bevorzugt angezeigt."
              />
              <Field
                label="E-Mail"
                type="email"
                value={formState.email}
                disabled={lockStammdaten}
                onChange={(event) => handleFieldChange("email", event.target.value)}
              />
              <Field
                label="Telefon"
                value={formState.phone}
                disabled={lockStammdaten}
                onChange={(event) => handleFieldChange("phone", event.target.value)}
              />
            </div>
          </article>

          <article className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <header>
              <h2 className="text-base font-semibold text-zinc-900">Organisation</h2>
              <p className="text-sm text-zinc-500">
                Weise dem Teammitglied Standorte zu und steuere, ob Online-Termine möglich sind.
              </p>
            </header>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-zinc-700">Standorte</label>
                <div className="rounded-2xl border border-zinc-200 p-3">
                  <div className="space-y-2">
                    {locations.map((locationOption) => {
                      const checked = formState.locationIds.includes(locationOption.id);
                      return (
                        <label
                          key={locationOption.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-transparent px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => handleLocationToggle(locationOption.id)}
                              className="h-4 w-4 rounded border-zinc-300"
                            />
                            {locationOption.name}
                          </span>
                          <span className="text-xs text-zinc-400">{locationOption.slug}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-zinc-700">Status</label>
                <select
                  value={formState.status}
                  onChange={(event) => handleFieldChange("status", event.target.value as StaffStatus)}
                  className="rounded-full border border-zinc-200 px-4 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none"
                >
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status] ?? status}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-zinc-800">Online buchbar</p>
                  <p className="text-xs text-zinc-500">Steuert, ob der Mitarbeiter in der Online-Buchung sichtbar ist.</p>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={formState.onlineBookingEnabled}
                    onChange={(event) => handleFieldChange("onlineBookingEnabled", event.target.checked)}
                  />
                  <span className="h-6 w-11 rounded-full bg-zinc-300 transition peer-checked:bg-emerald-500" />
                  <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition peer-checked:translate-x-5" />
                </label>
              </div>
            </div>
          </article>

          <article className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <header>
              <h2 className="text-base font-semibold text-zinc-900">Leistungen &amp; Angebote</h2>
              <p className="text-sm text-zinc-500">
                Wähle aus, welche Services das Teammitglied durchführen kann. Inaktive Leistungen werden grau dargestellt.
              </p>
            </header>

            <div className="grid gap-3 md:grid-cols-2">
              {activeServices.map((service) => {
                const disabled = service.status !== ServiceStatus.ACTIVE;
                return (
                  <label
                    key={service.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition ${
                      disabled
                        ? "border-zinc-200 bg-zinc-50 text-zinc-400"
                        : service.isSelected
                          ? "border-emerald-300 bg-emerald-50"
                          : "border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-zinc-300"
                      checked={service.isSelected}
                      disabled={disabled}
                      onChange={() => handleServiceToggle(service.id)}
                    />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {service.name}
                        {disabled ? " (inaktiv)" : ""}
                      </p>
                      <p className="text-xs text-zinc-500">{service.duration} Minuten</p>
                    </div>
                  </label>
                );
              })}
            </div>

            {activeServices.length === 0 && (
              <p className="rounded-xl border border-dashed border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-500">
                Für diesen Standort wurden noch keine Services angelegt.
              </p>
            )}
          </article>
        </div>
      </div>
    </section>
  );
}

function createFormState(staff: StaffDetail): FormState {
  return {
    firstName: staff.firstName,
    lastName: staff.lastName,
    displayName: staff.displayName ?? "",
    email: staff.email ?? "",
    phone: staff.phone ?? "",
    color: staff.color ?? "#1f2937",
    status: staff.status,
    locationIds: staff.locationIds ?? [staff.locationId].filter(Boolean),
    onlineBookingEnabled: staff.metadata.onlineBookingEnabled ?? false,
    serviceIds: staff.assignedServiceIds ?? [],
    profileImageUrl: staff.metadata.profileImageUrl ?? null,
  };
}

function isFormEqual(a: FormState, b: FormState) {
  return (
    a.firstName === b.firstName &&
    a.lastName === b.lastName &&
    a.displayName === b.displayName &&
    a.email === b.email &&
    a.phone === b.phone &&
    a.color === b.color &&
    a.status === b.status &&
    arraysEqual(a.locationIds, b.locationIds) &&
    a.onlineBookingEnabled === b.onlineBookingEnabled &&
    arraysEqual(a.serviceIds, b.serviceIds) &&
    a.profileImageUrl === b.profileImageUrl
  );
}

function arraysEqual(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function getInitials(name: string) {
  const parts = name.split(" ").filter(Boolean);
  if (!parts.length) return "TM";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "TM";
}

function formatDate(iso: string) {
  const date = new Date(iso);
  return date.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatRelativeDate(iso: string) {
  const date = new Date(iso);
  const formatter = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMinutes = Math.round(diffMs / 60000);

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, "hour");
  }

  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

function StatusBadge({ status }: { status: StaffStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${
        STATUS_STYLES[status] ?? "border-zinc-200 bg-zinc-100 text-zinc-600"
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function Field({
  label,
  helper,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: string;
  helper?: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium text-zinc-700">{label}</span>
      <input
        type={type}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="rounded-full border border-zinc-200 px-4 py-2 text-sm text-zinc-700 focus:border-zinc-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
      />
      {helper ? <span className="text-xs text-zinc-500">{helper}</span> : null}
    </label>
  );
}

async function parseJsonResponse(response: Response) {
  const raw = await response.text();
  if (!raw.trim().length) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Antwort konnte nicht gelesen werden.");
  }
}
