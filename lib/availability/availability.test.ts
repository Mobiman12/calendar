import { describe, expect, it } from "vitest";
import {
  findAvailability,
  type AvailabilityRequest,
  type Resource,
  type Schedule,
  type ServiceDefinition,
  type ServiceStepDefinition,
  type StaffMember,
} from "./index";

process.env.TZ = "UTC";

const LOCATION_ID = "loc-1";
const STAFF_LINA = "staff-lina";
const STAFF_MARCO = "staff-marco";
const RESOURCE_CHAIR_1 = "chair-1";
const RESOURCE_CHAIR_2 = "chair-2";
const RESOURCE_BASIN_1 = "basin-1";

const windowStart = new Date("2025-03-03T08:00:00.000Z"); // Monday
const windowEnd = new Date("2025-03-03T18:00:00.000Z");

function date(iso: string): Date {
  return new Date(iso);
}

const MINUTE = 60 * 1000;
const minutes = (value: number) => value * MINUTE;

function buildLocationSchedule(): Schedule {
  return {
    id: "schedule-location",
    ownerType: "LOCATION",
    ownerId: LOCATION_ID,
    timezone: "UTC",
    rules: [
      {
        id: "loc-mon",
        type: "WEEKLY",
        weekday: "MONDAY",
        startMinute: 8 * 60,
        endMinute: 18 * 60,
      },
    ],
  };
}

function buildStaffSchedule(staffId: string): Schedule {
  return {
    id: `schedule-${staffId}`,
    ownerType: "STAFF",
    ownerId: staffId,
    timezone: "UTC",
    rules: [
      {
        id: `rule-${staffId}-mon`,
        type: "WEEKLY",
        weekday: "MONDAY",
        startMinute: 9 * 60,
        endMinute: 17 * 60,
      },
    ],
  };
}

function buildResourceSchedule(resourceId: string): Schedule {
  return {
    id: `schedule-${resourceId}`,
    ownerType: "RESOURCE",
    ownerId: resourceId,
    timezone: "UTC",
    rules: [
      {
        id: `rule-${resourceId}-mon`,
        type: "WEEKLY",
        weekday: "MONDAY",
        startMinute: 8 * 60,
        endMinute: 18 * 60,
      },
    ],
  };
}

function buildStaffMembers(): StaffMember[] {
  return [
    { id: STAFF_LINA, locationId: LOCATION_ID },
    { id: STAFF_MARCO, locationId: LOCATION_ID },
  ];
}

function buildResources(): Resource[] {
  return [
    { id: RESOURCE_CHAIR_1, locationId: LOCATION_ID, type: "CHAIR", capacity: 1 },
    { id: RESOURCE_CHAIR_2, locationId: LOCATION_ID, type: "CHAIR", capacity: 1 },
    { id: RESOURCE_BASIN_1, locationId: LOCATION_ID, type: "BASIN", capacity: 1 },
  ];
}

function createBaseRequest(): AvailabilityRequest {
  const staff = buildStaffMembers();
  const resources = buildResources();
  const schedules: Schedule[] = [buildLocationSchedule(), ...staff.map((s) => buildStaffSchedule(s.id)), ...resources.map((r) => buildResourceSchedule(r.id))];
  return {
    locationId: LOCATION_ID,
    window: {
      from: new Date(windowStart),
      to: new Date(windowEnd),
    },
    services: [],
    staff,
    resources,
    schedules,
    timeOffs: [],
    availabilityExceptions: [],
    appointments: [],
    slotGranularityMinutes: 5,
  };
}

function createService(id: string, options: Partial<ServiceDefinition> & { steps: ServiceStepDefinition[] }): ServiceDefinition {
  return {
    id,
    locationId: LOCATION_ID,
    bufferBefore: 0,
    bufferAfter: 0,
    ...options,
  };
}

describe("Availability engine", () => {
  it("returns basic availability slots for a simple service", () => {
    const request = createBaseRequest();
    request.services = [
      createService("svc-haircut", {
        steps: [
          {
            id: "step-consult",
            name: "Consultation",
            duration: 15,
            resources: [{ resourceIds: [RESOURCE_CHAIR_1, RESOURCE_CHAIR_2] }],
          },
          {
            id: "step-cut",
            name: "Cut & Finish",
            duration: 30,
            resources: [{ resourceIds: [RESOURCE_CHAIR_1, RESOURCE_CHAIR_2] }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);

    expect(slots.length).toBeGreaterThan(0);
    const firstSlot = slots[0];
    expect(firstSlot.staffId).toBe(STAFF_LINA);
    expect(firstSlot.start.toISOString()).toBe("2025-03-03T09:00:00.000Z");
    expect(firstSlot.end.getTime() - firstSlot.start.getTime()).toBe(minutes(45));
    expect(firstSlot.services[0].steps).toHaveLength(2);
  });

  it("respects buffer before and after", () => {
    const request = createBaseRequest();
    request.services = [
      createService("svc-color", {
        bufferBefore: 15,
        bufferAfter: 10,
        steps: [
          {
            id: "step-coloring",
            name: "Color Application",
            duration: 45,
            resources: [{ resourceType: "CHAIR" }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);

    const firstSlot = slots[0];
    expect(firstSlot.start.toISOString()).toBe("2025-03-03T09:15:00.000Z");
    expect(firstSlot.reservedFrom.toISOString()).toBe("2025-03-03T09:00:00.000Z");
    expect(firstSlot.reservedTo.toISOString()).toBe("2025-03-03T10:10:00.000Z");
  });

  it("allows processing steps without staff presence", () => {
    const request = createBaseRequest();
    request.staffId = STAFF_LINA;
    request.appointments = [
      {
        id: "apt-staff-busy",
        locationId: LOCATION_ID,
        staffId: STAFF_LINA,
        startsAt: date("2025-03-03T09:10:00.000Z"),
        endsAt: date("2025-03-03T09:35:00.000Z"),
      },
    ];
    request.services = [
      createService("svc-color-processing", {
        steps: [
          {
            id: "step-apply",
            name: "Apply",
            duration: 10,
            resources: [{ resourceType: "CHAIR" }],
          },
          {
            id: "step-process",
            name: "Process",
            duration: 20,
            requiresStaff: false,
            resources: [{ resourceType: "CHAIR" }],
          },
          {
            id: "step-finish",
            name: "Finish",
            duration: 15,
            resources: [{ resourceType: "CHAIR" }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    const firstSlot = slots[0];
    expect(firstSlot.start.toISOString()).toBe("2025-03-03T09:35:00.000Z");
    expect(firstSlot.services[0].steps).toHaveLength(3);
  });

  it("excludes slots overlapping staff time off", () => {
    const request = createBaseRequest();
    request.staffId = STAFF_LINA;
    request.timeOffs = [
      {
        id: "timeoff-1",
        locationId: LOCATION_ID,
        staffId: STAFF_LINA,
        startsAt: date("2025-03-03T10:00:00.000Z"),
        endsAt: date("2025-03-03T11:00:00.000Z"),
      },
    ];
    request.services = [
      createService("svc-haircut", {
        steps: [
          {
            id: "step-cut",
            name: "Cut",
            duration: 45,
            resources: [{ resourceIds: [RESOURCE_CHAIR_1] }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((slot) => slot.start.toISOString() === "2025-03-03T10:00:00.000Z")).toBe(false);
    expect(slots[0].start.toISOString()).toBe("2025-03-03T09:00:00.000Z");
  });

  it("combines multiple services sequentially", () => {
    const request = createBaseRequest();
    request.services = [
      createService("svc-cut", {
        bufferAfter: 5,
        steps: [
          {
            id: "step-cutting",
            name: "Cutting",
            duration: 30,
            resources: [{ resourceType: "CHAIR" }],
          },
        ],
      }),
      createService("svc-finish", {
        bufferBefore: 5,
        steps: [
          {
            id: "step-style",
            name: "Styling",
            duration: 20,
            resources: [{ resourceType: "CHAIR" }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0];
    expect(slot.services).toHaveLength(2);
    expect(slot.services.flatMap((service) => service.steps).length).toBe(2);
    expect(slot.reservedTo.toISOString()).toBe("2025-03-03T09:55:00.000Z");
  });

  it("skips slots when required resources are already booked", () => {
    const request = createBaseRequest();
    request.appointments = [
      {
        id: "apt-chair-busy",
        locationId: LOCATION_ID,
        resourceIds: [RESOURCE_CHAIR_1],
        startsAt: date("2025-03-03T09:30:00.000Z"),
        endsAt: date("2025-03-03T10:30:00.000Z"),
      },
    ];
    request.services = [
      createService("svc-keratin", {
        steps: [
          {
            id: "step-keratin",
            name: "Keratin",
            duration: 60,
            resources: [{ resourceIds: [RESOURCE_CHAIR_1] }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].start.toISOString()).toBe("2025-03-03T10:30:00.000Z");
  });

  it("honours requested staff filters", () => {
    const request = createBaseRequest();
    request.staffId = STAFF_MARCO;
    request.services = [
      createService("svc-haircut", {
        steps: [
          {
            id: "step-cut",
            name: "Cut",
            duration: 30,
            resources: [{ resourceType: "CHAIR" }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    expect(new Set(slots.map((slot) => slot.staffId))).toEqual(new Set([STAFF_MARCO]));
  });

  it("supports steps that only require resources", () => {
    const request = createBaseRequest();
    request.services = [
      createService("svc-room-only", {
        steps: [
          {
            id: "step-room",
            name: "Room usage",
            duration: 30,
            requiresStaff: false,
            resources: [{ resourceIds: [RESOURCE_BASIN_1] }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].services[0].steps[0].resourceIds).toEqual([RESOURCE_BASIN_1]);
  });

  it("blocks slots inside location exceptions", () => {
    const request = createBaseRequest();
    request.availabilityExceptions = [
      {
        id: "exception-lunch",
        locationId: LOCATION_ID,
        type: "BLOCK",
        startsAt: date("2025-03-03T12:00:00.000Z"),
        endsAt: date("2025-03-03T13:00:00.000Z"),
      },
    ];
    request.services = [
      createService("svc-haircut", {
        steps: [
          {
            id: "step-cut",
            name: "Cut",
            duration: 45,
            resources: [{ resourceType: "CHAIR" }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.some((slot) => slot.start.toISOString() === "2025-03-03T12:00:00.000Z")).toBe(false);
  });

  it("chooses alternate resources when primary is busy", () => {
    const request = createBaseRequest();
    request.appointments = [
      {
        id: "apt-chair1",
        locationId: LOCATION_ID,
        resourceIds: [RESOURCE_CHAIR_1],
        startsAt: date("2025-03-03T09:00:00.000Z"),
        endsAt: date("2025-03-03T10:00:00.000Z"),
      },
    ];
    request.services = [
      createService("svc-haircut", {
        steps: [
          {
            id: "step-cut",
            name: "Cut",
            duration: 30,
            resources: [{ resourceIds: [RESOURCE_CHAIR_1, RESOURCE_CHAIR_2] }],
          },
        ],
      }),
    ];

    const slots = findAvailability(request);
    expect(slots.length).toBeGreaterThan(0);
    const firstSlot = slots[0];
    expect(firstSlot.start.toISOString()).toBe("2025-03-03T09:00:00.000Z");
    expect(firstSlot.services[0].steps[0].resourceIds).toEqual([RESOURCE_CHAIR_2]);
  });
});
