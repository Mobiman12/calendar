import { describe, expect, it } from "vitest";

import { createIcsEvent } from "./ics";

describe("createIcsEvent", () => {
  it("generates a basic ICS event with escaped fields", () => {
    const startsAt = new Date("2025-05-05T09:00:00.000Z");
    const endsAt = new Date("2025-05-05T10:00:00.000Z");

    const ics = createIcsEvent({
      summary: "Haarschnitt, Waschen & Styling",
      description: "Anmerkungen: Bitte auf Allergien achten\nWeitere Infos folgen.",
      location: "Salon Müller, Musterstraße 1, München",
      startsAt,
      endsAt,
      attendees: [
        { name: "Max Mustermann", email: "max@example.com" },
        { name: "Salon Müller", email: "info@salon.example", role: "REQ-PARTICIPANT" },
      ],
      remindersMinutesBefore: [60],
    });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("SUMMARY:Haarschnitt\\, Waschen & Styling");
    expect(ics).toContain("DESCRIPTION:Anmerkungen: Bitte auf Allergien achten\\nWeitere Infos folgen.");
    expect(ics).toContain("LOCATION:Salon Müller\\, Musterstraße 1\\, München");
    expect(ics).toContain("ATTENDEE;CN=Max Mustermann;ROLE=REQ-PARTICIPANT:mailto:max@example.com");
    expect(ics).toContain("TRIGGER:-PT60M");
    expect(ics).toContain("DTSTART:20250505T090000Z");
    expect(ics).toContain("DTEND:20250505T100000Z");
  });
});
