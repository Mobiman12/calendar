export const SUPPORTED_TIMEZONES = [
  "Europe/Berlin",
  "Europe/Zurich",
  "Europe/Vienna",
  "Europe/Paris",
  "Europe/Amsterdam",
  "Europe/Brussels",
  "UTC",
] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];
