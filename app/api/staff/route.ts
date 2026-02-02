import { NextResponse, type NextRequest } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { resolvePermittedStaffIdsForDevice } from "@/lib/customer-booking-permissions";

const prisma = getPrismaClient();

type StaffResponse = {
  data: Array<{
    id: string;
    name: string;
    role?: string;
  }>;
};

const STAFF_CACHE_TTL_MS = 30_000;
const STAFF_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=30, stale-while-revalidate=30",
};
const staffCache = new Map<string, { expiresAt: number; payload: StaffResponse }>();

function readStaffCache(key: string): StaffResponse | null {
  const entry = staffCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    staffCache.delete(key);
    return null;
  }
  return entry.payload;
}

function writeStaffCache(key: string, payload: StaffResponse) {
  staffCache.set(key, { expiresAt: Date.now() + STAFF_CACHE_TTL_MS, payload });
}

export async function GET(request: NextRequest) {
  const locationId = request.nextUrl.searchParams.get("locationId");
  const deviceId = request.nextUrl.searchParams.get("deviceId");
  if (!locationId) {
    return NextResponse.json({ error: "Missing locationId" }, { status: 400 });
  }

  const cacheKey = `${locationId}:${deviceId ?? "public"}`;
  const disableCache = Boolean(deviceId);
  if (!disableCache) {
    const cached = readStaffCache(cacheKey);
    if (cached) {
      return NextResponse.json(cached, { headers: STAFF_CACHE_HEADERS });
    }
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staff = await prisma.staff.findMany({
    where: membershipSupported
      ? {
          status: "ACTIVE",
          memberships: {
            some: { locationId },
          },
        }
      : {
          locationId,
          status: "ACTIVE",
        },
    orderBy: [{ displayName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      metadata: true,
    },
  });

  const { staffIds: permittedStaffIds } = await resolvePermittedStaffIdsForDevice({
    deviceId,
    locationId,
    prisma,
  });
  const permittedSet = new Set(permittedStaffIds);

  const payload: StaffResponse = {
    data: staff
      .filter((member) => {
        const metadata = member.metadata;
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
          return true;
        }
        const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
        const onlineBookable = typeof value === "boolean" ? value : true;
        return onlineBookable || permittedSet.has(member.id);
      })
      .map((member) => ({
        id: member.id,
        name: member.displayName?.trim() || `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || "Team",
        role: undefined,
      })),
  };

  if (!disableCache) {
    writeStaffCache(cacheKey, payload);
    return NextResponse.json(payload, { headers: STAFF_CACHE_HEADERS });
  }
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
