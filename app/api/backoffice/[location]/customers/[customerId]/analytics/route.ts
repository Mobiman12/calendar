import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { fetchTillhubCustomerAnalytics } from "@/lib/tillhub-analytics";
import { readCustomerProfile } from "@/lib/customer-metadata";

const prisma = getPrismaClient();

function readTillhubCustomerId(
  metadata: Prisma.JsonValue | null,
  profile?: { customerNumber?: string | null },
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const tillhub = (metadata as Record<string, unknown>).tillhub;
  if (!tillhub || typeof tillhub !== "object" || Array.isArray(tillhub)) return null;
  const candidate =
    (tillhub as Record<string, unknown>).customerId ??
    (tillhub as Record<string, unknown>).id ??
    (tillhub as Record<string, unknown>).customer_id ??
    (tillhub as Record<string, unknown>).uuid ??
    null;
  if (typeof candidate === "string" && candidate.trim().length) return candidate.trim();
  const fallback = profile?.customerNumber ?? null;
  return typeof fallback === "string" && fallback.trim().length ? fallback.trim() : null;
}

function readTillhubAccountId(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const tillhub = (metadata as Record<string, unknown>).tillhub;
  if (!tillhub || typeof tillhub !== "object" || Array.isArray(tillhub)) return null;
  const candidate =
    (tillhub as Record<string, unknown>).accountId ??
    (tillhub as Record<string, unknown>).account_id ??
    (tillhub as Record<string, unknown>).clientAccountId ??
    (tillhub as Record<string, unknown>).clientId ??
    null;
  return typeof candidate === "string" && candidate.trim().length ? candidate.trim() : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string; customerId: string }> },
) {
  const { location, customerId } = await context.params;

  let tenantId: string;
  try {
    tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
  } catch {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  let locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, slug: true, currency: true },
  });
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({
      where: { slug: location },
      select: { id: true, slug: true, currency: true },
    });
  }
  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customerScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        id: customerId,
        OR: [
          { locationId: locationRecord.id },
          { memberships: { some: { locationId: locationRecord.id } } },
        ],
      }
    : { id: customerId, locationId: locationRecord.id };

  const customer = await prisma.customer.findFirst({
    where: customerScope,
    select: { id: true, metadata: true },
  });

  if (!customer) {
    return NextResponse.json({ error: "Kunde nicht gefunden." }, { status: 404 });
  }

  const profile = readCustomerProfile(customer.metadata ?? null);
  const tillhubCustomerId = readTillhubCustomerId(customer.metadata ?? null, profile);
  const tillhubAccountId = readTillhubAccountId(customer.metadata ?? null);

  const result = await fetchTillhubCustomerAnalytics({
    tenantId,
    customerId: tillhubCustomerId,
    customerNumber: profile?.customerNumber ?? null,
    accountId: tillhubAccountId,
    currency: locationRecord.currency ?? "EUR",
  });

  return NextResponse.json(result);
}
