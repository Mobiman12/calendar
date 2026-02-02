import { LocationSettingsApp } from "@/components/dashboard/LocationSettingsApp";
import { getPrismaClient } from "@/lib/prisma";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";
import { resolveBookingTenant } from "@/lib/booking-tenant";

interface SettingsPageProps {
  params: Promise<{ location: string }>;
}

function parseTenantSlugFromHost(host: string | null): string | null {
  if (!host) return null;
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");
  if (parts.length < 3) return null;
  return parts[0] || null;
}

async function resolveTenantSlug(tenantId: string | undefined, host: string | null): Promise<string | null> {
  const hostSlug = parseTenantSlugFromHost(host);
  if (hostSlug) return hostSlug;
  if (!tenantId) return null;

  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return tenantId;

  try {
    const url = new URL("/api/internal/tenant/info", baseUrl);
    url.searchParams.set("tenantId", tenantId);
    const secret = process.env.PROVISION_SECRET?.trim();
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: secret ? { "x-provision-secret": secret } : undefined,
    });
    if (!response.ok) {
      return tenantId;
    }
    const payload = (await response.json()) as { tenantSlug?: string | null };
    return payload?.tenantSlug ?? tenantId;
  } catch {
    return tenantId;
  }
}

async function pickBookingTenantSlug({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string | null;
  tenantId: string | undefined;
}): Promise<string | null> {
  const candidates = [tenantSlug?.trim(), tenantId?.trim()].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const resolution = await resolveBookingTenant(candidate);
      if (resolution) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export default async function SettingsPage({ params }: SettingsPageProps) {
  const { location } = await params;
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const tenantContext = readTenantContext(hdrs);
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect(`/backoffice/${location}/calendar`);
  }
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  const selectLocation = {
    select: {
      id: true,
      slug: true,
      name: true,
      timezone: true,
      metadata: true,
    },
  } as const;

  let locationRecord = await prisma.location.findFirst(
    tenantId ? { where: { tenantId: tenantId, slug: location }, ...selectLocation } : { where: { slug: location }, ...selectLocation },
  );
  if (!locationRecord && tenantId) {
    // Fallback ohne Tenant-Filter (dev/debug), falls Header/Session nicht passt
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, ...selectLocation });
  }

  if (!locationRecord) {
    notFound();
  }

  const metadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(metadata?.bookingPreferences ?? null);
  const tenantSlug = await resolveTenantSlug(tenantId, hdrs.get("host"));
  const bookingTenantSlug = await pickBookingTenantSlug({ tenantSlug, tenantId });
  const bookingBaseUrl = (process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3002").replace(/\/$/, "");

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Standorteinstellungen</p>
        <h1 className="text-3xl font-semibold text-zinc-900">{locationRecord.name ?? locationRecord.slug}</h1>
        <p className="text-sm text-zinc-600">Globale Einstellungen für Online-Buchung, Benachrichtigungen und Zahlung.</p>
      </header>
      <LocationSettingsApp
        locationSlug={locationRecord.slug}
        tenantSlug={(bookingTenantSlug ?? locationRecord.slug) || undefined}
        bookingBaseUrl={bookingBaseUrl}
        initialPreferences={bookingPreferences}
      />
    </section>
  );
}
