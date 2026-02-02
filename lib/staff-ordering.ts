import { Prisma, type PrismaClient } from "@prisma/client";

export async function supportsCalendarOrder(prisma: PrismaClient): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'Staff'
          AND column_name = 'calendarOrder'
      ) AS "exists"
    `);
    return Boolean(result?.[0]?.exists);
  } catch (error) {
    console.warn("[staff-ordering] column detection failed, assuming unsupported", error);
    return false;
  }
}

export async function getNextCalendarOrder(prisma: PrismaClient, locationId: string): Promise<number | null> {
  if (!(await supportsCalendarOrder(prisma))) {
    return null;
  }

  const result = await prisma.staff.aggregate({
    where: {
      memberships: {
        some: { locationId },
      },
    },
    _max: { calendarOrder: true },
  });

  const currentMax = result._max.calendarOrder ?? -1;
  return currentMax + 1;
}

export async function ensureCalendarOrdering(prisma: PrismaClient, locationId: string): Promise<void> {
  if (!(await supportsCalendarOrder(prisma))) {
    return;
  }

  const staff = await prisma.staff.findMany({
    where: {
      memberships: {
        some: { locationId },
      },
    },
    orderBy: [{ calendarOrder: "asc" }, { displayName: "asc" }, { lastName: "asc" }],
    select: { id: true, calendarOrder: true },
  });

  if (!staff.length) return;

  let needsUpdate = false;
  let lastValue = -1;
  for (const entry of staff) {
    if (entry.calendarOrder === null || entry.calendarOrder <= lastValue) {
      needsUpdate = true;
      break;
    }
    lastValue = entry.calendarOrder;
  }

  if (!needsUpdate) return;

  await prisma.$transaction(
    staff.map((entry, index) =>
      prisma.staff.update({
        where: { id: entry.id },
        data: { calendarOrder: index },
      }),
    ),
  );
}
