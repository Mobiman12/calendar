import type { AvailabilityRequest, AvailabilitySlot } from "./types";
import {
  Interval,
  MINUTE_IN_MS,
  buildScheduleIntervals,
  clampIntervals,
  intersectIntervals,
  mergeIntervals,
  subtractIntervals,
} from "./intervals";

export type SmartSlotConfig = {
  stepUiMin: number;
  stepEngineMin: number;
  bufferMin: number;
  minGapMin: number;
  maxSmartSlotsPerHour: number;
  minWasteReductionMin: number;
  maxOffGridOffsetMin: number;
  timeZone: string;
};

type SlotScore = {
  slot: AvailabilitySlot;
  wasteBeforeMin: number;
  wasteAfterMin: number;
  wasteTotalMin: number;
  badFragments: number;
  distancePenaltyMin: number;
  hourKey: string;
  blockKey: string;
  blockLengthMin: number;
};

type ComputeSmartSlotsParams = {
  availabilityRequest: AvailabilityRequest;
  uiSlots: AvailabilitySlot[];
  engineSlots: AvailabilitySlot[];
  config: SmartSlotConfig;
};

export function computeSmartSlots(params: ComputeSmartSlotsParams): AvailabilitySlot[] {
  const { availabilityRequest, uiSlots, engineSlots, config } = params;
  if (!config.maxSmartSlotsPerHour || config.stepEngineMin >= config.stepUiMin) {
    return [];
  }

  const staffAvailability = buildStaffAvailabilityMap(availabilityRequest);
  if (!staffAvailability.size) return [];

  const originMs = availabilityRequest.window.from.getTime();
  const stepUiMs = config.stepUiMin * MINUTE_IN_MS;
  const maxOffsetMs = config.maxOffGridOffsetMin * MINUTE_IN_MS;
  const hourFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });

  const uiScoresByBlock = new Map<string, SlotScore[]>();
  for (const slot of uiSlots) {
    const score = scoreSlot({
      slot,
      staffAvailability,
      originMs,
      stepUiMs,
      maxOffsetMs,
      minGapMin: config.minGapMin,
      bufferMin: config.bufferMin,
      hourFormatter,
      isUiSlot: true,
    });
    if (!score) continue;
    const list = uiScoresByBlock.get(score.blockKey) ?? [];
    list.push(score);
    uiScoresByBlock.set(score.blockKey, list);
  }

  const uiSlotKeys = new Set(uiSlots.map((slot) => slot.slotKey));
  const candidateScoresByBlock = new Map<string, SlotScore[]>();
  for (const slot of engineSlots) {
    if (uiSlotKeys.has(slot.slotKey)) continue;
    const score = scoreSlot({
      slot,
      staffAvailability,
      originMs,
      stepUiMs,
      maxOffsetMs,
      minGapMin: config.minGapMin,
      bufferMin: config.bufferMin,
      hourFormatter,
      isUiSlot: false,
    });
    if (!score) continue;
    if (score.distancePenaltyMin <= 0) continue;
    const list = candidateScoresByBlock.get(score.blockKey) ?? [];
    list.push(score);
    candidateScoresByBlock.set(score.blockKey, list);
  }

  const selected = new Map<string, AvailabilitySlot>();
  const selectedByHour = new Map<string, number>();
  for (const [blockKey, candidates] of candidateScoresByBlock) {
    if (!candidates.length) continue;
    const uiScores = uiScoresByBlock.get(blockKey) ?? [];
    const sortedCandidates = [...candidates].sort(compareScores);
    const blockLengthMin = sortedCandidates[0]?.blockLengthMin ?? 0;
    const baseline = uiScores.length
      ? pickBest(uiScores)
      : ({
          wasteTotalMin: blockLengthMin,
          badFragments: blockLengthMin > 0 && blockLengthMin < config.minGapMin ? 1 : 0,
        } as Pick<SlotScore, "wasteTotalMin" | "badFragments">);

    for (const candidate of sortedCandidates) {
      const currentHourCount = selectedByHour.get(candidate.hourKey) ?? 0;
      if (currentHourCount >= config.maxSmartSlotsPerHour) continue;
      const wasteReduction = baseline.wasteTotalMin - candidate.wasteTotalMin;
      const fragmentsReduced = candidate.badFragments < baseline.badFragments;
      if (wasteReduction >= config.minWasteReductionMin || fragmentsReduced) {
        selected.set(candidate.slot.slotKey, { ...candidate.slot, isSmart: true });
        selectedByHour.set(candidate.hourKey, currentHourCount + 1);
      }
    }
  }

  return Array.from(selected.values());
}

function compareScores(a: SlotScore, b: SlotScore): number {
  if (a.badFragments !== b.badFragments) {
    return a.badFragments - b.badFragments;
  }
  if (a.wasteTotalMin !== b.wasteTotalMin) {
    return a.wasteTotalMin - b.wasteTotalMin;
  }
  return a.distancePenaltyMin - b.distancePenaltyMin;
}

function pickBest(scores: SlotScore[]): SlotScore {
  return scores.reduce((best, current) => (compareScores(current, best) < 0 ? current : best), scores[0]);
}

function scoreSlot(params: {
  slot: AvailabilitySlot;
  staffAvailability: Map<string, Interval[]>;
  originMs: number;
  stepUiMs: number;
  maxOffsetMs: number;
  minGapMin: number;
  bufferMin: number;
  hourFormatter: Intl.DateTimeFormat;
  isUiSlot: boolean;
}): SlotScore | null {
  const { slot, staffAvailability, originMs, stepUiMs, maxOffsetMs, minGapMin, bufferMin, hourFormatter, isUiSlot } =
    params;
  const intervals = staffAvailability.get(slot.staffId);
  if (!intervals?.length) return null;

  const reservedStart = slot.reservedFrom?.getTime?.() ?? slot.start.getTime();
  const reservedEnd = slot.reservedTo?.getTime?.() ?? slot.end.getTime();
  const bufferMs = Math.max(0, bufferMin) * MINUTE_IN_MS;
  const effectiveEnd = reservedEnd + bufferMs;

  const interval = intervals.find((entry) => reservedStart >= entry.start && effectiveEnd <= entry.end);
  if (!interval) return null;

  const wasteBeforeMin = Math.max(0, Math.round((reservedStart - interval.start) / MINUTE_IN_MS));
  const wasteAfterMin = Math.max(0, Math.round((interval.end - effectiveEnd) / MINUTE_IN_MS));
  const badFragments =
    (wasteBeforeMin > 0 && wasteBeforeMin < minGapMin ? 1 : 0) +
    (wasteAfterMin > 0 && wasteAfterMin < minGapMin ? 1 : 0);

  let distancePenaltyMin = 0;
  if (!isUiSlot) {
    const delta = slot.start.getTime() - originMs;
    const offset = ((delta % stepUiMs) + stepUiMs) % stepUiMs;
    const distanceMs = Math.min(offset, stepUiMs - offset);
    if (distanceMs === 0 || distanceMs > maxOffsetMs) {
      return null;
    }
    distancePenaltyMin = Math.round(distanceMs / MINUTE_IN_MS);
  }

  return {
    slot,
    wasteBeforeMin,
    wasteAfterMin,
    wasteTotalMin: wasteBeforeMin + wasteAfterMin,
    badFragments,
    distancePenaltyMin,
    hourKey: toHourKey(slot.start, hourFormatter),
    blockKey: `${slot.staffId}:${interval.start}:${interval.end}`,
    blockLengthMin: Math.max(0, Math.round((interval.end - interval.start) / MINUTE_IN_MS)),
  };
}

function toHourKey(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(date);
  const lookup = new Map(parts.map((part) => [part.type, part.value]));
  const year = lookup.get("year") ?? "0000";
  const month = lookup.get("month") ?? "00";
  const day = lookup.get("day") ?? "00";
  const hour = lookup.get("hour") ?? "00";
  return `${year}-${month}-${day}T${hour}`;
}

function buildStaffAvailabilityMap(request: AvailabilityRequest): Map<string, Interval[]> {
  const locationIntervals = computeLocationAvailability(request);
  if (!locationIntervals.length) return new Map();

  const staffBusy = buildStaffBusyIndex(request);
  const staffAvailabilities = new Map<string, Interval[]>();
  for (const staff of request.staff) {
    const staffSchedule = buildScheduleIntervals(request.schedules, "STAFF", staff.id, request.window);
    const base = staffSchedule.length
      ? mergeIntervals(intersectIntervals(locationIntervals, staffSchedule))
      : [...locationIntervals];
    const busy = staffBusy.get(staff.id) ?? [];
    const intervals = clampIntervals(mergeIntervals(subtractIntervals(base, busy)), request.window);
    if (intervals.length) {
      staffAvailabilities.set(staff.id, intervals);
    }
  }
  return staffAvailabilities;
}

function computeLocationAvailability(request: AvailabilityRequest): Interval[] {
  const scheduleIntervals = buildScheduleIntervals(request.schedules, "LOCATION", request.locationId, request.window);
  if (!scheduleIntervals.length) return [];
  const locationBlocks: Interval[] = [];
  for (const exception of request.availabilityExceptions) {
    if (exception.locationId !== request.locationId) continue;
    if (exception.staffId || exception.resourceId) continue;
    if (exception.type === "BLOCK") {
      locationBlocks.push({
        start: exception.startsAt.getTime(),
        end: exception.endsAt.getTime(),
      });
    }
  }
  const reduced = locationBlocks.length ? subtractIntervals(scheduleIntervals, mergeIntervals(locationBlocks)) : scheduleIntervals;
  return clampIntervals(mergeIntervals(reduced), request.window);
}

function buildStaffBusyIndex(request: AvailabilityRequest): Map<string, Interval[]> {
  const staffBusy = new Map<string, Interval[]>();

  for (const timeOff of request.timeOffs) {
    if (!timeOff.staffId) continue;
    const interval = { start: timeOff.startsAt.getTime(), end: timeOff.endsAt.getTime() };
    const list = staffBusy.get(timeOff.staffId) ?? [];
    list.push(interval);
    staffBusy.set(timeOff.staffId, list);
  }

  for (const exception of request.availabilityExceptions) {
    if (exception.type !== "BLOCK" || !exception.staffId) continue;
    const interval = { start: exception.startsAt.getTime(), end: exception.endsAt.getTime() };
    const list = staffBusy.get(exception.staffId) ?? [];
    list.push(interval);
    staffBusy.set(exception.staffId, list);
  }

  for (const appointment of request.appointments) {
    if (!appointment.staffId) continue;
    const interval = { start: appointment.startsAt.getTime(), end: appointment.endsAt.getTime() };
    const list = staffBusy.get(appointment.staffId) ?? [];
    list.push(interval);
    staffBusy.set(appointment.staffId, list);
  }

  for (const [staffId, intervals] of staffBusy.entries()) {
    staffBusy.set(staffId, mergeIntervals(intervals));
  }

  return staffBusy;
}
