"use server";

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { StaffStatus } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { readTenantContext } from "@/lib/tenant";
import { readAppsEnabled } from "@/lib/staff-metadata";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

const prisma = getPrismaClient();

const STATUS_OPTIONS: Array<{ value: StaffStatus; label: string }> = [
  { value: "ACTIVE", label: "Aktiv" },
  { value: "INVITED", label: "Onboarding" },
  { value: "LEAVE", label: "Abwesend" },
  { value: "INACTIVE", label: "Inaktiv" },
];

export default async function CentralStaffDetailPage({
  params,
}: {
  params: Promise<{ staffId: string }>;
}) {
  const { staffId } = await params;
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect("/backoffice");
  }
  const hdrs = await headers();
  const tenant = readTenantContext(hdrs);
  const tenantId = tenant?.id ?? process.env.DEFAULT_TENANT_ID;
  if (!tenantId) {
    notFound();
  }

  const [staff, locations] = await Promise.all([
    prisma.staff.findFirst({
      where: { id: staffId, location: { tenantId } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
        phone: true,
        color: true,
        status: true,
        metadata: true,
        locationId: true,
        code: true,
      },
    }),
    prisma.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!staff) {
    notFound();
  }

  const apps = readAppsEnabled(staff.metadata);

  return (
    <main className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Zentrale Mitarbeiter</p>
        <h1 className="text-3xl font-semibold text-zinc-900">{staff.displayName ?? `${staff.firstName} ${staff.lastName}`}</h1>
        <p className="text-sm text-zinc-600">Bearbeite Daten und App-Sichtbarkeit zentral.</p>
      </header>

      <CentralStaffForm staffId={staff.id} locations={locations} staff={staff} apps={apps} />

      <div>
        <Link href="/backoffice/staff-central" className="text-sm font-semibold text-zinc-900 underline-offset-2 hover:underline">
          Zurück zur Übersicht
        </Link>
      </div>
    </main>
  );
}

function CentralStaffForm({
  staffId,
  locations,
  staff,
  apps,
}: {
  staffId: string;
  locations: Array<{ id: string; name: string | null; slug: string | null }>;
  staff: {
    firstName: string;
    lastName: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    color: string | null;
    status: StaffStatus;
    locationId: string | null;
    code: string | null;
  };
  apps: { calendar: boolean; timeshift: boolean; website: boolean };
}) {
  const fallbackLocation = locations[0]?.id ?? "";
  return (
    <form
      action={`/api/backoffice/staff-central/${staffId}`}
      method="post"
      className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
    >
      <input type="hidden" name="_method" value="PATCH" />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Vorname">
          <input
            name="firstName"
            defaultValue={staff.firstName}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            required
          />
        </Field>
        <Field label="Nachname">
          <input
            name="lastName"
            defaultValue={staff.lastName}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            required
          />
        </Field>
        <Field label="Anzeigename">
          <input
            name="displayName"
            defaultValue={staff.displayName ?? ""}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </Field>
        <Field label="E-Mail">
          <input
            name="email"
            defaultValue={staff.email ?? ""}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </Field>
        <Field label="Telefon">
          <input
            name="phone"
            defaultValue={staff.phone ?? ""}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </Field>
        <Field label="Farbe (optional)">
          <input
            name="color"
            defaultValue={staff.color ?? ""}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </Field>
        <Field label="Status">
          <select
            name="status"
            defaultValue={staff.status}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Standort">
          <select
            name="locationId"
            defaultValue={staff.locationId ?? fallbackLocation}
            className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            required
          >
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name ?? loc.slug ?? loc.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Apps">
          <div className="flex flex-wrap gap-3 text-sm text-zinc-700">
            <input type="hidden" name="apps.calendar" value="false" />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="apps.calendar" defaultChecked={apps.calendar} /> Calendar
            </label>
            <input type="hidden" name="apps.timeshift" value="false" />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="apps.timeshift" defaultChecked={apps.timeshift} /> Timeshift
            </label>
            <input type="hidden" name="apps.website" value="false" />
            <label className="flex items-center gap-2">
              <input type="checkbox" name="apps.website" defaultChecked={apps.website} /> Website
            </label>
          </div>
        </Field>
        <Field label="Externe ID/Code (read-only)">
          <input
            value={staff.code ?? "–"}
            readOnly
            className="rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-900"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          formMethod="post"
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
        >
          Speichern
        </button>
        <span className="text-sm text-zinc-500">Änderungen gelten für alle Apps.</span>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-zinc-700">
      <span>{label}</span>
      {children}
    </label>
  );
}
