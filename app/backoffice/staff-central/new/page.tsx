"use server";

import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StaffStatus } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

const prisma = getPrismaClient();

const STATUS_OPTIONS: Array<{ value: StaffStatus; label: string }> = [
  { value: "ACTIVE", label: "Aktiv" },
  { value: "INVITED", label: "Onboarding" },
  { value: "LEAVE", label: "Abwesend" },
  { value: "INACTIVE", label: "Inaktiv" },
];

export default async function CentralStaffNewPage() {
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect("/backoffice");
  }
  const hdrs = await headers();
  const tenant = readTenantContext(hdrs);
  const tenantId = tenant?.id ?? process.env.DEFAULT_TENANT_ID;
  if (!tenantId) {
    return (
      <main className="space-y-4">
        <h1 className="text-2xl font-semibold text-zinc-900">Neuen Mitarbeiter anlegen</h1>
        <p className="text-sm text-red-600">Tenant-Kontext fehlt. Bitte über die passende Subdomain/App aufrufen.</p>
      </main>
    );
  }

  const locations = await prisma.location.findMany({
    where: { tenantId },
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });

  return (
    <main className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Zentrale Mitarbeiter</p>
        <h1 className="text-3xl font-semibold text-zinc-900">Neuen Mitarbeiter anlegen</h1>
        <p className="text-sm text-zinc-600">Dieser Mitarbeiter wird zentral für alle Apps geführt.</p>
      </header>

      <form
        action="/api/backoffice/staff-central"
        method="post"
        className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Vorname">
            <input
              name="firstName"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              required
            />
          </Field>
          <Field label="Nachname">
            <input
              name="lastName"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              required
            />
          </Field>
          <Field label="Anzeigename">
            <input
              name="displayName"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </Field>
          <Field label="E-Mail">
            <input
              name="email"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </Field>
          <Field label="Telefon">
            <input
              name="phone"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </Field>
          <Field label="Farbe (optional)">
            <input
              name="color"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            />
          </Field>
          <Field label="Status">
            <select
              name="status"
              defaultValue="ACTIVE"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-inner focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Standort" >
            <select
              name="locationId"
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
                <input type="checkbox" name="apps.calendar" defaultChecked /> Calendar
              </label>
              <input type="hidden" name="apps.timeshift" value="false" />
              <label className="flex items-center gap-2">
                <input type="checkbox" name="apps.timeshift" defaultChecked /> Timeshift
              </label>
              <input type="hidden" name="apps.website" value="false" />
              <label className="flex items-center gap-2">
                <input type="checkbox" name="apps.website" defaultChecked /> Website
              </label>
            </div>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
          >
            Anlegen
          </button>
          <Link href="/backoffice/staff-central" className="text-sm font-semibold text-zinc-900 underline-offset-2 hover:underline">
            Abbrechen
          </Link>
        </div>
      </form>
    </main>
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
