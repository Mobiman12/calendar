import { Prisma } from "@prisma/client";

export type AppsEnabled = {
  calendar: boolean;
  timeshift: boolean;
  website: boolean;
};

const DEFAULT_APPS: AppsEnabled = {
  calendar: true,
  timeshift: true,
  website: true,
};

export function readAppsEnabled(metadata: Prisma.JsonValue | null): AppsEnabled {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ...DEFAULT_APPS };
  }
  const record = metadata as Record<string, unknown>;
  const apps = record.apps;
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) {
    return { ...DEFAULT_APPS };
  }
  const readFlag = (key: keyof AppsEnabled) => {
    const value = (apps as Record<string, unknown>)[key];
    return typeof value === "boolean" ? value : DEFAULT_APPS[key];
  };
  return {
    calendar: readFlag("calendar"),
    timeshift: readFlag("timeshift"),
    website: readFlag("website"),
  };
}

export function writeAppsEnabled(
  metadata: Prisma.JsonValue | null,
  updates: Partial<AppsEnabled>,
): Prisma.InputJsonValue {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const current = readAppsEnabled(metadata);
  const next: AppsEnabled = {
    calendar: updates.calendar ?? current.calendar,
    timeshift: updates.timeshift ?? current.timeshift,
    website: updates.website ?? current.website,
  };
  base.apps = next;
  return base as Prisma.InputJsonValue;
}

export function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function readStaffProfileImageUrl(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  return normalizeString(record.profileImageUrl);
}
