import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { AuditAction, AuditActorType, Prisma } from "@prisma/client";
import { getTenantIdOrThrow } from "@/lib/tenant";

const requestSchema = z.object({
  description: z.string().max(2000),
  website: z.string().max(400).optional().default(""),
  facebook: z.string().max(400).optional().default(""),
  instagram: z.string().max(400).optional().default(""),
  xProfile: z.string().max(400).optional().default(""),
  newsletterText: z.string().max(400).optional().default(""),
  imprint: z.string().max(400).optional().default(""),
  customLegalText: z.boolean().optional().default(false),
  terms: z.string().max(400).optional().default(""),
  privacy: z.string().max(400).optional().default(""),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: tenantId, slug: location },
    select: { id: true, metadata: true },
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

  const metadataRecord: Record<string, unknown> =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? { ...(locationRecord.metadata as Record<string, unknown>) }
      : {};

  metadataRecord.companyProfile = payload;

  try {
    await prisma.location.update({
      where: { id: locationRecord.id },
      data: {
        metadata: metadataRecord as Prisma.JsonObject,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profil konnte nicht gespeichert werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "company_profile",
    entityId: locationRecord.id,
    diff: payload,
    context: { source: "company_profile" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ success: true });
}
