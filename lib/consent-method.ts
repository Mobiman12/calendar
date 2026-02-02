export const CONSENT_METHOD_ONLINE = "online" as const;
export const CONSENT_METHOD_PERSONAL = "persönlich" as const;
export const CONSENT_METHOD_WRITTEN = "schriftlich" as const;

export const CONSENT_METHOD_OPTIONS = [
  { value: CONSENT_METHOD_ONLINE, label: "Online" },
  { value: CONSENT_METHOD_PERSONAL, label: "Persönlich" },
  { value: CONSENT_METHOD_WRITTEN, label: "Schriftlich" },
] as const;

export type ConsentMethod = (typeof CONSENT_METHOD_OPTIONS)[number]["value"];

const METHOD_ALIASES: Record<string, ConsentMethod> = {
  online: CONSENT_METHOD_ONLINE,
  "persönlich": CONSENT_METHOD_PERSONAL,
  persoenlich: CONSENT_METHOD_PERSONAL,
  personlich: CONSENT_METHOD_PERSONAL,
  muendlich: CONSENT_METHOD_PERSONAL,
  "mündlich": CONSENT_METHOD_PERSONAL,
  telefonisch: CONSENT_METHOD_PERSONAL,
  termin: CONSENT_METHOD_PERSONAL,
  schriftlich: CONSENT_METHOD_WRITTEN,
};

export function normalizeConsentMethod(value?: string | null): ConsentMethod | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return METHOD_ALIASES[key] ?? null;
}
