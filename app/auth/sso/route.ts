import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_TTL_MS } from "@/lib/session";
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

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const token = searchParams.get("token");
  const payload = verifyTenantSsoToken(token, "CALENDAR");
  const origin = request.nextUrl.origin;

  if (!payload) {
    const loginUrl = new URL("/auth/login", origin);
    return NextResponse.redirect(loginUrl);
  }

  const email = (payload.email ?? "").trim().toLowerCase();
  if (!email) {
    const loginUrl = new URL("/auth/login", origin);
    return NextResponse.redirect(loginUrl);
  }

  const prisma = getPrismaClient();
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        role: UserRole.ADMIN,
        metadata: {
          tenantId: payload.tenantId,
          tenantSlug: payload.tenantSlug,
          tenantName: payload.tenantName ?? null,
        },
      },
    });
  } else {
    const meta = (user.metadata as Record<string, unknown> | null) ?? {};
    const nextMeta = {
      ...meta,
      tenantId: meta.tenantId ?? payload.tenantId,
      tenantSlug: meta.tenantSlug ?? payload.tenantSlug,
      tenantName: meta.tenantName ?? payload.tenantName ?? null,
    };
    const changed =
      meta.tenantId !== nextMeta.tenantId ||
      meta.tenantSlug !== nextMeta.tenantSlug ||
      meta.tenantName !== nextMeta.tenantName;
    if (changed) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { metadata: nextMeta },
      });
    }
  }

  const sessionToken = createSessionToken({
    userId: user.id,
    tenantId: payload.tenantId,
    role: user.role,
  });

  const firstLocation = await prisma.location.findFirst({
    where: { tenantId: payload.tenantId },
    select: { slug: true },
    orderBy: { createdAt: "asc" },
  });
  const defaultRedirect = firstLocation
    ? `/backoffice/${firstLocation.slug}/calendar`
    : "/backoffice";

  const fallbackRedirect = payload.returnTo ?? defaultRedirect;
  const redirectParam = searchParams.get("redirect");
  let redirectPath = normalizeRedirect(redirectParam, fallbackRedirect, origin);
  if (redirectPath === "/backoffice" || redirectPath === "/backoffice/") {
    redirectPath = defaultRedirect;
  }
  const redirectTarget = new URL(redirectPath, origin);

  const response = NextResponse.redirect(redirectTarget);
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
