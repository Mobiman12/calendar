"use client";

export type UserPreferences = {
  calendarSlotIntervalMinutes: number;
};

export const USER_PREFERENCES_STORAGE_KEY = "codex-user-preferences";
export const USER_PREFERENCES_EVENT = "user-preferences:update";

export const SLOT_INTERVAL_OPTIONS = [5, 10, 15, 30] as const;

export function getDefaultUserPreferences(): UserPreferences {
  return {
    calendarSlotIntervalMinutes: 30,
  };
}

export function loadUserPreferences(): UserPreferences {
  if (typeof window === "undefined") {
    return getDefaultUserPreferences();
  }
  try {
    const raw = window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return getDefaultUserPreferences();
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return getDefaultUserPreferences();
    }
    const prefs = getDefaultUserPreferences();
    if (
      typeof (parsed as Record<string, unknown>).calendarSlotIntervalMinutes === "number" &&
      SLOT_INTERVAL_OPTIONS.includes((parsed as Record<string, number>).calendarSlotIntervalMinutes as any)
    ) {
      prefs.calendarSlotIntervalMinutes = (parsed as Record<string, number>).calendarSlotIntervalMinutes;
    }
    return prefs;
  } catch {
    return getDefaultUserPreferences();
  }
}

export function saveUserPreferences(partial: Partial<UserPreferences>): UserPreferences {
  if (typeof window === "undefined") {
    return { ...getDefaultUserPreferences(), ...partial };
  }
  const current = loadUserPreferences();
  const next: UserPreferences = {
    ...current,
    ...partial,
  };
  try {
    window.localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent<UserPreferences>(USER_PREFERENCES_EVENT, { detail: next }));
  } catch {
    // ignore write errors (storage full, disabled, etc.)
  }
  return next;
}
