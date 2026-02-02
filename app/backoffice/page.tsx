"use server";

import { notFound } from "next/navigation";
import Link from "next/link";

import { getPrismaClient } from "@/lib/prisma";
import { AdminShell } from "@/components/layout/AdminShell";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

async function getLocations(tenantId?: string) {
  const prisma = getPrismaClient();
  const entries = await prisma.location.findMany({
    where: tenantId ? { tenantId } : undefined,
    select: { id: true, slug: true, name: true, tenantId: true },
    orderBy: { createdAt: "asc" },
  });
  if (!entries.length && tenantId) {
    // Fallback ohne Filter (dev/debug), falls Session/Headers keinen Tenant liefern
    return prisma.location.findMany({
      select: { id: true, slug: true, name: true, tenantId: true },
      orderBy: { createdAt: "asc" },
    });
  }
  return entries;
}

async function fetchTenantInfo(
  tenantId: string,
): Promise<{ name: string | null; slug: string | null } | null> {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return null;
  const url = new URL("/api/internal/tenant/info", baseUrl);
  url.searchParams.set("tenantId", tenantId);
  const secret = process.env.PROVISION_SECRET?.trim();
  try {
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: secret ? { "x-provision-secret": secret } : undefined,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { tenantName?: string | null; tenantSlug?: string | null } | null;
    return { name: payload?.tenantName ?? null, slug: payload?.tenantSlug ?? null };
  } catch {
    return null;
  }
}

export default async function BackofficeIndexPage() {
  const session = await getSessionOrNull();
  const userName = session ? "Angemeldeter Nutzer" : "Admin Nutzer";
  const userRole = session?.role ?? "ADMIN";
  const isAdmin = isAdminRole(userRole);
  const tenantId = session?.tenantId ?? process.env.DEFAULT_TENANT_ID ?? "legacy";
  const prisma = getPrismaClient();
  const [tenantInfo, tenantRecord] = await Promise.all([
    typeof tenantId === "string" ? fetchTenantInfo(tenantId) : Promise.resolve(null),
    typeof tenantId === "string"
      ? prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
      : Promise.resolve(null),
  ]);
  const tenantLabel = tenantInfo?.slug ?? tenantInfo?.name ?? tenantRecord?.name ?? tenantId ?? undefined;
  const locations = await getLocations(tenantId);
  if (!locations.length) {
    notFound();
  }

  return (
    <AdminShell
        locations={locations.map((location) => ({
          slug: location.slug,
          name: location.name ?? location.slug,
        }))}
        currentLocation={locations[0].slug}
        user={{ name: userName, role: userRole, tenant: tenantLabel }}
      >
      <section className="space-y-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-widest text-zinc-500">Backoffice</p>
          <h1 className="text-3xl font-semibold text-zinc-900">Willkommen zurück</h1>
          <p className="text-sm text-zinc-600">
            Wähle einen Bereich aus der Navigation, um Termine, Kund:innen oder Kampagnen zu verwalten.
          </p>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <QuickActionCard
            title="Kalender öffnen"
            description="Wochenansicht mit Drag-&-Drop, Termin-Erstellung und Konfliktprüfung."
            href={`/backoffice/${locations[0].slug}/calendar`}
          />
          <QuickActionCard
            title="Kundenübersicht"
            description="Kundenprofile, Einwilligungen und Segmentierung verwalten."
            href={`/backoffice/${locations[0].slug}/customers`}
          />
          {isAdmin ? (
            <QuickActionCard
              title="Marketing planen"
              description="E-Mail-/SMS-Kampagnen erstellen, Kennzahlen prüfen und automatisieren."
              href={`/backoffice/${locations[0].slug}/marketing`}
            />
          ) : null}
          {isAdmin ? (
            <QuickActionCard
              title="Mitarbeiter zentral"
              description="Mitarbeiter einmalig pflegen und für Calendar/Timeshift/Website freigeben."
              href={`/backoffice/staff-central`}
            />
          ) : null}
        </div>
      </section>
    </AdminShell>
  );
}

function QuickActionCard({ title, description, href }: { title: string; description: string; href: string }) {
  return (
    <Link
      href={href}
      className="group flex h-full flex-col justify-between rounded-lg border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-zinc-900 hover:shadow-md"
    >
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
        <p className="mt-2 text-sm text-zinc-600">{description}</p>
      </div>
      <span className="mt-4 text-xs font-semibold uppercase tracking-widest text-zinc-500 group-hover:text-zinc-900">
        Bereich öffnen →
      </span>
    </Link>
  );
}
