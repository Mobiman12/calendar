import { getPrismaClient } from "@/lib/prisma";

type TenantResolution = {
  tenantId: string;
  tenantSlug: string;
};

async function fetchTenantSlug(tenantId: string): Promise<string | null> {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  const secret = process.env.PROVISION_SECRET?.trim();
  if (!baseUrl || !secret) return null;
  try {
    const url = new URL("/api/internal/tenant/info", baseUrl);
    url.searchParams.set("tenantId", tenantId);
    const response = await fetch(url.toString(), {
      cache: "no-store",
      headers: { "x-provision-secret": secret },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { tenantSlug?: string | null };
    const slug = typeof data?.tenantSlug === "string" ? data.tenantSlug.trim() : "";
    return slug || null;
  } catch {
    return null;
  }
}

export async function resolveBookingTenant(tenantParam: string): Promise<TenantResolution | null> {
  const candidate = tenantParam.trim();
  if (!candidate) return null;

  const prisma = getPrismaClient();
  const existing = await prisma.location.findFirst({
    where: { tenantId: candidate },
    select: { tenantId: true },
  });
  if (existing) {
    const canonicalSlug = await fetchTenantSlug(candidate);
    return { tenantId: candidate, tenantSlug: canonicalSlug ?? candidate };
  }

  let resolvedTenantId: string | null = null;
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (baseUrl) {
    try {
      const url = new URL("/api/internal/tenant/resolve", baseUrl);
      url.searchParams.set("tenant", candidate);
      url.searchParams.set("app", "booking");
      const secret = process.env.PROVISION_SECRET?.trim();
      const response = await fetch(url.toString(), {
        cache: "no-store",
        headers: secret ? { "x-provision-secret": secret } : undefined,
      });
      if (response.ok) {
        const data = (await response.json()) as { tenantId?: string | null };
        if (data?.tenantId) {
          resolvedTenantId = data.tenantId;
        }
      }
    } catch {
      // ignore resolver errors and fall back to local lookup
    }
  }

  if (resolvedTenantId) {
    const hasLocation = await prisma.location.findFirst({
      where: { tenantId: resolvedTenantId },
      select: { tenantId: true },
    });
    if (hasLocation) {
      const canonicalSlug = await fetchTenantSlug(resolvedTenantId);
      return { tenantId: resolvedTenantId, tenantSlug: canonicalSlug ?? candidate };
    }
  }

  const slugMatches = await prisma.location.findMany({
    where: { slug: candidate },
    select: { tenantId: true },
  });
  const uniqueTenantIds = Array.from(new Set(slugMatches.map((row) => row.tenantId)));
  if (uniqueTenantIds.length === 1) {
    const canonicalSlug = await fetchTenantSlug(uniqueTenantIds[0]);
    return { tenantId: uniqueTenantIds[0], tenantSlug: canonicalSlug ?? candidate };
  }

  return null;
}
