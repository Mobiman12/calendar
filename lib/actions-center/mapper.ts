import "server-only";

import { getPrismaClient } from "@/lib/prisma";

export type MerchantContext = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  locationId: string;
  locationSlug: string;
  locationName: string;
  timezone: string;
  currency: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

const prisma = getPrismaClient();

export function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

export function parseDateValue(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    const millis = trimmed.length > 10 ? numeric : numeric * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function resolveMerchantContext(params: {
  merchantId?: string | null;
  locationId?: string | null;
  tenantSlug?: string | null;
  locationSlug?: string | null;
}): Promise<MerchantContext | null> {
  const locationId = params.merchantId ?? params.locationId ?? null;

  const location = locationId
    ? await prisma.location.findFirst({
        where: { id: locationId },
        include: { tenant: { select: { id: true, slug: true, name: true } } },
      })
    : params.tenantSlug && params.locationSlug
      ? await prisma.location.findFirst({
          where: {
            slug: params.locationSlug,
            tenant: { slug: params.tenantSlug },
          },
          include: { tenant: { select: { id: true, slug: true, name: true } } },
        })
      : null;

  if (!location || !location.tenant) return null;

  return {
    tenantId: location.tenant.id,
    tenantSlug: location.tenant.slug,
    tenantName: location.tenant.name,
    locationId: location.id,
    locationSlug: location.slug,
    locationName: location.name,
    timezone: location.timezone,
    currency: location.currency,
    email: location.email ?? null,
    phone: location.phone ?? null,
    addressLine1: location.addressLine1 ?? null,
    addressLine2: location.addressLine2 ?? null,
    city: location.city ?? null,
    state: location.state ?? null,
    postalCode: location.postalCode ?? null,
    country: location.country ?? null,
  };
}
