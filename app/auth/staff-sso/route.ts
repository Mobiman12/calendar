import { NextRequest, NextResponse } from "next/server";
import { Prisma, UserRole } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_TTL_MS, getSessionOrNull } from "@/lib/session";
import { normalizeStaffRoleKey } from "@/lib/role-permissions";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { verifyTenantSsoToken } from "@/lib/tenant-sso";

function normalizeRedirect(raw: string | null, fallback: string, origin: string): string {
  if (!raw) return fallback;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}` || fallback;
  } catch {
    return fallback;
  }
}

function normalizeRole(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseLocationSlug(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    const url = new URL(path, "http://internal");
    const parts = url.pathname.split("/").filter(Boolean);
    const backofficeIndex = parts.indexOf("backoffice");
    if (backofficeIndex === -1) return null;
    const slug = parts[backofficeIndex + 1];
    return normalizeString(slug);
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function resolveCalendarRole(role: string | null | undefined): UserRole {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return UserRole.STAFF;
  if (normalized === "owner") return UserRole.OWNER;
  if (normalized === "2" || normalized.includes("admin")) {
    return UserRole.ADMIN;
  }
  if (normalized.includes("leiter") || normalized.includes("manager")) {
    return UserRole.MANAGER;
  }
  return UserRole.STAFF;
}

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  try {
    const token = request.nextUrl.searchParams.get("token");
    const payload = token ? verifyTenantSsoToken(token, "CALENDAR") : null;
    const session = payload ? null : await getSessionOrNull();
    if (!payload && !session) {
      return NextResponse.redirect(new URL("/auth/login", origin));
    }

    const staffId = request.nextUrl.searchParams.get("staffId");
    const staffCode = normalizeString(payload?.staffCode);
    const expectedTenantId = payload?.tenantId ?? session?.tenantId ?? null;
    if (staffCode && !expectedTenantId) {
      return NextResponse.redirect(new URL("/auth/login", origin));
    }
    if (!staffCode && !staffId) {
      return NextResponse.redirect(new URL("/backoffice/staff-central?error=staff-missing", origin));
    }

    const prisma = getPrismaClient();
    const membershipSupported = await supportsStaffMemberships(prisma);

  type StaffWithMemberships = {
    id: string;
    email: string | null;
    metadata: Prisma.JsonValue | null;
    userId: string | null;
    location: { id: string; slug: string; tenantId: string };
    memberships: Array<{ locationId: string; role: string | null }>;
  };
  type StaffWithoutMemberships = Omit<StaffWithMemberships, "memberships">;

    const staffLookup = staffCode
      ? { code: staffCode, location: { is: { tenantId: expectedTenantId as string } } }
      : { id: staffId as string };
    let staff = membershipSupported
      ? ((await prisma.staff.findFirst({
          where: staffLookup,
          select: {
            id: true,
            email: true,
            metadata: true,
            userId: true,
            location: { select: { id: true, slug: true, tenantId: true } },
            memberships: { select: { locationId: true, role: true } },
          },
        })) as StaffWithMemberships | null)
      : ((await prisma.staff.findFirst({
          where: staffLookup,
          select: {
            id: true,
            email: true,
            metadata: true,
            userId: true,
            location: { select: { id: true, slug: true, tenantId: true } },
          },
        })) as StaffWithoutMemberships | null);

    if (!staff && staffCode && expectedTenantId) {
      const redirectParam = request.nextUrl.searchParams.get("redirect");
      const preferredSlug =
        parseLocationSlug(redirectParam) ?? parseLocationSlug(payload?.returnTo) ?? null;
      let location = preferredSlug
        ? await prisma.location.findFirst({
            where: { tenantId: expectedTenantId, slug: preferredSlug },
            select: { id: true, slug: true, tenantId: true },
          })
        : null;
      if (!location) {
        location = await prisma.location.findFirst({
          where: { tenantId: expectedTenantId },
          select: { id: true, slug: true, tenantId: true },
          orderBy: { createdAt: "asc" },
        });
      }
      if (location) {
        const displayName =
          normalizeString(payload?.displayName) ??
          normalizeString(payload?.username) ??
          [payload?.firstName, payload?.lastName].filter(Boolean).join(" ").trim() ||
          "Mitarbeiter";
        const [firstName, lastName] = (() => {
          if (payload?.firstName || payload?.lastName) {
            return [
              normalizeString(payload?.firstName) ?? displayName,
              normalizeString(payload?.lastName) ?? "",
            ] as const;
          }
          const parts = displayName.split(" ").filter(Boolean);
          return [parts[0] ?? displayName, parts.slice(1).join(" ")] as const;
        })();
        const created = await prisma.staff.create({
          data: {
            locationId: location.id,
            code: staffCode,
            firstName,
            lastName,
            displayName,
            email: normalizeString(payload?.email) ?? null,
            status: "ACTIVE",
            metadata: { source: "staff-sso" },
          },
          select: { id: true },
        });
        staff = membershipSupported
          ? ((await prisma.staff.findUnique({
              where: { id: created.id },
              select: {
                id: true,
                email: true,
                metadata: true,
                userId: true,
                location: { select: { id: true, slug: true, tenantId: true } },
                memberships: { select: { locationId: true, role: true } },
              },
            })) as StaffWithMemberships | null)
          : ((await prisma.staff.findUnique({
              where: { id: created.id },
              select: {
                id: true,
                email: true,
                metadata: true,
                userId: true,
                location: { select: { id: true, slug: true, tenantId: true } },
              },
            })) as StaffWithoutMemberships | null);
      }
    }

    if (!staff) {
      return NextResponse.redirect(new URL("/backoffice/staff-central?error=staff-missing", origin));
    }

    if (expectedTenantId && staff.location.tenantId !== expectedTenantId) {
      return NextResponse.redirect(new URL("/backoffice/staff-central?error=staff-tenant", origin));
    }

    const payloadEmail = normalizeString(payload?.email);
    const email = staff.email?.trim().toLowerCase() ?? payloadEmail?.toLowerCase();
    if (!email) {
      return NextResponse.redirect(new URL("/backoffice/staff-central?error=staff-email", origin));
    }

    let resolvedRole: string | null = normalizeRole(payload?.role);
    if (membershipSupported && "memberships" in staff) {
      const membership = staff.memberships.find(
        (entry) =>
          entry.locationId === staff.location.id && typeof entry.role === "string" && entry.role.trim().length,
      );
      resolvedRole = resolvedRole ?? membership?.role?.trim() ?? null;
    }
    if (!resolvedRole) {
      resolvedRole = extractRoleFromMetadata(staff.metadata);
    }

    const userRole = resolveCalendarRole(resolvedRole);
    let user = staff.userId ? await prisma.user.findUnique({ where: { id: staff.userId } }) : null;
    if (!user) {
      user = await prisma.user.findUnique({ where: { email } });
    }

    const baseMeta =
      user && typeof user.metadata === "object" && user.metadata && !Array.isArray(user.metadata)
        ? (user.metadata as Record<string, unknown>)
        : {};
    const nextMeta = {
      ...baseMeta,
      tenantId: staff.location.tenantId,
      tenantSlug: staff.location.slug,
      staffId: staff.id,
      staffRoleKey: normalizeStaffRoleKey(resolvedRole),
      source: "staff-sso",
    };

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          role: userRole,
          metadata: nextMeta,
        },
      });
    } else {
      const updates: { role?: UserRole; metadata?: Prisma.JsonValue } = {};
      if (user.role !== userRole) {
        updates.role = userRole;
      }
      const metaChanged =
        baseMeta.tenantId !== nextMeta.tenantId ||
        baseMeta.tenantSlug !== nextMeta.tenantSlug ||
        baseMeta.staffId !== nextMeta.staffId ||
        baseMeta.source !== nextMeta.source;
      if (metaChanged) {
        updates.metadata = nextMeta;
      }
      if (Object.keys(updates).length) {
        user = await prisma.user.update({ where: { id: user.id }, data: updates });
      }
    }

  if (!staff.userId || staff.userId !== user.id) {
    const linkedStaff = await prisma.staff.findFirst({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!linkedStaff || linkedStaff.id === staff.id) {
      await prisma.staff.update({ where: { id: staff.id }, data: { userId: user.id } });
    } else {
      console.warn("[staff-sso] user already linked to another staff", {
        userId: user.id,
        staffId: staff.id,
        linkedStaffId: linkedStaff.id,
      });
    }
  }

    const sessionToken = createSessionToken({
      userId: user.id,
      tenantId: staff.location.tenantId,
      role: userRole,
    });
    const redirectParam = request.nextUrl.searchParams.get("redirect");
    const defaultRedirect = staff.location.slug ? `/backoffice/${staff.location.slug}/calendar` : "/backoffice";
    const fallbackRedirect = payload?.returnTo ?? defaultRedirect;
    const redirectPath = normalizeRedirect(redirectParam, fallbackRedirect, origin);
    const response = NextResponse.redirect(new URL(redirectPath, origin));
    response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
      secure: process.env.NODE_ENV === "production",
    });
    return response;
  } catch (error) {
    console.error("[staff-sso] failed", error);
    const fallback = new URL("/auth/login", origin);
    fallback.searchParams.set("error", "staff-sso");
    return NextResponse.redirect(fallback);
  }
}
