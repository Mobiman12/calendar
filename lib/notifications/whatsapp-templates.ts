export const WHATSAPP_TEMPLATE_OPTIONS = [
  { key: "reminder", label: "Termin-Erinnerung" },
  { key: "bookingConfirmation", label: "Buchungsbestätigung" },
  { key: "followUpThanks", label: "Follow-up (Danke)" },
  { key: "followUpNoShow", label: "Follow-up (No-Show)" },
] as const;

export const WHATSAPP_TEMPLATE_KEYS = [
  ...WHATSAPP_TEMPLATE_OPTIONS.map((option) => option.key),
  "bookingConfirmationLink",
] as const;

export type WhatsAppTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export const DEFAULT_WHATSAPP_TEMPLATE: WhatsAppTemplateKey = "reminder";
