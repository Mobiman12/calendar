import { addMinutes, eachDayOfInterval, startOfDay, subMilliseconds } from "date-fns";
import type { AvailabilityWindow, Schedule, ScheduleOwnerType, ScheduleRule, ScheduleRuleType, Weekday } from "./types";

export interface Interval {
  start: number;
  end: number;
}

export const MINUTE_IN_MS = 60 * 1000;

const WEEKDAY_TO_INDEX: Record<Weekday, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export function toInterval(start: Date, end: Date): Interval {
  return { start: start.getTime(), end: end.getTime() };
}

export function compareIntervals(a: Interval, b: Interval): number {
  if (a.start === b.start) {
    return a.end - b.end;
  }
  return a.start - b.start;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort(compareIntervals);
  const result: Interval[] = [];
  let current = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      result.push(current);
      current = { ...next };
    }
  }
  result.push(current);
  return result;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  if (!a.length || !b.length) return [];
  const result: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (start < end) {
      result.push({ start, end });
    }
    if (a[i].end < b[j].end) {
      i++;
    } else {
      j++;
    }
  }
  return result;
}

export function subtractIntervals(source: Interval[], subtract: Interval[]): Interval[] {
  if (!source.length || !subtract.length) return [...source];
  const result: Interval[] = [];
  let subtractIndex = 0;
  for (const interval of source) {
    let currentStart = interval.start;
    while (subtractIndex < subtract.length && subtract[subtractIndex].end <= currentStart) {
      subtractIndex++;
    }
    let cursor = subtractIndex;
    let activeStart = currentStart;
    while (cursor < subtract.length && subtract[cursor].start < interval.end) {
      const block = subtract[cursor];
      if (block.start > activeStart) {
        result.push({ start: activeStart, end: Math.min(block.start, interval.end) });
      }
      activeStart = Math.max(activeStart, block.end);
      if (activeStart >= interval.end) break;
      cursor++;
    }
    if (activeStart < interval.end) {
      result.push({ start: activeStart, end: interval.end });
    }
  }
  return result;
}

export function clampIntervals(intervals: Interval[], window: AvailabilityWindow): Interval[] {
  const start = window.from.getTime();
  const end = window.to.getTime();
  const clamped: Interval[] = [];
  for (const interval of intervals) {
    const s = Math.max(interval.start, start);
    const e = Math.min(interval.end, end);
    if (s < e) {
      clamped.push({ start: s, end: e });
    }
  }
  return clamped;
}

export function isRangeWithin(intervals: Interval[], start: number, end: number): boolean {
  if (!intervals.length) return false;
  for (const interval of intervals) {
    if (start >= interval.start && end <= interval.end) {
      return true;
    }
  }
  return false;
}

function isRuleActive(rule: ScheduleRule, reference: AvailabilityWindow): boolean {
  if (rule.isActive === false) return false;
  if (rule.effectiveFrom && rule.effectiveFrom > reference.to) return false;
  if (rule.effectiveTo && rule.effectiveTo < reference.from) return false;
  return true;
}

function rulesToIntervals(rule: ScheduleRule, day: Date, window: AvailabilityWindow): Interval[] {
  const intervals: Interval[] = [];
  if (rule.type === "WEEKLY" && rule.weekday !== undefined) {
    const weekdayIndex = WEEKDAY_TO_INDEX[rule.weekday];
    if (day.getDay() !== weekdayIndex) {
      return intervals;
    }
  } else if (rule.type === "DATE" && rule.date) {
    const dayIso = toLocalIsoDate(day);
    if (dayIso !== rule.date) {
      return intervals;
    }
  } else {
    // Unsupported rule type combinations
    return intervals;
  }

  const dayStart = startOfDay(day);
  const intervalStart = addMinutes(dayStart, rule.startMinute);
  const intervalEnd = addMinutes(dayStart, rule.endMinute);
  intervals.push(toInterval(intervalStart, intervalEnd));
  return clampIntervals(intervals, window);
}

function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildScheduleIntervals(
  schedules: Schedule[],
  ownerType: ScheduleOwnerType,
  ownerId: string | null,
  window: AvailabilityWindow,
): Interval[] {
  if (window.to <= window.from) {
    return [];
  }
  const ownerSchedules = schedules.filter((schedule) => schedule.ownerType === ownerType && schedule.ownerId === ownerId);
  if (!ownerSchedules.length) {
    return [];
  }

  const windowStartDay = startOfDay(window.from);
  const lastMoment = subMilliseconds(window.to, 1);
  const windowEndDay = startOfDay(lastMoment);
  const days = eachDayOfInterval({ start: windowStartDay, end: windowEndDay });

  const intervals: Interval[] = [];
  for (const schedule of ownerSchedules) {
    for (const rule of schedule.rules) {
      if (!isRuleActive(rule, window)) continue;
      for (const day of days) {
        intervals.push(...rulesToIntervals(rule, day, window));
      }
    }
  }

  return mergeIntervals(intervals);
}

export function alignToGrid(time: number, origin: number, step: number): number {
  if (step <= 0) return time;
  const delta = time - origin;
  const remainder = delta % step;
  if (remainder === 0) return time;
  return time + (step - remainder);
}
