"use strict";

import twilio, { type Twilio } from "twilio";

import { getLogger } from "@/lib/logger";
import { normalizePhoneNumber } from "@/lib/notifications/phone";

let twilioClient: Twilio | null = null;

function ensureClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials are not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).");
  }
  if (!twilioClient) {
    twilioClient = twilio(accountSid, authToken);
  }
  return twilioClient;
}

export function isSmsConfigured() {
  return Boolean(getControlPlaneSmsUrl() || (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN));
}

export function isWhatsappConfigured() {
  return Boolean(process.env.CONTROL_PLANE_WHATSAPP_URL || process.env.CONTROL_PLANE_URL);
}

export async function sendSms(params: { to: string; body: string; tenantId?: string | null; sender?: string | null }) {
  const logger = getLogger();
  const controlPlaneUrl = getControlPlaneSmsUrl();
  const normalizedTo = normalizePhoneNumber(params.to);

  if (controlPlaneUrl && params.tenantId) {
    const secret = process.env.PROVISION_SECRET?.trim();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) {
      headers["x-provision-secret"] = secret;
    }
    const res = await fetch(controlPlaneUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tenantId: params.tenantId,
        to: normalizedTo,
        text: params.body,
        sender: params.sender ?? undefined,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(`Control Plane SMS failed: ${res.status} ${text}`);
    }
    return;
  }

  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) {
    throw new Error("TWILIO_FROM_NUMBER is not configured.");
  }

  const client = ensureClient();
  try {
    await client.messages.create({
      to: normalizedTo,
      from,
      body: params.body,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to send SMS via Twilio");
    throw error;
  }
}

function getControlPlaneSmsUrl() {
  const explicit = process.env.CONTROL_PLANE_SMS_URL?.trim();
  if (explicit) {
    const cleaned = explicit.replace(/\/$/, "");
    if (cleaned.endsWith("/api/internal/sms/send")) {
      return cleaned;
    }
    return `${cleaned}/api/internal/sms/send`;
  }
  const base = process.env.CONTROL_PLANE_URL?.trim();
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/api/internal/sms/send`;
}
