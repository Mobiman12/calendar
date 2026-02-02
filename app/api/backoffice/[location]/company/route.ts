import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { AuditAction, AuditActorType, Prisma } from "@prisma/client";
import { getTenantIdOrThrow } from "@/lib/tenant";

const requestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().max(60).optional().or(z.literal("")),
  addressLine1: z.string().max(200).optional().or(z.literal("")),
  addressLine2: z.string().max(200).optional().or(z.literal("")),
  postalCode: z.string().max(20).optional().or(z.literal("")),
  city: z.string().max(120).optional().or(z.literal("")),
  country: z.string().max(120).optional().or(z.literal("")),
  timezone: z.string().min(1).max(120),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: tenantId, slug: location },
    select: {
      id: true,
      metadata: true,
      tenantId: true,
    },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const metadataRecord = extractMetadata(locationRecord.metadata);
  const profileRecord = extractProfile(metadataRecord);
  const trimmedName = payload.name.trim();
  profileRecord.customName = true;
  profileRecord.displayName = trimmedName;
  metadataRecord.companyProfile = profileRecord;

  try {
    await prisma.location.update({
      where: { id: locationRecord.id },
      data: {
        name: trimmedName,
        email: payload.email?.trim() || null,
        phone: payload.phone?.trim() || null,
        addressLine1: payload.addressLine1?.trim() || null,
        addressLine2: payload.addressLine2?.trim() || null,
        postalCode: payload.postalCode?.trim() || null,
        city: payload.city?.trim() || null,
        country: payload.country?.trim() || null,
        timezone: payload.timezone,
        metadata: metadataRecord as Prisma.JsonObject,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Konnte nicht gespeichert werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "company_settings",
    entityId: locationRecord.id,
    diff: payload,
    context: { source: "company_settings" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ success: true });
}

function extractMetadata(value: unknown): Record<string, unknown> {
  if (!value || value === Prisma.JsonNull || value === Prisma.DbNull) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function extractProfile(metadata: Record<string, unknown>): Record<string, unknown> {
  const profile = metadata.companyProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return {};
  }
  return { ...(profile as Record<string, unknown>) };
}
