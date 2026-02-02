import { createHash, randomBytes } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { sendMail } from "@/lib/notifications/smtp";

type PrismaDelegate = PrismaClient | Prisma.TransactionClient;

const TOKEN_BYTES = 32;
const TOKEN_MAX_ATTEMPTS = 3;
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

export function hashCustomerPermissionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function buildCustomerPermissionConfirmUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL?.trim() || "http://localhost:3002";
  return `${base.replace(/\/$/, "")}/vip/confirm/${encodeURIComponent(token)}`;
}

export async function createCustomerPermissionToken(params: {
  customerId: string;
  locationId: string;
  createdByUserId?: string | null;
  expiresAt?: Date;
  prisma?: PrismaDelegate;
}): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const client = params.prisma ?? getPrismaClient();
  const expiresAt = params.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
  const canRetry = "$transaction" in client;

  for (let attempt = 0; attempt < TOKEN_MAX_ATTEMPTS; attempt += 1) {
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const tokenHash = hashCustomerPermissionToken(token);
    try {
      await client.customerPermissionToken.create({
        data: {
          tokenHash,
          customerId: params.customerId,
          locationId: params.locationId,
          expiresAt,
          createdByUserId: params.createdByUserId ?? null,
        },
      });
      return { token, tokenHash, expiresAt };
    } catch (error) {
      if (!canRetry) throw error;
      const isUniqueError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!isUniqueError || attempt >= TOKEN_MAX_ATTEMPTS - 1) {
        throw error;
      }
    }
  }

  throw new Error("Permission token could not be created.");
}

export async function sendCustomerPermissionEmail(params: {
  customerId: string;
  locationId: string;
  email: string;
  customerName?: string | null;
  createdByUserId?: string | null;
  prisma?: PrismaDelegate;
}): Promise<{ token: string; expiresAt: Date; confirmUrl: string }> {
  const { token, expiresAt } = await createCustomerPermissionToken({
    customerId: params.customerId,
    locationId: params.locationId,
    createdByUserId: params.createdByUserId ?? null,
    prisma: params.prisma,
  });
  const confirmUrl = buildCustomerPermissionConfirmUrl(token);
  const displayName = params.customerName?.trim() || "Kunde";
  const text = [
    `Hallo ${displayName},`,
    "",
    "bitte bestätige die Freigabe zur Online-Buchung.",
    confirmUrl,
    "",
    "Der Link ist 1 Stunde gültig.",
  ].join("\n");

  await sendMail({
    to: params.email,
    subject: "Freigabe zur Online-Buchung bestätigen",
    text,
  });

  return { token, expiresAt, confirmUrl };
}

export async function resolveVerifiedCustomerIdForDevice(params: {
  deviceId?: string | null;
  locationId: string;
  prisma?: PrismaDelegate;
}): Promise<string | null> {
  const deviceId = params.deviceId?.trim();
  if (!deviceId || !isUuid(deviceId)) return null;
  const client = params.prisma ?? getPrismaClient();
  const membershipSupported = await supportsCustomerMemberships(client);

  const device = await client.customerDevice.findFirst({
    where: {
      deviceId,
      revokedAt: null,
      customer: membershipSupported
        ? {
            OR: [
              { locationId: params.locationId },
              { memberships: { some: { locationId: params.locationId } } },
            ],
          }
        : { locationId: params.locationId },
    },
    select: { customerId: true },
  });

  if (!device?.customerId) return null;

  const verification = await client.customerDeviceVerification.findUnique({
    where: {
      customerId_locationId_deviceId: {
        customerId: device.customerId,
        locationId: params.locationId,
        deviceId,
      },
    },
    select: { id: true },
  });

  return verification ? device.customerId : null;
}

export async function resolvePermittedStaffIdsForDevice(params: {
  deviceId?: string | null;
  locationId: string;
  prisma?: PrismaDelegate;
}): Promise<{ customerId: string | null; staffIds: string[] }> {
  const client = params.prisma ?? getPrismaClient();
  const customerId = await resolveVerifiedCustomerIdForDevice({
    deviceId: params.deviceId,
    locationId: params.locationId,
    prisma: client,
  });
  if (!customerId) {
    return { customerId: null, staffIds: [] };
  }

  const permissions = await client.customerStaffBookingPermission.findMany({
    where: {
      customerId,
      locationId: params.locationId,
      isAllowed: true,
      revokedAt: null,
    },
    select: { staffId: true },
  });

  const staffIds = Array.from(
    new Set(
      permissions
        .map((entry) => entry.staffId)
        .filter((staffId): staffId is string => typeof staffId === "string" && staffId.trim().length > 0),
    ),
  );

  return { customerId, staffIds };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
