import { NextResponse } from "next/server";
import { z } from "zod";
import { StaffStatus, AuditAction, AuditActorType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { ensureCalendarOrdering, getNextCalendarOrder, supportsCalendarOrder } from "@/lib/staff-ordering";
import { syncStundenlisteStaff, getHiddenStaffByLocation } from "@/lib/stundenliste-sync";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { readStaffProfileImageUrl } from "@/lib/staff-metadata";

const prisma = getPrismaClient();

const createSchema = z.object({
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  displayName: z.string().max(120).optional(),
  email: z.string().email().optional().or(z.literal("")).transform((value) => value || null),
  phone: z.string().max(50).optional().or(z.literal("")).transform((value) => value || null),
  color: z.string().max(20).optional().or(z.literal("")).transform((value) => value || null),
  status: z.nativeEnum(StaffStatus).optional().default(StaffStatus.ACTIVE),
  bio: z.string().max(3000).optional().or(z.literal("")).transform((value) => value || null),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });
  const locationRecord = await prisma.location.findFirst({
    where: {
      slug: location,
      tenantId,
    },
    select: { id: true, tenantId: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = membershipSupported
    ? {
        memberships: {
          some: { locationId: locationRecord.id },
        },
      }
    : {
        locationId: locationRecord.id,
      };

  const staffCodesByLocation = await syncStundenlisteStaff(tenantId);
  const syncedCodes = staffCodesByLocation?.[locationRecord.id] ?? null;
  const hiddenStaffIds = Array.from(getHiddenStaffByLocation().get(locationRecord.id) ?? new Set<string>());

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();
  const statusParam = searchParams.get("status") ?? "all";

  const statusFilter: Prisma.StaffWhereInput =
    statusParam && statusParam !== "all" && Object.values(StaffStatus).includes(statusParam as StaffStatus)
      ? { status: statusParam as StaffStatus }
      : {};

  const where: Prisma.StaffWhereInput = {
    ...staffScope,
    ...(hiddenStaffIds.length ? { id: { notIn: hiddenStaffIds } } : {}),
    ...statusFilter,
    ...(query
      ? {
          OR: [
            { firstName: { contains: query, mode: "insensitive" } },
            { lastName: { contains: query, mode: "insensitive" } },
            { displayName: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
            { phone: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const calendarOrderSupported = await supportsCalendarOrder(prisma);
  if (calendarOrderSupported) {
    await ensureCalendarOrdering(prisma, locationRecord.id);
  }

  let staffRecords: Array<{
    id: string;
    code: string | null;
    firstName: string;
    lastName: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    color: string | null;
    status: StaffStatus;
    bio: string | null;
    profileImageUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
    calendarOrder: number | null;
    _count: {
      appointmentItems: number;
      notifications: number;
    };
  }>;

  if (calendarOrderSupported) {
    const staffWithOrder = await prisma.staff.findMany({
      where,
      orderBy: [{ calendarOrder: "asc" }, { displayName: "asc" }, { lastName: "asc" }],
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
        bio: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        calendarOrder: true,
        _count: {
          select: {
            appointmentItems: true,
            notifications: true,
          },
        },
      },
    });
    staffRecords = staffWithOrder.map(({ metadata, ...entry }) => ({
      ...entry,
      profileImageUrl: readStaffProfileImageUrl(metadata ?? null),
      calendarOrder: entry.calendarOrder ?? null,
    }));
  } else {
    const staffWithoutOrder = await prisma.staff.findMany({
      where,
      orderBy: [{ status: "asc" }, { displayName: "asc" }, { lastName: "asc" }],
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
        bio: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            appointmentItems: true,
            notifications: true,
          },
        },
      },
    });
    staffRecords = staffWithoutOrder.map(({ metadata, ...entry }) => ({
      ...entry,
      profileImageUrl: readStaffProfileImageUrl(metadata ?? null),
      calendarOrder: null,
    }));
  }

  return NextResponse.json({
    data: staffRecords.map((entry) => ({
      ...entry,
      appointmentCount: entry._count?.appointmentItems ?? 0,
      notificationCount: entry._count?.notifications ?? 0,
      calendarOrder: entry.calendarOrder,
    })),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;

  const locationRecord = await prisma.location.findFirst({
    where: {
      OR: [{ slug: location }],
    },
    select: { id: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof createSchema>;
  try {
    const body = await request.json();
    payload = createSchema.parse(body);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const calendarOrderSupported = await supportsCalendarOrder(prisma);
    const calendarOrderValue = calendarOrderSupported
      ? await getNextCalendarOrder(prisma, locationRecord.id)
      : null;

    const createData: Prisma.StaffUncheckedCreateInput = {
      locationId: locationRecord.id,
      firstName: payload.firstName.trim(),
      lastName: payload.lastName.trim(),
      displayName: payload.displayName?.trim() || `${payload.firstName} ${payload.lastName}`.trim(),
      email: payload.email,
      phone: payload.phone,
      color: payload.color,
      status: payload.status ?? StaffStatus.ACTIVE,
      bio: payload.bio,
    };
    if (calendarOrderValue !== null) {
      createData.calendarOrder = calendarOrderValue;
    }

    const staff = await prisma.staff.create({
      data: createData,
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
        bio: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
        calendarOrder: true,
        _count: {
          select: {
            appointmentItems: true,
            notifications: true,
          },
        },
      },
    });

    await prisma.staffLocationMembership.upsert({
      where: {
        staffId_locationId: {
          staffId: staff.id,
          locationId: locationRecord.id,
        },
      },
      update: {},
      create: {
        staffId: staff.id,
        locationId: locationRecord.id,
      },
    });

    await logAuditEvent({
      locationId: locationRecord.id,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.CREATE,
      entityType: "staff",
      entityId: staff.id,
      diff: {
        created: staff,
      },
      context: { source: "backoffice_staff_create" },
      ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
      userAgent: request.headers.get("user-agent") ?? null,
    });

    return NextResponse.json({
      data: {
        id: staff.id,
        code: staff.code,
        firstName: staff.firstName,
        lastName: staff.lastName,
        displayName: staff.displayName,
        email: staff.email,
        phone: staff.phone,
        color: staff.color,
        status: staff.status,
        bio: staff.bio,
        profileImageUrl: readStaffProfileImageUrl(staff.metadata ?? null),
        createdAt: staff.createdAt,
        updatedAt: staff.updatedAt,
        appointmentCount: staff._count.appointmentItems,
        notificationCount: staff._count.notifications,
        calendarOrder: staff.calendarOrder ?? null,
      },
    });
  } catch (error) {
    console.error("[staff:create] failed", error);
    return NextResponse.json({ error: "Mitarbeiter konnte nicht angelegt werden." }, { status: 500 });
  }
}
