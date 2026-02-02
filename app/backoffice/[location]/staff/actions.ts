'use server';

import { Prisma, StaffStatus } from '@prisma/client';

import { getPrismaClient } from '@/lib/prisma';
import { ensureCalendarOrdering, supportsCalendarOrder } from '@/lib/staff-ordering';
import { supportsStaffMemberships } from '@/lib/staff-memberships';
import { readStaffProfileImageUrl } from '@/lib/staff-metadata';

const prisma = getPrismaClient();

export type StaffListEntry = {
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
  createdAt: string;
  updatedAt: string;
  calendarOrder: number | null;
  appointmentCount: number;
  notificationCount: number;
};

type StaffReorderResult =
  | { success: true; staff: StaffListEntry[] }
  | { success: false; error: string };

export async function reorderStaffAction(locationSlug: string, order: string[]): Promise<StaffReorderResult> {
  const locationRecord = await prisma.location.findFirst({
    where: { slug: locationSlug },
    select: { id: true },
  });

  if (!locationRecord) {
    return { success: false, error: 'Standort wurde nicht gefunden.' };
  }

  if (!(await supportsCalendarOrder(prisma))) {
    return { success: false, error: 'Reihenfolge kann derzeit nicht gespeichert werden.' };
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffWhere: Prisma.StaffWhereInput = membershipSupported
    ? {
        memberships: {
          some: { locationId: locationRecord.id },
        },
      }
    : {
        locationId: locationRecord.id,
      };

  const staff = await prisma.staff.findMany({
    where: staffWhere,
    orderBy: [{ calendarOrder: 'asc' }, { displayName: 'asc' }, { lastName: 'asc' }],
    select: { id: true },
  });

  if (!staff.length) {
    return { success: true, staff: [] };
  }

  const knownIds = new Set(staff.map((entry) => entry.id));
  const requested = order.filter((id) => knownIds.has(id));
  const remaining = staff.map((entry) => entry.id).filter((id) => !requested.includes(id));
  const mergedOrder = requested.length ? [...requested, ...remaining] : staff.map((entry) => entry.id);

  await prisma.$transaction(
    mergedOrder.map((id, index) =>
      prisma.staff.updateMany({
        where: { id },
        data: { calendarOrder: index },
      }),
    ),
  );

  await ensureCalendarOrdering(prisma, locationRecord.id);

  const updatedStaff = await prisma.staff.findMany({
    where: staffWhere,
    orderBy: [{ calendarOrder: 'asc' }, { displayName: 'asc' }],
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

  const staffEntries: StaffListEntry[] = updatedStaff.map((entry) => ({
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
    profileImageUrl: readStaffProfileImageUrl(entry.metadata ?? null),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    calendarOrder: entry.calendarOrder ?? null,
    appointmentCount: entry._count.appointmentItems,
    notificationCount: entry._count.notifications,
  }));

  return {
    success: true,
    staff: staffEntries,
  };
}
