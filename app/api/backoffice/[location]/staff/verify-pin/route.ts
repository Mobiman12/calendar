"use server";

import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { createBookingPinToken, secureComparePin } from "@/lib/booking-auth";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

const schema = z.object({
  pin: z.string().min(1).max(64),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { slug: location, tenantId },
    select: { id: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort wurde nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof schema>;
  try {
    const body = await request.json();
    payload = schema.parse(body);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffWhere: Prisma.StaffWhereInput = membershipSupported
    ? {
        bookingPin: { not: null },
        OR: [
          { memberships: { some: { locationId: locationRecord.id } } },
          { locationId: locationRecord.id },
        ],
      }
    : {
        locationId: locationRecord.id,
        bookingPin: { not: null },
      };

  type StaffCandidateWithMemberships = {
    id: string;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
    bookingPin: string | null;
    code: string | null;
    metadata: Prisma.JsonValue | null;
    memberships: Array<{ role: string | null }>;
  };
  type StaffCandidateWithoutMemberships = {
    id: string;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
    bookingPin: string | null;
    code: string | null;
    metadata: Prisma.JsonValue | null;
  };
  type StaffCandidate = StaffCandidateWithMemberships | StaffCandidateWithoutMemberships;

  const loadStaffMembers = async (): Promise<StaffCandidate[]> => {
    if (membershipSupported) {
      return (await prisma.staff.findMany({
        where: staffWhere,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          displayName: true,
          bookingPin: true,
          code: true,
          metadata: true,
          memberships: {
            where: { locationId: locationRecord.id },
            select: { role: true },
          },
        },
      })) as StaffCandidate[];
    }
    return (await prisma.staff.findMany({
      where: staffWhere,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        bookingPin: true,
        code: true,
        metadata: true,
      },
    })) as StaffCandidate[];
  };

  const staffMembers = await loadStaffMembers();
  const staff = staffMembers.find(
    (member) => member.bookingPin && secureComparePin(member.bookingPin, payload.pin),
  );

  if (!staff) {
    return NextResponse.json({ error: "PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  let resolvedRole: string | null = null;
  if (membershipSupported && "memberships" in staff) {
    const withMemberships = staff as StaffCandidateWithMemberships;
    const membership = withMemberships.memberships.find((entry) => typeof entry.role === "string" && entry.role.trim().length);
    resolvedRole = membership?.role ? membership.role.trim() : null;
  }

  if (!resolvedRole) {
    resolvedRole = extractRoleFromMetadata(staff.metadata);
  }

  const role = resolvedRole ?? null;
  const { token, expiresAt } = createBookingPinToken(staff.id);
  const staffName =
    staff.displayName?.trim() ||
    `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
    "Mitarbeiter";

  return NextResponse.json({
    data: {
      staffId: staff.id,
      staffName,
      token,
      expiresAt,
      role,
    },
  });
}

function extractRoleFromMetadata(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const stundenliste = record.stundenliste;
  if (!isPlainObject(stundenliste)) {
    return null;
  }
  const role =
    normalizeRole((stundenliste as Record<string, unknown>).roleId) ??
    normalizeRole((stundenliste as Record<string, unknown>).role);
  if (role) {
    return role;
  }
  const permissions = (stundenliste as Record<string, unknown>).permissions;
  if (Array.isArray(permissions)) {
    const adminPermission = permissions.find(
      (entry) => typeof entry === "string" && entry.toLowerCase() === "admin",
    );
    if (adminPermission) {
      return "2";
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
