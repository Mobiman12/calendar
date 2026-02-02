import { NextResponse } from "next/server";
import { ConsentScope, ConsentType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";

const prisma = getPrismaClient();

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
        id: customerId,
        OR: [
          { locationId: locationRecord.id },
          { memberships: { some: { locationId: locationRecord.id } } },
        ],
      }
    : { id: customerId, locationId: locationRecord.id };

  const customer = await prisma.customer.findFirst({
    where: customerScope,
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

  if (!customer) {
    return NextResponse.json({ error: "Kunde nicht gefunden." }, { status: 404 });
  }

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

  return NextResponse.json({
    customer: {
      id: customer.id,
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      appointmentCount: customer._count.appointments ?? 0,
      lastAppointment: lastAppointment?.startsAt?.toISOString() ?? null,
      lastAppointmentStatus: lastAppointment?.status ?? null,
      consents: consentSummary,
    },
  });
}
