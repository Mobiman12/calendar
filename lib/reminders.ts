import { DEFAULT_WHATSAPP_TEMPLATE, type WhatsAppTemplateKey } from "@/lib/notifications/whatsapp-templates";

export type ReminderChannel = "EMAIL" | "SMS" | "WHATSAPP";
export type ReminderTiming = "BEFORE" | "AFTER";

export type ReminderRule = {
  id: string;
  message: string;
  offsetMinutes: number;
  timing: ReminderTiming;
  channels: ReminderChannel[];
  whatsappTemplateKey: WhatsAppTemplateKey;
  createdAt: string;
  updatedAt: string;
};

export type ReminderFormInput = {
  message: string;
  days: number;
  hours: number;
  minutes: number;
  timing: ReminderTiming;
  sendEmail: boolean;
  sendSms: boolean;
  sendWhatsapp: boolean;
  whatsappTemplateKey: WhatsAppTemplateKey;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readReminderRules(metadata: unknown): ReminderRule[] {
  if (!isRecord(metadata)) return [];
  const raw = metadata.reminders;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const id = typeof entry.id === "string" ? entry.id : null;
      const message = typeof entry.message === "string" ? entry.message.trim() : "";
      const offsetMinutes = typeof entry.offsetMinutes === "number" ? Math.max(0, entry.offsetMinutes) : 0;
      const timing = entry.timing === "AFTER" ? "AFTER" : "BEFORE";
      const channels = Array.isArray(entry.channels)
        ? entry.channels.filter(
            (value): value is ReminderChannel => value === "EMAIL" || value === "SMS" || value === "WHATSAPP",
          )
        : [];
      const whatsappTemplateKey =
        entry.whatsappTemplateKey === "bookingConfirmation" ||
        entry.whatsappTemplateKey === "reminder" ||
        entry.whatsappTemplateKey === "followUpThanks" ||
        entry.whatsappTemplateKey === "followUpNoShow"
          ? entry.whatsappTemplateKey
          : DEFAULT_WHATSAPP_TEMPLATE;
      const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : "";
      const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt : createdAt;
      const requiresMessage = channels.some((channel) => channel === "EMAIL" || channel === "SMS");
      if (!id || offsetMinutes <= 0 || channels.length === 0) return null;
      if (requiresMessage && !message) return null;
      return {
        id,
        message,
        offsetMinutes,
        timing,
        channels,
        whatsappTemplateKey,
        createdAt,
        updatedAt,
      } satisfies ReminderRule;
    })
    .filter((entry): entry is ReminderRule => Boolean(entry));
}

export function buildReminderFromInput(input: ReminderFormInput, existing?: ReminderRule): ReminderRule | null {
  const message = input.message.trim();
  const requiresMessage = input.sendEmail || input.sendSms;
  if (requiresMessage && !message) {
    return null;
  }
  const days = Number.isFinite(input.days) ? Math.max(0, Math.floor(input.days)) : 0;
  const hours = Number.isFinite(input.hours) ? Math.max(0, Math.floor(input.hours)) : 0;
  const minutes = Number.isFinite(input.minutes) ? Math.max(0, Math.floor(input.minutes)) : 0;
  const offsetMinutes = days * 24 * 60 + hours * 60 + minutes;
  const channels: ReminderChannel[] = [];
  if (input.sendEmail) channels.push("EMAIL");
  if (input.sendSms) channels.push("SMS");
  if (input.sendWhatsapp) channels.push("WHATSAPP");
  if (offsetMinutes <= 0 || channels.length === 0) {
    return null;
  }
  const now = new Date().toISOString();
  const whatsappTemplateKey = input.whatsappTemplateKey ?? existing?.whatsappTemplateKey ?? DEFAULT_WHATSAPP_TEMPLATE;
  return {
    id: existing?.id ?? crypto.randomUUID(),
    message,
    offsetMinutes,
    timing: input.timing === "AFTER" ? "AFTER" : "BEFORE",
    channels,
    whatsappTemplateKey,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function applyReminderRules(metadata: unknown, reminders: ReminderRule[]): Record<string, unknown> {
  const base = isRecord(metadata) ? { ...metadata } : {};
  return {
    ...base,
    reminders,
  };
}

export function splitOffsetMinutes(totalMinutes: number) {
  const safe = Math.max(0, Math.floor(totalMinutes));
  const days = Math.floor(safe / (24 * 60));
  const hours = Math.floor((safe % (24 * 60)) / 60);
  const minutes = safe % 60;
  return { days, hours, minutes };
}

export function formatReminderOffset(rule: ReminderRule) {
  const { days, hours, minutes } = splitOffsetMinutes(rule.offsetMinutes);
  const parts: string[] = [];
  if (days) parts.push(`${days} Tag${days === 1 ? "" : "e"}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes) parts.push(`${minutes} min`);
  if (!parts.length) parts.push("0 min");
  const suffix = rule.timing === "AFTER" ? "nach dem Termin" : "vor dem Termin";
  return `${parts.join(" ")} ${suffix}`;
}
