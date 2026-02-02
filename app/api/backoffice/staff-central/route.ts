import { NextResponse } from "next/server";
import { z } from "zod";
import { StaffStatus, type Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { readTenantContext, requireTenantContext } from "@/lib/tenant";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { normalizeString, readAppsEnabled, writeAppsEnabled } from "@/lib/staff-metadata";
import { isCentralStaffEditingEnabled, STAFF_EDITING_DISABLED_MESSAGE } from "@/lib/staff-management";

const prisma = getPrismaClient();

const createSchema = z.object({
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  displayName: z.string().max(120).optional().or(z.literal("")).transform((v) => v || null),
  email: z.string().email().optional().or(z.literal("")).transform((v) => v || null),
  phone: z.string().max(50).optional().or(z.literal("")).transform((v) => v || null),
  color: z.string().max(20).optional().or(z.literal("")).transform((v) => v || null),
  status: z.nativeEnum(StaffStatus).optional().default(StaffStatus.ACTIVE),
  locationId: z.string().min(1),
  apps: z
    .object({
      calendar: z.boolean().optional(),
      timeshift: z.boolean().optional(),
      website: z.boolean().optional(),
    })
    .optional(),
});

async function parsePayload(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return request.json();
  }
  const form = await request.formData();
  const obj: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
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

export async function GET(request: Request) {
  const hdrs = new Headers(request.headers);
  const tenant = readTenantContext(hdrs);
  const tenantId = tenant?.id ?? process.env.DEFAULT_TENANT_ID;
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant-Kontext fehlt." }, { status: 400 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staff = await prisma.staff.findMany({
    where: membershipSupported
      ? { memberships: { some: { location: { tenantId } } } }
      : { location: { tenantId } },
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
      location: { select: { id: true, name: true, slug: true } },
      memberships: membershipSupported
        ? {
            select: {
              location: { select: { id: true, slug: true, name: true } },
            },
          }
        : false,
    },
    orderBy: [{ createdAt: "asc" }],
  });

  const data = staff.map((entry) => {
    const apps = readAppsEnabled(entry.metadata);
    return {
      id: entry.id,
      code: entry.code,
      firstName: entry.firstName,
      lastName: entry.lastName,
      displayName: entry.displayName,
      email: entry.email,
      phone: entry.phone,
      color: entry.color,
      status: entry.status,
      location: entry.location,
      memberships: Array.isArray(entry.memberships) ? entry.memberships : [],
      apps,
    };
  });

  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  if (!isCentralStaffEditingEnabled()) {
    return NextResponse.json({ error: STAFF_EDITING_DISABLED_MESSAGE }, { status: 403 });
  }

  const hdrs = new Headers(request.headers);
  const tenantId = readTenantContext(hdrs)?.id ?? process.env.DEFAULT_TENANT_ID;
  if (!tenantId) {
    return NextResponse.json({ error: "Tenant-Kontext fehlt." }, { status: 400 });
  }

  let payload: z.infer<typeof createSchema>;
  try {
    payload = createSchema.parse(await parsePayload(request));
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const location = await prisma.location.findFirst({
    where: { id: payload.locationId, tenantId },
    select: { id: true },
  });
  if (!location) {
    return NextResponse.json({ error: "Standort wurde nicht gefunden." }, { status: 400 });
  }

  const appsEnabled = {
    calendar: payload.apps?.calendar ?? true,
    timeshift: payload.apps?.timeshift ?? true,
    website: payload.apps?.website ?? true,
  };

  const metadata = writeAppsEnabled(null, payload.apps ?? {});

  const staff = await prisma.staff.create({
    data: {
      firstName: payload.firstName.trim(),
      lastName: payload.lastName.trim(),
      displayName: normalizeString(payload.displayName),
      email: normalizeString(payload.email),
      phone: normalizeString(payload.phone),
      color: normalizeString(payload.color),
      status: payload.status,
      locationId: location.id,
      metadata: metadata as Prisma.InputJsonValue,
    },
    select: { id: true, code: true, firstName: true, lastName: true },
  });

  return NextResponse.json({ data: { ...staff, apps: appsEnabled } }, { status: 201 });
}
