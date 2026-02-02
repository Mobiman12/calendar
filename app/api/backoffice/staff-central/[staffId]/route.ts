import { NextResponse } from "next/server";
import { z } from "zod";
import { StaffStatus, type Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { readTenantContext, requireTenantContext } from "@/lib/tenant";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { normalizeString, readAppsEnabled, writeAppsEnabled } from "@/lib/staff-metadata";
import { isCentralStaffEditingEnabled, STAFF_EDITING_DISABLED_MESSAGE } from "@/lib/staff-management";

const prisma = getPrismaClient();

const updateSchema = z
  .object({
    firstName: z.string().min(1).max(120).optional(),
    lastName: z.string().min(1).max(120).optional(),
    displayName: z.string().max(120).optional().or(z.literal("")).transform((v) => v ?? undefined),
    email: z.string().email().optional().or(z.literal("")).transform((v) => v ?? undefined),
    phone: z.string().max(50).optional().or(z.literal("")).transform((v) => v ?? undefined),
    color: z.string().max(20).optional().or(z.literal("")).transform((v) => v ?? undefined),
    status: z.nativeEnum(StaffStatus).optional(),
    locationId: z.string().min(1).optional(),
    apps: z
      .object({
        calendar: z.boolean().optional(),
        timeshift: z.boolean().optional(),
        website: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Keine Änderungen übermittelt." });

async function parsePayload(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await request.json();
    if (typeof body === "object" && body && (body as any)._method === "PATCH") {
      delete (body as any)._method;
    }
    return body;
  }
  const form = await request.formData();
  const obj: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key === "_method") continue;
    if (key === "apps.calendar") {
      obj.apps = obj.apps || {};
      (obj.apps as Record<string, unknown>).calendar = value === "on" || value === "true";
    } else if (key === "apps.timeshift") {
      obj.apps = obj.apps || {};
      (obj.apps as Record<string, unknown>).timeshift = value === "on" || value === "true";
    } else if (key === "apps.website") {
      obj.apps = obj.apps || {};
      (obj.apps as Record<string, unknown>).website = value === "on" || value === "true";
    } else {
      obj[key] = typeof value === "string" ? value : undefined;
    }
  }
  return obj;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ staffId: string }> },
) {
  const { staffId } = await context.params;
  const hdrs = new Headers(request.headers);
  const tenant = readTenantContext(hdrs);
  const tenantId = tenant?.id ?? process.env.DEFAULT_TENANT_ID;
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant-Kontext fehlt." }, { status: 400 });
  }
  const membershipSupported = await supportsStaffMemberships(prisma);
  const staff = await prisma.staff.findFirst({
    where: membershipSupported
      ? { id: staffId, memberships: { some: { location: { tenantId } } } }
      : { id: staffId, location: { tenantId } },
    select: {
      id: true,
      code: true,
      firstName: true,
      lastName: true,
      displayName: true,
      email: true,
      phone: true,
      color: true,
      status: true,
      metadata: true,
      locationId: true,
    },
  });
  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter wurde nicht gefunden." }, { status: 404 });
  }
  const apps = readAppsEnabled(staff.metadata);
  return NextResponse.json({ data: { ...staff, apps } });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ staffId: string }> },
) {
  if (!isCentralStaffEditingEnabled()) {
    return NextResponse.json({ error: STAFF_EDITING_DISABLED_MESSAGE }, { status: 403 });
  }

  const { staffId } = await context.params;
  const hdrs = new Headers(request.headers);
  const tenantId = readTenantContext(hdrs)?.id ?? process.env.DEFAULT_TENANT_ID;
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant-Kontext fehlt." }, { status: 400 });
  }

  let payload: z.infer<typeof updateSchema>;
  try {
    payload = updateSchema.parse(await parsePayload(request));
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staff = await prisma.staff.findFirst({
    where: membershipSupported
      ? { id: staffId, memberships: { some: { location: { tenantId } } } }
      : { id: staffId, location: { tenantId } },
    select: { id: true, locationId: true, metadata: true },
  });
  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter wurde nicht gefunden." }, { status: 404 });
  }

  const data: Prisma.StaffUpdateInput = {};

  if (payload.firstName !== undefined) data.firstName = payload.firstName.trim();
  if (payload.lastName !== undefined) data.lastName = payload.lastName.trim();
  if (payload.displayName !== undefined) data.displayName = normalizeString(payload.displayName);
  if (payload.email !== undefined) data.email = normalizeString(payload.email);
  if (payload.phone !== undefined) data.phone = normalizeString(payload.phone);
  if (payload.color !== undefined) data.color = normalizeString(payload.color);
  if (payload.status !== undefined) data.status = payload.status;

  let targetLocationId = staff.locationId;
  if (payload.locationId && payload.locationId !== staff.locationId) {
    const targetLoc = await prisma.location.findFirst({
      where: { id: payload.locationId, tenantId },
      select: { id: true },
    });
    if (!targetLoc) {
      return NextResponse.json({ error: "Ziel-Standort wurde nicht gefunden." }, { status: 400 });
    }
    targetLocationId = targetLoc.id;
    data.location = { connect: { id: targetLoc.id } };
  }

  if (payload.apps) {
    data.metadata = writeAppsEnabled(staff.metadata ?? null, payload.apps);
  }

  await prisma.staff.update({
    where: { id: staffId },
    data,
  });

  return NextResponse.json({ data: { id: staffId, locationId: targetLocationId } });
}

// Form POST Fallback (method override)
export async function POST(
  request: Request,
  context: { params: Promise<{ staffId: string }> },
) {
  return PATCH(request, context);
}
