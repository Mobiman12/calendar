import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { formatPersonName } from "@/lib/staff/format-person-name";

const prisma = getPrismaClient();

const digitsOnly = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "");

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const url = new URL(request.url);
  const phoneParam = String(url.searchParams.get("phone") ?? "").trim();
  const rawParam = String(url.searchParams.get("raw") ?? "").trim();
  const lookupValue = phoneParam || rawParam;

  if (!lookupValue) {
    return NextResponse.json({ customer: null });
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

  const selectCustomer = {
    id: true,
    firstName: true,
    lastName: true,
    phone: true,
  } as const;

  let customer =
    (phoneParam
      ? await prisma.customer.findFirst({
          where: { ...customerScope, phone: phoneParam },
          select: selectCustomer,
        })
      : null) ||
    (rawParam
      ? await prisma.customer.findFirst({
          where: { ...customerScope, phone: rawParam },
          select: selectCustomer,
        })
      : null);

  if (!customer) {
    const digits = digitsOnly(lookupValue);
    const suffix = digits.length > 6 ? digits.slice(-6) : digits;
    if (suffix.length >= 4) {
      const candidates = await prisma.customer.findMany({
        where: {
          ...customerScope,
          phone: { contains: suffix },
        },
        select: selectCustomer,
        take: 25,
      });
      customer = candidates.find((entry) => digitsOnly(entry.phone) === digits) ?? null;
    }
  }

  if (!customer) {
    return NextResponse.json({ customer: null });
  }

  const lastItem = await prisma.appointmentItem.findFirst({
    where: {
      customerId: customer.id,
      appointment: { locationId: locationRecord.id },
    },
    orderBy: { startsAt: "desc" },
    select: { service: { select: { name: true } } },
  });

  const name = formatPersonName(customer.firstName, customer.lastName) ?? "Kunde";
  const detailUrl = `/backoffice/${locationRecord.slug}/customers?customer=${customer.id}`;

  return NextResponse.json({
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      phone: customer.phone ?? null,
      name,
      detailUrl,
      lastBookedService: lastItem?.service?.name ?? null,
    },
  });
}
