export type TenantContext = {
  id: string;
  app: string;
  status: string;
  provisionMode?: string;
  trialEndsAt?: string;
  themePreset?: string;
  themeMode?: string;
};

export function readTenantContext(headers: Headers): TenantContext | null {
  const id = headers.get("x-tenant-id");
  const app = headers.get("x-app-type");
  const status = headers.get("x-tenant-status");

  if (!id || !app || !status) return null;

  return {
    id,
    app,
    status,
    provisionMode: headers.get("x-tenant-provision-mode") || undefined,
    trialEndsAt: headers.get("x-tenant-trial-ends") || undefined,
    themePreset: headers.get("x-tenant-theme") || undefined,
    themeMode: headers.get("x-tenant-theme-mode") || undefined,
  };
}

export function requireTenantContext(headers: Headers): TenantContext {
  const ctx = readTenantContext(headers);
  if (!ctx) {
    throw new Error("Tenant context missing: ensure middleware is active and headers are forwarded.");
  }
  return ctx;
}

import { getPrismaClient } from "./prisma";

/**
 * Resolve a tenantId, preferring middleware headers and falling back to the Location record.
 * Useful for backoffice routes where middleware headers may be missing in local/dev.
 */
export async function getTenantIdOrThrow(
  headers: Headers,
  opts?: { locationSlug?: string; locationId?: string },
): Promise<string> {
  const ctx = readTenantContext(headers);
  if (ctx?.id) return ctx.id;

  const prisma = getPrismaClient();
  const locationLookups = [];
  if (opts?.locationId) {
    locationLookups.push({ id: opts.locationId });
  }
  if (opts?.locationSlug) {
    locationLookups.push({ slug: opts.locationSlug });
  }

  for (const lookup of locationLookups) {
    try {
      const location = await prisma.location.findFirst({
        where: lookup,
        select: { tenantId: true },
      });
      if (location?.tenantId) return location.tenantId;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Unknown field `tenantId`")) {
        // Old client without tenantId: skip and try fallback
        continue;
      }
      throw error;
    }
  }

  const fallback = process.env.DEFAULT_TENANT_ID;
  if (fallback) return fallback;

  throw new Error("Tenant context missing and could not derive tenantId.");
}

export async function resolveTenantName(
  tenantId: string | null | undefined,
  fallback?: string | null,
): Promise<string | null> {
  const fallbackName = fallback && fallback.trim().length ? fallback.trim() : null;
  if (!tenantId) return fallbackName;

  const prisma = getPrismaClient();
  try {
    const rows = await prisma.$queryRaw<{ name: string | null; metadata: unknown }[]>`
      SELECT name, metadata
      FROM "control_plane"."Tenant"
      WHERE id = ${tenantId}
      LIMIT 1
    `;
    const row = rows[0];
    if (row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)) {
      const meta = row.metadata as Record<string, unknown>;
      const companyName = typeof meta.companyName === "string" ? meta.companyName.trim() : "";
      if (companyName.length) {
        return companyName;
      }
    }
    const name = row?.name?.trim();
    return name && name.length ? name : fallbackName;
  } catch {
    return fallbackName;
  }
}
