import Link from "next/link";
import { notFound } from "next/navigation";

import { getPrismaClient } from "@/lib/prisma";
import { resolveBookingTenant } from "@/lib/booking-tenant";
import { deriveBookingPreferences } from "@/lib/booking-preferences";

export const revalidate = 0;
export const dynamic = "force-dynamic";

function isLocationArchived(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const stundenliste = (metadata as Record<string, unknown>).stundenliste;
  if (!stundenliste || typeof stundenliste !== "object" || Array.isArray(stundenliste)) return false;
  return Boolean((stundenliste as Record<string, unknown>).removedAt);
}

function isOnlineBookingEnabled(metadata: unknown): boolean {
  const prefs = deriveBookingPreferences(
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).bookingPreferences ?? null
      : null,
  );
  return prefs.onlineBookingEnabled;
}

export default async function TenantLandingPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  const prisma = getPrismaClient();
  const resolution = await resolveBookingTenant(tenant);
  if (!resolution) {
    notFound();
  }

  const locations = await prisma.location.findMany({
    where: { tenantId: resolution.tenantId },
    select: { id: true, slug: true, name: true, addressLine1: true, city: true, metadata: true },
    orderBy: { createdAt: "asc" },
  });

  const visibleLocations = locations.filter(
    (loc) => !isLocationArchived(loc.metadata) && isOnlineBookingEnabled(loc.metadata),
  );

  if (!visibleLocations.length) {
    notFound();
  }

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-6 py-12 text-zinc-900">
      <header className="mb-8 space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Online-Buchung</p>
        <h1 className="text-3xl font-semibold">Standort wählen</h1>
        <p className="text-sm text-zinc-600">
          Wähle einen Standort, um freie Termine zu sehen und deine Buchung abzuschließen.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {visibleLocations.map((location) => (
          <Link
            key={location.id}
            href={`/book/${resolution.tenantSlug}/${location.slug}`}
            className="group rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">{location.name ?? location.slug}</h2>
              <span className="text-xs uppercase tracking-wide text-zinc-500">Jetzt buchen</span>
            </div>
            <p className="mt-2 text-sm text-zinc-600">
              {location.addressLine1 ?? "Adresse folgt"}
              {location.city ? ` · ${location.city}` : ""}
            </p>
            <p className="mt-3 text-sm font-medium text-zinc-800">Zur Buchungsseite →</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
