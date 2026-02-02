import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AuditAction, AuditActorType, type Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { logAuditEvent } from "@/lib/audit/logger";

const prisma = getPrismaClient();
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "booking-banners");
const MAX_FILE_SIZE = 6 * 1024 * 1024;

async function ensureUploadDirectory() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
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
  return `/uploads/booking-banners/${fileName}`;
}

function resolveAbsolutePath(url: string) {
  if (!url.startsWith("/uploads/booking-banners/")) {
    return null;
  }
  return path.join(process.cwd(), "public", url);
}

export async function POST(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, metadata: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Bitte ein gültiges Bild auswählen." }, { status: 400 });
  }

  if (!file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Nur Bilddateien sind erlaubt." }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "Das Bild ist zu groß (max. 6 MB)." }, { status: 400 });
  }

  await ensureUploadDirectory();

  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = resolveExtension(file);
  const fileName = `${Date.now()}-${crypto.randomUUID()}${extension}`;
  const absolutePath = path.join(UPLOAD_DIR, fileName);
  await fs.writeFile(absolutePath, buffer);

  const metadataRecord = normalizeRecord(locationRecord.metadata);
  const bookingPreferences = normalizeRecord(metadataRecord.bookingPreferences);
  const previousUrl =
    typeof bookingPreferences.bookingBannerImageUrl === "string"
      ? (bookingPreferences.bookingBannerImageUrl as string)
      : null;

  const publicUrl = buildPublicPath(fileName);
  bookingPreferences.bookingBannerImageUrl = publicUrl;
  metadataRecord.bookingPreferences = bookingPreferences;

  await prisma.location.update({
    where: { id: locationRecord.id },
    data: { metadata: metadataRecord as Prisma.InputJsonValue },
  });

  if (previousUrl) {
    const oldPath = resolveAbsolutePath(previousUrl);
    if (oldPath) {
      await fs.unlink(oldPath).catch(() => undefined);
    }
  }

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "booking_preferences",
    entityId: locationRecord.id,
    diff: { updated: { bookingBannerImageUrl: publicUrl } },
    context: { source: "booking_banner_upload" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ data: { bookingBannerImageUrl: publicUrl } });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, metadata: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const metadataRecord = normalizeRecord(locationRecord.metadata);
  const bookingPreferences = normalizeRecord(metadataRecord.bookingPreferences);
  const bannerUrl =
    typeof bookingPreferences.bookingBannerImageUrl === "string"
      ? (bookingPreferences.bookingBannerImageUrl as string)
      : null;

  if (!bannerUrl) {
    return NextResponse.json({ data: { bookingBannerImageUrl: null } });
  }

  bookingPreferences.bookingBannerImageUrl = null;
  metadataRecord.bookingPreferences = bookingPreferences;

  await prisma.location.update({
    where: { id: locationRecord.id },
    data: { metadata: metadataRecord as Prisma.InputJsonValue },
  });

  const absolutePath = resolveAbsolutePath(bannerUrl);
  if (absolutePath) {
    await fs.unlink(absolutePath).catch(() => undefined);
  }

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "booking_preferences",
    entityId: locationRecord.id,
    diff: { updated: { bookingBannerImageUrl: null } },
    context: { source: "booking_banner_remove" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ data: { bookingBannerImageUrl: null } });
}
