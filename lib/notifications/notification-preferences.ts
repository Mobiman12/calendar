import { deriveBookingPreferences } from "@/lib/booking-preferences";

export type NotificationPreferences = {
  emailSenderName: string | null;
  emailReplyTo: string | null;
  smsBrandName: string | null;
  smsSenderName: string | null;
};

export function resolveNotificationPreferences(metadata: unknown): NotificationPreferences {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  const prefs = deriveBookingPreferences(record?.bookingPreferences ?? null);
  const emailSenderName = prefs.emailSenderName.trim();
  const smsBrandName = prefs.smsBrandName.trim();
  const smsSenderName = prefs.smsSenderName.trim();
  const emailReplyTo =
    prefs.emailReplyToEnabled && prefs.emailReplyTo.trim() ? prefs.emailReplyTo.trim() : "";

  return {
    emailSenderName: emailSenderName || null,
    emailReplyTo: emailReplyTo || null,
    smsBrandName: smsBrandName || null,
    smsSenderName: smsSenderName || null,
  };
}
