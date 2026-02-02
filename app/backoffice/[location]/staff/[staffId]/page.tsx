"use server";

import { notFound } from "next/navigation";
import { StaffStatus, ServiceStatus } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import StaffDetailView from "@/components/staff/StaffDetailView";
import { supportsStaffMemberships } from "@/lib/staff-memberships";

const prisma = getPrismaClient();

type StaffMetadata = {
  profileImageUrl?: string | null;
  onlineBookingEnabled?: boolean;
  serviceIds?: string[];
};

function parseMetadata(input: unknown): StaffMetadata {
  if (!input || typeof input !== "object") {
    return {};
  }
  try {
    const record = input as Record<string, unknown>;
    const onlineBooking =
      typeof record.onlineBookingEnabled === "boolean" ? record.onlineBookingEnabled : undefined;
    const serviceIds =
      Array.isArray(record.serviceIds) && record.serviceIds.every((value) => typeof value === "string")
        ? (record.serviceIds as string[])
        : undefined;
    const profileImageUrl =
      typeof record.profileImageUrl === "string" ? (record.profileImageUrl as string) : undefined;

    return {
      profileImageUrl: profileImageUrl ?? null,
      onlineBookingEnabled: onlineBooking,
      serviceIds,
    };
  } catch {
    return {};
  }
}

export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ location: string; staffId: string }>;
}) {
  const { location, staffId } = await params;
  const membershipSupported = await supportsStaffMemberships(prisma);

  const staffRecord = await prisma.staff.findFirst({
    where: membershipSupported
      ? {
          id: staffId,
          OR: [
            { location: { slug: location } },
            { memberships: { some: { location: { slug: location } } } },
          ],
        }
      : { id: staffId, location: { slug: location } },
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
      location: {
        select: { id: true, name: true, slug: true },
      },
      memberships: membershipSupported
        ? {
            select: {
              locationId: true,
              location: {
                select: {
                  id: true,
                  slug: true,
                  name: true,
                },
              },
            },
          }
        : false,
    },
  });

  if (!staffRecord) {
    notFound();
  }

  const [locations, services] = await Promise.all([
    prisma.location.findMany({
      select: { id: true, slug: true, name: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    }),
    prisma.service.findMany({
      where: { location: { slug: location } },
      select: { id: true, name: true, duration: true, status: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    }),
  ]);

  const metadata = parseMetadata(staffRecord.metadata);
  const assignedServiceIds = metadata.serviceIds ?? [];

  type MembershipWithLocation = {
    locationId: string;
    location?: {
      id: string;
      slug: string | null;
      name: string | null;
    } | null;
  };

  const memberships: MembershipWithLocation[] =
    membershipSupported && Array.isArray(staffRecord.memberships)
      ? (staffRecord.memberships as MembershipWithLocation[])
      : [];

  let effectiveLocationId: string | null = staffRecord.locationId ?? null;
  let effectiveLocationName: string | null = staffRecord.location?.name ?? null;
  if (membershipSupported && (!effectiveLocationId || !effectiveLocationName)) {
    const matchingMembership = memberships.find((entry) => entry.location?.slug === location);
    const fallbackMembership = matchingMembership ?? memberships[0];
    if (fallbackMembership?.location) {
      effectiveLocationId = fallbackMembership.location.id;
      effectiveLocationName =
        fallbackMembership.location.name ?? fallbackMembership.location.slug ?? null;
    }
  }
  const locationIdsFromMemberships = membershipSupported
    ? Array.from(new Set(memberships.map((entry) => entry.locationId)))
    : [];
  const locationIds =
    locationIdsFromMemberships.length > 0
      ? locationIdsFromMemberships
      : staffRecord.locationId
        ? [staffRecord.locationId]
        : [];

  return (
    <StaffDetailView
      locationSlug={location}
      staff={{
        id: staffRecord.id,
        code: staffRecord.code,
        locationId: effectiveLocationId,
        locationIds,
        firstName: staffRecord.firstName,
        lastName: staffRecord.lastName,
        displayName: staffRecord.displayName,
        email: staffRecord.email,
        phone: staffRecord.phone,
        color: staffRecord.color,
        status: staffRecord.status as StaffStatus,
        bio: staffRecord.bio,
        metadata,
        createdAt: staffRecord.createdAt.toISOString(),
        updatedAt: staffRecord.updatedAt.toISOString(),
        locationName: effectiveLocationName,
        assignedServiceIds,
      }}
      locations={locations.map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        name: entry.name ?? entry.slug,
      }))}
      services={services.map((entry) => ({
        id: entry.id,
        name: entry.name,
        duration: entry.duration,
        status: entry.status as ServiceStatus,
      }))}
      lockStammdaten
    />
  );
}
