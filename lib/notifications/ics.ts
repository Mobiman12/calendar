import { v4 as uuid } from "uuid";

export interface IcsEventAttendee {
  name: string;
  email?: string;
  role?: "REQ-PARTICIPANT" | "OPT-PARTICIPANT";
}

export interface IcsEventOptions {
  uid?: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
  organizer?: IcsEventAttendee;
  attendees?: IcsEventAttendee[];
  url?: string;
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  remindersMinutesBefore?: number[];
}

export function createIcsEvent(options: IcsEventOptions): string {
  return createIcsCalendar([options]);
}

export function createIcsCalendar(events: IcsEventOptions[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Calendar App//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    lines.push(...buildEventLines(event));
  }

  lines.push("END:VCALENDAR");

  return lines.join("\r\n");
}

function buildEventLines(options: IcsEventOptions): string[] {
  const now = new Date();
  const uid = options.uid ?? uuid();

  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${escapeField(options.summary)}`,
    `DTSTAMP:${formatUtc(options.createdAt ?? now)}`,
    `DTSTART:${formatUtc(options.startsAt)}`,
    `DTEND:${formatUtc(options.endsAt)}`,
  ];

  if (options.updatedAt) {
    lines.push(`LAST-MODIFIED:${formatUtc(options.updatedAt)}`);
  }

  if (options.description) {
    lines.push(`DESCRIPTION:${escapeField(options.description)}`);
  }

  if (options.location) {
    lines.push(`LOCATION:${escapeField(options.location)}`);
  }

  if (options.status) {
    lines.push(`STATUS:${options.status}`);
  }

  if (options.url) {
    lines.push(`URL:${options.url}`);
  }

  if (options.organizer?.email) {
    lines.push(
      `ORGANIZER;CN=${escapeField(options.organizer.name)}:mailto:${escapeField(options.organizer.email)}`,
    );
  }

  if (options.attendees?.length) {
    for (const attendee of options.attendees) {
      if (!attendee.email) continue;
      const role = attendee.role ?? "REQ-PARTICIPANT";
      lines.push(
        `ATTENDEE;CN=${escapeField(attendee.name)};ROLE=${role}:mailto:${escapeField(attendee.email)}`,
      );
    }
  }

  if (options.remindersMinutesBefore?.length) {
    for (const minutes of options.remindersMinutesBefore) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push("DESCRIPTION:Appointment reminder");
      lines.push(`TRIGGER:-PT${minutes}M`);
      lines.push("END:VALARM");
    }
  }

  lines.push("END:VEVENT");

  return lines;
}

function escapeField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\n/g, "\\n");
}

function formatUtc(date: Date): string {
  const iso = date.toISOString(); // e.g., 2025-02-20T10:15:30.123Z
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
