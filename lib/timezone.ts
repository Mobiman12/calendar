const DEFAULT_LOCALE = "de-DE";

function getTimeZoneOffsetMinutes(date: Date, timeZone: string): number {
  if (!timeZone || typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    return -date.getTimezoneOffset();
  }

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).formatToParts(date);

    const tzName = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    const match = /GMT([+-])(\d{2})(?::?(\d{2}))?/.exec(tzName);
    if (match) {
      const sign = match[1] === "-" ? -1 : 1;
      const hours = Number.parseInt(match[2], 10);
      const minutes = match[3] ? Number.parseInt(match[3], 10) : 0;
      return sign * (hours * 60 + minutes);
    }
  } catch {
    // fall through to default behaviour
  }

  return -date.getTimezoneOffset();
}

function createDateInTimeZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let offset = getTimeZoneOffsetMinutes(new Date(utc), timeZone);
  let adjusted = utc - offset * 60 * 1000;

  const secondOffset = getTimeZoneOffsetMinutes(new Date(adjusted), timeZone);
  if (secondOffset !== offset) {
    adjusted = utc - secondOffset * 60 * 1000;
  }

  return new Date(adjusted);
}

export function combineDateWithMinutesInTimeZone(day: Date, minutesFromStart: number, timeZone: string): Date {
  if (!timeZone || typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") {
    const base = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    return new Date(base.getTime() + minutesFromStart * 60 * 1000);
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(day);

  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? `${day.getUTCFullYear()}`, 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? `${day.getUTCMonth() + 1}`, 10);
  const date = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? `${day.getUTCDate()}`, 10);

  const hours = Math.floor(minutesFromStart / 60);
  const minutes = minutesFromStart % 60;

  return createDateInTimeZone(year, month, date, hours, minutes, 0, timeZone);
}

export function formatInTimeZone(
  date: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  locale: string = DEFAULT_LOCALE,
): string {
  const tz = typeof timeZone === "string" && timeZone.length ? timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(locale, { timeZone: tz, ...options }).format(date);
}

export function formatDateTimeLocalInput(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function parseDateTimeLocalInput(value: string, timeZone: string): Date {
  const [datePart, timePart] = value.split("T");
  if (!datePart || !timePart) {
    return new Date(value);
  }
  const [yearStr, monthStr, dayStr] = datePart.split("-");
  const [hourStr, minuteStr] = timePart.split(":");

  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  const day = Number.parseInt(dayStr, 10);
  const hour = Number.parseInt(hourStr ?? "0", 10);
  const minute = Number.parseInt(minuteStr ?? "0", 10);

  return createDateInTimeZone(year, month, day, hour, minute, 0, timeZone);
}

export function formatDateWithPatternInTimeZone(date: Date, pattern: "date" | "time" | "datetime", timeZone: string) {
  switch (pattern) {
    case "date":
      return formatInTimeZone(date, timeZone, { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
    case "time":
      return formatInTimeZone(date, timeZone, { hour: "2-digit", minute: "2-digit", hour12: false });
    case "datetime":
    default:
      return formatInTimeZone(date, timeZone, {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
  }
}
