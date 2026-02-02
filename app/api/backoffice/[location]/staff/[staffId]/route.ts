import { NextResponse } from "next/server";
import { z } from "zod";
import { StaffStatus, AuditAction, AuditActorType, type Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { supportsStaffMemberships } from "@/lib/staff-memberships";

const prisma = getPrismaClient();

const metadataSchema = z
  .object({
    profileImageUrl: z
      .union([
        z
          .string()
          .max(2048)
          .trim()
          .optional()
          .transform((value) => (value && value.length ? value : null)),
        z.null(),
      ])
      .optional(),
    onlineBookingEnabled: z.boolean().optional(),
    serviceIds: z.array(z.string().min(1)).optional(),
  })
  .partial()
  .optional();

const updateSchema = z
  .object({
    firstName: z.string().min(1).max(120).optional(),
    lastName: z.string().min(1).max(120).optional(),
    displayName: z.string().max(120).optional(),
    email: z
      .string()
      .email()
      .optional()
      .or(z.literal(""))
      .transform((value) => (value === "" ? null : value)),
    phone: z
      .string()
      .max(50)
      .optional()
      .or(z.literal(""))
      .transform((value) => (value === "" ? null : value)),
    color: z
      .string()
      .max(20)
      .optional()
      .or(z.literal(""))
      .transform((value) => (value === "" ? null : value)),
    status: z.nativeEnum(StaffStatus).optional(),
    bio: z
      .string()
      .max(3000)
      .optional()
      .or(z.literal(""))
      .transform((value) => (value === "" ? null : value)),
    locationId: z.string().min(1).optional(),
    locationIds: z.array(z.string().min(1)).optional(),
    metadata: metadataSchema,
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Keine Änderungen übermittelt." });

async function syncStaffLocationsToControlPlane(params: {
  staffId: string;
  tenantId: string;
  locationIds: string[];
}) {
  if (!params.locationIds.length) return;
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim() || "http://localhost:3003";
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const secret = process.env.PROVISION_SECRET?.trim();
  if (!trimmedBase) return;
  try {
    const res = await fetch(`${trimmedBase}/api/internal/staff/locations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-provision-secret": secret } : {}),
      },
      body: JSON.stringify({
        staffId: params.staffId,
        tenantId: params.tenantId,
        locationIds: params.locationIds,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[staff-locations] control-plane sync failed", {
        status: res.status,
        staffId: params.staffId,
        tenantId: params.tenantId,
        error: text,
      });
    }
  } catch (error) {
    console.error("[staff-locations] control-plane sync failed", error);
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { location, staffId } = await context.params;

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = membershipSupported
    ? {
        id: staffId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: staffId, location: { slug: location } };

  const staff = await prisma.staff.findFirst({
    where: staffScope,
    select: {
      id: true,
      code: true,
      locationId: true,
      firstName: true,
      lastName: true,
      displayName: true,
      email: true,
      phone: true,
      color: true,
      status: true,
      bio: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
      appointmentItems: {
        where: { startsAt: { gte: new Date() } },
        orderBy: { startsAt: "asc" },
        take: 5,
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          status: true,
          service: { select: { id: true, name: true } },
        },
      },
      _count: {
        select: {
          appointmentItems: true,
          notifications: true,
        },
      },
    },
  });

  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      ...staff,
      appointmentCount: staff._count?.appointmentItems ?? 0,
      notificationCount: staff._count?.notifications ?? 0,
    },
  });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { location, staffId } = await context.params;

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = membershipSupported
    ? {
        id: staffId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: staffId, location: { slug: location } };

  const staffRecord = await prisma.staff.findFirst({
    where: staffScope,
    select: { id: true, locationId: true, metadata: true, location: { select: { tenantId: true } } },
  });

  if (!staffRecord) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof updateSchema>;
  try {
    const body = await request.json();
    payload = updateSchema.parse(body);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const data: Prisma.StaffUpdateInput = {};
    let targetLocationId = staffRecord.locationId;
    let normalizedLocationIds: string[] | null = null;
    let metadataForResponse: Record<string, unknown> | null = null;

    if (payload.firstName !== undefined) data.firstName = payload.firstName.trim();
    if (payload.lastName !== undefined) data.lastName = payload.lastName.trim();
    if (payload.displayName !== undefined) {
      const value = payload.displayName.trim();
      data.displayName = value.length ? value : null;
    }
    if (payload.email !== undefined) data.email = payload.email;
    if (payload.phone !== undefined) data.phone = payload.phone;
    if (payload.color !== undefined) data.color = payload.color;
    if (payload.status !== undefined) data.status = payload.status;
    if (payload.bio !== undefined) data.bio = payload.bio;
    const requestedLocationIds = payload.locationIds
      ? payload.locationIds.map((id) => id.trim()).filter(Boolean)
      : payload.locationId
        ? [payload.locationId.trim()]
        : null;
    if (requestedLocationIds && requestedLocationIds.length === 0) {
      return NextResponse.json({ error: "Mindestens ein Standort muss ausgewählt werden." }, { status: 400 });
    }
    if (requestedLocationIds) {
      const uniqueRequested = Array.from(new Set(requestedLocationIds));
      const tenantId = staffRecord.location?.tenantId ?? null;
      const locations = await prisma.location.findMany({
        where: tenantId
          ? { id: { in: uniqueRequested }, tenantId }
          : { id: { in: uniqueRequested } },
        select: { id: true },
      });
      if (locations.length !== uniqueRequested.length) {
        return NextResponse.json({ error: "Mindestens ein ausgewählter Standort wurde nicht gefunden." }, { status: 400 });
      }
      normalizedLocationIds = uniqueRequested;
      targetLocationId = normalizedLocationIds[0] ?? staffRecord.locationId;
      if (targetLocationId && targetLocationId !== staffRecord.locationId) {
        data.location = { connect: { id: targetLocationId } };
      }
    }

    if (payload.metadata) {
      const currentMetadata =
        staffRecord.metadata && typeof staffRecord.metadata === "object"
          ? { ...(staffRecord.metadata as Record<string, unknown>) }
          : {};
      let metadataChanged = false;

      if (Object.prototype.hasOwnProperty.call(payload.metadata, "profileImageUrl")) {
        currentMetadata.profileImageUrl = payload.metadata.profileImageUrl ?? null;
        metadataChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(payload.metadata, "onlineBookingEnabled")) {
        currentMetadata.onlineBookingEnabled = payload.metadata.onlineBookingEnabled ?? false;
        metadataChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(payload.metadata, "serviceIds")) {
        currentMetadata.serviceIds = payload.metadata.serviceIds ?? [];
        metadataChanged = true;
      }

      if (metadataChanged) {
        metadataForResponse = currentMetadata;
        data.metadata = currentMetadata as Prisma.InputJsonValue;
      }
    }

    const updated = await prisma.staff.update({
      where: { id: staffRecord.id },
      data,
      select: {
        id: true,
        code: true,
        locationId: true,
        firstName: true,
        lastName: true,
        displayName: true,
        email: true,
        phone: true,
        color: true,
        status: true,
        bio: true,
        metadata: true,
        updatedAt: true,
      },
    });

    if (membershipSupported && normalizedLocationIds) {
      const locationsToKeep = normalizedLocationIds;
      await prisma.staffLocationMembership.deleteMany({
        where: { staffId: staffRecord.id, locationId: { notIn: locationsToKeep } },
      });
      const existing = await prisma.staffLocationMembership.findMany({
        where: { staffId: staffRecord.id, locationId: { in: locationsToKeep } },
        select: { locationId: true },
      });
      const existingSet = new Set(existing.map((entry) => entry.locationId));
      const toCreate = locationsToKeep
        .filter((locationId) => !existingSet.has(locationId))
        .map((locationId) => ({ staffId: staffRecord.id, locationId, role: "member" }));
      if (toCreate.length) {
        await prisma.staffLocationMembership.createMany({ data: toCreate, skipDuplicates: true });
      }
    }

    if (normalizedLocationIds && staffRecord.location?.tenantId) {
      await syncStaffLocationsToControlPlane({
        staffId: staffRecord.id,
        tenantId: staffRecord.location.tenantId,
        locationIds: normalizedLocationIds,
      });
    }

    await logAuditEvent({
      locationId: targetLocationId,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "staff",
      entityId: staffRecord.id,
      appointmentId: null,
      diff: {
        updated,
      },
      context: { source: "backoffice_staff_update" },
      ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
      userAgent: request.headers.get("user-agent") ?? null,
    });

    const responseData = {
      ...updated,
      metadata: metadataForResponse ?? updated.metadata,
      locationIds: normalizedLocationIds ?? undefined,
    };

    return NextResponse.json({ data: responseData });
  } catch (error) {
    console.error("[staff:update] failed", error);
    return NextResponse.json({ error: "Mitarbeiter konnte nicht aktualisiert werden." }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { location, staffId } = await context.params;

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = membershipSupported
    ? {
        id: staffId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: staffId, location: { slug: location } };

  const staffRecord = await prisma.staff.findFirst({
    where: staffScope,
    select: { id: true, locationId: true },
  });

  if (!staffRecord) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.staff.delete({
        where: { id: staffRecord.id },
      });

      await logAuditEvent({
        locationId: staffRecord.locationId,
        actorType: AuditActorType.USER,
        actorId: null,
        action: AuditAction.DELETE,
        entityType: "staff",
        entityId: staffRecord.id,
        appointmentId: null,
        diff: {
          deleted: staffRecord.id,
        },
        context: { source: "backoffice_staff_delete" },
        ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
        userAgent: request.headers.get("user-agent") ?? null,
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[staff:delete] failed", error);
    return NextResponse.json({ error: "Mitarbeiter konnte nicht gelöscht werden." }, { status: 500 });
  }
}
