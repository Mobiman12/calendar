import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { hashCustomerPermissionToken } from "@/lib/customer-booking-permissions";

const prisma = getPrismaClient();

const payloadSchema = z.object({
  token: z.string().min(1),
  deviceId: z.string().uuid(),
  locationId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null);
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { token, deviceId, locationId } = parsed.data;
  const tokenHash = hashCustomerPermissionToken(token);
  const record = await prisma.customerPermissionToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      customerId: true,
      locationId: true,
      expiresAt: true,
      usedAt: true,
    },
  });

  if (!record) {
    return NextResponse.json({ error: "Ungültiger Bestätigungslink." }, { status: 404 });
  }
  if (record.usedAt) {
    return NextResponse.json({ error: "Dieser Bestätigungslink wurde bereits verwendet." }, { status: 409 });
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    return NextResponse.json({ error: "Dieser Bestätigungslink ist abgelaufen." }, { status: 410 });
  }
  if (locationId && locationId !== record.locationId) {
    return NextResponse.json({ error: "Ungültige Standortzuordnung." }, { status: 400 });
  }

  const now = new Date();
  const userAgent = request.headers.get("user-agent") ?? null;

  await prisma.$transaction(async (tx) => {
    await tx.customerPermissionToken.update({
      where: { id: record.id },
      data: { usedAt: now },
    });

    await tx.customerDevice.upsert({
      where: {
        customerId_deviceId: {
          customerId: record.customerId,
          deviceId,
        },
      },
      update: {
        lastSeenAt: now,
        userAgent: userAgent ?? undefined,
        revokedAt: null,
      },
      create: {
        customerId: record.customerId,
        deviceId,
        firstSeenAt: now,
        lastSeenAt: now,
        userAgent: userAgent ?? undefined,
      },
    });

    await tx.customerDeviceVerification.upsert({
      where: {
        customerId_locationId_deviceId: {
          customerId: record.customerId,
          locationId: record.locationId,
          deviceId,
        },
      },
      update: { verifiedAt: now },
      create: {
        customerId: record.customerId,
        locationId: record.locationId,
        deviceId,
        verifiedAt: now,
      },
    });
  });

  return NextResponse.json({ ok: true });
}
