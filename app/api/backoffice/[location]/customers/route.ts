import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { createCustomerAction } from "@/app/backoffice/[location]/customers/actions";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  let locationRecord = await prisma.location.findFirst({
    where: { tenantId: tenantId, slug: location },
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

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Ungültige Eingabe." }, { status: 400 });
  }

  const { firstName = "", lastName = "", email = "", phone = "" } = body as Record<string, unknown>;

  const formData = new FormData();
  formData.append("firstName", String(firstName ?? ""));
  formData.append("lastName", String(lastName ?? ""));
  formData.append("email", String(email ?? ""));
  formData.append("phone", String(phone ?? ""));

  const result = await createCustomerAction(locationRecord.id, locationRecord.slug, formData);

  if (!result.success || !result.customer) {
    return NextResponse.json(
      { error: result.error ?? "Kunde konnte nicht gespeichert werden." },
      { status: 400 },
    );
  }

  return NextResponse.json({ customer: result.customer });
}
