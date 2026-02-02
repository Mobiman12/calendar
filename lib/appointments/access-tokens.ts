import { createHash, randomBytes } from "crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";

type PrismaDelegate = PrismaClient | Prisma.TransactionClient;

const TOKEN_BYTES = 32;
const SHORT_CODE_BYTES = 12;
const MAX_ATTEMPTS = 3;

export function hashAppointmentAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createAppointmentAccessToken(
  appointmentId: string,
  expiresAt: Date,
  prisma?: PrismaDelegate,
): Promise<{ token: string; tokenHash: string; shortCode: string }> {
  const client = prisma ?? getPrismaClient();
  const canRetry = "$transaction" in client;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    const tokenHash = hashAppointmentAccessToken(token);
    const shortCode = randomBytes(SHORT_CODE_BYTES).toString("base64url");
    const shortCodeHash = hashAppointmentAccessToken(shortCode);
    try {
      await client.appointmentAccessToken.create({
        data: {
          appointmentId,
          tokenHash,
          shortCodeHash,
          expiresAt,
        },
      });
      return { token, tokenHash, shortCode };
    } catch (error) {
      if (!canRetry) {
        throw error;
      }
      const isUniqueError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (!isUniqueError || attempt >= MAX_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw new Error("Appointment access token could not be created.");
}

export function buildAppointmentManageUrl(tenantParam: string, token: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL?.trim() || "http://localhost:3002";
  const normalizedBase = base.replace(/\/$/, "");
  return `${normalizedBase}/book/${encodeURIComponent(tenantParam)}/appointment/${token}`;
}

export function buildAppointmentSmsUrl(shortCode: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL?.trim() || "http://localhost:3002";
  const normalizedBase = base.replace(/\/$/, "");
  return `${normalizedBase}/b/${shortCode}`;
}
