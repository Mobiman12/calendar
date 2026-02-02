import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AuditAction, AuditActorType, type Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { supportsStaffMemberships } from "@/lib/staff-memberships";

const prisma = getPrismaClient();
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "staff");

async function ensureUploadDirectory() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function resolveExtension(file: File) {
  const fromName = path.extname(file.name ?? "").toLowerCase();
  if (fromName) return fromName;

  const mime = file.type ?? "";
  if (mime === "image/png") return ".png";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/jpeg") return ".jpg";
  return ".jpg";
}

function buildPublicPath(fileName: string) {
  return `/uploads/staff/${fileName}`;
}

function resolveAbsolutePath(url: string) {
  if (!url.startsWith("/uploads/staff/")) {
    return null;
  }
  return path.join(process.cwd(), "public", url);
}

function resolveCalendarBaseUrl(request: Request) {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.endsWith("/") ? configured.slice(0, -1) : configured;
  }
  return new URL(request.url).origin;
}

async function syncProfileImageToControlPlane(params: {
  staffId: string;
  tenantId: string;
  photoUrl: string | null;
}) {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim() || "http://localhost:3003";
  const trimmedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const secret = process.env.PROVISION_SECRET?.trim();
  if (!trimmedBase) return;
  try {
    const res = await fetch(`${trimmedBase}/api/internal/staff/photo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-provision-secret": secret } : {}),
      },
      body: JSON.stringify({
        staffId: params.staffId,
        tenantId: params.tenantId,
        photoUrl: params.photoUrl,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error("[staff-photo] control-plane sync failed", {
        status: res.status,
        staffId: params.staffId,
        tenantId: params.tenantId,
        error: text,
      });
    }
  } catch (error) {
    console.error("[staff-photo] control-plane sync failed", error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { location, staffId } = await context.params;

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = membershipSupported
    ? {
        id: staffId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: staffId, location: { slug: location } };

  const staff = await prisma.staff.findFirst({
    where: staffScope,
    select: { id: true, locationId: true, metadata: true, location: { select: { tenantId: true } } },
  });

  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Es wurde keine gültige Bilddatei übermittelt." }, { status: 400 });
  }

  await ensureUploadDirectory();

  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = resolveExtension(file);
  const fileName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const absolutePath = path.join(UPLOAD_DIR, fileName);

  await fs.writeFile(absolutePath, buffer);

  const previousMetadata =
    staff.metadata && typeof staff.metadata === "object" ? { ...(staff.metadata as Record<string, unknown>) } : {};

  const previousUrl =
    typeof previousMetadata.profileImageUrl === "string" ? (previousMetadata.profileImageUrl as string) : null;

  const publicUrl = buildPublicPath(fileName);
  previousMetadata.profileImageUrl = publicUrl;

  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      metadata: previousMetadata as Prisma.InputJsonValue,
    },
  });

  if (previousUrl) {
    const oldPath = resolveAbsolutePath(previousUrl);
    if (oldPath) {
      await fs.unlink(oldPath).catch(() => undefined);
    }
  }

  await logAuditEvent({
    locationId: staff.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "staff",
    entityId: staff.id,
    appointmentId: null,
    diff: {
      updated: { profileImageUrl: publicUrl },
    },
    context: { source: "backoffice_staff_profile_image_upload" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  const calendarBaseUrl = resolveCalendarBaseUrl(request);
  const absolutePhotoUrl = `${calendarBaseUrl}${publicUrl.startsWith("/") ? "" : "/"}${publicUrl}`;
  await syncProfileImageToControlPlane({
    staffId: staff.id,
    tenantId: staff.location.tenantId,
    photoUrl: absolutePhotoUrl,
  });

  return NextResponse.json({ data: { profileImageUrl: publicUrl } });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string; staffId: string }> },
) {
  const { location, staffId } = await context.params;

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffScope: Prisma.StaffWhereInput = membershipSupported
    ? {
        id: staffId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: staffId, location: { slug: location } };

  const staff = await prisma.staff.findFirst({
    where: staffScope,
    select: { id: true, locationId: true, metadata: true, location: { select: { tenantId: true } } },
  });

  if (!staff) {
    return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
  }

  const metadata =
    staff.metadata && typeof staff.metadata === "object" ? { ...(staff.metadata as Record<string, unknown>) } : {};
  const profileUrl =
    typeof metadata.profileImageUrl === "string" ? (metadata.profileImageUrl as string) : null;

  if (!profileUrl) {
    return NextResponse.json({ data: { profileImageUrl: null } });
  }

  metadata.profileImageUrl = null;

  await prisma.staff.update({
    where: { id: staff.id },
    data: {
      metadata: metadata as Prisma.InputJsonValue,
    },
  });

  const absolutePath = resolveAbsolutePath(profileUrl);
  if (absolutePath) {
    await fs.unlink(absolutePath).catch(() => undefined);
  }

  await logAuditEvent({
    locationId: staff.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "staff",
    entityId: staff.id,
    appointmentId: null,
    diff: {
      updated: { profileImageUrl: null },
    },
    context: { source: "backoffice_staff_profile_image_remove" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  await syncProfileImageToControlPlane({
    staffId: staff.id,
    tenantId: staff.location.tenantId,
    photoUrl: null,
  });

  return NextResponse.json({ data: { profileImageUrl: null } });
}
