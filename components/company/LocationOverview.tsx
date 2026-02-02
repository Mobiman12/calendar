"use client";

import Link from "next/link";
import { Building2, MapPin, Settings } from "lucide-react";

import type { LocationSummary, ScheduleEntry } from "@/app/backoffice/[location]/locations/queries";

const WEEKDAY_LABELS: Record<ScheduleEntry["weekday"], string> = {
  MONDAY: "Mo",
  TUESDAY: "Di",
  WEDNESDAY: "Mi",
  THURSDAY: "Do",
  FRIDAY: "Fr",
  SATURDAY: "Sa",
  SUNDAY: "So",
};

type LocationOverviewProps = {
  locations: LocationSummary[];
  bookingBaseUrl?: string;
  tenantSlug?: string;
  tenantLocationsUrl?: string;
};

export function LocationOverview({
  locations,
  bookingBaseUrl,
  tenantSlug,
  tenantLocationsUrl,
}: LocationOverviewProps) {
  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-semibold">Hinweis</p>
        <p>
          Standorte werden zentral im Tenant-Dashboard gepflegt. Neue Standorte, Adressänderungen oder Öffnungszeiten bitte
          direkt dort verwalten.{" "}
          {tenantLocationsUrl ? (
            <a href={tenantLocationsUrl} className="font-semibold underline decoration-amber-400/70 underline-offset-2">
              Standorte im Tenant-Dashboard öffnen
            </a>
          ) : (
            "Standorte im Tenant-Dashboard öffnen."
          )}{" "}
          Diese Übersicht zeigt die aktuell synchronisierten Daten für den Kalender an.
        </p>
      </div>

      <div className="space-y-4">
        {locations.map((location) => {
          const summary = buildScheduleSummary(location.schedule);
          const bookingTenant = tenantSlug ?? location.slug;
          const bookingHref = bookingBaseUrl ? `${bookingBaseUrl}/book/${bookingTenant}/${location.slug}` : null;
          return (
            <article key={location.id} className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                    <Building2 className="h-4 w-4 text-zinc-500" />
                    {location.name}
                  </div>
                  <p className="text-sm text-zinc-600">
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-4 w-4 text-zinc-400" />
                      {formatAddress(location)}
                    </span>
                  </p>
                  <p className="text-xs uppercase tracking-widest text-zinc-400">
                    Slug: <span className="font-mono text-zinc-500">{location.slug}</span>
                  </p>
                  <p className="text-xs text-zinc-500">Zeitzone: {location.timezone}</p>
                  <p className="text-xs text-zinc-500">Team: {location.staffCount} · Kunden: {location.customerCount}</p>
                  {bookingHref && (
                    <p className="text-xs text-zinc-500">
                      Buchungslink:{" "}
                      <a
                        href={bookingHref}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-blue-600 hover:underline"
                      >
                        Öffnen
                      </a>
                    </p>
                  )}
                </div>
                <Link
                  href={`/backoffice/${location.slug}/settings`}
                  className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-zinc-600 transition hover:border-zinc-900 hover:text-zinc-900"
                >
                  <Settings className="h-4 w-4" />
                  Öffnungszeiten ansehen
                </Link>
              </div>

              <div className="mt-4 space-y-1 text-xs text-zinc-500">
                {summary.length > 0 ? (
                  summary.map((entry) => (
                    <p
                      key={`${location.id}-${entry.label}-${entry.value}`}
                      className="flex justify-between gap-2 rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-1.5"
                    >
                      <span>{entry.label}:</span>
                      <span className="font-medium text-zinc-700">{entry.value}</span>
                    </p>
                  ))
                ) : (
                  <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-1.5">
                    Keine Öffnungszeiten hinterlegt.
                  </p>
                )}
              </div>
            </article>
          );
        })}
        {locations.length === 0 && (
          <p className="rounded-2xl border border-dashed border-zinc-200 bg-white/60 p-6 text-sm text-zinc-500">
            Keine Standorte vorhanden.
          </p>
        )}
      </div>
    </div>
  );
}

function formatAddress(location: LocationSummary): string {
  const parts = [location.addressLine1, location.city].filter(Boolean);
  return parts.length ? parts.join(", ") : "Keine Adresse hinterlegt";
}

function minutesToLabel(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return "";
  }
  const hours = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function buildScheduleSummary(schedule: ScheduleEntry[]) {
  if (!schedule.length) return [];
  const summaries: Array<{ label: string; value: string }> = [];

  let currentStart = schedule[0];
  let currentEnd = schedule[0];

  const flushGroup = () => {
    const dayLabel =
      currentStart.weekday === currentEnd.weekday
        ? WEEKDAY_LABELS[currentStart.weekday]
        : `${WEEKDAY_LABELS[currentStart.weekday]} – ${WEEKDAY_LABELS[currentEnd.weekday]}`;
    const closed = currentStart.startsAt === null || currentStart.endsAt === null;
    const value = closed
      ? "Geschlossen"
      : `${minutesToLabel(currentStart.startsAt)} – ${minutesToLabel(currentStart.endsAt)}`;
    summaries.push({ label: dayLabel, value });
  };

  for (let index = 1; index < schedule.length; index += 1) {
    const entry = schedule[index];
    const sameTimes = currentStart.startsAt === entry.startsAt && currentStart.endsAt === entry.endsAt;
    if (sameTimes) {
      currentEnd = entry;
      continue;
    }
    flushGroup();
    currentStart = entry;
    currentEnd = entry;
  }

  flushGroup();

  return summaries;
}
