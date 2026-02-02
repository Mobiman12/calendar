import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { getPrismaClient } from "@/lib/prisma";
import { AdminShell } from "@/components/layout/AdminShell";
import { syncStundenlisteBranches } from "@/lib/stundenliste-sync";
import { getTenantIdOrThrow, readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { resolvePermissionSnapshot } from "@/lib/role-permissions";

interface BackofficeLocationLayoutProps {
  children: ReactNode;
  params: Promise<{ location: string }>;
}

// In der lokalen Entwicklung (oder per ALLOW_ARCHIVED_LOCATIONS) dürfen archivierte Standorte sichtbar bleiben.
const allowArchivedLocations =
  (process.env.ALLOW_ARCHIVED_LOCATIONS || "").trim().toLowerCase() === "true" ||
  (process.env.ALLOW_ARCHIVED_LOCATIONS === undefined && process.env.NODE_ENV !== "production");

function isLocationArchived(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const stundenliste = (metadata as Record<string, unknown>).stundenliste;
  if (!stundenliste || typeof stundenliste !== "object" || Array.isArray(stundenliste)) {
    return false;
  }
  const removedAt = (stundenliste as Record<string, unknown>).removedAt;
  if (!removedAt) {
    return false;
  }
  return !allowArchivedLocations;
}

async function fetchLocations(tenantId?: string) {
  const prisma = getPrismaClient();
  const entries = await prisma.location.findMany(
    tenantId
      ? {
          where: { tenantId },
          select: { id: true, slug: true, name: true, metadata: true },
          orderBy: { createdAt: "asc" },
        }
      : {
          select: { id: true, slug: true, name: true, metadata: true },
          orderBy: { createdAt: "asc" },
        },
  );
  return entries
    .filter((entry) => !isLocationArchived(entry.metadata))
    .map(({ metadata, ...location }) => location);
}

async function fetchLocation(slug: string, tenantId?: string, allowTenantFallback = true) {
  const prisma = getPrismaClient();
  let entry = await prisma.location.findFirst({
    where: tenantId ? { slug, tenantId } : { slug },
    select: { id: true, slug: true, name: true, tenantId: true, metadata: true },
  });
  // Fallback ohne Tenant-Filter, falls kein Tenant-Kontext vorhanden ist.
  if (!entry && tenantId && allowTenantFallback) {
    entry = await prisma.location.findFirst({
      where: { slug },
      select: { id: true, slug: true, name: true, tenantId: true, metadata: true },
    });
  }
  if (!entry || isLocationArchived(entry.metadata)) {
    return null;
  }
  const { metadata, ...location } = entry;
  return location;
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

export default async function BackofficeLocationLayout({ children, params }: BackofficeLocationLayoutProps) {
  const { location } = await params;
  const hdrs = await headers();
  const session = await getSessionOrNull();
  const tenantContext = readTenantContext(hdrs);
  const tenantIdCandidate =
    tenantContext?.id ??
    session?.tenantId ??
    (await getTenantIdOrThrow(hdrs, { locationSlug: location }).catch(() => null)) ??
    process.env.DEFAULT_TENANT_ID ??
    undefined;
  const allowLocationFallback = !tenantContext?.id && !session?.tenantId;
  if (tenantIdCandidate) {
    await syncStundenlisteBranches(tenantIdCandidate);
  }
  const prisma = getPrismaClient();
  const currentLocation = await fetchLocation(location, tenantIdCandidate, allowLocationFallback);

  if (!currentLocation) {
    notFound();
  }

  const effectiveTenantId = currentLocation.tenantId;
  const [locations, tenantInfo, tenant, userRecord] = await Promise.all([
    fetchLocations(effectiveTenantId),
    effectiveTenantId ? fetchTenantInfo(effectiveTenantId) : Promise.resolve(null),
    effectiveTenantId ? prisma.tenant.findUnique({ where: { id: effectiveTenantId }, select: { name: true } }) : null,
    session?.userId
      ? prisma.user.findUnique({
          where: { id: session.userId },
          select: { email: true, role: true, metadata: true },
        })
      : Promise.resolve(null),
  ]);
  const safeLocations = locations.length ? locations : [currentLocation];
  const tenantLabel = tenantInfo?.slug ?? tenantInfo?.name ?? tenant?.name ?? effectiveTenantId ?? undefined;
  const userRole = userRecord?.role ?? session?.role ?? "ADMIN";
  const userName = userRecord?.email ?? "Angemeldeter Nutzer";
  const permissionSnapshot = await resolvePermissionSnapshot({
    session,
    tenantId: effectiveTenantId,
    userMetadata: userRecord?.metadata,
  });

  return (
      <AdminShell
        locations={safeLocations.map((entry) => ({
          slug: entry.slug,
          name: entry.name ?? entry.slug,
        }))}
        currentLocation={currentLocation.slug}
        user={{ name: userName, role: userRole, tenant: tenantLabel }}
        permissionKeys={permissionSnapshot.keys}
      >
        {children}
      </AdminShell>
    );
  }
