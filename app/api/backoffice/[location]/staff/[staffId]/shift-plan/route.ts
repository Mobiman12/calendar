import { NextResponse } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { getShiftPlanClient, resolveShiftPlanStaffIdWithLookup } from "@/lib/shift-plan-client";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

const saveSchema = z.object({
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  days: z
    .array(
      z.object({
        isoDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        start: z.string().nullable().optional().transform((value) => value ?? null),
        end: z.string().nullable().optional().transform((value) => value ?? null),
        requiredPauseMinutes: z.number().int().min(0),
      }),
    )
    .min(1),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { staffId, location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });
  const locationRecord = await prisma.location.findFirst({
    where: { slug: location, tenantId },
    select: { id: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const staff = await prisma.staff.findFirst({
    where: {
      id: staffId,
      OR: [{ locationId: locationRecord.id }, { memberships: { some: { locationId: locationRecord.id } } }],
    },
    select: { id: true, code: true, metadata: true, email: true, firstName: true, lastName: true, displayName: true },
  });

  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month") ?? undefined;

  try {
    const client = getShiftPlanClient(tenantId);
    const shiftPlanStaffId = await resolveShiftPlanStaffIdWithLookup(client, staff);
    if (!shiftPlanStaffId) {
      return NextResponse.json({ error: "Schichtplan konnte nicht geladen werden." }, { status: 404 });
    }
    const plan = await client.getShiftPlan(shiftPlanStaffId, month);
    return NextResponse.json({ data: plan });
  } catch (error) {
    console.error("[shift-plan:get]", error);
    return NextResponse.json({ error: "Schichtplan konnte nicht geladen werden." }, { status: 502 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { staffId, location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });
  const locationRecord = await prisma.location.findFirst({
    where: { slug: location, tenantId },
    select: { id: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const staff = await prisma.staff.findFirst({
    where: {
      id: staffId,
      OR: [{ locationId: locationRecord.id }, { memberships: { some: { locationId: locationRecord.id } } }],
    },
    select: { id: true, code: true, metadata: true, email: true, firstName: true, lastName: true, displayName: true },
  });

  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof saveSchema>;
  try {
    payload = saveSchema.parse(await request.json());
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabedaten";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const client = getShiftPlanClient(tenantId);
    const shiftPlanStaffId = await resolveShiftPlanStaffIdWithLookup(client, staff);
    if (!shiftPlanStaffId) {
      return NextResponse.json({ error: "Schichtplan konnte nicht gespeichert werden." }, { status: 404 });
    }
    const plan = await client.saveShiftPlan(shiftPlanStaffId, payload);
    return NextResponse.json({ data: plan });
  } catch (error) {
    console.error("[shift-plan:save]", error);
    return NextResponse.json({ error: "Schichtplan konnte nicht gespeichert werden." }, { status: 502 });
  }
}
