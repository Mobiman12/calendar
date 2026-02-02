import type { WhatsAppTemplateKey } from "@/lib/notifications/whatsapp-templates";
import { normalizePhoneNumber } from "@/lib/notifications/phone";

type SendWhatsAppPayload = {
  tenantId: string;
  to: string;
  templateKey: WhatsAppTemplateKey;
  placeholders: string[];
  fallbackTemplateKey?: WhatsAppTemplateKey;
  fallbackPlaceholders?: string[];
  fallbackText?: string;
};

function getControlPlaneEndpoint(): string {
  const explicit = process.env.CONTROL_PLANE_WHATSAPP_URL?.trim();
  if (explicit) return explicit;
  const base = process.env.CONTROL_PLANE_URL?.trim();
  if (!base) {
    throw new Error("CONTROL_PLANE_URL is not configured.");
  }
  return `${base.replace(/\/$/, "")}/api/internal/whatsapp/send`;
}

function getInternalSecret(): string | null {
  const secret = process.env.PROVISION_SECRET?.trim();
  return secret || null;
}

export async function sendWhatsAppNotification(payload: SendWhatsAppPayload) {
  const normalizedTo = normalizePhoneNumber(payload.to);
  if (!normalizedTo || normalizedTo === "+") {
    return;
  }
  const url = getControlPlaneEndpoint();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret = getInternalSecret();
  if (secret) {
    headers["x-provision-secret"] = secret;
  }

  const sendTemplate = (templateKey: WhatsAppTemplateKey, placeholders: string[]) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tenantId: payload.tenantId,
        to: normalizedTo,
        type: "template",
        templateKey,
        placeholders,
      }),
    });

  let res = await sendTemplate(payload.templateKey, payload.placeholders);

  if (res.ok) {
    return;
  }

  if (payload.fallbackTemplateKey) {
    const fallbackPlaceholders = payload.fallbackPlaceholders ?? payload.placeholders;
    const fallbackRes = await sendTemplate(payload.fallbackTemplateKey, fallbackPlaceholders);
    if (fallbackRes.ok) {
      return;
    }
    res = fallbackRes;
  }

  if (process.env.WHATSAPP_ALLOW_TEXT_FALLBACK === "true" && payload.fallbackText) {
    const fallbackRes = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tenantId: payload.tenantId,
        to: normalizedTo,
        type: "text",
        text: payload.fallbackText,
      }),
    });
    if (fallbackRes.ok) {
      return;
    }
  }

  const message = await res.text().catch(() => "");
  throw new Error(`WhatsApp send failed: ${res.status} ${message}`);
}
