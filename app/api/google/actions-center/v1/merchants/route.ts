import { NextRequest } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { jsonResponse, verifyActionsCenterRequest } from "@/lib/actions-center/auth";
import { resolveMerchantContext } from "@/lib/actions-center/mapper";

export const dynamic = "force-dynamic";

const prisma = getPrismaClient();

function formatMerchant(merchant: Awaited<ReturnType<typeof resolveMerchantContext>>) {
  if (!merchant) return null;
  return {
    merchantId: merchant.locationId,
    name: `${merchant.tenantName} - ${merchant.locationName}`,
    locationName: merchant.locationName,
    tenantName: merchant.tenantName,
    timeZone: merchant.timezone,
    phoneNumber: merchant.phone,
    email: merchant.email,
    address: {
      streetAddress: [merchant.addressLine1, merchant.addressLine2].filter(Boolean),
      locality: merchant.city,
      region: merchant.state,
      postalCode: merchant.postalCode,
      country: merchant.country,
    },
  };
}

export async function GET(req: NextRequest) {
  const auth = await verifyActionsCenterRequest(req);
  if (!auth.ok) return auth.response;

  const searchParams = new URL(req.url).searchParams;
  const merchantId = searchParams.get("merchantId") ?? searchParams.get("merchant_id");
  const tenantSlug = searchParams.get("tenant") ?? searchParams.get("tenantSlug");
  const locationSlug = searchParams.get("location") ?? searchParams.get("locationSlug");

  if (merchantId || (tenantSlug && locationSlug)) {
    const merchant = await resolveMerchantContext({
      merchantId,
      tenantSlug,
      locationSlug,
    });
    if (!merchant) {
      return jsonResponse(auth.requestId, { error: "merchant_not_found" }, { status: 404 });
    }
    return jsonResponse(auth.requestId, { merchants: [formatMerchant(merchant)] });
  }

  const locations = await prisma.location.findMany({
    include: { tenant: { select: { id: true, slug: true, name: true } } },
  });

  const merchants = locations
    .filter((location) => location.tenant)
    .map((location) =>
      formatMerchant({
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
      }),
    )
    .filter((merchant) => merchant !== null);

  return jsonResponse(auth.requestId, { merchants });
}
