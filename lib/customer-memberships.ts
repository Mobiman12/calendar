import { Prisma, type PrismaClient } from "@prisma/client";

const membershipSupportCache = new WeakMap<PrismaClient, boolean>();

export async function supportsCustomerMemberships(prisma: PrismaClient): Promise<boolean> {
  if (membershipSupportCache.has(prisma)) {
    return membershipSupportCache.get(prisma) ?? false;
  }

  try {
    const result = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'CustomerLocationMembership'
      ) AS "exists"
    `);

    const supported = Boolean(result?.[0]?.exists);
    membershipSupportCache.set(prisma, supported);
    return supported;
  } catch (error) {
    console.warn("[customer-memberships] detection failed, assuming unsupported", error);
    membershipSupportCache.set(prisma, false);
    return false;
  }
}

