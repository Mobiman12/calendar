"use server";

import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { setSessionCookie } from "@/lib/session";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import { normalizeStaffRoleKey } from "@/lib/role-permissions";

const prisma = getPrismaClient();


type StaffAuthResponse = {
  ok: true;
  staffId: string;
  tenantId: string;
  tenantName?: string | null;
  tenantSlug?: string | null;
  email: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: string | null;
};

async function verifyStaffLogin(email: string, password: string): Promise<StaffAuthResponse | null> {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return null;
  const secret = process.env.PROVISION_SECRET?.trim();
  try {
    const response = await fetch(`${baseUrl}/api/internal/staff/auth`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-provision-secret": secret } : {}),
      },
      body: JSON.stringify({ email, password, app: "CALENDAR" }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as StaffAuthResponse;
    if (!payload?.ok) return null;
    return payload;
  } catch {
    return null;
  }
}

function resolveCalendarRole(role: string | null | undefined): UserRole {
  const normalized = (role ?? "").trim().toLowerCase();
  if (normalized.includes("admin")) {
    return UserRole.ADMIN;
  }
  if (normalized.includes("leiter") || normalized.includes("manager")) {
    return UserRole.MANAGER;
  }
  return UserRole.STAFF;
}

async function resolveCalendarRedirect(
  prisma: ReturnType<typeof getPrismaClient>,
  {
    tenantId,
    user,
    staffLogin,
    userMeta,
  }: {
    tenantId: string | undefined;
    user: {
      staff?: { id: string; location?: { slug: string | null } | null } | null;
    } | null;
    staffLogin: StaffAuthResponse | null;
    userMeta: Record<string, unknown> | null;
  },
) {
  const metaStaffId = userMeta && typeof userMeta.staffId === "string" ? userMeta.staffId : null;
  const preferredStaffId = staffLogin?.staffId ?? metaStaffId ?? user?.staff?.id ?? null;
  let locationSlug = user?.staff?.location?.slug ?? null;

  if (!locationSlug && preferredStaffId) {
    const staffRecord = await prisma.staff.findUnique({
      where: { id: preferredStaffId },
      select: { location: { select: { slug: true } } },
    });
    locationSlug = staffRecord?.location?.slug ?? null;
  }

  if (!locationSlug && tenantId) {
    const locationRecord = await prisma.location.findFirst({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      select: { slug: true },
    });
    locationSlug = locationRecord?.slug ?? null;
  }

  return locationSlug ? `/backoffice/${locationSlug}/calendar` : "/backoffice";
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { ok: false, message: "E-Mail und Passwort erforderlich." };
  }

  let user = await prisma.user.findUnique({
    where: { email },
    include: {
      staff: {
        select: {
          id: true,
          location: { select: { tenantId: true } },
        },
      },
    },
  });

  const passwordOk = user ? await verifyPassword(password, user.hashedPassword) : false;
  const userMeta =
    user && typeof user.metadata === "object" && user.metadata && !Array.isArray(user.metadata)
      ? (user.metadata as Record<string, unknown>)
      : null;
  let staffLogin: StaffAuthResponse | null = null;

  if (passwordOk) {
    staffLogin = await verifyStaffLogin(email, password);
    if (staffLogin && user) {
      const nextRole = resolveCalendarRole(staffLogin.role);
      const nextMeta = {
        ...(userMeta ?? {}),
        tenantId: staffLogin.tenantId,
        tenantName: staffLogin.tenantName ?? null,
        tenantSlug: staffLogin.tenantSlug ?? null,
        staffId: staffLogin.staffId,
        staffRoleKey: normalizeStaffRoleKey(staffLogin.role),
        source: "staff",
      };
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          role: nextRole,
          metadata: nextMeta,
        },
        include: {
          staff: {
            select: {
              id: true,
              location: { select: { tenantId: true } },
            },
          },
        },
      });

      try {
        const staffRow = await prisma.staff.findUnique({
          where: { id: staffLogin.staffId },
          select: { userId: true },
        });
        if (staffRow && (!staffRow.userId || staffRow.userId === user.id)) {
          await prisma.staff.update({
            where: { id: staffLogin.staffId },
            data: { userId: user.id },
          });
        }
      } catch {
        // Ignorieren, falls Staff-Record noch nicht vorhanden ist.
      }
    }
  }

  if (!passwordOk) {
    const allowStaffFallback =
      !user ||
      user.role === UserRole.STAFF ||
      user.role === UserRole.MANAGER ||
      userMeta?.source === "staff" ||
      userMeta?.staffId;
    if (!allowStaffFallback) {
      return { ok: false, message: "Login fehlgeschlagen." };
    }

    staffLogin = await verifyStaffLogin(email, password);
    if (!staffLogin) {
      return { ok: false, message: "Login fehlgeschlagen." };
    }

    const nextRole = resolveCalendarRole(staffLogin.role);
    const nextMeta = {
      ...(userMeta ?? {}),
      tenantId: staffLogin.tenantId,
      tenantName: staffLogin.tenantName ?? null,
      tenantSlug: staffLogin.tenantSlug ?? null,
      staffId: staffLogin.staffId,
      staffRoleKey: normalizeStaffRoleKey(staffLogin.role),
      source: "staff",
    };

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          role: nextRole,
          hashedPassword: hashPassword(password),
          metadata: nextMeta,
        },
        include: {
          staff: {
            select: {
              id: true,
              location: { select: { tenantId: true } },
            },
          },
        },
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          role: nextRole,
          hashedPassword: hashPassword(password),
          metadata: nextMeta,
        },
        include: {
          staff: {
            select: {
              id: true,
              location: { select: { tenantId: true } },
            },
          },
        },
      });
    }

    try {
      const staffRow = await prisma.staff.findUnique({
        where: { id: staffLogin.staffId },
        select: { userId: true },
      });
      if (staffRow && (!staffRow.userId || staffRow.userId === user.id)) {
        await prisma.staff.update({
          where: { id: staffLogin.staffId },
          data: { userId: user.id },
        });
      }
    } catch {
      // Ignorieren, falls Staff-Record noch nicht vorhanden ist.
    }
  }

  if (user && passwordOk && needsRehash(user.hashedPassword ?? null)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { hashedPassword: hashPassword(password) },
    });
  }

  const tenantId =
    staffLogin?.tenantId ??
    user.staff?.location.tenantId ??
    (typeof user.metadata === "object" && user.metadata && "tenantId" in user.metadata
      ? String((user.metadata as Record<string, unknown>).tenantId)
      : process.env.DEFAULT_TENANT_ID ?? "legacy");

  await setSessionCookie(
    {
      userId: user.id,
      tenantId,
      role: user.role,
    },
    7 * 24 * 60 * 60 * 1000,
  );

  const redirectPath = await resolveCalendarRedirect(prisma, {
    tenantId,
    user,
    staffLogin,
    userMeta,
  });
  redirect(redirectPath);
}
