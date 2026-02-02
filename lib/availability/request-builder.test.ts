import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type {
  AppointmentItemStatus,
  Prisma,
  ResourceType,
  ScheduleOwnerType,
  ScheduleRuleType,
  ServiceStatus,
  StaffStatus,
} from "@prisma/client";

import { buildAvailabilityRequest } from "./request-builder";

const window = {
  from: new Date("2025-04-01T08:00:00.000Z"),
  to: new Date("2025-04-01T12:00:00.000Z"),
};

function buildService(): Prisma.ServiceGetPayload<{
  include: {
    steps: {
      include: {
        resources: {
          include: {
            resource: true;
          };
        };
      };
    };
  };
}> {
  return {
    id: "svc-1",
    locationId: "loc-1",
    name: "Sample Service",
    slug: "sample-service",
    categoryId: null,
    description: null,
    color: null,
    duration: 60,
    bufferBefore: 5,
    bufferAfter: 10,
    basePrice: new Decimal("50.00"),
    priceCurrency: "EUR",
    depositType: "NONE",
    depositAmount: null,
    status: "ACTIVE" as ServiceStatus,
    maxParticipants: 1,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    steps: [
      {
        id: "step-1",
        serviceId: "svc-1",
        name: "Cut",
        description: null,
        order: 1,
        duration: 30,
        minStaff: 1,
        maxStaff: 1,
        requiresExclusiveResource: false,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        resources: [
          {
            id: "step-resource-1",
            serviceStepId: "step-1",
            resourceId: "res-chair-1",
            quantity: 1,
            resource: {
              id: "res-chair-1",
              locationId: "loc-1",
              name: "Chair 1",
              code: "CHAIR-1",
              type: "CHAIR" as ResourceType,
              capacity: 1,
              color: "#000",
              isActive: true,
              metadata: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        ],
      },
      {
        id: "step-2",
        serviceId: "svc-1",
        name: "Process",
        description: null,
        order: 2,
        duration: 20,
        minStaff: 0,
        maxStaff: 1,
        requiresExclusiveResource: false,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        resources: [],
      },
    ],
  };
}

describe("buildAvailabilityRequest", () => {
  it("maps Prisma payloads to availability request", () => {
    const availability = buildAvailabilityRequest({
      locationId: "loc-1",
      window,
      services: [buildService()],
      staff: [
        {
          id: "staff-1",
          locationId: "loc-1",
          userId: null,
          code: "EMP-1",
          firstName: "Lina",
          lastName: "Schmidt",
          displayName: "Lina",
          email: null,
          phone: null,
          color: null,
          status: "ACTIVE" as StaffStatus,
          bio: null,
          bookingPin: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          calendarOrder: 0,
        },
      ],
      resources: [
        {
          id: "res-chair-1",
          locationId: "loc-1",
          name: "Chair 1",
          code: "CHAIR-1",
          type: "CHAIR" as ResourceType,
          capacity: 1,
          color: null,
          isActive: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      schedules: [
        {
          id: "schedule-loc",
          locationId: "loc-1",
          ownerType: "LOCATION" as ScheduleOwnerType,
          staffId: null,
          resourceId: null,
          name: "Location hours",
          timezone: "UTC",
          isDefault: true,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          rules: [
            {
              id: "rule-weekly",
              scheduleId: "schedule-loc",
              ruleType: "WEEKLY" as ScheduleRuleType,
              weekday: "TUESDAY",
              startsAt: 8 * 60,
              endsAt: 18 * 60,
              serviceId: null,
              staffId: null,
              priority: 0,
              effectiveFrom: null,
              effectiveTo: null,
              isActive: true,
              metadata: null,
            },
          ],
        },
      ],
      timeOffs: [],
      availabilityExceptions: [],
      appointmentItems: [
        {
          id: "item-1",
          appointmentId: "apt-1",
          appointment: {
            id: "apt-1",
            locationId: "loc-1",
          },
          serviceId: "svc-1",
          serviceStepId: null,
          customerId: null,
          staffId: "staff-1",
          resourceId: "res-chair-1",
          status: "SCHEDULED" as AppointmentItemStatus,
          startsAt: new Date("2025-04-01T09:00:00Z"),
          endsAt: new Date("2025-04-01T09:45:00Z"),
          price: new Decimal("80.00"),
          currency: "EUR",
          notes: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      staffId: "staff-1",
      slotGranularityMinutes: 10,
    });

    expect(availability.locationId).toBe("loc-1");
    expect(availability.services[0].steps).toHaveLength(2);
    expect(availability.services[0].steps[0].requiresStaff).toBe(true);
    expect(availability.services[0].steps[1].requiresStaff).toBe(false);
    expect(availability.services[0].steps[0].resources?.[0]?.resourceIds).toEqual(["res-chair-1"]);
    expect(availability.staff).toHaveLength(1);
    expect(availability.resources[0].type).toBe("CHAIR");
    expect(availability.schedules).toHaveLength(1);
    expect(availability.appointments[0].resourceIds).toEqual(["res-chair-1"]);
    expect(availability.staffId).toBe("staff-1");
  });
});
