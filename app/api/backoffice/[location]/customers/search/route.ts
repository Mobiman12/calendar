import { NextResponse } from "next/server";
import { ConsentScope, ConsentType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";

const prisma = getPrismaClient();

const digitsOnly = (value: string) => value.replace(/\D/g, "");

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const url = new URL(request.url);
  const query = String(url.searchParams.get("q") ?? "").trim();
  const limitParam = Number.parseInt(String(url.searchParams.get("limit") ?? ""), 10);
  const take = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, limitParam)) : 50;

  if (query.length < 2) {
    return NextResponse.json({ customers: [] });
  }

  let tenantId: string;
  try {
    tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
  } catch {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  let locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, slug: true },
  });
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({
      where: { slug: location },
      select: { id: true, slug: true },
    });
  }
  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customerScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        OR: [
          { locationId: locationRecord.id },
          { memberships: { some: { locationId: locationRecord.id } } },
        ],
      }
    : { locationId: locationRecord.id };

  const digits = digitsOnly(query);
  const searchFilters: Prisma.CustomerWhereInput[] = [
    { firstName: { contains: query, mode: "insensitive" } },
    { lastName: { contains: query, mode: "insensitive" } },
    { email: { contains: query, mode: "insensitive" } },
    { phone: { contains: query } },
  ];
  if (digits.length >= 4) {
    searchFilters.push({ phone: { contains: digits } });
  }

  const customers = await prisma.customer.findMany({
    where: {
      AND: [customerScope, { OR: searchFilters }],
    },
    take,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      consents: {
        where: {
          type: ConsentType.COMMUNICATION,
          scope: { in: [ConsentScope.EMAIL, ConsentScope.SMS, ConsentScope.WHATSAPP] },
        },
        select: { scope: true, granted: true },
      },
      _count: {
        select: { appointments: true },
      },
      appointments: {
        where: { locationId: locationRecord.id },
        orderBy: { startsAt: "desc" },
        take: 1,
        select: { startsAt: true, status: true },
      },
    },
  });

  const results = customers.map((customer) => {
    const consentSummary = {
      email: false,
      sms: false,
      whatsapp: false,
    };
    for (const consent of customer.consents ?? []) {
      if (!consent.granted) continue;
      switch (consent.scope) {
        case "EMAIL":
          consentSummary.email = true;
          break;
        case "SMS":
          consentSummary.sms = true;
          break;
        case "WHATSAPP":
          consentSummary.whatsapp = true;
          break;
        default:
          break;
      }
    }

    const lastAppointment = customer.appointments[0] ?? null;

    return {
      id: customer.id,
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      appointmentCount: customer._count.appointments ?? 0,
      lastAppointment: lastAppointment?.startsAt?.toISOString() ?? null,
      lastAppointmentStatus: lastAppointment?.status ?? null,
      consents: consentSummary,
    };
  });

  return NextResponse.json({ customers: results });
}
