import { describe, expect, it } from "vitest";

import { makeAvailabilityCacheKey } from "./cache";

describe("availability cache", () => {
  it("creates deterministic cache keys regardless of service order", () => {
    const paramsA = {
      locationId: "loc-1",
      windowFrom: "2025-04-01T08:00:00.000Z",
      windowTo: "2025-04-01T12:00:00.000Z",
      serviceIds: ["svc-a", "svc-b", "svc-c"],
      staffId: "staff-1",
    };

    const paramsB = {
      ...paramsA,
      serviceIds: ["svc-c", "svc-b", "svc-a"],
    };

    const keyA = makeAvailabilityCacheKey(paramsA);
    const keyB = makeAvailabilityCacheKey(paramsB);

    expect(keyA).toBe(keyB);
  });

  it("differentiates staff scoped requests from all-staff requests", () => {
    const base = {
      locationId: "loc-1",
      windowFrom: "2025-04-01T08:00:00.000Z",
      windowTo: "2025-04-01T12:00:00.000Z",
      serviceIds: ["svc-a"],
    };

    const allStaffKey = makeAvailabilityCacheKey(base);
    const scopedKey = makeAvailabilityCacheKey({ ...base, staffId: "staff-1" });

    expect(allStaffKey).not.toBe(scopedKey);
  });

  it("differentiates shiftplan mode from opening-hours mode", () => {
    const base = {
      locationId: "loc-1",
      windowFrom: "2025-04-01T08:00:00.000Z",
      windowTo: "2025-04-01T12:00:00.000Z",
      serviceIds: ["svc-a"],
      staffId: "staff-1",
    };

    const openingHoursKey = makeAvailabilityCacheKey({ ...base, mode: "opening-hours" });
    const shiftPlanKey = makeAvailabilityCacheKey({ ...base, mode: "shiftplan" });

    expect(openingHoursKey).not.toBe(shiftPlanKey);
  });

  it("differentiates color precheck payloads", () => {
    const base = {
      locationId: "loc-1",
      windowFrom: "2025-04-01T08:00:00.000Z",
      windowTo: "2025-04-01T12:00:00.000Z",
      serviceIds: ["svc-a"],
    };

    const keyA = makeAvailabilityCacheKey({
      ...base,
      colorPrecheck: "{\"hairLength\":\"short\"}",
    });
    const keyB = makeAvailabilityCacheKey({
      ...base,
      colorPrecheck: "{\"hairLength\":\"long\"}",
    });

    expect(keyA).not.toBe(keyB);
  });
});
