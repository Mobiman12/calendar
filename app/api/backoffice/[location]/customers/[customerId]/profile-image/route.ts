import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { AuditAction, AuditActorType, type Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { applyCustomerProfile, readCustomerProfile } from "@/lib/customer-metadata";

const prisma = getPrismaClient();
const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads", "customers");

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
  return `/uploads/customers/${fileName}`;
}

function resolveAbsolutePath(url: string) {
  if (!url.startsWith("/uploads/customers/")) {
    return null;
  }
  return path.join(process.cwd(), "public", url);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string; customerId: string }> },
) {
  const { location, customerId } = await context.params;

  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customerScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        id: customerId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: customerId, location: { slug: location } };

  const customer = await prisma.customer.findFirst({
    where: customerScope,
    select: { id: true, locationId: true, metadata: true },
  });

  if (!customer) {
    return NextResponse.json({ error: "Kunde nicht gefunden." }, { status: 404 });
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

  const currentProfile = readCustomerProfile(customer.metadata ?? null);
  const previousUrl = currentProfile.photoUrl;
  const publicUrl = buildPublicPath(fileName);

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      metadata: applyCustomerProfile(customer.metadata ?? null, { photoUrl: publicUrl }),
    },
  });

  if (previousUrl) {
    const oldPath = resolveAbsolutePath(previousUrl);
    if (oldPath) {
      await fs.unlink(oldPath).catch(() => undefined);
    }
  }

  await logAuditEvent({
    locationId: customer.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "customer",
    entityId: customer.id,
    appointmentId: null,
    diff: {
      updated: { photoUrl: publicUrl },
    },
    context: { source: "backoffice_customer_profile_image_upload" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ data: { profileImageUrl: publicUrl } });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string; customerId: string }> },
) {
  const { location, customerId } = await context.params;

  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customerScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        id: customerId,
        OR: [
          { location: { slug: location } },
          { memberships: { some: { location: { slug: location } } } },
        ],
      }
    : { id: customerId, location: { slug: location } };

  const customer = await prisma.customer.findFirst({
    where: customerScope,
    select: { id: true, locationId: true, metadata: true },
  });

  if (!customer) {
    return NextResponse.json({ error: "Kunde nicht gefunden." }, { status: 404 });
  }

  const currentProfile = readCustomerProfile(customer.metadata ?? null);
  if (!currentProfile.photoUrl) {
    return NextResponse.json({ data: { profileImageUrl: null } });
  }

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      metadata: applyCustomerProfile(customer.metadata ?? null, { photoUrl: null }),
    },
  });

  const absolutePath = resolveAbsolutePath(currentProfile.photoUrl);
  if (absolutePath) {
    await fs.unlink(absolutePath).catch(() => undefined);
  }

  await logAuditEvent({
    locationId: customer.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "customer",
    entityId: customer.id,
    appointmentId: null,
    diff: {
      updated: { photoUrl: null },
    },
    context: { source: "backoffice_customer_profile_image_remove" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ data: { profileImageUrl: null } });
}
