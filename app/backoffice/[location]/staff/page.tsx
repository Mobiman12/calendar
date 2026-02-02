"use server";

import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { StaffStatus, Prisma } from "@prisma/client";
import { headers } from "next/headers";

import { getPrismaClient } from "@/lib/prisma";
import { syncStundenlisteStaff } from "@/lib/stundenliste-sync";
import { ensureCalendarOrdering, supportsCalendarOrder } from "@/lib/staff-ordering";
import { StaffDirectorySkeleton } from "@/components/staff/StaffDirectorySkeleton";
import StaffDirectory from "@/components/staff/StaffDirectory";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { readTenantContext } from "@/lib/tenant";
import { readStaffProfileImageUrl } from "@/lib/staff-metadata";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

const prisma = getPrismaClient();

export default async function StaffPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  const hdrs = await headers();
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect(`/backoffice/${location}/calendar`);
  }
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? process.env.DEFAULT_TENANT_ID;

  const locationRecord = await prisma.location.findFirst({
    where: tenantId
      ? {
          OR: [{ slug: location, tenantId }, { slug: location }],
        }
      : { slug: location },
    select: { id: true, tenantId: true },
  });

  if (!locationRecord) {
    notFound();
  }

  const staffMembershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = staffMembershipSupported
    ? {
        memberships: {
          some: { locationId: locationRecord.id },
        },
      }
    : {
        locationId: locationRecord.id,
      };

  const effectiveTenantId = locationRecord.tenantId ?? tenantId;
  const staffCodesByLocation = effectiveTenantId ? await syncStundenlisteStaff(effectiveTenantId) : null;
  const codes = staffCodesByLocation?.[locationRecord.id] ?? null;

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
      where: {
        ...staffScope,
      },
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
      where: {
        ...staffScope,
      },
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

  const initialStaff = staffRecords.map((entry) => ({
    id: entry.id,
    code: entry.code,
    firstName: entry.firstName,
    lastName: entry.lastName,
    displayName: entry.displayName,
    email: entry.email,
    phone: entry.phone,
    color: entry.color,
    status: entry.status,
    bio: entry.bio,
    profileImageUrl: entry.profileImageUrl,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    appointmentCount: entry._count.appointmentItems,
    notificationCount: entry._count.notifications,
    calendarOrder: entry.calendarOrder,
  }));

  return (
    <Suspense fallback={<StaffDirectorySkeleton />}>
      <StaffDirectory locationSlug={location} initialStaff={initialStaff} />
    </Suspense>
  );
}
