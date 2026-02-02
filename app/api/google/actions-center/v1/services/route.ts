import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { jsonResponse, verifyActionsCenterRequest } from "@/lib/actions-center/auth";
import { resolveMerchantContext, readStringArray } from "@/lib/actions-center/mapper";

export const dynamic = "force-dynamic";

const prisma = getPrismaClient();

export async function GET(req: NextRequest) {
  const auth = await verifyActionsCenterRequest(req);
  if (!auth.ok) return auth.response;

  const searchParams = new URL(req.url).searchParams;
  const merchantId = searchParams.get("merchantId") ?? searchParams.get("merchant_id");
  const locationId = searchParams.get("locationId");
  const tenantSlug = searchParams.get("tenant") ?? searchParams.get("tenantSlug");
  const locationSlug = searchParams.get("location") ?? searchParams.get("locationSlug");
  const rawServiceIds = [
    ...searchParams.getAll("serviceId"),
    ...searchParams.getAll("service_id"),
    ...searchParams.getAll("service"),
    ...searchParams.getAll("services"),
    ...searchParams.getAll("serviceIds"),
    ...searchParams.getAll("service_ids"),
  ];
  const serviceIds = rawServiceIds.flatMap((entry) => readStringArray(entry));

  let resolvedLocationId: string | null = merchantId ?? locationId ?? null;
  if (!resolvedLocationId && tenantSlug && locationSlug) {
    const context = await resolveMerchantContext({ tenantSlug, locationSlug });
    if (!context) {
      return jsonResponse(auth.requestId, { error: "merchant_not_found" }, { status: 404 });
    }
    resolvedLocationId = context.locationId;
  }

  const where: Prisma.ServiceWhereInput = {
    status: "ACTIVE",
    duration: { gt: 0 },
  };

  if (resolvedLocationId) {
    where.locationId = resolvedLocationId;
  }
  if (serviceIds.length) {
    where.id = { in: serviceIds };
  }

  const services = await prisma.service.findMany({
    where,
    include: {
      category: { select: { id: true, name: true } },
      steps: { orderBy: { order: "asc" } },
    },
  });

  const formatted = services.map((service) => ({
    serviceId: service.id,
    merchantId: service.locationId,
    name: service.name,
    durationMins: service.duration + service.bufferBefore + service.bufferAfter,
    baseDurationMins: service.duration,
    bufferBeforeMins: service.bufferBefore,
    bufferAfterMins: service.bufferAfter,
    price: {
      amount: Number(service.basePrice),
      currencyCode: service.priceCurrency,
    },
    category: service.category?.name ?? null,
    maxParticipants: service.maxParticipants,
    stepCount: service.steps.length,
  }));

  return jsonResponse(auth.requestId, { services: formatted });
}
