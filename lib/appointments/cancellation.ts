import { bookingLimitToMinutes } from "@/lib/booking-preferences";
import type { BookingPreferencesState } from "@/lib/booking-preferences";
import type { LocationPolicies } from "@/lib/policies/types";
import { getCancellationDeadlineMinutes } from "@/lib/policies";

export function resolveCancellationDeadline(params: {
  startsAt: Date;
  policies?: LocationPolicies | null;
  bookingPreferences?: BookingPreferencesState | null;
}): Date | null {
  const { startsAt, policies, bookingPreferences } = params;
  let minutes: number | null = null;

  if (typeof policies?.cancellation?.windowHours === "number" && Number.isFinite(policies.cancellation.windowHours)) {
    minutes = getCancellationDeadlineMinutes(Math.max(0, policies.cancellation.windowHours));
  } else if (bookingPreferences) {
    minutes = bookingLimitToMinutes(bookingPreferences.cancelLimit);
  }

  if (minutes === null) {
    return null;
  }

  return new Date(startsAt.getTime() - minutes * 60 * 1000);
}
