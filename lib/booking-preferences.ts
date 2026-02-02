export type BookingLimitUnit = "minutes" | "hours" | "days" | "weeks";

export type BookingLimit = {
  value: number;
  unit: BookingLimitUnit;
};

export type BookingBannerFit = "cover" | "contain";
export type ManualConfirmationMode = "single" | "both";

export type BookingPreferencesState = {
  onlineBookingEnabled: boolean;
  customerNoticeEnabled: boolean;
  customerNoticeText: string;
  emailReplyToEnabled: boolean;
  emailReplyTo: string;
  emailSenderName: string;
  smsBrandName: string;
  smsSenderName: string;
  bookingBannerImageUrl: string | null;
  bookingBannerHeight: number;
  bookingBannerFit: BookingBannerFit;
  bookingButtonFloating: boolean;
  bookingButtonUseLocation: boolean;
  bookingButtonPosition: "left" | "right";
  bookingButtonText: string;
  bookingButtonColor: string;
  bookingButtonTextColor: string;
  autoConfirm: boolean;
  manualConfirmationMode: ManualConfirmationMode;
  interval: string;
  minAdvance: BookingLimit;
  maxAdvance: BookingLimit;
  cancelLimit: BookingLimit;
  expandCategories: boolean;
  servicesPerBooking: number;
  askPeopleCount: boolean;
  autoPriceAdjust: boolean;
  showAnyStaffOption: boolean;
  shiftPlan: boolean;
  combineStaffResources: boolean;
  hideLastNames: boolean;
  popularServicesWindowDays: number;
  popularServicesLimit: number;
  serviceListLimit: number;
  smartSlotsEnabled: boolean;
  stepEngineMin: number;
  bufferMin: number;
  minGapMin: number;
  maxSmartSlotsPerHour: number;
  minWasteReductionMin: number;
  maxOffGridOffsetMin: number;
};

const MINUTES_PER_UNIT: Record<BookingLimitUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 60 * 24,
  weeks: 60 * 24 * 7,
};

export function bookingLimitToMinutes(limit: BookingLimit): number {
  const value = Number.isFinite(limit.value) ? Math.max(0, limit.value) : 0;
  const multiplier = MINUTES_PER_UNIT[limit.unit] ?? MINUTES_PER_UNIT.hours;
  return value * multiplier;
}

export const bookingPreferencesDefaults: BookingPreferencesState = {
  onlineBookingEnabled: true,
  customerNoticeEnabled: false,
  customerNoticeText: "",
  emailReplyToEnabled: false,
  emailReplyTo: "",
  emailSenderName: "",
  smsBrandName: "",
  smsSenderName: "",
  bookingBannerImageUrl: null,
  bookingBannerHeight: 220,
  bookingBannerFit: "cover",
  bookingButtonFloating: true,
  bookingButtonUseLocation: false,
  bookingButtonPosition: "left",
  bookingButtonText: "Termin online buchen",
  bookingButtonColor: "#1f6feb",
  bookingButtonTextColor: "#ffffff",
  autoConfirm: true,
  manualConfirmationMode: "both",
  interval: "30",
  minAdvance: { value: 0, unit: "hours" },
  maxAdvance: { value: 4, unit: "weeks" },
  cancelLimit: { value: 24, unit: "hours" },
  expandCategories: false,
  servicesPerBooking: 3,
  askPeopleCount: false,
  autoPriceAdjust: true,
  showAnyStaffOption: true,
  shiftPlan: false,
  combineStaffResources: false,
  hideLastNames: false,
  popularServicesWindowDays: 90,
  popularServicesLimit: 6,
  serviceListLimit: 8,
  smartSlotsEnabled: false,
  stepEngineMin: 5,
  bufferMin: 0,
  minGapMin: 10,
  maxSmartSlotsPerHour: 1,
  minWasteReductionMin: 10,
  maxOffGridOffsetMin: 10,
};

export function deriveBookingPreferences(raw: unknown): BookingPreferencesState {
  let normalized = raw;
  if (typeof normalized === "string") {
    try {
      normalized = JSON.parse(normalized) as unknown;
    } catch {
      normalized = null;
    }
  }
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return { ...bookingPreferencesDefaults };
  }
  const record = normalized as Record<string, unknown>;
  const mapLimit = (value: unknown, fallback: BookingLimit): BookingLimit => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fallback;
    }
    const entry = value as Record<string, unknown>;
    const limitValue = typeof entry.value === "number" ? entry.value : fallback.value;
    const unit = typeof entry.unit === "string" ? (entry.unit as BookingLimitUnit) : fallback.unit;
    return { value: limitValue, unit };
  };

  const normalizeHeight = (value: unknown, fallback: number) => {
    const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw);
    return Math.min(360, Math.max(120, rounded));
  };

  const normalizeNotice = (value: unknown, fallback: string) => {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed.length ? trimmed.slice(0, 280) : "";
  };

  const normalizeText = (value: unknown, fallback: string, maxLength: number) => {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed.length ? trimmed.slice(0, maxLength) : "";
  };

  const normalizeEmail = (value: unknown, fallback: string) => {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (!trimmed) return "";
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailPattern.test(trimmed) ? trimmed.slice(0, 120) : fallback;
  };

  const normalizePopularWindowDays = (value: unknown, fallback: number) => {
    const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw);
    if (rounded === 30 || rounded === 90) return rounded;
    return fallback;
  };

  const normalizePopularLimit = (value: unknown, fallback: number) => {
    const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw);
    return Math.min(6, Math.max(4, rounded));
  };

  const normalizeServiceListLimit = (value: unknown, fallback: number) => {
    const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw);
    return Math.min(12, Math.max(4, rounded));
  };

  const normalizeInt = (value: unknown, fallback: number, min: number, max: number) => {
    const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw);
    return Math.min(max, Math.max(min, rounded));
  };

  const normalizeInterval = (value: unknown, fallback: string) => {
    const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
    const parsed = Number.parseInt(raw ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return String(parsed);
  };

  const interval = normalizeInterval(record.interval, bookingPreferencesDefaults.interval);
  const stepUiMin = Math.max(1, Number.parseInt(interval, 10) || 1);
  const resolveStepEngine = (value: unknown, fallback: number) => {
    const requested = normalizeInt(value, fallback, 1, stepUiMin);
    if (stepUiMin % requested === 0) return requested;
    for (let candidate = Math.min(requested, stepUiMin); candidate >= 1; candidate -= 1) {
      if (stepUiMin % candidate === 0) return candidate;
    }
    return stepUiMin;
  };
  const maxOffsetLimit = Math.max(0, Math.floor(stepUiMin / 2));

  return {
    onlineBookingEnabled:
      typeof record.onlineBookingEnabled === "boolean"
        ? record.onlineBookingEnabled
        : bookingPreferencesDefaults.onlineBookingEnabled,
    customerNoticeEnabled:
      typeof record.customerNoticeEnabled === "boolean"
        ? record.customerNoticeEnabled
        : bookingPreferencesDefaults.customerNoticeEnabled,
    customerNoticeText: normalizeNotice(record.customerNoticeText, bookingPreferencesDefaults.customerNoticeText),
    emailReplyToEnabled:
      typeof record.emailReplyToEnabled === "boolean"
        ? record.emailReplyToEnabled
        : bookingPreferencesDefaults.emailReplyToEnabled,
    emailReplyTo: normalizeEmail(record.emailReplyTo, bookingPreferencesDefaults.emailReplyTo),
    emailSenderName: normalizeText(record.emailSenderName, bookingPreferencesDefaults.emailSenderName, 80),
    smsBrandName: normalizeText(record.smsBrandName, bookingPreferencesDefaults.smsBrandName, 20),
    smsSenderName: normalizeText(record.smsSenderName, bookingPreferencesDefaults.smsSenderName, 11),
    bookingBannerImageUrl:
      typeof record.bookingBannerImageUrl === "string" ? record.bookingBannerImageUrl : bookingPreferencesDefaults.bookingBannerImageUrl,
    bookingBannerHeight: normalizeHeight(record.bookingBannerHeight, bookingPreferencesDefaults.bookingBannerHeight),
    bookingBannerFit:
      record.bookingBannerFit === "contain" || record.bookingBannerFit === "cover"
        ? record.bookingBannerFit
        : bookingPreferencesDefaults.bookingBannerFit,
    bookingButtonFloating:
      typeof record.bookingButtonFloating === "boolean"
        ? record.bookingButtonFloating
        : bookingPreferencesDefaults.bookingButtonFloating,
    bookingButtonUseLocation:
      typeof record.bookingButtonUseLocation === "boolean"
        ? record.bookingButtonUseLocation
        : bookingPreferencesDefaults.bookingButtonUseLocation,
    bookingButtonPosition:
      record.bookingButtonPosition === "left" || record.bookingButtonPosition === "right"
        ? record.bookingButtonPosition
        : bookingPreferencesDefaults.bookingButtonPosition,
    bookingButtonText:
      typeof record.bookingButtonText === "string" && record.bookingButtonText.trim().length
        ? record.bookingButtonText
        : bookingPreferencesDefaults.bookingButtonText,
    bookingButtonColor:
      typeof record.bookingButtonColor === "string" && record.bookingButtonColor.trim().length
        ? record.bookingButtonColor
        : bookingPreferencesDefaults.bookingButtonColor,
    bookingButtonTextColor:
      typeof record.bookingButtonTextColor === "string" && record.bookingButtonTextColor.trim().length
        ? record.bookingButtonTextColor
        : bookingPreferencesDefaults.bookingButtonTextColor,
    autoConfirm: typeof record.autoConfirm === "boolean" ? record.autoConfirm : bookingPreferencesDefaults.autoConfirm,
    manualConfirmationMode:
      record.manualConfirmationMode === "single" || record.manualConfirmationMode === "both"
        ? (record.manualConfirmationMode as ManualConfirmationMode)
        : bookingPreferencesDefaults.manualConfirmationMode,
    interval,
    minAdvance: mapLimit(record.minAdvance, bookingPreferencesDefaults.minAdvance),
    maxAdvance: mapLimit(record.maxAdvance, bookingPreferencesDefaults.maxAdvance),
    cancelLimit: mapLimit(record.cancelLimit, bookingPreferencesDefaults.cancelLimit),
    expandCategories:
      typeof record.expandCategories === "boolean" ? record.expandCategories : bookingPreferencesDefaults.expandCategories,
    servicesPerBooking:
      typeof record.servicesPerBooking === "number" ? record.servicesPerBooking : bookingPreferencesDefaults.servicesPerBooking,
    askPeopleCount:
      typeof record.askPeopleCount === "boolean" ? record.askPeopleCount : bookingPreferencesDefaults.askPeopleCount,
    autoPriceAdjust:
      typeof record.autoPriceAdjust === "boolean" ? record.autoPriceAdjust : bookingPreferencesDefaults.autoPriceAdjust,
    showAnyStaffOption:
      typeof record.showAnyStaffOption === "boolean" ? record.showAnyStaffOption : bookingPreferencesDefaults.showAnyStaffOption,
    shiftPlan: typeof record.shiftPlan === "boolean"
      ? record.shiftPlan
      : typeof record.shiftPlanEnabled === "boolean"
        ? (record.shiftPlanEnabled as boolean)
        : bookingPreferencesDefaults.shiftPlan,
    combineStaffResources:
      typeof record.combineStaffResources === "boolean"
        ? record.combineStaffResources
        : bookingPreferencesDefaults.combineStaffResources,
    hideLastNames:
      typeof record.hideLastNames === "boolean" ? record.hideLastNames : bookingPreferencesDefaults.hideLastNames,
    popularServicesWindowDays: normalizePopularWindowDays(
      record.popularServicesWindowDays,
      bookingPreferencesDefaults.popularServicesWindowDays,
    ),
    popularServicesLimit: normalizePopularLimit(
      record.popularServicesLimit,
      bookingPreferencesDefaults.popularServicesLimit,
    ),
    serviceListLimit: normalizeServiceListLimit(
      record.serviceListLimit,
      bookingPreferencesDefaults.serviceListLimit,
    ),
    smartSlotsEnabled:
      typeof record.smartSlotsEnabled === "boolean"
        ? record.smartSlotsEnabled
        : bookingPreferencesDefaults.smartSlotsEnabled,
    stepEngineMin: resolveStepEngine(record.stepEngineMin, bookingPreferencesDefaults.stepEngineMin),
    bufferMin: normalizeInt(record.bufferMin, bookingPreferencesDefaults.bufferMin, 0, 15),
    minGapMin: normalizeInt(record.minGapMin, bookingPreferencesDefaults.minGapMin, 5, 30),
    maxSmartSlotsPerHour: normalizeInt(
      record.maxSmartSlotsPerHour,
      bookingPreferencesDefaults.maxSmartSlotsPerHour,
      0,
      2,
    ),
    minWasteReductionMin: normalizeInt(
      record.minWasteReductionMin,
      bookingPreferencesDefaults.minWasteReductionMin,
      0,
      60,
    ),
    maxOffGridOffsetMin: normalizeInt(
      record.maxOffGridOffsetMin,
      Math.min(bookingPreferencesDefaults.maxOffGridOffsetMin, maxOffsetLimit),
      0,
      maxOffsetLimit,
    ),
  };
}
