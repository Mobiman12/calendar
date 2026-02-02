"use server";

import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getPrismaClient } from "@/lib/prisma";
import { readTenantContext } from "@/lib/tenant";
import { readAppsEnabled } from "@/lib/staff-metadata";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";
import { StaffStatus } from "@prisma/client";

const prisma = getPrismaClient();

export default async function CentralStaffPage() {
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
        <h1 className="text-2xl font-semibold text-zinc-900">Mitarbeiterübersicht (zentral)</h1>
        <p className="text-sm text-red-600">Tenant-Kontext fehlt. Bitte über die passende Subdomain/App aufrufen.</p>
      </main>
    );
  }

  const [locations, staff] = await Promise.all([
    prisma.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, slug: true },
      orderBy: { name: "asc" },
    }),
    prisma.staff.findMany({
      where: { location: { tenantId } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
        phone: true,
        status: true,
        metadata: true,
        location: { select: { id: true, name: true, slug: true } },
        code: true,
      },
      orderBy: [{ createdAt: "asc" }],
    }),
  ]);

  return (
    <main className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Zentrale Mitarbeiter</p>
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="text-3xl font-semibold text-zinc-900">Mitarbeiterübersicht (zentral)</h1>
          <Link
            href="/backoffice/staff-central/new"
            className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
          >
            Neu anlegen
          </Link>
        </div>
        <p className="text-sm text-zinc-600">
          Zentrale Pflege aller Mitarbeiter über alle Apps (Kalender, Timeshift, Website). Lokale Bearbeitung pro Standort ist deaktiviert.
        </p>
      </header>

      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">E-Mail</th>
              <th className="px-4 py-3">Telefon</th>
              <th className="px-4 py-3">Standort</th>
              <th className="px-4 py-3">Apps</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Aktionen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {staff.map((member) => {
              const apps = readAppsEnabled(member.metadata);
              const name = (member.displayName || `${member.firstName} ${member.lastName}`).trim();
              const calendarRedirect = member.location?.slug
                ? `/backoffice/${member.location.slug}/calendar`
                : "/backoffice";
              const calendarHref = `/auth/staff-sso?staffId=${encodeURIComponent(member.id)}&redirect=${encodeURIComponent(
                calendarRedirect,
              )}`;
              const calendarEnabled = apps.calendar && Boolean(member.email);
              return (
                <tr key={member.id} className="hover:bg-zinc-50">
                  <td className="px-4 py-3 font-medium text-zinc-900">{name}</td>
                  <td className="px-4 py-3 text-zinc-600">{member.email ?? "–"}</td>
                  <td className="px-4 py-3 text-zinc-600">{member.phone ?? "–"}</td>
                  <td className="px-4 py-3 text-zinc-600">{member.location?.name ?? member.location?.slug ?? "–"}</td>
                  <td className="px-4 py-3 text-zinc-600">
                    <div className="flex flex-wrap gap-1">
                      <AppBadge active={apps.calendar}>Calendar</AppBadge>
                      <AppBadge active={apps.timeshift}>Timeshift</AppBadge>
                      <AppBadge active={apps.website}>Website</AppBadge>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <StatusBadge status={member.status} />
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <div className="flex flex-col gap-2">
                      <Link
                        href={`/backoffice/staff-central/${member.id}`}
                        className="text-sm font-semibold text-zinc-900 underline-offset-2 hover:underline"
                      >
                        Bearbeiten
                      </Link>
                      {calendarEnabled ? (
                        <Link
                          href={calendarHref}
                          className="text-xs font-semibold text-emerald-700 underline-offset-2 hover:underline"
                        >
                          Kalender öffnen
                        </Link>
                      ) : (
                        <span className="text-xs text-zinc-400">
                          {apps.calendar ? "E-Mail fehlt" : "Calendar deaktiviert"}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {staff.length === 0 && (
          <div className="px-6 py-10 text-center text-sm text-zinc-500">
            Noch keine Mitarbeiter angelegt. Lege den ersten Mitarbeiter zentral an.
          </div>
        )}
      </div>
    </main>
  );
}

function AppBadge({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) {
    return <span className="rounded-full border border-zinc-200 px-2 py-1 text-xs text-zinc-400 line-through">{children}</span>;
  }
  return <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">{children}</span>;
}

function StatusBadge({ status }: { status: StaffStatus }) {
  const map: Record<StaffStatus, string> = {
    ACTIVE: "Aktiv",
    INVITED: "Onboarding",
    LEAVE: "Abwesend",
    INACTIVE: "Inaktiv",
  };
  const style: Record<StaffStatus, string> = {
    ACTIVE: "bg-emerald-100 text-emerald-800",
    INVITED: "bg-sky-100 text-sky-800",
    LEAVE: "bg-amber-100 text-amber-800",
    INACTIVE: "bg-zinc-100 text-zinc-700",
  };
  return <span className={`rounded-full px-2 py-1 text-xs font-semibold ${style[status]}`}>{map[status]}</span>;
}
