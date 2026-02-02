"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, addMonths } from "date-fns";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { BookingCustomerNotice } from "@/components/booking/BookingCustomerNotice";
import { useToast } from "@/components/ui/ToastProvider";
import {
  isColorConsultationName,
  type ColorDurationConfig,
  type ColorPrecheckAnswers,
} from "@/lib/color-consultation";

type ServiceOption = {
  id: string;
  name: string;
  description?: string;
  durationMin: number;
  priceCents?: number;
  showDurationOnline?: boolean;
  isComplex?: boolean;
  colorConsultationDurations?: ColorDurationConfig | null;
  categoryId?: string;
  categoryName?: string;
  assignedStaffIds?: string[];
  addOnServiceIds?: string[];
};

type StaffOption = {
  id: string;
  name: string;
  role?: string;
};

type SlotOption = {
  id: string;
  start: string;
  end: string;
  staffId?: string;
  staffName?: string;
  locationId?: string;
  capacity?: number;
  isPool?: boolean;
  isSmart?: boolean;
};

type LocationInfo = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
};

type BookingTheme = {
  accentColor?: string;
  accentTextColor?: string;
};

type ServicesResponse = {
  data: ServiceOption[];
  popularServiceIds?: string[];
  popularServiceIdsByCategory?: Record<string, string[]>;
};

type StaffResponse = {
  data: StaffOption[];
};

type AvailabilityMeta = {
  earliestStart?: string;
  minAdvanceMinutes?: number;
  maxAdvanceMinutes?: number | null;
};

type AvailabilityResponse = {
  data: SlotOption[];
  meta?: AvailabilityMeta;
};

type DeviceCustomer = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
};

type BookingSuggestion = {
  serviceId: string;
  serviceName: string;
  addOnServiceIds?: string[];
  addOnServiceNames?: string[];
  weekdayIndex: number;
  weekdayLabel: string;
  timeHHmm: string;
  startsAtLocalISO?: string | null;
  staffId?: string | null;
};

type DeviceCustomerResponse = {
  customer: DeviceCustomer | null;
  suggestion: BookingSuggestion | null;
};

type CheckoutResponse = {
  data: {
    appointmentId: string;
    confirmationCode: string;
    startsAt: string;
    endsAt: string;
    status: "PENDING" | "CONFIRMED";
    policy: Record<string, unknown> | null;
    channels?: {
      sms: boolean;
      whatsapp: boolean;
    };
  };
};

type CustomerFormState = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  landline: string;
  whatsappOptIn: boolean;
  termsAccepted: boolean;
  marketingOptIn: boolean;
};

type BookingStep = "slots" | "customer" | "success";

type ColorFlowMode = "consultation" | "direct";

type ColorFlow = {
  requestedServiceId: string | null;
  mode: ColorFlowMode;
};

type ColorQuestionnaire = {
  hairLength: "" | "short" | "medium" | "long";
  hairDensity: "" | "fine" | "normal" | "thick";
  hairState: "" | "natural" | "colored" | "blonded";
  desiredResult: "" | "refresh" | "change";
  allergies: "" | "yes" | "no";
  returning: "" | "yes" | "no";
};

type SlotHold = {
  slotKey: string;
  token: string;
  expiresAt: number;
  holdId?: string;
  staffId?: string;
  staffName?: string;
  slotId?: string;
};

type SlotPayload = {
  slotKey: string;
  locationId: string;
  staffId: string;
  start: string;
  end: string;
  reservedFrom?: string;
  reservedTo?: string;
  service?: {
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  };
  services?: Array<{
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  }>;
};

type TimeOfDay = "am" | "pm" | "eve";

type SlotGroup = {
  key: string;
  label: string;
  dateLabel: string;
  slots: SlotOption[];
};

type CategoryOption = {
  id: string;
  name: string;
};

const WINDOW_DAYS = 7;
const INITIAL_SLOT_LIMIT = 10;
const MIN_VISIBLE_DAY_GROUPS = 3;
const MAX_BOOKING_ATTACHMENTS = 1;
const MAX_BOOKING_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const BOOKING_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const COLOR_SERVICE_REGEX = /balayage|color|farbe|blond|strähn|highlight/i;

function createEmptyColorQuestionnaire(): ColorQuestionnaire {
  return {
    hairLength: "",
    hairDensity: "",
    hairState: "",
    desiredResult: "",
    allergies: "",
    returning: "",
  };
}

function isColorConsultationService(service: ServiceOption): boolean {
  return isColorConsultationName(service.name);
}

function isComplexColorService(service: ServiceOption, consultationId?: string | null): boolean {
  if (consultationId && service.id === consultationId) return false;
  if (service.isComplex) return true;
  const label = `${service.name} ${service.categoryName ?? ""}`.toLowerCase();
  return COLOR_SERVICE_REGEX.test(label);
}

interface BookingFlowProps {
  location: LocationInfo;
  initialServices?: ServiceOption[];
  tenantSlug?: string;
  theme?: BookingTheme;
  customerNotice?: string;
  companyProfile?: {
    terms?: string | null;
    privacy?: string | null;
    imprint?: string | null;
  };
  bookingPreferences?: {
    showAnyStaffOption?: boolean;
    hideLastNames?: boolean;
    servicesPerBooking?: number;
    serviceListLimit?: number;
  };
}

export function BookingFlow({
  location,
  initialServices = [],
  tenantSlug,
  theme,
  customerNotice,
  companyProfile,
  bookingPreferences,
}: BookingFlowProps) {
  const accentColor = theme?.accentColor ?? "#111827";
  const accentTextColor = theme?.accentTextColor ?? "#ffffff";
  const themeStyle = {
    "--booking-accent": accentColor,
    "--booking-accent-text": accentTextColor,
  } as React.CSSProperties;
  const allowAnyStaffOption = bookingPreferences?.showAnyStaffOption ?? true;
  const hideLastNames = bookingPreferences?.hideLastNames ?? false;
  const maxServicesPerBooking = Math.max(1, Math.min(bookingPreferences?.servicesPerBooking ?? 1, 10));
  const serviceListLimit = Math.max(4, Math.min(bookingPreferences?.serviceListLimit ?? 8, 12));

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const timeOfDay = resolveTimeOfDay(searchParams.get("timeOfDay"));
  const isTimeOfDayActive = Boolean(timeOfDay);

  const [services, setServices] = useState<ServiceOption[]>(initialServices);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [servicesError, setServicesError] = useState<string | null>(null);
  const [popularServiceIds, setPopularServiceIds] = useState<string[]>([]);
  const [popularServiceIdsByCategory, setPopularServiceIdsByCategory] = useState<Record<string, string[]>>({});
  const [serviceSearchTerm, setServiceSearchTerm] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [showAllServices, setShowAllServices] = useState(false);
  const [selectedServiceIds, setSelectedServiceIds] = useState<string[]>([]);
  const [expandedAddOnIds, setExpandedAddOnIds] = useState<string[]>([]);
  const [showServicePickerMobile, setShowServicePickerMobile] = useState(true);
  const [serviceFiltersCollapsed, setServiceFiltersCollapsed] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);
  const [staffError, setStaffError] = useState<string | null>(null);
  const [staffQuery, setStaffQuery] = useState("");
  const [showStaffSearch, setShowStaffSearch] = useState(false);
  const [selectedStaffId, setSelectedStaffId] = useState<string | null>(null);
  const [showStaffPickerMobile, setShowStaffPickerMobile] = useState(false);
  const [showDateJump, setShowDateJump] = useState(false);
  const [dateJumpInput, setDateJumpInput] = useState(() => formatDateInput(normalizeStartOfDay(new Date())));
  const [manualStartDate, setManualStartDate] = useState<Date | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isReturningDevice, setIsReturningDevice] = useState(false);
  const [deviceCustomer, setDeviceCustomer] = useState<DeviceCustomer | null>(null);
  const [deviceCustomerLoading, setDeviceCustomerLoading] = useState(false);
  const [ignoreDeviceCustomer, setIgnoreDeviceCustomer] = useState(false);
  const [bookingSuggestion, setBookingSuggestion] = useState<BookingSuggestion | null>(null);
  const [showSuggestionCard, setShowSuggestionCard] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [suggestionAccepted, setSuggestionAccepted] = useState(false);
  const [preferredWeekdayIndex, setPreferredWeekdayIndex] = useState<number | null>(null);
  const [preferredTimeHHmm, setPreferredTimeHHmm] = useState<string | null>(null);
  const [suggestionHint, setSuggestionHint] = useState<string | null>(null);
  const [highlightedSlotId, setHighlightedSlotId] = useState<string | null>(null);
  const [colorFlow, setColorFlow] = useState<ColorFlow | null>(null);
  const [colorQuestionnaire, setColorQuestionnaire] = useState<ColorQuestionnaire>(() =>
    createEmptyColorQuestionnaire(),
  );

  const [step, setStep] = useState<BookingStep>("slots");
  const [slots, setSlots] = useState<SlotOption[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [loadMoreLoading, setLoadMoreLoading] = useState(false);
  const [hasMoreSlots, setHasMoreSlots] = useState(true);
  const [pagesLoaded, setPagesLoaded] = useState(0);
  const [hideEarlier, setHideEarlier] = useState(false);
  const [revealEarlier, setRevealEarlier] = useState(false);
  const [slotError, setSlotError] = useState<string | null>(null);
  const [availabilityMeta, setAvailabilityMeta] = useState<AvailabilityMeta | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [selectedSlotSnapshot, setSelectedSlotSnapshot] = useState<SlotOption | null>(null);
  const [slotHold, setSlotHold] = useState<SlotHold | null>(null);
  const [holdRemainingSeconds, setHoldRemainingSeconds] = useState<number | null>(null);
  const slotHoldRef = useRef<SlotHold | null>(null);
  const fetchSlotsRef = useRef<((rangeStart: Date, append: boolean) => Promise<void>) | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [nextRangeStart, setNextRangeStart] = useState(() => normalizeStartOfDay(new Date()));
  const [loadedRanges, setLoadedRanges] = useState(0);
  const [currentRangeStart, setCurrentRangeStart] = useState(() => normalizeStartOfDay(new Date()));

  const [checkoutForm, setCheckoutForm] = useState<CustomerFormState>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    landline: "",
    whatsappOptIn: false,
    termsAccepted: false,
    marketingOptIn: false,
  });
  const [attachments, setAttachments] = useState<File[]>([]);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CheckoutResponse["data"] | null>(null);

  const currentFetch = useRef<AbortController | null>(null);
  const prevSelectedServiceRef = useRef<number>(0);
  const suggestionAppliedRef = useRef(false);
  const userSelectedServiceRef = useRef(false);
  const userSelectedStaffRef = useRef(false);
  const deviceCustomerAppliedRef = useRef(false);
  const serviceListAnchorRef = useRef<HTMLDivElement | null>(null);
  const { pushToast } = useToast();
  const termsLink = companyProfile?.terms?.trim() || "";
  const privacyLink = companyProfile?.privacy?.trim() || "";
  const imprintLink = companyProfile?.imprint?.trim() || "";
  const returningGreeting = deviceCustomer?.firstName?.trim()
    ? `Willkommen zurück, ${deviceCustomer.firstName.trim()}.`
    : "Willkommen zurück.";
  const returningFirstName = deviceCustomer?.firstName?.trim() || "";
  const notMeLabel = deviceCustomer?.firstName?.trim()
    ? `Ich bin nicht ${deviceCustomer.firstName.trim()}`
    : "Ich bin nicht diese Person";
  const showReturningSuggestionCard = Boolean(isReturningDevice && bookingSuggestion && showSuggestionCard);
  const showReturningGreetingBar = Boolean(isReturningDevice && !showReturningSuggestionCard && !suggestionAccepted);
  const showQuickSubtitle = !isReturningDevice;
  const allowServiceSelection = !isReturningDevice || suggestionDismissed || !bookingSuggestion;
  const formatStaffName = useCallback(
    (name?: string | null) => {
      if (!name) return "";
      if (!hideLastNames) return name;
      const trimmed = name.trim();
      if (!trimmed) return "";
      const [first] = trimmed.split(/\s+/);
      return first ?? trimmed;
    },
    [hideLastNames],
  );

  const selectedStaffName = useMemo(() => {
    if (!selectedStaffId) return null;
    const direct = staff.find((member) => member.id === selectedStaffId)?.name;
    return direct ? formatStaffName(direct) : null;
  }, [selectedStaffId, staff, formatStaffName]);
  const staffLabel = selectedStaffName ?? (allowAnyStaffOption ? "Beliebig" : "Team");
  const serviceStaffLabel = selectedStaffId
    ? `by ${selectedStaffName ?? "Team"}`
    : allowAnyStaffOption
      ? "Beliebig"
      : "";

  const rangeLabel = useMemo(() => formatDisplayDate(currentRangeStart), [currentRangeStart]);
  const isDateJumpActive = useMemo(
    () => formatDateInput(currentRangeStart) !== formatDateInput(normalizeStartOfDay(new Date())),
    [currentRangeStart],
  );
  const earliestBookingHint = useMemo(() => {
    if (!availabilityMeta?.earliestStart) return null;
    const minAdvanceMinutes = availabilityMeta.minAdvanceMinutes ?? 0;
    if (minAdvanceMinutes <= 0) return null;
    const earliestStartMs = Date.parse(availabilityMeta.earliestStart);
    if (!Number.isFinite(earliestStartMs)) return null;
    const todayKey = formatDateOnlyInTimeZone(new Date(nowMs), location.timezone);
    const earliestKey = formatDateOnlyInTimeZone(new Date(earliestStartMs), location.timezone);
    if (earliestKey === todayKey) {
      const timeLabel = formatTimeLabelInTimeZone(new Date(earliestStartMs), location.timezone);
      return `Heute erst ab ${timeLabel} Uhr buchbar (Einstellung "Frühestens buchbar").`;
    }
    const dateLabel = formatDateLabelInTimeZone(new Date(earliestStartMs), location.timezone);
    return `Termine erst ab ${dateLabel} buchbar (Einstellung "Frühestens buchbar").`;
  }, [availabilityMeta, location.timezone, nowMs]);

  useEffect(() => {
    if (showDateJump) {
      setDateJumpInput(formatDateInput(currentRangeStart));
    }
  }, [currentRangeStart, showDateJump]);

  useEffect(() => {
    if (!isReturningDevice) {
      setServiceFiltersCollapsed(false);
    }
  }, [isReturningDevice]);
  useEffect(() => {
    if (!bookingSuggestion || !isReturningDevice) {
      setSuggestionAccepted(false);
    }
  }, [bookingSuggestion?.serviceId, bookingSuggestion?.staffId, isReturningDevice]);

  const effectivePagesLoaded = useMemo(() => Math.max(pagesLoaded, Math.max(loadedRanges - 1, 0)), [loadedRanges, pagesLoaded]);

  useEffect(() => {
    const today = normalizeStartOfDay(new Date());
    const offsetDays = Math.floor((currentRangeStart.getTime() - today.getTime()) / 86400000);
    const shouldHide = effectivePagesLoaded >= 2 || offsetDays > 14;
    if (revealEarlier && shouldHide) {
      return;
    }
    setHideEarlier(shouldHide);
    if (!shouldHide) {
      setRevealEarlier(false);
    }
  }, [currentRangeStart, effectivePagesLoaded, revealEarlier]);

  const handleResetFilters = useCallback(() => {
    setSelectedCategoryId(null);
    if (isTimeOfDayActive) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("timeOfDay");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }
  }, [isTimeOfDayActive, pathname, router, searchParams]);

  const handleCategorySelect = useCallback((categoryId: string | null) => {
    setSelectedCategoryId(categoryId);
    requestAnimationFrame(() => {
      serviceListAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const handleApplyDeviceCustomer = useCallback(() => {
    if (!deviceCustomer) return;
    setCheckoutForm((current) => ({
      ...current,
      firstName: current.firstName.trim().length > 0 ? current.firstName : deviceCustomer.firstName || current.firstName,
      lastName: current.lastName.trim().length > 0 ? current.lastName : deviceCustomer.lastName || current.lastName,
      email: current.email.trim().length > 0 ? current.email : deviceCustomer.email ?? current.email,
      phone: current.phone.trim().length > 0 ? current.phone : deviceCustomer.phone ?? current.phone,
    }));
    if (bookingSuggestion && !suggestionDismissed) {
      setShowSuggestionCard(true);
    }
  }, [bookingSuggestion, deviceCustomer, suggestionDismissed]);

  useEffect(() => {
    if (!deviceCustomer || deviceCustomerAppliedRef.current) return;
    handleApplyDeviceCustomer();
    deviceCustomerAppliedRef.current = true;
  }, [deviceCustomer, handleApplyDeviceCustomer]);

  const handleIgnoreSuggestion = useCallback(() => {
    setShowSuggestionCard(false);
    setSuggestionDismissed(true);
    setShowAllServices(false);
    setServiceFiltersCollapsed(false);
    setServiceSearchTerm("");
    setSelectedCategoryId(null);
    setColorFlow(null);
    setColorQuestionnaire(createEmptyColorQuestionnaire());
    setShowServicePickerMobile(true);
    userSelectedStaffRef.current = false;
    setSelectedStaffId(null);
    setShowStaffPickerMobile(true);
  }, []);

  useEffect(() => {
    const previousCount = prevSelectedServiceRef.current;
    if (previousCount === 0 && selectedServiceIds.length > 0) {
      setShowServicePickerMobile(false);
    }
    if (selectedServiceIds.length > 0 && showAllServices) {
      setShowAllServices(false);
    }
    if (
      userSelectedServiceRef.current &&
      selectedServiceIds.length >= 2 &&
      selectedServiceIds.length > previousCount
    ) {
      pushToast({
        variant: "info",
        message: `Du hast ${selectedServiceIds.length} Leistungen ausgewählt.`,
        duration: 1800,
      });
    }
    prevSelectedServiceRef.current = selectedServiceIds.length;
  }, [pushToast, selectedServiceIds.length]);

  const servicesById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const addOnServiceIdSet = useMemo(() => {
    const ids = new Set<string>();
    services.forEach((service) => {
      service.addOnServiceIds?.forEach((id) => ids.add(id));
    });
    return ids;
  }, [services]);
  const colorConsultationService = useMemo(
    () => services.find((service) => isColorConsultationService(service)) ?? null,
    [services],
  );
  const lastColorServiceId = useMemo(() => {
    if (!bookingSuggestion?.serviceId) return null;
    const candidate = servicesById.get(bookingSuggestion.serviceId);
    if (!candidate) return null;
    return isComplexColorService(candidate, colorConsultationService?.id) ? candidate.id : null;
  }, [bookingSuggestion?.serviceId, colorConsultationService?.id, servicesById]);
  const canBookColorDirect = useCallback(
    (serviceId: string) => Boolean(isReturningDevice && lastColorServiceId && lastColorServiceId === serviceId),
    [isReturningDevice, lastColorServiceId],
  );
  const primaryServices = useMemo(() => services, [services]);

  const staffNameById = useMemo(() => {
    return new Map(staff.map((member) => [member.id, formatStaffName(member.name)]));
  }, [staff, formatStaffName]);

  const servicesByStaff = useMemo(() => {
    if (!selectedStaffId || !userSelectedStaffRef.current) return primaryServices;
    return primaryServices.filter(
      (service) => Array.isArray(service.assignedStaffIds) && service.assignedStaffIds.includes(selectedStaffId),
    );
  }, [primaryServices, selectedStaffId]);

  const normalizedServiceQuery = useMemo(() => normalizeSearchValue(serviceSearchTerm), [serviceSearchTerm]);

  const servicesBySearch = useMemo(() => {
    if (!normalizedServiceQuery) return servicesByStaff;
    return servicesByStaff.filter((service) => normalizeSearchValue(service.name).includes(normalizedServiceQuery));
  }, [normalizedServiceQuery, servicesByStaff]);

  const derivedCategories = useMemo(() => {
    const map = new Map<string, string>();
    servicesByStaff.forEach((service) => {
      if (!service.categoryId) return;
      const name = service.categoryName?.trim() || "Kategorie";
      map.set(service.categoryId, name);
    });
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [servicesByStaff]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    servicesBySearch.forEach((service) => {
      if (!service.categoryId) return;
      counts.set(service.categoryId, (counts.get(service.categoryId) ?? 0) + 1);
    });
    return counts;
  }, [servicesBySearch]);

  const filteredServices = useMemo(() => {
    if (!selectedCategoryId) return servicesBySearch;
    return servicesBySearch.filter((service) => service.categoryId === selectedCategoryId);
  }, [selectedCategoryId, servicesBySearch]);

  const popularServiceIdsForFilter = useMemo(() => {
    if (!selectedCategoryId) return popularServiceIds;
    const scoped = popularServiceIdsByCategory[selectedCategoryId];
    return Array.isArray(scoped) ? scoped : [];
  }, [popularServiceIds, popularServiceIdsByCategory, selectedCategoryId]);

  const popularServices = useMemo(() => {
    if (!popularServiceIdsForFilter.length) return [];
    const serviceMap = new Map(servicesByStaff.map((service) => [service.id, service]));
    return popularServiceIdsForFilter
      .map((serviceId) => serviceMap.get(serviceId))
      .filter((service): service is ServiceOption => Boolean(service));
  }, [popularServiceIdsForFilter, servicesByStaff]);
  const popularServiceIdSet = useMemo(() => {
    return new Set(popularServices.map((service) => service.id));
  }, [popularServices]);

  const selectedServices = useMemo(() => {
    if (!selectedServiceIds.length) return [];
    return selectedServiceIds
      .map((id) => servicesById.get(id))
      .filter((service): service is ServiceOption => Boolean(service));
  }, [selectedServiceIds, servicesById]);

  const primaryService = selectedServices[0] ?? null;
  const colorRequestedService = useMemo(() => {
    if (!colorFlow?.requestedServiceId) return null;
    return servicesById.get(colorFlow.requestedServiceId) ?? null;
  }, [colorFlow?.requestedServiceId, servicesById]);
  const showColorPrecheck = Boolean(colorFlow);
  const colorConsultationLabel = colorConsultationService?.name ?? "Farbberatung & Planung";
  const colorPrecheckAnswers = useMemo<ColorPrecheckAnswers | null>(() => {
    if (!colorFlow) return null;
    const answers: ColorPrecheckAnswers = {};
    if (colorQuestionnaire.hairLength) answers.hairLength = colorQuestionnaire.hairLength;
    if (colorQuestionnaire.hairDensity) answers.hairDensity = colorQuestionnaire.hairDensity;
    if (colorQuestionnaire.hairState) answers.hairState = colorQuestionnaire.hairState;
    if (colorQuestionnaire.desiredResult) answers.desiredResult = colorQuestionnaire.desiredResult;
    if (colorQuestionnaire.allergies) answers.allergies = colorQuestionnaire.allergies;
    if (colorQuestionnaire.returning) answers.returning = colorQuestionnaire.returning;
    return Object.keys(answers).length ? answers : null;
  }, [colorFlow, colorQuestionnaire]);
  const colorPrecheckPayload = colorPrecheckAnswers ?? null;
  const colorPrecheckQuery = useMemo(
    () => (colorPrecheckPayload ? JSON.stringify(colorPrecheckPayload) : null),
    [colorPrecheckPayload],
  );
  const addOnServices = useMemo(() => {
    if (!primaryService?.addOnServiceIds?.length) return [];
    const base = primaryService.addOnServiceIds
      .map((id) => servicesById.get(id))
      .filter((service): service is ServiceOption => Boolean(service));
    if (!selectedStaffId || !userSelectedStaffRef.current) return base;
    return base.filter(
      (service) => Array.isArray(service.assignedStaffIds) && service.assignedStaffIds.includes(selectedStaffId),
    );
  }, [primaryService, selectedStaffId, servicesById]);
  const suggestedAddOnServices = useMemo(() => addOnServices.slice(0, 3), [addOnServices]);
  const ADDON_DESCRIPTION_PREVIEW_LIMIT = 90;
  useEffect(() => {
    setExpandedAddOnIds([]);
  }, [primaryService?.id]);
  useEffect(() => {
    if (!colorFlow) return;
    const consultationId = colorConsultationService?.id ?? null;
    const requiredId = colorFlow.mode === "consultation" ? consultationId : colorFlow.requestedServiceId;
    if (!requiredId || !selectedServiceIds.includes(requiredId)) {
      setColorFlow(null);
      setColorQuestionnaire(createEmptyColorQuestionnaire());
    }
  }, [colorConsultationService?.id, colorFlow, selectedServiceIds]);
  useEffect(() => {
    if (!colorFlow) return;
    setColorQuestionnaire((current) => {
      if (current.returning) return current;
      return { ...current, returning: isReturningDevice ? "yes" : "no" };
    });
  }, [colorFlow, isReturningDevice]);
  const serviceDetailLabel = useMemo(() => {
    if (!selectedServices.length) return "";
    return selectedServices.map((service) => service.name).join(" · ");
  }, [selectedServices]);
  const serviceSummaryLabel = useMemo(() => {
    if (!selectedServices.length) return "";
    if (selectedServices.length <= 2) return serviceDetailLabel;
    return `${selectedServices[0].name} + ${selectedServices.length - 1} weitere`;
  }, [selectedServices, serviceDetailLabel]);
  const getEffectiveDuration = useCallback((service: ServiceOption) => service.durationMin, []);
  const selectedServiceDurationMin = useMemo(() => {
    if (!selectedServices.length) return null;
    return selectedServices.reduce((sum, service) => sum + getEffectiveDuration(service), 0);
  }, [getEffectiveDuration, selectedServices]);
  const showDurationForSelection = useMemo(() => {
    if (!selectedServices.length) return true;
    return selectedServices.every((service) => service.showDurationOnline !== false);
  }, [selectedServices]);
  const selectedServiceDurationDisplay = showDurationForSelection ? selectedServiceDurationMin : null;
  const selectedServicePriceCents = useMemo(() => {
    if (!selectedServices.length) return null;
    if (!selectedServices.every((service) => typeof service.priceCents === "number")) return null;
    return selectedServices.reduce((sum, service) => sum + (service.priceCents ?? 0), 0);
  }, [selectedServices]);

  useEffect(() => {
    if (!selectedServiceIds.length) return;
    const allowedAddOns = new Set(primaryService?.addOnServiceIds ?? []);
    setSelectedServiceIds((current) => {
      let changed = false;
      const primaryId = current[0] ?? null;
      const next = current.filter((id) => {
        if (id === primaryId) return true;
        if (!addOnServiceIdSet.has(id)) return true;
        const keep = Boolean(primaryService) && allowedAddOns.has(id);
        if (!keep) changed = true;
        return keep;
      });
      if (!next.length && current.length) {
        changed = true;
      }
      return changed ? next : current;
    });
  }, [addOnServiceIdSet, primaryService, selectedServiceIds.length]);

  useEffect(() => {
    if (!filteredServices.length) {
      if (selectedServiceIds.length) {
        setSelectedServiceIds([]);
      }
      return;
    }
    setSelectedServiceIds((current) => {
      const available = new Set(services.map((service) => service.id));
      let next = current.filter((id) => available.has(id));
      if (next.length > maxServicesPerBooking) {
        next = next.slice(0, maxServicesPerBooking);
      }
      if (!next.length) {
        return current.length ? [] : current;
      }
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current;
      }
      return next;
    });
  }, [filteredServices, maxServicesPerBooking, selectedServiceIds.length, services]);
  const staffById = useMemo(() => new Map(staff.map((member) => [member.id, member])), [staff]);
  const suggestedStaffName = useMemo(() => {
    if (!bookingSuggestion?.staffId) return null;
    const staffMember = staffById.get(bookingSuggestion.staffId);
    if (!staffMember) return null;
    const suggestedService = services.find((service) => service.id === bookingSuggestion.serviceId);
    if (
      suggestedService?.assignedStaffIds?.length &&
      !suggestedService.assignedStaffIds.includes(bookingSuggestion.staffId)
    ) {
      return null;
    }
    return formatStaffName(staffMember.name);
  }, [bookingSuggestion?.serviceId, bookingSuggestion?.staffId, formatStaffName, staffById, services]);
  const suggestedAddOnNames = useMemo(() => {
    if (!bookingSuggestion) return [];
    if (bookingSuggestion.addOnServiceNames?.length) {
      return bookingSuggestion.addOnServiceNames.filter(Boolean);
    }
    if (!bookingSuggestion.addOnServiceIds?.length) return [];
    return bookingSuggestion.addOnServiceIds
      .map((id) => servicesById.get(id)?.name)
      .filter((name): name is string => Boolean(name));
  }, [bookingSuggestion, servicesById]);
  const selectedServiceStaffIds = useMemo(() => {
    if (!selectedServices.length) return null;
    let intersection: string[] | null = null;
    for (const service of selectedServices) {
      const assigned = Array.isArray(service.assignedStaffIds) ? service.assignedStaffIds : [];
      if (!assigned.length) return [];
      intersection = intersection ? intersection.filter((id) => assigned.includes(id)) : [...assigned];
    }
    return intersection ?? [];
  }, [selectedServices]);
  const eligibleStaff = useMemo(() => {
    if (!selectedServices.length) return staff;
    if (selectedServiceStaffIds === null) return staff;
    if (!selectedServiceStaffIds.length) return [];
    return selectedServiceStaffIds
      .map((id) => staffById.get(id))
      .filter((member): member is StaffOption => Boolean(member));
  }, [selectedServiceStaffIds, selectedServices.length, staff, staffById]);
  const staffOptionsPreview = eligibleStaff;
  const staffSearchActive = showStaffSearch || eligibleStaff.length > 5;
  const effectiveStaffId = useMemo(
    () => (allowAnyStaffOption ? selectedStaffId : selectedStaffId),
    [allowAnyStaffOption, selectedStaffId],
  );

  const availabilityByStaff = useMemo(() => {
    if (allowAnyStaffOption) return new Map<string, number>();
    const eligibleIds = new Set(eligibleStaff.map((member) => member.id));
    const counts = new Map<string, number>();
    for (const slot of slots) {
      if (!slot.staffId || !eligibleIds.has(slot.staffId)) continue;
      const startMs = Date.parse(slot.start);
      if (!Number.isFinite(startMs) || startMs <= nowMs) continue;
      counts.set(slot.staffId, (counts.get(slot.staffId) ?? 0) + 1);
    }
    return counts;
  }, [allowAnyStaffOption, eligibleStaff, nowMs, slots]);

  const autoStaffIdFromSlots = useMemo(() => {
    if (allowAnyStaffOption) return null;
    if (!eligibleStaff.length) return null;
    const counts = availabilityByStaff;
    if (!counts.size) return null;
    let maxCount = 0;
    for (const count of counts.values()) {
      if (count > maxCount) maxCount = count;
    }
    const tied = eligibleStaff.filter((member) => (counts.get(member.id) ?? 0) === maxCount);
    if (!tied.length) return null;
    const sorted = tied.slice().sort((a, b) => a.id.localeCompare(b.id));
    const rotationKey = `${formatDateOnly(currentRangeStart)}:${selectedServiceIds.slice().sort().join(",")}`;
    const rotationIndex = Math.abs(hashStringToInt(rotationKey)) % sorted.length;
    return sorted[rotationIndex]?.id ?? sorted[0]?.id ?? null;
  }, [allowAnyStaffOption, availabilityByStaff, currentRangeStart, eligibleStaff, selectedServiceIds]);

  useEffect(() => {
    if (allowAnyStaffOption) return;
    if (userSelectedStaffRef.current) return;
    const selectedHasAvailability =
      selectedStaffId && (availabilityByStaff.get(selectedStaffId) ?? 0) > 0;
    if (selectedHasAvailability) return;
    if (!autoStaffIdFromSlots) return;
    setSelectedStaffId(autoStaffIdFromSlots);
  }, [allowAnyStaffOption, autoStaffIdFromSlots, availabilityByStaff, selectedStaffId]);

  const handleForgetDevice = useCallback(() => {
    const hadAppliedDeviceCustomer = deviceCustomerAppliedRef.current;
    clearDeviceCookie();
    const regenerated = generateDeviceId();
    if (regenerated) {
      writeDeviceCookie(regenerated);
      setDeviceId(regenerated);
    } else {
      setDeviceId(null);
    }
    setIgnoreDeviceCustomer(true);
    setIsReturningDevice(false);
    setDeviceCustomer(null);
    setDeviceCustomerLoading(false);
    setBookingSuggestion(null);
    setShowSuggestionCard(false);
    setSuggestionDismissed(false);
    setPreferredWeekdayIndex(null);
    setPreferredTimeHHmm(null);
    setSuggestionHint(null);
    setHighlightedSlotId(null);
    setSuggestionAccepted(false);
    suggestionAppliedRef.current = false;
    deviceCustomerAppliedRef.current = false;
    setServiceFiltersCollapsed(false);
    setShowServicePickerMobile(true);
    setServiceSearchTerm("");
    setSelectedCategoryId(null);
    setColorFlow(null);
    setColorQuestionnaire(createEmptyColorQuestionnaire());
    if (!userSelectedStaffRef.current) {
      setSelectedStaffId(null);
      setShowStaffPickerMobile(true);
    }
    if (!userSelectedServiceRef.current) {
      setSelectedServiceIds([]);
    }
    if (hadAppliedDeviceCustomer) {
      setCheckoutForm((current) => ({
        ...current,
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        landline: "",
      }));
    }
  }, []);
  const isServicePickerVisibleMobile =
    showServicePickerMobile || !primaryService || servicesLoading || Boolean(servicesError);
  const showServiceFilters = !serviceFiltersCollapsed || !isReturningDevice || !primaryService;
  const isStaffPickerVisibleMobile = showStaffPickerMobile || Boolean(staffError);
  const showPopularServices =
    allowServiceSelection &&
    showServiceFilters &&
    popularServices.length > 0 &&
    !serviceSearchTerm.trim() &&
    selectedServiceIds.length === 0;

  const servicesForList = useMemo(() => {
    if (!showPopularServices || popularServiceIdSet.size === 0) return filteredServices;
    return filteredServices.filter((service) => !popularServiceIdSet.has(service.id));
  }, [filteredServices, popularServiceIdSet, showPopularServices]);

  const servicesForListOrdered = useMemo(() => {
    if (!selectedServiceIds.length) return servicesForList;
    const selectedSet = new Set(selectedServiceIds);
    const selected = selectedServiceIds
      .map((id) => servicesForList.find((service) => service.id === id))
      .filter((service): service is ServiceOption => Boolean(service));
    const rest = servicesForList.filter((service) => !selectedSet.has(service.id));
    return [...selected, ...rest];
  }, [selectedServiceIds, servicesForList]);

  const visibleServices = useMemo(() => {
    if (showAllServices) {
      return servicesForListOrdered;
    }
    return servicesForListOrdered.slice(0, serviceListLimit);
  }, [servicesForListOrdered, showAllServices, serviceListLimit]);

  const showServiceMore = servicesForListOrdered.length > serviceListLimit;

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const loadServices = async () => {
      setServicesLoading(true);
      setServicesError(null);
      try {
        const response = await fetch(`/api/services?locationId=${encodeURIComponent(location.id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Dienstleistungen konnten nicht geladen werden.");
        }
        const payload = (await response.json()) as ServicesResponse;
        const nextServices = Array.isArray(payload.data) ? payload.data : [];
        const nextPopularIds = Array.isArray(payload.popularServiceIds) ? payload.popularServiceIds : [];
        const nextPopularByCategory =
          payload.popularServiceIdsByCategory && typeof payload.popularServiceIdsByCategory === "object"
            ? (payload.popularServiceIdsByCategory as Record<string, string[]>)
            : {};
        if (!isMounted) return;
        setServices(nextServices);
        setPopularServiceIds(nextPopularIds);
        setPopularServiceIdsByCategory(nextPopularByCategory);
        if (!nextServices.length) {
          setServicesError("Keine Dienstleistungen verfügbar.");
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        const message = error instanceof Error ? error.message : "Dienstleistungen konnten nicht geladen werden.";
        if (!isMounted) return;
        setServicesError(message);
        setServices(initialServices);
      } finally {
        if (!isMounted) return;
        setServicesLoading(false);
      }
    };

    void loadServices();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [initialServices, location.id]);

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const loadStaff = async () => {
      setStaffLoading(true);
      setStaffError(null);
      try {
        const params = new URLSearchParams({ locationId: location.id });
        if (deviceId) {
          params.set("deviceId", deviceId);
        }
        const response = await fetch(`/api/staff?${params.toString()}`, {
          cache: deviceId ? "no-store" : "force-cache",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Team konnte nicht geladen werden.");
        }
        const payload = (await response.json()) as StaffResponse;
        const nextStaff = Array.isArray(payload.data) ? payload.data : [];
        if (!isMounted) return;
        setStaff(nextStaff);
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        const message = error instanceof Error ? error.message : "Team konnte nicht geladen werden.";
        if (!isMounted) return;
        setStaffError(message);
        setStaff([]);
      } finally {
        if (!isMounted) return;
        setStaffLoading(false);
      }
    };

    void loadStaff();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [deviceId, location.id]);

  useEffect(() => {
    if (suggestionAppliedRef.current) return;
    if (!bookingSuggestion) return;
    if (servicesLoading) return;
    if (step !== "slots" || selectedSlotId) return;
    const suggestedService = services.find((service) => service.id === bookingSuggestion.serviceId);
    if (!suggestedService) return;
    if (isReturningDevice) {
      setServiceFiltersCollapsed(true);
    }
    suggestionAppliedRef.current = true;
  }, [
    bookingSuggestion,
    isReturningDevice,
    selectedSlotId,
    services,
    servicesLoading,
    staff,
    staffLoading,
    step,
  ]);

  useEffect(() => {
    if (selectedCategoryId && !derivedCategories.some((category) => category.id === selectedCategoryId)) {
      setSelectedCategoryId(null);
    }
  }, [derivedCategories, selectedCategoryId]);

  useEffect(() => {
    if (!selectedStaffId || !selectedServices.length) return;
    if (!selectedServiceStaffIds || selectedServiceStaffIds.length === 0) return;
    if (!selectedServiceStaffIds.includes(selectedStaffId)) {
      setSelectedStaffId(null);
    }
  }, [selectedServiceStaffIds, selectedServices.length, selectedStaffId]);

  const clearHoldState = useCallback(() => {
    setSlotHold(null);
    setHoldRemainingSeconds(null);
  }, []);

  useEffect(() => {
    slotHoldRef.current = slotHold;
  }, [slotHold]);

  useEffect(() => {
    const existing = readDeviceCookie();
    if (existing) {
      setDeviceId(existing);
      setIsReturningDevice(false);
      return;
    }
    const generated = generateDeviceId();
    if (!generated) return;
    writeDeviceCookie(generated);
    setDeviceId(generated);
    setIsReturningDevice(false);
  }, []);

  useEffect(() => {
    if (!deviceId || ignoreDeviceCustomer) {
      setDeviceCustomer(null);
      setDeviceCustomerLoading(false);
      setBookingSuggestion(null);
      setShowSuggestionCard(false);
      setSuggestionDismissed(false);
      setPreferredWeekdayIndex(null);
      setPreferredTimeHHmm(null);
      setSuggestionHint(null);
      setHighlightedSlotId(null);
      setIsReturningDevice(false);
      return;
    }
    let isMounted = true;
    const controller = new AbortController();

    const loadDeviceCustomer = async () => {
      setDeviceCustomerLoading(true);
      try {
        const params = new URLSearchParams({
          locationId: location.id,
          deviceId,
        });
        const response = await fetch(`/api/customer-devices?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Device lookup failed");
        }
        const payload = (await response.json()) as DeviceCustomerResponse;
        if (!isMounted) return;
        setDeviceCustomer(payload.customer ?? null);
        setBookingSuggestion(payload.suggestion ?? null);
        setShowSuggestionCard(false);
        setSuggestionDismissed(false);
        setPreferredWeekdayIndex(null);
        setPreferredTimeHHmm(null);
        setSuggestionHint(null);
        setHighlightedSlotId(null);
        setIsReturningDevice(Boolean(payload.customer));
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        if (!isMounted) return;
        setDeviceCustomer(null);
        setBookingSuggestion(null);
        setShowSuggestionCard(false);
        setSuggestionDismissed(false);
        setIsReturningDevice(false);
      } finally {
        if (!isMounted) return;
        setDeviceCustomerLoading(false);
      }
    };

    void loadDeviceCustomer();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [deviceId, ignoreDeviceCustomer, location.id]);

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  const releaseSlotHold = useCallback(
    async (hold: SlotHold) => {
      if (hold.holdId) {
        await fetch(`/api/holds/${hold.holdId}`, { method: "DELETE" }).catch(() => null);
        return;
      }
      if (!tenantSlug) return;
      const basePath = `/book/${tenantSlug}/${location.slug}`;
      await fetch(`${basePath}/hold`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotKey: hold.slotKey, token: hold.token }),
      }).catch(() => null);
    },
    [location.slug, tenantSlug],
  );

  const handleApplySuggestion = useCallback(async () => {
    if (!bookingSuggestion) return;
    if (slotHold) {
      await releaseSlotHold(slotHold);
      clearHoldState();
    }
    setSelectedSlotId(null);
    setSelectedSlotSnapshot(null);
    setCheckoutError(null);
    setStep("slots");
    setSelectedCategoryId(null);
    setServiceSearchTerm("");
    userSelectedStaffRef.current = false;
    if (bookingSuggestion.staffId) {
      setSelectedStaffId(bookingSuggestion.staffId);
      setShowStaffPickerMobile(false);
    } else {
      setSelectedStaffId(null);
      setShowStaffPickerMobile(true);
    }
    const nextServiceIds = [bookingSuggestion.serviceId];
    if (maxServicesPerBooking > 1 && bookingSuggestion.addOnServiceIds?.length) {
      bookingSuggestion.addOnServiceIds.forEach((id) => {
        if (id && !nextServiceIds.includes(id)) {
          nextServiceIds.push(id);
        }
      });
    }
    setSelectedServiceIds(nextServiceIds.slice(0, maxServicesPerBooking));
    setShowServicePickerMobile(false);
    setServiceFiltersCollapsed(true);
    const suggestedService = servicesById.get(bookingSuggestion.serviceId);
    if (suggestedService && isComplexColorService(suggestedService, colorConsultationService?.id)) {
      setColorFlow({ requestedServiceId: bookingSuggestion.serviceId, mode: "direct" });
      setColorQuestionnaire(createEmptyColorQuestionnaire());
    } else {
      setColorFlow(null);
      setColorQuestionnaire(createEmptyColorQuestionnaire());
    }
    setPreferredWeekdayIndex(bookingSuggestion.weekdayIndex);
    setPreferredTimeHHmm(bookingSuggestion.timeHHmm);
    setSuggestionHint(null);
    setHighlightedSlotId(null);
    setShowSuggestionCard(false);
    setSuggestionDismissed(false);
    setSuggestionAccepted(true);
  }, [bookingSuggestion, clearHoldState, colorConsultationService?.id, releaseSlotHold, servicesById, slotHold]);

  const requestSlotHold = useCallback(
    async (slot: SlotOption) => {
      if (!tenantSlug) return null;
      const payload = decodeSlotId(slot.id);
      if (!payload) return null;
      const basePath = `/book/${tenantSlug}/${location.slug}`;
      const response = await fetch(`${basePath}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slotKey: payload.slotKey,
          slot: {
            locationId: payload.locationId,
            staffId: payload.staffId,
            start: payload.start,
            end: payload.end,
            reservedFrom: payload.reservedFrom ?? payload.start,
            reservedTo: payload.reservedTo ?? payload.end,
          },
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message =
          response.status === 409
            ? "Dieser Termin wurde gerade vergeben. Bitte wähle einen anderen."
            : typeof payload.error === "string"
              ? payload.error
              : "Slot konnte nicht reserviert werden.";
        pushToast({ variant: "error", message });
        return null;
      }
      const json = (await response.json()) as { token?: string; expiresAt?: string };
      if (!json.token || !json.expiresAt) {
        pushToast({ variant: "error", message: "Slot-Reservierung fehlgeschlagen." });
        return null;
      }
      const expiresAt = Date.parse(json.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        pushToast({ variant: "error", message: "Slot-Reservierung fehlgeschlagen." });
        return null;
      }
      const nextHold = { slotKey: payload.slotKey, token: json.token, expiresAt };
      setSlotHold(nextHold);
      return nextHold;
    },
    [location.slug, pushToast, tenantSlug],
  );

  const requestPoolHold = useCallback(
    async (slot: SlotOption) => {
      if (!selectedServiceIds.length) return null;
      const response = await fetch("/api/holds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: location.id,
          serviceIds: selectedServiceIds,
          start: slot.start,
          ...(deviceId ? { deviceId } : {}),
          ...(colorPrecheckPayload ? { colorPrecheck: colorPrecheckPayload } : {}),
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message =
          response.status === 409
            ? "Dieser Termin wurde gerade vergeben. Bitte wähle einen anderen."
            : typeof payload.error === "string"
              ? payload.error
              : "Slot konnte nicht reserviert werden.";
        pushToast({ variant: "error", message });
        return null;
      }
      const json = (await response.json()) as {
        holdId?: string;
        slotId?: string;
        slotKey?: string;
        staffId?: string;
        staffName?: string;
        expiresAt?: string;
        token?: string;
      };
      if (!json.holdId || !json.slotId || !json.slotKey || !json.expiresAt) {
        pushToast({ variant: "error", message: "Slot-Reservierung fehlgeschlagen." });
        return null;
      }
      const expiresAt = Date.parse(json.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        pushToast({ variant: "error", message: "Slot-Reservierung fehlgeschlagen." });
        return null;
      }
      const nextHold: SlotHold = {
        slotKey: json.slotKey,
        token: json.token ?? "",
        expiresAt,
        holdId: json.holdId,
        staffId: json.staffId,
        staffName: json.staffName,
        slotId: json.slotId,
      };
      setSlotHold(nextHold);
      return { hold: nextHold, slotId: json.slotId };
    },
    [colorPrecheckPayload, deviceId, location.id, pushToast, selectedServiceIds],
  );

  const resetToSlots = useCallback(
    async (releaseHold: boolean) => {
      if (releaseHold && slotHold) {
        await releaseSlotHold(slotHold);
      }
      clearHoldState();
      setSelectedSlotId(null);
      setSelectedSlotSnapshot(null);
      setCheckoutError(null);
      setStep("slots");
      if (selectedServiceIds.length && fetchSlotsRef.current) {
        void fetchSlotsRef.current(currentRangeStart, false);
      }
    },
    [clearHoldState, currentRangeStart, releaseSlotHold, selectedServiceIds, slotHold],
  );

  useEffect(() => {
    if (!slotHold) {
      setHoldRemainingSeconds(null);
      return;
    }

    const updateRemaining = () => {
      const remainingMs = slotHold.expiresAt - Date.now();
      if (remainingMs <= 0) {
        setHoldRemainingSeconds(0);
        void resetToSlots(true);
        return;
      }
      setHoldRemainingSeconds(Math.ceil(remainingMs / 1000));
    };

    updateRemaining();
    const intervalId = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(intervalId);
  }, [resetToSlots, slotHold]);

  useEffect(() => () => {
    if (slotHold) {
      void releaseSlotHold(slotHold);
    }
  }, [releaseSlotHold, slotHold]);

  useEffect(() => {
    if (!tenantSlug) return;
    const basePath = `/book/${tenantSlug}/${location.slug}`;
    const releaseOnUnload = () => {
      const hold = slotHoldRef.current;
      if (!hold) return;
      if (hold.holdId) {
        fetch(`/api/holds/${hold.holdId}`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => null);
        return;
      }
      fetch(`${basePath}/hold`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slotKey: hold.slotKey, token: hold.token }),
        keepalive: true,
      }).catch(() => null);
    };

    window.addEventListener("pagehide", releaseOnUnload);
    window.addEventListener("beforeunload", releaseOnUnload);
    return () => {
      window.removeEventListener("pagehide", releaseOnUnload);
      window.removeEventListener("beforeunload", releaseOnUnload);
    };
  }, [location.slug, tenantSlug]);

  const fetchSlots = useCallback(
    async (rangeStart: Date, append: boolean) => {
      if (!selectedServiceIds.length) {
        setSlots([]);
        setSlotError(null);
        setAvailabilityMeta(null);
        return;
      }

      setSlotError(null);
      if (append) {
        setLoadMoreLoading(true);
      } else {
        setSlotsLoading(true);
        setHasMoreSlots(true);
      }

      if (currentFetch.current) {
        currentFetch.current.abort();
      }
      const controller = new AbortController();
      currentFetch.current = controller;

      if (!append) {
        setCurrentRangeStart(rangeStart);
        setPagesLoaded(0);
        setHideEarlier(false);
        setRevealEarlier(false);
      }
      const from = formatDateOnlyInTimeZone(rangeStart, location.timezone);
      const params = new URLSearchParams({
        locationId: location.id,
        from,
        days: String(WINDOW_DAYS),
      });
      selectedServiceIds.forEach((serviceId) => params.append("services", serviceId));
      if (effectiveStaffId) {
        params.set("staffId", effectiveStaffId);
      }
      if (timeOfDay) {
        params.set("timeOfDay", timeOfDay);
      }
      if (deviceId) {
        params.set("deviceId", deviceId);
      }
      if (colorPrecheckQuery) {
        params.set("colorPrecheck", colorPrecheckQuery);
      }

      try {
        const response = await fetch(`/api/availability?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("Verfügbarkeiten konnten nicht geladen werden.");
        }
        const json = (await response.json()) as AvailabilityResponse;
        const nextSlots = Array.isArray(json.data) ? json.data : [];
        setAvailabilityMeta(json.meta ?? null);
        setSlots((prev) => mergeSlots(append ? [...prev, ...nextSlots] : nextSlots));
        setNextRangeStart(addDays(rangeStart, WINDOW_DAYS));
        setLoadedRanges((prev) => (append ? prev + 1 : 1));
        if (!nextSlots.length && !append) {
          setSlotError("Keine Slots im ausgewählten Zeitraum verfügbar.");
        }
        if (append && nextSlots.length === 0) {
          setHasMoreSlots(false);
        }
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        const message = error instanceof Error ? error.message : "Unbekannter Fehler beim Laden der Slots.";
        setSlotError(message);
        pushToast({ variant: "error", message });
      } finally {
        if (currentFetch.current === controller) {
          currentFetch.current = null;
        }
        setSlotsLoading(false);
        setLoadMoreLoading(false);
      }
    },
    [colorPrecheckQuery, deviceId, effectiveStaffId, location.id, pushToast, selectedServiceIds, timeOfDay],
  );

  useEffect(() => {
    fetchSlotsRef.current = fetchSlots;
  }, [fetchSlots]);

  useEffect(() => {
    const start = manualStartDate ?? normalizeStartOfDay(new Date());
    setNextRangeStart(start);
    setLoadedRanges(0);
    setSlots([]);
    setSelectedSlotId(null);
    setSelectedSlotSnapshot(null);
    setSlotError(null);
    setStep("slots");
    setConfirmation(null);
    setPagesLoaded(0);
    setHideEarlier(false);
    setRevealEarlier(false);
    if (selectedServiceIds.length) {
      void fetchSlots(start, false);
    }
    setHasMoreSlots(true);
  }, [fetchSlots, manualStartDate, selectedServiceIds]);

  useEffect(() => {
    if (!bookingSuggestion || !selectedServiceIds.length) return;
    if (!selectedServiceIds.includes(bookingSuggestion.serviceId)) {
      setPreferredWeekdayIndex(null);
      setPreferredTimeHHmm(null);
      setSuggestionHint(null);
      setHighlightedSlotId(null);
    }
  }, [bookingSuggestion, selectedServiceIds]);

  const slotsWithStaffNames = useMemo(() => {
    if (!staffNameById.size && !hideLastNames) return slots;
    return slots.map((slot) => {
      if (slot.staffName) {
        return hideLastNames ? { ...slot, staffName: formatStaffName(slot.staffName) } : slot;
      }
      if (!slot.staffId) return slot;
      const name = staffNameById.get(slot.staffId);
      return name ? { ...slot, staffName: name } : slot;
    });
  }, [formatStaffName, hideLastNames, slots, staffNameById]);

  const slotsForDisplay = useMemo(() => {
    if (!allowAnyStaffOption) {
      if (!selectedStaffId) return [];
      return slotsWithStaffNames.filter((slot) => slot.staffId === selectedStaffId);
    }
    return slotsWithStaffNames;
  }, [allowAnyStaffOption, selectedStaffId, slotsWithStaffNames]);

  const orderedSlots = useMemo(() => {
    const upcoming = slotsForDisplay.filter((slot) => Date.parse(slot.start) > nowMs);
    return upcoming.slice().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  }, [nowMs, slotsForDisplay]);

  const isPoolMode = useMemo(
    () => allowAnyStaffOption && !effectiveStaffId,
    [allowAnyStaffOption, effectiveStaffId],
  );

  const displaySlots = useMemo(() => {
    if (!isPoolMode) return orderedSlots;
    const grouped = new Map<number, { slot: SlotOption; count: number }>();
    for (const slot of orderedSlots) {
      const startMs = Date.parse(slot.start);
      if (!Number.isFinite(startMs)) continue;
      const existing = grouped.get(startMs);
      if (!existing) {
        grouped.set(startMs, { slot, count: 1 });
      } else {
        existing.count += 1;
      }
    }
    return Array.from(grouped.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => ({
        id: `pool:${entry.slot.start}`,
        start: entry.slot.start,
        end: entry.slot.end,
        locationId: entry.slot.locationId,
        capacity: entry.count,
        isPool: true,
      }));
  }, [isPoolMode, orderedSlots]);

  const nextAvailableSlot = useMemo(() => displaySlots[0] ?? null, [displaySlots]);
  const nextAvailableLabel = useMemo(() => {
    if (!nextAvailableSlot) return null;
    const dateLabel = new Intl.DateTimeFormat("de-DE", {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      timeZone: location.timezone,
    }).format(new Date(nextAvailableSlot.start));
    const timeLabel = new Intl.DateTimeFormat("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: location.timezone,
    }).format(new Date(nextAvailableSlot.start));
    return `${dateLabel} · ${timeLabel} Uhr`;
  }, [location.timezone, nextAvailableSlot]);
  const rangeStartKey = useMemo(
    () => formatDateOnlyInTimeZone(currentRangeStart, location.timezone),
    [currentRangeStart, location.timezone],
  );
  const hasSlotsOnRangeStart = useMemo(() => {
    if (!displaySlots.length) return false;
    return displaySlots.some(
      (slot) => formatDateOnlyInTimeZone(new Date(slot.start), location.timezone) === rangeStartKey,
    );
  }, [displaySlots, location.timezone, rangeStartKey]);
  const showRangeMeta = isDateJumpActive || hasSlotsOnRangeStart;

  const visibleSlots = useMemo(() => {
    if (loadedRanges <= 1) {
      const limit = displaySlots.length > INITIAL_SLOT_LIMIT ? INITIAL_SLOT_LIMIT : displaySlots.length;
      return displaySlots.slice(0, limit);
    }
    return displaySlots;
  }, [displaySlots, loadedRanges]);

  const slotGroups = useMemo(() => groupSlotsByDay(visibleSlots, location.timezone), [location.timezone, visibleSlots]);
  const visibleSlotGroups = useMemo(() => {
    if (!hideEarlier) return slotGroups;
    if (slotGroups.length <= MIN_VISIBLE_DAY_GROUPS) return slotGroups;
    return slotGroups.slice(-MIN_VISIBLE_DAY_GROUPS);
  }, [hideEarlier, slotGroups]);
  const hiddenGroupCount = hideEarlier ? Math.max(0, slotGroups.length - visibleSlotGroups.length) : 0;
  const dedupedSlotGroups = useMemo(() => {
    if (!nextAvailableSlot) return visibleSlotGroups;
    return visibleSlotGroups.map((group, index) => {
      if (index !== 0) return group;
      return {
        ...group,
        slots: group.slots.filter((slot) => slot.id !== nextAvailableSlot.id),
      };
    });
  }, [nextAvailableSlot, visibleSlotGroups]);

  useEffect(() => {
    if (preferredWeekdayIndex === null || !preferredTimeHHmm) {
      setHighlightedSlotId(null);
      setSuggestionHint(null);
      return;
    }
    if (!displaySlots.length) return;
    const preferredMinutes = parseTimeHHmm(preferredTimeHHmm);
    if (preferredMinutes === null) return;

    const candidates = displaySlots
      .map((slot) => {
        const local = getLocalSlotParts(new Date(slot.start), location.timezone);
        if (!local) return null;
        return {
          slot,
          weekdayIndex: local.weekdayIndex,
          minutes: local.minutes,
        };
      })
      .filter((entry): entry is { slot: SlotOption; weekdayIndex: number; minutes: number } => Boolean(entry));

    const sameWeekday = candidates.filter((entry) => entry.weekdayIndex === preferredWeekdayIndex);
    if (!sameWeekday.length) {
      setHighlightedSlotId(null);
      setSuggestionHint("Zu dieser Zeit ist aktuell nichts frei. Alternativen werden angezeigt.");
      return;
    }

    let best = sameWeekday[0];
    let bestDiff = Math.abs(best.minutes - preferredMinutes);
    for (const entry of sameWeekday.slice(1)) {
      const diff = Math.abs(entry.minutes - preferredMinutes);
      if (diff < bestDiff) {
        best = entry;
        bestDiff = diff;
      }
    }

    const withinWindow = bestDiff <= 60;
    setHighlightedSlotId(best.slot.id);
    setSuggestionHint(withinWindow ? null : "Zu dieser Zeit ist aktuell nichts frei. Alternativen werden angezeigt.");
  }, [displaySlots, location.timezone, preferredTimeHHmm, preferredWeekdayIndex]);

  useEffect(() => {
    if (!highlightedSlotId) return;
    const timeout = window.setTimeout(() => {
      const element = findSlotElement(highlightedSlotId);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [highlightedSlotId]);

  const selectedSlot = useMemo(
    () =>
      slotsWithStaffNames.find((slot) => slot.id === selectedSlotId) ??
      (selectedSlotId ? selectedSlotSnapshot : null),
    [selectedSlotId, selectedSlotSnapshot, slotsWithStaffNames],
  );

  const handleServiceSelect = (serviceId: string) => {
    userSelectedServiceRef.current = true;
    const selectedService = servicesById.get(serviceId) ?? null;
    const consultationId = colorConsultationService?.id ?? null;
    const isConsultation = Boolean(consultationId && serviceId === consultationId);
    const isComplexColor = Boolean(selectedService && isComplexColorService(selectedService, consultationId));
    const isAddOnSelection = Boolean(primaryService?.addOnServiceIds?.includes(serviceId));
    const allowDirectColor = isComplexColor && canBookColorDirect(serviceId);

    if (!isAddOnSelection && isComplexColor && !allowDirectColor) {
      if (!colorConsultationService) {
        pushToast({
          variant: "error",
          message: "Farbe ist individuell – bitte buche zuerst eine kurze Farbberatung.",
        });
        return;
      }
      setColorFlow({ requestedServiceId: serviceId, mode: "consultation" });
      setColorQuestionnaire(createEmptyColorQuestionnaire());
      setSelectedServiceIds([colorConsultationService.id]);
      setShowServicePickerMobile(false);
      setServiceFiltersCollapsed(false);
      return;
    }

    if (!isAddOnSelection && selectedService) {
      if (isConsultation) {
        setColorFlow({ requestedServiceId: null, mode: "consultation" });
        setColorQuestionnaire(createEmptyColorQuestionnaire());
      } else if (isComplexColor) {
        if (allowDirectColor) {
          setColorFlow({ requestedServiceId: serviceId, mode: "direct" });
          setColorQuestionnaire(createEmptyColorQuestionnaire());
        }
      } else if (colorFlow) {
        setColorFlow(null);
        setColorQuestionnaire(createEmptyColorQuestionnaire());
      }
    }
    setSelectedServiceIds((current) => {
      const isActive = current.includes(serviceId);
      if (isActive) {
        return current.filter((id) => id !== serviceId);
      }
      if (maxServicesPerBooking === 1) {
        return [serviceId];
      }
      if (current.length >= maxServicesPerBooking) {
        pushToast({
          variant: "error",
          message: `Maximal ${maxServicesPerBooking} Leistungen pro Termin.`,
        });
        return current;
      }
      return [...current, serviceId];
    });
    setShowServicePickerMobile(false);
    setServiceFiltersCollapsed(false);
  };

  const applyStartDate = useCallback((nextDate: Date) => {
    const normalized = normalizeStartOfDay(nextDate);
    setManualStartDate(normalized);
    setCurrentRangeStart(normalized);
    setShowDateJump(false);
    setSlots([]);
    setSelectedSlotId(null);
    setSelectedSlotSnapshot(null);
    setSlotError(null);
    setLoadedRanges(0);
    setNextRangeStart(normalized);
    setStep("slots");
  }, []);

  const handleDateJumpChange = useCallback(
    (value: string) => {
      setDateJumpInput(value);
      const parsed = parseDateInput(value);
      if (parsed) {
        applyStartDate(parsed);
      }
    },
    [applyStartDate],
  );

  const handleResetDate = useCallback(() => {
    applyStartDate(normalizeStartOfDay(new Date()));
  }, [applyStartDate]);

  const handleAttachmentChange = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const selected = Array.from(files).slice(0, MAX_BOOKING_ATTACHMENTS);
      const next: File[] = [];
      for (const file of selected) {
        if (!BOOKING_ATTACHMENT_TYPES.has(file.type)) {
          pushToast({ variant: "error", message: `Ungültiger Dateityp: ${file.name}` });
          continue;
        }
        if (file.size > MAX_BOOKING_ATTACHMENT_BYTES) {
          pushToast({ variant: "error", message: `Datei zu groß: ${file.name}` });
          continue;
        }
        next.push(file);
      }
      setAttachments(next);
    },
    [pushToast],
  );

  const handleAttachmentRemove = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, current) => current !== index));
  }, []);

  const handleSlotSelect = async (slot: SlotOption) => {
    if (slot.isPool) {
      if (slotHold) {
        await releaseSlotHold(slotHold);
        clearHoldState();
      }
      const poolHold = await requestPoolHold(slot);
      if (!poolHold) {
        void fetchSlots(currentRangeStart, false);
        return;
      }
      setSelectedSlotId(poolHold.slotId);
      setSelectedSlotSnapshot({
        id: poolHold.slotId,
        start: slot.start,
        end: slot.end,
        locationId: slot.locationId,
        staffId: poolHold.hold.staffId,
        staffName: poolHold.hold.staffName,
      });
      setStep("customer");
      void fetchSlots(currentRangeStart, false);
      return;
    }

    const payload = decodeSlotId(slot.id);
    if (!payload) {
      pushToast({ variant: "error", message: "Slot konnte nicht geladen werden. Bitte erneut versuchen." });
      return;
    }
    if (slotHold && payload && slotHold.slotKey === payload.slotKey && slotHold.expiresAt > Date.now()) {
      setSelectedSlotId(slot.id);
      setStep("customer");
      return;
    }

    if (slotHold) {
      await releaseSlotHold(slotHold);
      clearHoldState();
    }

    const hold = await requestSlotHold(slot);
    if (payload && !hold) {
      return;
    }
    setSelectedSlotId(slot.id);
    setSelectedSlotSnapshot(slot);
    setStep("customer");
    void fetchSlots(currentRangeStart, false);
  };

  const handleCustomerSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedServices.length || !selectedSlot) {
      setCheckoutError("Bitte wähle zuerst einen Termin aus.");
      return;
    }

    if (!checkoutForm.firstName.trim() || !checkoutForm.lastName.trim()) {
      setCheckoutError("Bitte gib Vor- und Nachnamen an.");
      return;
    }

    const hasEmail = checkoutForm.email.trim().length > 0;
    const hasPhone = checkoutForm.phone.trim().length > 0;
    if (!hasEmail || !hasPhone) {
      setCheckoutError("Bitte gib eine Telefonnummer und eine E-Mail-Adresse an.");
      return;
    }
    if (!checkoutForm.termsAccepted) {
      setCheckoutError("Bitte akzeptiere die AGB und Datenschutzrichtlinien.");
      return;
    }

    setCheckoutLoading(true);
    setCheckoutError(null);

    try {
      const consents = [
        { type: "TERMS", scope: "PUSH", granted: true },
        { type: "PRIVACY", scope: "PUSH", granted: true },
        ...(checkoutForm.whatsappOptIn ? [{ type: "COMMUNICATION", scope: "WHATSAPP", granted: true }] : []),
        ...(checkoutForm.marketingOptIn ? [{ type: "MARKETING", scope: "EMAIL", granted: true }] : []),
      ];
      const metadata: Record<string, unknown> = {};
      const landline = checkoutForm.landline.trim();
      if (landline.length > 0) {
        metadata.customerProfile = { landline };
      }
      if (colorFlow) {
        const colorRequest: Record<string, unknown> = {
          mode: colorFlow.mode,
          requestedServiceId: colorRequestedService?.id ?? null,
          requestedServiceName: colorRequestedService?.name ?? null,
          consultationServiceId: colorConsultationService?.id ?? null,
          consultationServiceName: colorConsultationLabel,
        };
        metadata.colorRequest = colorRequest;
        if (colorPrecheckPayload) {
          metadata.colorPrecheck = colorPrecheckPayload;
        }
      }
      const metadataPayload = Object.keys(metadata).length > 0 ? metadata : undefined;
      const payload = {
        slotId: slotHold?.slotId ?? selectedSlot.id,
        ...(slotHold?.holdId ? { holdId: slotHold.holdId } : {}),
        ...(selectedServices.length === 1
          ? { serviceId: selectedServices[0].id }
          : { serviceIds: selectedServices.map((service) => service.id) }),
        staffId: slotHold?.staffId ?? selectedStaffId ?? undefined,
        ...(deviceId ? { deviceId } : {}),
        customer: {
          firstName: checkoutForm.firstName.trim(),
          lastName: checkoutForm.lastName.trim(),
          phone: checkoutForm.phone.trim(),
          email: checkoutForm.email.trim(),
        },
        consents,
        ...(metadataPayload ? { metadata: metadataPayload } : {}),
      };
      const response =
        attachments.length > 0
          ? await fetch("/api/bookings", {
              method: "POST",
              body: buildBookingFormData(payload, attachments),
            })
          : await fetch("/api/bookings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });

      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        const message =
          typeof json.error === "string"
            ? json.error
            : response.status === 409
              ? "Dieser Termin wurde gerade vergeben. Bitte wähle einen anderen."
              : "Buchung fehlgeschlagen. Bitte versuche es erneut.";
        throw new Error(message);
      }

      const json = (await response.json()) as CheckoutResponse;
      setConfirmation(json.data);
      if (slotHold) {
        await releaseSlotHold(slotHold);
        clearHoldState();
      }
      setCheckoutForm({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        landline: "",
        whatsappOptIn: false,
        termsAccepted: false,
        marketingOptIn: false,
      });
      setAttachments([]);
      setStep("success");
      void fetchSlots(currentRangeStart, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Fehler bei der Buchung.";
      setCheckoutError(message);
      pushToast({ variant: "error", message });
    } finally {
      setCheckoutLoading(false);
    }
  };

  const confirmationStatus = confirmation?.status ?? "CONFIRMED";
  const isPendingConfirmation = confirmationStatus === "PENDING";
  const confirmationChannelLabel = isPendingConfirmation
    ? "E-Mail"
    : confirmation?.channels?.whatsapp
      ? "E-Mail und WhatsApp"
      : confirmation?.channels?.sms
        ? "E-Mail und SMS"
        : "E-Mail";
  const confirmationStaffName = selectedStaffId
    ? selectedStaffName ?? formatStaffName(selectedSlot?.staffName) ?? "Team"
    : slotHold?.staffName
      ? formatStaffName(slotHold.staffName)
      : formatStaffName(selectedSlot?.staffName) ?? null;
  const customerStaffLabel =
    slotHold?.staffName
      ? formatStaffName(slotHold.staffName)
      : selectedStaffId
        ? selectedStaffName ?? formatStaffName(selectedSlot?.staffName) ?? "Team"
        : allowAnyStaffOption
          ? formatStaffName(selectedSlot?.staffName) || "Beliebig"
          : formatStaffName(selectedSlot?.staffName) || "Team";

  return (
    <div className="flex flex-col gap-8" style={themeStyle}>
      <StepTransition isActive={step === "slots"}>
        <section className="space-y-6 pb-20 sm:pb-0">
          <div className="space-y-4">
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Termin buchen</p>
            {showReturningSuggestionCard && bookingSuggestion ? (
              <ReturningSuggestionCard
                suggestion={bookingSuggestion}
                staffName={suggestedStaffName}
                customerFirstName={returningFirstName}
                addOnNames={suggestedAddOnNames}
                loading={deviceCustomerLoading}
                onConfirm={() => void handleApplySuggestion()}
                onDismiss={handleIgnoreSuggestion}
                onForget={handleForgetDevice}
                notMeLabel={notMeLabel}
              />
            ) : showReturningGreetingBar ? (
              <ReturningGreetingBar
                greeting={returningGreeting}
                loading={deviceCustomerLoading}
                onForget={handleForgetDevice}
                notMeLabel={notMeLabel}
              />
            ) : null}
            {allowServiceSelection && (
              <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">Wähle deinen Service</h2>
            )}
          </div>

          {allowServiceSelection && showServiceFilters ? (
            <div className="space-y-2">
              <input
                type="search"
                value={serviceSearchTerm}
                onChange={(event) => setServiceSearchTerm(event.target.value)}
                placeholder="Service suchen…"
                className="min-h-[44px] w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)]"
              />
              <div className="flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => handleCategorySelect(null)}
                  className={`min-h-[44px] shrink-0 rounded-full border px-4 py-2 text-sm transition ${
                    selectedCategoryId === null
                      ? "border-[var(--booking-accent)] bg-[var(--booking-accent)] text-[var(--booking-accent-text)]"
                      : "border-zinc-300 text-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  Alle
                </button>
                {derivedCategories.map((category) => {
                  const isActive = category.id === selectedCategoryId;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      onClick={() => handleCategorySelect(category.id)}
                      className={`min-h-[44px] shrink-0 rounded-full border px-4 py-2 text-sm transition ${
                        isActive
                          ? "border-[var(--booking-accent)] bg-[var(--booking-accent)] text-[var(--booking-accent-text)]"
                          : "border-zinc-300 text-zinc-700 hover:border-zinc-500"
                      }`}
                    >
                      {category.name}
                    </button>
                  );
                })}
              </div>
              {(selectedCategoryId !== null || isTimeOfDayActive) && (
                <button
                  type="button"
                  onClick={handleResetFilters}
                  className="inline-flex min-h-[44px] items-center text-xs font-semibold text-zinc-500 hover:text-zinc-700"
                >
                  Filter zurücksetzen
                </button>
              )}
            </div>
          ) : null}

          {showPopularServices && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Beliebte Services</p>
              <ServicePicker
                services={popularServices}
                selectedServiceIds={selectedServiceIds}
                onSelect={handleServiceSelect}
                maxSelection={maxServicesPerBooking}
              />
            </div>
          )}

          {allowServiceSelection && !isServicePickerVisibleMobile && primaryService && (
            <div className="sm:hidden">
              <button
                type="button"
                onClick={() => {
                  setShowServicePickerMobile(true);
                  setServiceFiltersCollapsed(false);
                }}
                className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-left text-sm text-zinc-700 shadow-sm"
              >
                <span className="font-semibold">Service: {serviceSummaryLabel}</span>
                <span className="text-xs text-zinc-500">ändern</span>
              </button>
            </div>
          )}

          {allowServiceSelection && (
            <div className={isServicePickerVisibleMobile ? "" : "hidden sm:block"}>
              <div ref={serviceListAnchorRef} />
              {servicesLoading ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {Array.from({ length: serviceListLimit }).map((_, index) => (
                    <div key={`service-skeleton-${index}`} className="h-12 rounded-lg border border-zinc-200 bg-zinc-100" />
                  ))}
                </div>
              ) : servicesError ? (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                  {servicesError}
                </div>
              ) : filteredServices.length === 0 ? (
                <div className="space-y-3 rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500">
                  <p>Keine Dienstleistungen gefunden.</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCategoryId(null);
                        setServiceSearchTerm("");
                      }}
                      className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
                    >
                      Filter zurücksetzen
                    </button>
                    {selectedStaffId ? (
                      <button
                        type="button"
                        onClick={() => {
                          userSelectedStaffRef.current = true;
                          setSelectedStaffId(null);
                        }}
                        className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
                      >
                        Mitarbeiter zurücksetzen
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <ServicePicker
                  services={visibleServices}
                  selectedServiceIds={selectedServiceIds}
                  onSelect={handleServiceSelect}
                  maxSelection={maxServicesPerBooking}
                  getDuration={getEffectiveDuration}
                />
              )}
            </div>
          )}

          {allowServiceSelection && showServiceMore && (
            <button
              type="button"
              onClick={() => setShowAllServices((prev) => !prev)}
              className={`min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 ${
                isServicePickerVisibleMobile ? "" : "hidden sm:inline-flex"
              }`}
            >
              {showAllServices ? "Weniger Services anzeigen" : "Weitere Services anzeigen"}
            </button>
          )}

          {allowServiceSelection &&
            primaryService &&
            maxServicesPerBooking > 1 &&
            suggestedAddOnServices.length > 0 &&
            !servicesLoading && (
              <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
                <div>
                  <p className="text-sm font-semibold text-zinc-900">Termin erweitern?</p>
                  <p className="text-xs text-zinc-500">Optional dazu buchen.</p>
                </div>
                <div className="grid gap-2">
                  {suggestedAddOnServices.map((service) => {
                    const selected = selectedServiceIds.includes(service.id);
                    const description = service.description?.trim() ?? "";
                    const showDescription = description.length > 0;
                    const showMoreHint = description.length > ADDON_DESCRIPTION_PREVIEW_LIMIT;
                    const isExpanded = expandedAddOnIds.includes(service.id);
                    const descriptionPreview = showMoreHint
                      ? `${description.slice(0, ADDON_DESCRIPTION_PREVIEW_LIMIT).trimEnd()} …`
                      : description;
                    const showDuration = service.showDurationOnline !== false;
                    const addOnMetaParts: string[] = [];
                    if (showDuration) addOnMetaParts.push(`${getEffectiveDuration(service)} Min`);
                    if (typeof service.priceCents === "number") {
                      addOnMetaParts.push(formatPriceCents(service.priceCents));
                    }
                    return (
                      <label
                        key={service.id}
                        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm transition ${
                          selected ? "border-[var(--booking-accent)] bg-[var(--booking-accent)]/10" : "border-zinc-200 hover:border-zinc-400"
                        }`}
                      >
                        <div className="flex flex-col">
                          <span className="font-semibold text-zinc-800">{service.name}</span>
                          <span className="text-xs text-zinc-500">
                            {addOnMetaParts.join(" · ")}
                          </span>
                          {showDescription ? (
                            <span className="mt-1 text-xs text-zinc-500">
                              <span className={isExpanded ? "" : "line-clamp-2"}>
                                {isExpanded ? description : descriptionPreview}
                              </span>
                              {showMoreHint ? (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setExpandedAddOnIds((current) =>
                                      current.includes(service.id)
                                        ? current.filter((id) => id !== service.id)
                                        : [...current, service.id],
                                    );
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setExpandedAddOnIds((current) =>
                                        current.includes(service.id)
                                          ? current.filter((id) => id !== service.id)
                                          : [...current, service.id],
                                      );
                                    }
                                  }}
                                  className="mt-1 inline-flex font-semibold text-zinc-700"
                                >
                                  {isExpanded ? "weniger" : "mehr"}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </div>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => handleServiceSelect(service.id)}
                          className="h-4 w-4 rounded border-zinc-300 text-[var(--booking-accent)] focus:ring-[var(--booking-accent)]"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

          {showColorPrecheck && (
            <div className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-zinc-900">Farbberatung & Planung</p>
                <p className="text-xs text-zinc-500">Farbe ist individuell – wir planen sie gemeinsam.</p>
                {colorFlow?.mode === "consultation" ? (
                  <p className="text-xs text-zinc-600">
                    {colorRequestedService ? `Gewünschte Farbe: ${colorRequestedService.name}. ` : ""}
                    Wir buchen zuerst {colorConsultationLabel}.
                  </p>
                ) : (
                  <p className="text-xs text-zinc-600">Wir planen die Details gemeinsam im Termin.</p>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm text-zinc-700">
                  <span>Haarlänge</span>
                  <select
                    value={colorQuestionnaire.hairLength}
                    onChange={(event) =>
                      setColorQuestionnaire((current) => ({ ...current, hairLength: event.target.value as ColorQuestionnaire["hairLength"] }))
                    }
                    className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm"
                  >
                    <option value="">Bitte wählen</option>
                    <option value="short">Kurz</option>
                    <option value="medium">Mittel</option>
                    <option value="long">Lang</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-700">
                  <span>Haardichte</span>
                  <select
                    value={colorQuestionnaire.hairDensity}
                    onChange={(event) =>
                      setColorQuestionnaire((current) => ({ ...current, hairDensity: event.target.value as ColorQuestionnaire["hairDensity"] }))
                    }
                    className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm"
                  >
                    <option value="">Bitte wählen</option>
                    <option value="fine">Fein</option>
                    <option value="normal">Normal</option>
                    <option value="thick">Kräftig</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-700">
                  <span>Aktueller Zustand</span>
                  <select
                    value={colorQuestionnaire.hairState}
                    onChange={(event) =>
                      setColorQuestionnaire((current) => ({ ...current, hairState: event.target.value as ColorQuestionnaire["hairState"] }))
                    }
                    className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm"
                  >
                    <option value="">Bitte wählen</option>
                    <option value="natural">Natur</option>
                    <option value="colored">Gefärbt</option>
                    <option value="blonded">Blondiert</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-700">
                  <span>Gewünschtes Ergebnis</span>
                  <select
                    value={colorQuestionnaire.desiredResult}
                    onChange={(event) =>
                      setColorQuestionnaire((current) => ({ ...current, desiredResult: event.target.value as ColorQuestionnaire["desiredResult"] }))
                    }
                    className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm"
                  >
                    <option value="">Bitte wählen</option>
                    <option value="refresh">Auffrischen</option>
                    <option value="change">Veränderung</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-700">
                  <span>Allergien / Sensibilitäten</span>
                  <select
                    value={colorQuestionnaire.allergies}
                    onChange={(event) =>
                      setColorQuestionnaire((current) => ({ ...current, allergies: event.target.value as ColorQuestionnaire["allergies"] }))
                    }
                    className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm"
                  >
                    <option value="">Bitte wählen</option>
                    <option value="yes">Ja</option>
                    <option value="no">Nein</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-zinc-700">
                  <span>Bereits Kund:in</span>
                  <select
                    value={colorQuestionnaire.returning}
                    onChange={(event) =>
                      setColorQuestionnaire((current) => ({ ...current, returning: event.target.value as ColorQuestionnaire["returning"] }))
                    }
                    className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm"
                  >
                    <option value="">Bitte wählen</option>
                    <option value="yes">Ja</option>
                    <option value="no">Nein</option>
                  </select>
                </label>
              </div>
              <AttachmentPicker
                title="Foto hochladen (optional)"
                helperText="Erlaubte Formate: JPG, PNG, PDF (max. 5 MB)."
                attachments={attachments}
                onAttachmentsChange={handleAttachmentChange}
                onAttachmentRemove={handleAttachmentRemove}
              />
            </div>
          )}

          {allowServiceSelection && selectedServices.length > 0 && (staffLoading || staff.length > 0 || staffError) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Mitarbeiter wählen (optional)</p>
              {!isStaffPickerVisibleMobile && (
                <div className="sm:hidden">
                  <button
                    type="button"
                    onClick={() => setShowStaffPickerMobile(true)}
                    className="flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-4 py-3 text-left text-sm text-zinc-700 shadow-sm"
                  >
                    <span className="font-semibold">
                      Mitarbeiter: {staffLoading ? "lädt…" : staffLabel}
                    </span>
                    <span className="text-xs text-zinc-500">ändern</span>
                  </button>
                </div>
              )}
              <div className={isStaffPickerVisibleMobile ? "" : "hidden sm:block"}>
                {staffLoading ? (
                  <div className="flex flex-wrap gap-2">
                    {Array.from({ length: 5 }).map((_, index) => (
                      <div key={`staff-skeleton-${index}`} className="h-10 w-28 rounded-full border border-zinc-200 bg-zinc-100" />
                    ))}
                  </div>
                ) : staffError ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                    {staffError}
                  </div>
                ) : (
                  <StaffPicker
                    staff={staffOptionsPreview}
                    selectedStaffId={selectedStaffId}
                    onSelect={(staffId) => {
                      userSelectedStaffRef.current = true;
                      setSelectedStaffId(staffId);
                      setShowStaffSearch(false);
                      setShowStaffPickerMobile(false);
                    }}
                    showAnyStaffOption={allowAnyStaffOption}
                    formatStaffName={formatStaffName}
                  />
                )}
              </div>

              {staffSearchActive && showStaffSearch && (
                <div className={isStaffPickerVisibleMobile ? "" : "hidden sm:block"}>
                  <StaffSearch
                    query={staffQuery}
                    onQueryChange={setStaffQuery}
                    staff={eligibleStaff}
                    onSelect={(staffId) => {
                      userSelectedStaffRef.current = true;
                      setSelectedStaffId(staffId);
                      setShowStaffSearch(false);
                      setShowStaffPickerMobile(false);
                    }}
                    showAnyStaffOption={allowAnyStaffOption}
                    formatStaffName={formatStaffName}
                  />
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h3 className="text-3xl font-semibold tracking-tight text-zinc-900">Freie Termine</h3>
                {primaryService ? (
                  <p className="mt-1 text-sm text-zinc-600">
                    {serviceDetailLabel}
                    {serviceStaffLabel ? ` · ${serviceStaffLabel}` : ""}
                    {selectedServiceDurationDisplay ? ` · ${selectedServiceDurationDisplay} Min` : ""}
                    {typeof selectedServicePriceCents === "number"
                      ? ` · ${formatPriceCents(selectedServicePriceCents)}`
                      : ""}
                  </p>
                ) : null}
              </div>
              {primaryService ? (
                <button
                  type="button"
                  onClick={() => setShowDateJump(true)}
                  className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
                >
                  Anderes Datum wählen
                </button>
              ) : null}
            </div>
            {primaryService ? (
              <div className="space-y-2">
                {showRangeMeta ? (
                  <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                    <span>Zeige Termine ab: {rangeLabel}</span>
                    {isDateJumpActive && (
                      <button
                        type="button"
                        onClick={handleResetDate}
                        className="inline-flex min-h-[44px] items-center text-xs font-semibold text-zinc-500 hover:text-zinc-700"
                      >
                        Zurück zu nächsten Terminen
                      </button>
                    )}
                  </div>
                ) : null}
                {earliestBookingHint ? (
                  <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                    {earliestBookingHint}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {!selectedServices.length && (
            <div className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500">
              Bitte wähle zuerst einen Service, um freie Termine zu sehen.
            </div>
          )}

          {selectedServices.length > 0 && slotsLoading && (
            <div className="space-y-3">
              <div className="h-4 w-32 animate-pulse rounded bg-zinc-100" />
              <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={`slot-skeleton-${index}`} className="h-20 animate-pulse rounded-lg border border-zinc-200 bg-zinc-100" />
                ))}
              </div>
            </div>
          )}

          {selectedServices.length > 0 && slotError && !slotsLoading && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              {slotError}
            </div>
          )}

          {selectedServices.length > 0 && !slotsLoading && !slotError && slotGroups.length === 0 && (
            <div className="space-y-3 rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500">
              <p>Keine freien Termine im aktuellen Zeitraum verfügbar.</p>
              <button
                type="button"
                onClick={() => void fetchSlots(nextRangeStart, true)}
                className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
              >
                +7 Tage erweitern
              </button>
            </div>
          )}

          {selectedServices.length > 0 && !slotsLoading && !slotError && nextAvailableSlot && nextAvailableLabel && !isDateJumpActive && (
            <button
              type="button"
              onClick={() => void handleSlotSelect(nextAvailableSlot)}
              className="flex w-full items-center justify-between gap-4 rounded-2xl border border-[var(--booking-accent)]/30 bg-gradient-to-br from-[var(--booking-accent)]/10 to-white px-5 py-4 text-left text-sm text-zinc-800 shadow-md transition hover:border-[var(--booking-accent)]/50"
            >
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Nächster freier Termin</div>
                {showQuickSubtitle && (
                  <div className="mt-1 inline-flex rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-zinc-500">
                    Schnell buchen
                  </div>
                )}
                <div className="mt-2 text-lg font-semibold text-zinc-900">{nextAvailableLabel}</div>
              </div>
              <span className="text-xs font-semibold text-zinc-500">Wählen →</span>
            </button>
          )}

          {selectedServices.length > 0 && suggestionHint && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              {suggestionHint}
            </div>
          )}

          {selectedServices.length > 0 && slotGroups.length > 0 && (
            <>
              {hideEarlier && hiddenGroupCount > 0 && (
                <div className="flex flex-col gap-1 text-xs text-zinc-500">
                  <button
                    type="button"
                    onClick={() => {
                      setHideEarlier(false);
                      setRevealEarlier(true);
                    }}
                    className="min-h-[44px] w-fit text-sm font-medium text-zinc-600 hover:underline"
                  >
                    ↑ Vorherige Termine anzeigen
                  </button>
                  <span className="text-xs text-zinc-400">Frühere Termine ausgeblendet</span>
                </div>
              )}
                <SlotList
                  groups={dedupedSlotGroups}
                  selectedSlotId={selectedSlotId}
                  highlightedSlotId={highlightedSlotId}
                  durationMin={selectedServiceDurationDisplay}
                  timezone={location.timezone}
                  onSelect={handleSlotSelect}
                  showStaffName={allowAnyStaffOption && !effectiveStaffId}
                  formatStaffName={formatStaffName}
                />
            </>
          )}

          {selectedServices.length > 0 && slotGroups.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setPagesLoaded((prev) => prev + 1);
                  void fetchSlots(nextRangeStart, true);
                }}
                disabled={slotsLoading || loadMoreLoading || !hasMoreSlots}
                className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadMoreLoading
                  ? "Lade weitere Termine…"
                  : hasMoreSlots
                    ? "Weitere Termine anzeigen"
                    : "Keine weiteren Termine verfügbar"}
              </button>
              {effectivePagesLoaded >= 2 && !showDateJump && (
                <button
                  type="button"
                  onClick={() => setShowDateJump(true)}
                  className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
                >
                  Anderes Datum wählen
                </button>
              )}
            </div>
          )}

          {showDateJump && (
            <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 pb-28 pt-6 sm:items-center sm:pb-6">
              <div className="w-full max-w-sm max-h-[80vh] overflow-y-auto rounded-2xl bg-white p-4 shadow-xl">
                <div className="flex items-center justify-between">
                  <h4 className="text-base font-semibold text-zinc-900">Anderes Datum wählen</h4>
                  <button
                    type="button"
                    onClick={() => setShowDateJump(false)}
                    className="text-xs font-semibold text-zinc-500 hover:text-zinc-700"
                  >
                    Schließen
                  </button>
                </div>
                <div className="mt-4 space-y-3">
                  <label className="flex flex-col gap-1 text-sm text-zinc-700">
                    <span>Datum</span>
                    <input
                      type="date"
                      value={dateJumpInput}
                      onChange={(event) => handleDateJumpChange(event.target.value)}
                      className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)]"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <button
                      type="button"
                      onClick={() => applyStartDate(addDays(currentRangeStart, 7))}
                      className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-zinc-700 hover:bg-zinc-100"
                    >
                      +1 Woche
                    </button>
                    <button
                      type="button"
                      onClick={() => applyStartDate(addDays(currentRangeStart, 14))}
                      className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-zinc-700 hover:bg-zinc-100"
                    >
                      +2 Wochen
                    </button>
                    <button
                      type="button"
                      onClick={() => applyStartDate(addMonths(currentRangeStart, 1))}
                      className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-zinc-700 hover:bg-zinc-100"
                    >
                      +1 Monat
                    </button>
                    <button
                      type="button"
                      onClick={() => applyStartDate(addMonths(currentRangeStart, 2))}
                      className="min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-zinc-700 hover:bg-zinc-100"
                    >
                      +2 Monate
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {allowServiceSelection && primaryService && !showDateJump && (
            <div className="sm:hidden sticky bottom-0 z-20 -mx-4 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur">
              <div className="flex flex-col gap-2 text-sm text-zinc-700">
                <button
                  type="button"
                  onClick={() => {
                    setShowServicePickerMobile(true);
                    setServiceFiltersCollapsed(false);
                  }}
                  className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 bg-white px-3 py-2"
                >
                  <span className="font-semibold">Service: {serviceSummaryLabel}</span>
                  <span className="text-xs text-zinc-500">ändern</span>
                </button>
                {(staff.length > 0 || staffLoading) && (
                  <button
                    type="button"
                    onClick={() => setShowStaffPickerMobile(true)}
                    className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 bg-white px-3 py-2"
                  >
                    <span className="font-semibold">
                      Mitarbeiter: {staffLoading ? "lädt…" : staffLabel}
                    </span>
                    <span className="text-xs text-zinc-500">ändern</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </StepTransition>

      <StepTransition isActive={step === "customer" && Boolean(selectedServices.length && selectedSlot)}>
        {selectedServices.length && selectedSlot ? (
          <CustomerForm
            slot={selectedSlot}
            timezone={location.timezone}
            form={checkoutForm}
            onChange={setCheckoutForm}
            onBack={() => void resetToSlots(true)}
            onSubmit={handleCustomerSubmit}
            attachments={attachments}
            onAttachmentsChange={handleAttachmentChange}
            onAttachmentRemove={handleAttachmentRemove}
            hideAttachments={showColorPrecheck}
            error={checkoutError}
            loading={checkoutLoading}
            holdRemainingSeconds={holdRemainingSeconds}
            serviceSummary={serviceSummaryLabel}
            serviceDetails={serviceDetailLabel}
            serviceDurationMin={selectedServiceDurationDisplay ?? null}
            staffName={customerStaffLabel}
            termsLink={termsLink}
            privacyLink={privacyLink}
          />
        ) : null}
      </StepTransition>

      <StepTransition isActive={step === "success" && Boolean(confirmation)}>
        {confirmation ? (
          <Confirmation
            confirmation={confirmation}
            timezone={location.timezone}
            status={confirmationStatus}
            channelLabel={confirmationChannelLabel}
            staffName={confirmationStaffName ?? undefined}
            customerNotice={customerNotice}
            serviceName={serviceDetailLabel || serviceSummaryLabel}
            serviceDurationMin={selectedServiceDurationDisplay}
            onReset={() => {
              setConfirmation(null);
              void resetToSlots(false);
            }}
          />
        ) : null}
      </StepTransition>

      <div className="flex justify-end pt-4 text-xs text-zinc-500">
        <div className="flex flex-wrap items-center gap-4">
          {termsLink ? (
            <a
              href={termsLink}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-zinc-600 hover:text-zinc-900"
            >
              AGB
            </a>
          ) : (
            <span>AGB</span>
          )}
          {privacyLink ? (
            <a
              href={privacyLink}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-zinc-600 hover:text-zinc-900"
            >
              Datenschutz
            </a>
          ) : (
            <span>Datenschutz</span>
          )}
          {imprintLink ? (
            <a
              href={imprintLink}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-zinc-600 hover:text-zinc-900"
            >
              Impressum
            </a>
          ) : (
            <span>Impressum</span>
          )}
        </div>
      </div>
    </div>
  );
}

function StepTransition({
  isActive,
  children,
  className,
}: {
  isActive: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!isActive) return;
    setEntered(false);
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, [isActive]);

  if (!isActive) return null;
  return (
    <div
      className={`${className ?? ""} ${
        prefersReducedMotion
          ? "opacity-100"
          : `transition duration-200 ease-out motion-reduce:transition-none ${
              entered ? "opacity-100 transform-none" : "-translate-y-2 opacity-0"
            }`
      }`}
    >
      {children}
    </div>
  );
}

function ReturningSuggestionCard({
  suggestion,
  staffName,
  customerFirstName,
  addOnNames,
  loading,
  onConfirm,
  onDismiss,
  onForget,
  notMeLabel,
}: {
  suggestion: BookingSuggestion;
  staffName?: string | null;
  customerFirstName?: string;
  addOnNames: string[];
  loading: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
  onForget: () => void;
  notMeLabel: string;
}) {
  const addOnLabel = addOnNames.length ? ` + ${addOnNames.join(" + ")}` : "";
  return (
    <div className="rounded-2xl border border-[var(--booking-accent)]/20 bg-[var(--booking-accent)]/5 p-5 shadow-md">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <span className="text-xs uppercase tracking-[0.2em] text-zinc-500">
            {customerFirstName ? `Willkommen zurück ${customerFirstName}` : "Willkommen zurück"}
          </span>
          <p className="mt-2 text-base font-medium text-zinc-800">
            {loading
              ? "Lade Vorschlag…"
              : `Wie beim letzten Mal, ${suggestion.serviceName}${addOnLabel}${staffName ? ` bei ${staffName}` : ""}?`}
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={onConfirm}
          disabled={loading}
          className="min-h-[44px] w-full rounded-md bg-[var(--booking-accent)] px-4 py-2 text-sm font-semibold text-[var(--booking-accent-text)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          Ja, genau so
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="min-h-[44px] w-full rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 sm:w-auto"
        >
          Etwas anderes
        </button>
      </div>
      <button
        type="button"
        onClick={onForget}
        className="mt-3 min-h-[44px] text-xs font-semibold text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline"
      >
        {notMeLabel}
      </button>
    </div>
  );
}

function ReturningGreetingBar({
  greeting,
  loading,
  onForget,
  notMeLabel,
}: {
  greeting: string;
  loading: boolean;
  onForget: () => void;
  notMeLabel: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{loading ? "Willkommen zurück…" : greeting}</span>
        <button
          type="button"
          onClick={onForget}
          className="min-h-[44px] text-xs font-semibold text-zinc-500 underline-offset-2 hover:text-zinc-700 hover:underline"
        >
          {notMeLabel}
        </button>
      </div>
    </div>
  );
}

function ServicePicker({
  services,
  selectedServiceIds,
  onSelect,
  maxSelection,
  getDuration,
}: {
  services: ServiceOption[];
  selectedServiceIds: string[];
  onSelect: (serviceId: string) => void;
  maxSelection: number;
  getDuration?: (service: ServiceOption) => number;
}) {
  const DESCRIPTION_PREVIEW_LIMIT = 90;
  const [expandedServiceIds, setExpandedServiceIds] = useState<string[]>([]);

  const toggleExpanded = (serviceId: string) => {
    setExpandedServiceIds((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId],
    );
  };

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        {services.map((service) => {
          const isActive = selectedServiceIds.includes(service.id);
          const isDisabled = maxSelection > 1 && !isActive && selectedServiceIds.length >= maxSelection;
          const description = service.description?.trim() ?? "";
          const showDescription = description.length > 0;
          const showMoreHint = description.length > DESCRIPTION_PREVIEW_LIMIT;
          const isExpanded = expandedServiceIds.includes(service.id);
          const descriptionPreview = showMoreHint
            ? `${description.slice(0, DESCRIPTION_PREVIEW_LIMIT).trimEnd()} …`
            : description;
          const showDuration = service.showDurationOnline !== false;
          const durationValue = getDuration ? getDuration(service) : service.durationMin;
          return (
            <div key={service.id} className="relative flex w-full flex-col gap-2">
              <div className="relative flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest("[data-description-toggle]")) return;
                    if (event.defaultPrevented) return;
                    onSelect(service.id);
                  }}
                  disabled={isDisabled}
                  className={`relative min-h-[44px] w-full rounded-3xl border px-4 py-2 text-left text-sm transition ${
                    isActive
                      ? "border-[var(--booking-accent)] bg-[var(--booking-accent)] text-[var(--booking-accent-text)]"
                      : "border-zinc-300 text-zinc-700 hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-60"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{service.name}</span>
                    {showDuration ? (
                      <span className={isActive ? "text-[var(--booking-accent-text)]/80" : "text-zinc-500"}>
                        {`${durationValue} Min`}
                      </span>
                    ) : null}
                    {typeof service.priceCents === "number" ? (
                      <span className={isActive ? "text-[var(--booking-accent-text)]/80" : "text-zinc-500"}>
                        {formatPriceCents(service.priceCents)}
                      </span>
                    ) : null}
                  </div>
                  {showDescription ? (
                    <div
                      className={`mt-1 text-xs leading-relaxed ${
                        isActive ? "text-[var(--booking-accent-text)]/80" : "text-zinc-500"
                      }`}
                    >
                      <span className={isExpanded ? "" : "line-clamp-2"}>
                        {isExpanded ? description : descriptionPreview}
                      </span>
                      {showMoreHint ? (
                        <span
                          data-description-toggle="true"
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleExpanded(service.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              event.stopPropagation();
                              toggleExpanded(service.id);
                            }
                          }}
                          className={`mt-1 inline-flex font-semibold ${
                            isActive ? "text-[var(--booking-accent-text)]" : "text-zinc-700"
                          }`}
                        >
                          {isExpanded ? "weniger" : "mehr"}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function StaffPicker({
  staff,
  selectedStaffId,
  onSelect,
  showAnyStaffOption,
  formatStaffName,
}: {
  staff: StaffOption[];
  selectedStaffId: string | null;
  onSelect: (staffId: string | null) => void;
  showAnyStaffOption: boolean;
  formatStaffName: (name?: string | null) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {showAnyStaffOption && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`min-h-[44px] rounded-full border px-4 py-2 text-sm transition ${
            selectedStaffId === null
              ? "border-[var(--booking-accent)] bg-[var(--booking-accent)] text-[var(--booking-accent-text)]"
              : "border-zinc-300 text-zinc-700 hover:border-zinc-500"
          }`}
        >
          Beliebig
        </button>
      )}
      {staff.map((member) => {
        const isActive = member.id === selectedStaffId;
        return (
          <button
            key={member.id}
            type="button"
            onClick={() => onSelect(member.id)}
            className={`min-h-[44px] rounded-full border px-4 py-2 text-sm transition ${
              isActive
                ? "border-[var(--booking-accent)] bg-[var(--booking-accent)] text-[var(--booking-accent-text)]"
                : "border-zinc-300 text-zinc-700 hover:border-zinc-500"
            }`}
          >
            {formatStaffName(member.name)}
          </button>
        );
      })}
    </div>
  );
}

function StaffSearch({
  query,
  onQueryChange,
  staff,
  onSelect,
  showAnyStaffOption,
  formatStaffName,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  staff: StaffOption[];
  onSelect: (staffId: string | null) => void;
  showAnyStaffOption: boolean;
  formatStaffName: (name?: string | null) => string;
}) {
  const filtered = staff.filter((member) => member.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Mitarbeiter suchen"
        className="min-h-[44px] w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)]"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {showAnyStaffOption && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="min-h-[44px] rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm text-zinc-700 hover:border-zinc-400"
          >
            Beliebig
          </button>
        )}
        {filtered.map((member) => (
          <button
            key={member.id}
            type="button"
            onClick={() => onSelect(member.id)}
            className="min-h-[44px] rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm text-zinc-700 hover:border-zinc-400"
          >
            <div className="font-semibold text-zinc-900">{formatStaffName(member.name)}</div>
            {member.role ? <div className="text-xs text-zinc-500">{member.role}</div> : null}
          </button>
        ))}
        {!filtered.length && <p className="text-sm text-zinc-500">Keine Mitarbeiter gefunden.</p>}
      </div>
    </div>
  );
}

function SlotList({
  groups,
  selectedSlotId,
  highlightedSlotId,
  durationMin,
  timezone,
  onSelect,
  showStaffName,
  formatStaffName,
}: {
  groups: SlotGroup[];
  selectedSlotId: string | null;
  highlightedSlotId: string | null;
  durationMin: number | null;
  timezone: string;
  onSelect: (slot: SlotOption) => void;
  showStaffName: boolean;
  formatStaffName?: (name?: string | null) => string;
}) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.key} className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-1.5 text-sm font-semibold text-zinc-900 shadow-sm">
            <span className="uppercase tracking-wide text-zinc-400">{group.label}</span>
            <span className="text-zinc-900">{group.dateLabel}</span>
          </div>
          <div className="space-y-4">
            {(group.slots.length > 8 ? chunkSlots(group.slots, 4) : [group.slots]).map((chunk, chunkIndex) => (
              <div key={`${group.key}-${chunkIndex}`} className="grid gap-3 sm:grid-cols-2">
                {chunk.map((slot) => (
                  <SlotCard
                    key={slot.id}
                    slot={slot}
                    durationMin={durationMin}
                    timezone={timezone}
                    isSelected={slot.id === selectedSlotId}
                    isHighlighted={slot.id === highlightedSlotId}
                    onSelect={onSelect}
                    showStaffName={showStaffName}
                    formatStaffName={formatStaffName}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function SlotCard({
  slot,
  durationMin,
  timezone,
  isSelected,
  isHighlighted,
  onSelect,
  showStaffName,
  formatStaffName,
}: {
  slot: SlotOption;
  durationMin: number | null;
  timezone: string;
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: (slot: SlotOption) => void;
  showStaffName: boolean;
  formatStaffName?: (name?: string | null) => string;
}) {
  const timeLabel = useMemo(
    () =>
      new Intl.DateTimeFormat("de-DE", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
      }).format(new Date(slot.start)),
    [slot.start, timezone],
  );
  const staffLabel = showStaffName
    ? formatStaffName
      ? formatStaffName(slot.staffName ?? "Team")
      : slot.staffName ?? "Team"
    : null;
  const metaLabel = buildSlotMetaLabel(staffLabel, durationMin);

  return (
    <button
      type="button"
      onClick={() => onSelect(slot)}
      data-slot-id={slot.id}
      className={`group min-h-[72px] rounded-xl border p-4 text-left shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] motion-safe:transition motion-safe:duration-200 motion-reduce:transition-none ${
        isSelected
          ? "border-[var(--booking-accent)] bg-[var(--booking-accent)] text-[var(--booking-accent-text)] shadow-md"
          : isHighlighted
            ? "border-[var(--booking-accent)]/60 bg-[var(--booking-accent)]/5 shadow-md"
            : "border-zinc-300 bg-white hover:-translate-y-0.5 hover:border-zinc-500 hover:shadow-md active:translate-y-0 active:scale-[0.99]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className={`text-lg font-semibold ${isSelected ? "text-[var(--booking-accent-text)]" : "text-zinc-900"}`}>
          {timeLabel}
        </div>
        <span className="flex items-center gap-2 text-xs font-semibold">
          {slot.isSmart ? (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100 group-focus-visible:opacity-100 ${
                isSelected
                  ? "bg-white/20 text-[var(--booking-accent-text)]/90"
                  : "bg-emerald-50 text-emerald-700"
              }`}
            >
              Passend
            </span>
          ) : null}
          <span className={isSelected ? "text-[var(--booking-accent-text)]/90" : "text-zinc-500"}>Wählen →</span>
        </span>
      </div>
      {metaLabel ? (
        <div className={`text-xs ${isSelected ? "text-[var(--booking-accent-text)]/80" : "text-zinc-600"}`}>
          {metaLabel}
        </div>
      ) : null}
    </button>
  );
}

function CustomerForm({
  slot,
  timezone,
  form,
  onChange,
  onBack,
  onSubmit,
  attachments,
  onAttachmentsChange,
  onAttachmentRemove,
  hideAttachments,
  error,
  loading,
  holdRemainingSeconds,
  serviceSummary,
  serviceDetails,
  serviceDurationMin,
  staffName,
  termsLink,
  privacyLink,
}: {
  slot: SlotOption;
  timezone: string;
  form: CustomerFormState;
  onChange: (next: CustomerFormState) => void;
  onBack: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  attachments: File[];
  onAttachmentsChange: (files: FileList | null) => void;
  onAttachmentRemove: (index: number) => void;
  hideAttachments?: boolean;
  error: string | null;
  loading: boolean;
  holdRemainingSeconds: number | null;
  serviceSummary: string;
  serviceDetails?: string;
  serviceDurationMin: number | null;
  staffName?: string | null;
  termsLink?: string;
  privacyLink?: string;
}) {
  const firstNameRef = useRef<HTMLInputElement | null>(null);
  const lastNameRef = useRef<HTMLInputElement | null>(null);
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const [summaryEntered, setSummaryEntered] = useState(false);
  const dateLabel = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
  }).format(new Date(slot.start));
  const timeLabel = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(slot.start));

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setSummaryEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="space-y-6">
      <div
        className={`sticky top-0 z-10 -mx-4 rounded-b-xl border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur transition-all duration-300 motion-reduce:transition-none ${
          summaryEntered ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] rounded-md border border-zinc-200 bg-white px-3 py-1.5 font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Service: {serviceSummary} <span className="text-zinc-400">ändern</span>
          </button>
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] rounded-md border border-zinc-200 bg-white px-3 py-1.5 font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Mitarbeiter: {staffName ?? "Beliebig"} <span className="text-zinc-400">ändern</span>
          </button>
          <span className="rounded-md border border-zinc-200 bg-white px-3 py-1.5 font-semibold text-zinc-800">
            Termin: {dateLabel} · {timeLabel} Uhr
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Kundendaten</p>
          <h2 className="mt-2 text-xl font-semibold text-zinc-900 sm:text-2xl">Deine Angaben</h2>
          <p className="mt-2 text-sm text-zinc-600">
            {(serviceDetails || serviceSummary) + (serviceDurationMin ? ` · ${serviceDurationMin} Min` : "")} ·{" "}
            {dateLabel}, {timeLabel}
          </p>
          {staffName ? <p className="text-sm text-zinc-600">Mitarbeiter: {staffName}</p> : null}
        </div>
        {holdRemainingSeconds !== null && (
          <div className="self-start rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-semibold text-amber-900">
            Reserviert {formatCountdown(holdRemainingSeconds)}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Vorname"
            required
            value={form.firstName}
            onChange={(value) => onChange({ ...form, firstName: value })}
            autoComplete="given-name"
            inputRef={firstNameRef}
            onAutoAdvance={() => lastNameRef.current?.focus()}
          />
          <Field
            label="Nachname"
            required
            value={form.lastName}
            onChange={(value) => onChange({ ...form, lastName: value })}
            autoComplete="family-name"
            inputRef={lastNameRef}
            onAutoAdvance={() => phoneRef.current?.focus()}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Mobilnummer"
            required
            value={form.phone}
            onChange={(value) => onChange({ ...form, phone: value })}
            autoComplete="tel"
            inputRef={phoneRef}
            onAutoAdvance={() => emailRef.current?.focus()}
          />
          <Field
            label="E-Mail"
            type="email"
            required
            value={form.email}
            onChange={(value) => onChange({ ...form, email: value })}
            autoComplete="email"
            inputRef={emailRef}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Festnetznummer"
            value={form.landline}
            onChange={(value) => onChange({ ...form, landline: value })}
          />
        </div>
        <p className="text-xs text-zinc-500">Mobilnummer und E-Mail sind erforderlich.</p>

        {!hideAttachments && (
          <AttachmentPicker
            title="Datei hochladen (optional)"
            helperText="Erlaubte Formate: JPG, PNG, PDF (max. 5 MB)."
            attachments={attachments}
            onAttachmentsChange={onAttachmentsChange}
            onAttachmentRemove={onAttachmentRemove}
          />
        )}

        <div className="space-y-2 text-sm text-zinc-600 sm:text-xs">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={form.whatsappOptIn}
              onChange={(event) => onChange({ ...form, whatsappOptIn: event.target.checked })}
              className="mt-1 h-5 w-5 rounded border-zinc-300 text-[var(--booking-accent)] focus:ring-[var(--booking-accent)] sm:h-4 sm:w-4"
            />
            <span>
              Ich möchte Termininfos per <span className="font-semibold">WhatsApp</span> erhalten.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={form.termsAccepted}
              onChange={(event) => onChange({ ...form, termsAccepted: event.target.checked })}
              className="mt-1 h-5 w-5 rounded border-zinc-300 text-[var(--booking-accent)] focus:ring-[var(--booking-accent)] sm:h-4 sm:w-4"
            />
            <span>
              Ich akzeptiere die{" "}
              {termsLink ? (
                <a
                  href={termsLink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-zinc-800 underline underline-offset-2 hover:text-zinc-900"
                >
                  AGB
                </a>
              ) : (
                "AGB"
              )}{" "}
              und{" "}
              {privacyLink ? (
                <a
                  href={privacyLink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-zinc-800 underline underline-offset-2 hover:text-zinc-900"
                >
                  Datenschutzrichtlinien
                </a>
              ) : (
                "Datenschutzrichtlinien"
              )}
              .
              <span className="ml-1 text-rose-500">*</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={form.marketingOptIn}
              onChange={(event) => onChange({ ...form, marketingOptIn: event.target.checked })}
              className="mt-1 h-5 w-5 rounded border-zinc-300 text-[var(--booking-accent)] focus:ring-[var(--booking-accent)] sm:h-4 sm:w-4"
            />
            <span>Ich möchte Neuigkeiten und Angebote per E-Mail erhalten.</span>
          </label>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] w-full rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 sm:w-auto"
          >
            Zurück zu Slots
          </button>
          <button
            type="submit"
            disabled={loading}
            className="min-h-[44px] w-full rounded-md bg-[var(--booking-accent)] px-4 py-2 text-sm font-semibold text-[var(--booking-accent-text)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
          >
            {loading ? "Bucht…" : "Termin buchen"}
          </button>
        </div>
      </form>
    </section>
  );
}

function AttachmentPicker({
  title,
  helperText,
  attachments,
  onAttachmentsChange,
  onAttachmentRemove,
}: {
  title: string;
  helperText?: string;
  attachments: File[];
  onAttachmentsChange: (files: FileList | null) => void;
  onAttachmentRemove: (index: number) => void;
}) {
  const canAddMore = attachments.length < MAX_BOOKING_ATTACHMENTS;
  const accept = Array.from(BOOKING_ATTACHMENT_TYPES).join(",");

  return (
    <div className="space-y-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{title}</p>
          {helperText ? <p className="text-xs text-zinc-500">{helperText}</p> : null}
        </div>
        <label
          className={`inline-flex min-h-[36px] cursor-pointer items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-widest transition ${
            canAddMore
              ? "border-zinc-300 text-zinc-700 hover:bg-zinc-100"
              : "border-zinc-200 text-zinc-400"
          }`}
        >
          Datei wählen
          <input
            type="file"
            accept={accept}
            multiple={MAX_BOOKING_ATTACHMENTS > 1}
            disabled={!canAddMore}
            onChange={(event) => onAttachmentsChange(event.target.files)}
            className="hidden"
          />
        </label>
      </div>
      {attachments.length > 0 ? (
        <ul className="space-y-1.5 text-sm text-zinc-600">
          {attachments.map((file, index) => (
            <li
              key={`${file.name}-${file.size}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 px-3 py-2"
            >
              <span className="truncate">{file.name}</span>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-400">{Math.round(file.size / 1024)} KB</span>
                <button
                  type="button"
                  onClick={() => onAttachmentRemove(index)}
                  className="text-xs font-semibold text-rose-600 hover:text-rose-700"
                >
                  Entfernen
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">Keine Datei ausgewählt.</p>
      )}
    </div>
  );
}

function Confirmation({
  confirmation,
  timezone,
  status,
  channelLabel,
  staffName,
  customerNotice,
  serviceName,
  serviceDurationMin,
  onReset,
}: {
  confirmation: CheckoutResponse["data"];
  timezone: string;
  status: CheckoutResponse["data"]["status"];
  channelLabel: string;
  staffName?: string;
  customerNotice?: string;
  serviceName?: string | null;
  serviceDurationMin?: number | null;
  onReset: () => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [checkAnimated, setCheckAnimated] = useState(false);
  const isPending = status === "PENDING";
  const dateLabel = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  }).format(new Date(confirmation.startsAt));
  const timeLabel = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(confirmation.startsAt));
  const icsUrl = `/api/bookings/ics?appointmentId=${encodeURIComponent(confirmation.appointmentId)}&code=${encodeURIComponent(
    confirmation.confirmationCode,
  )}`;

  useEffect(() => {
    if (prefersReducedMotion) return;
    const raf = window.requestAnimationFrame(() => setCheckAnimated(true));
    return () => window.cancelAnimationFrame(raf);
  }, [prefersReducedMotion]);

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-md">
      <div className="flex items-start gap-5">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full ${
            isPending ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600"
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            width="22"
            height="22"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path
              d="M5 13l4 4L19 7"
              style={{
                strokeDasharray: isPending ? 0 : 32,
                strokeDashoffset: prefersReducedMotion || checkAnimated || isPending ? 0 : 32,
                transition: prefersReducedMotion || isPending ? "none" : "stroke-dashoffset 0.7s ease",
              }}
            />
          </svg>
        </div>
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">
            {isPending ? "Anfrage eingegangen" : "Termin bestätigt"}
          </p>
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">
            {dateLabel} · {timeLabel} Uhr
          </h2>
          {serviceName ? (
            <p className="text-sm font-medium text-zinc-700">
              {serviceName}
              {serviceDurationMin ? ` · ${serviceDurationMin} Min` : ""}
            </p>
          ) : null}
          {staffName ? <p className="text-sm text-zinc-600">Mitarbeiter: {staffName}</p> : null}
          <p className="text-sm text-zinc-800">
            {isPending
              ? "Wir pruefen deine Anfrage und bestaetigen sie so schnell wie moeglich."
              : "Wir sehen uns dann."}
          </p>
          <p className="text-xs text-zinc-500">
            {isPending ? `Rueckmeldung per ${channelLabel}` : `Bestaetigung per ${channelLabel}`}
          </p>
        </div>
      </div>
      {customerNotice ? (
        <div className="mt-4">
          <BookingCustomerNotice text={customerNotice} />
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        {!isPending && (
          <a
            href={icsUrl}
            className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
            download
          >
            Zum Kalender hinzufügen (.ics)
          </a>
        )}
        <button
          type="button"
          onClick={onReset}
          className="min-h-[44px] rounded-md border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100"
        >
          Weitere Buchung vornehmen
        </button>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  inputRef,
  onAutoAdvance,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: React.HTMLInputTypeAttribute;
  autoComplete?: string;
  inputRef?: React.RefObject<HTMLInputElement>;
  onAutoAdvance?: () => void;
  required?: boolean;
}) {
  const id = useMemo(() => label.toLowerCase().replace(/\s+/g, "-"), [label]);
  const handleAnimationStart = useCallback(
    (event: React.AnimationEvent<HTMLInputElement>) => {
      if (event.animationName !== "autofill-start") return;
      if (document.activeElement !== event.currentTarget) return;
      if (!onAutoAdvance) return;
      window.setTimeout(() => onAutoAdvance(), 0);
    },
    [onAutoAdvance],
  );

  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm text-zinc-700">
      <span className="flex items-center gap-1">
        <span>{label}</span>
        {required && <span className="text-rose-500">*</span>}
      </span>
      <input
        id={id}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        autoComplete={autoComplete}
        ref={inputRef}
        onAnimationStart={handleAnimationStart}
        className={`min-h-[44px] rounded-md border border-zinc-300 px-3 py-2 text-base shadow-sm transition focus:border-[var(--booking-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--booking-accent)] sm:text-sm ${
          onAutoAdvance ? "autofill-advance" : ""
        }`}
      />
    </label>
  );
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

function normalizeStartOfDay(date: Date) {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function mergeSlots(slots: SlotOption[]) {
  const map = new Map<string, SlotOption>();
  for (const slot of slots) {
    if (!map.has(slot.id)) {
      map.set(slot.id, slot);
    }
  }
  return Array.from(map.values()).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

function resolveTimeOfDay(value: string | null): TimeOfDay | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["am", "vormittag", "morning"].includes(normalized)) return "am";
  if (["pm", "nachmittag", "afternoon"].includes(normalized)) return "pm";
  if (["eve", "abend", "evening"].includes(normalized)) return "eve";
  return null;
}

function normalizeSearchValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function groupSlotsByDay(slots: SlotOption[], timeZone: string): SlotGroup[] {
  if (!slots.length) return [];
  const dateKeyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekdayFormatter = new Intl.DateTimeFormat("de-DE", { timeZone, weekday: "long" });
  const dateLabelFormatter = new Intl.DateTimeFormat("de-DE", { timeZone, day: "2-digit", month: "2-digit" });

  const todayKey = dateKeyFormatter.format(new Date());
  const tomorrowKey = dateKeyFormatter.format(addDays(new Date(), 1));

  const grouped = new Map<string, SlotOption[]>();
  for (const slot of slots) {
    const key = dateKeyFormatter.format(new Date(slot.start));
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(slot);
  }

  const groups = Array.from(grouped.entries()).map(([key, daySlots]) => {
    const sorted = daySlots.slice().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    const referenceDate = new Date(sorted[0].start);
    const label = key === todayKey ? "Heute" : key === tomorrowKey ? "Morgen" : weekdayFormatter.format(referenceDate);
    const dateLabel = dateLabelFormatter.format(referenceDate);
    return { key, label, dateLabel, slots: sorted };
  });

  return groups.sort((a, b) => new Date(a.slots[0].start).getTime() - new Date(b.slots[0].start).getTime());
}

function formatPriceCents(value: number) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatDateOnlyInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatDateLabelInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatTimeLabelInTimeZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("de-DE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function parseTimeHHmm(value: string): number | null {
  const [hourStr, minuteStr] = value.split(":");
  const hour = Number.parseInt(hourStr ?? "", 10);
  const minute = Number.parseInt(minuteStr ?? "", 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  return hour * 60 + minute;
}

function getLocalSlotParts(date: Date, timeZone: string): { weekdayIndex: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "1970", 10);
    const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "1", 10);
    const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "1", 10);
    const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
    const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);
    const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { weekdayIndex, minutes: hour * 60 + minute };
  } catch {
    return null;
  }
}

function hashStringToInt(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function findSlotElement(slotId: string) {
  if (typeof document === "undefined") return null;
  const escaped = typeof CSS !== "undefined" && "escape" in CSS ? CSS.escape(slotId) : slotId.replace(/"/g, '\\"');
  return document.querySelector(`[data-slot-id="${escaped}"]`);
}

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DEVICE_COOKIE_NAME = "booking_device_id";
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function readDeviceCookie(): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";").map((entry) => entry.trim());
  const match = cookies.find((entry) => entry.startsWith(`${DEVICE_COOKIE_NAME}=`));
  if (!match) return null;
  const value = match.slice(DEVICE_COOKIE_NAME.length + 1).trim();
  return isUuid(value) ? value : null;
}

function writeDeviceCookie(value: string) {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" && process.env.NODE_ENV === "production";
  document.cookie = `${DEVICE_COOKIE_NAME}=${value}; Max-Age=${DEVICE_COOKIE_MAX_AGE}; Path=/; SameSite=Lax${
    secure ? "; Secure" : ""
  }`;
}

function clearDeviceCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${DEVICE_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function generateDeviceId(): string | null {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return createUuidFallback();
}

function createUuidFallback(): string | null {
  const bytes = typeof crypto !== "undefined" && "getRandomValues" in crypto ? new Uint8Array(16) : null;
  if (!bytes) return null;
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildBookingFormData(payload: Record<string, unknown>, attachments: File[]) {
  const formData = new FormData();
  formData.append("payload", JSON.stringify(payload));
  attachments.forEach((file) => {
    formData.append("attachments", file, file.name);
  });
  return formData;
}

function formatDisplayDate(date: Date) {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function parseDateInput(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatCountdown(totalSeconds: number) {
  const clamped = Math.max(totalSeconds, 0);
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function chunkSlots(slots: SlotOption[], size: number) {
  const chunks: SlotOption[][] = [];
  for (let index = 0; index < slots.length; index += size) {
    chunks.push(slots.slice(index, index + size));
  }
  return chunks;
}

function buildSlotMetaLabel(staffName: string | null, durationMin: number | null) {
  const parts: string[] = [];
  if (staffName) {
    parts.push(staffName);
  }
  if (durationMin) {
    parts.push(`Dauer ca. ${durationMin} Min`);
  }
  return parts.join(" · ");
}

function decodeSlotId(value: string): SlotPayload | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    if (typeof window !== "undefined" && typeof window.atob === "function") {
      return JSON.parse(window.atob(padded)) as SlotPayload;
    }
    return null;
  } catch {
    return null;
  }
}
