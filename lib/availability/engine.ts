import { createHash } from "crypto";
import {
  AvailabilityRequest,
  AvailabilitySlot,
  Resource,
  ServiceDefinition,
  ServiceStepDefinition,
  ServiceStepResourceRequirement,
  SlotServiceAllocation,
  SlotStepAllocation,
  StaffMember,
} from "./types";
import {
  Interval,
  MINUTE_IN_MS,
  alignToGrid,
  buildScheduleIntervals,
  clampIntervals,
  intersectIntervals,
  isRangeWithin,
  mergeIntervals,
  subtractIntervals,
} from "./intervals";

type OwnerAvailabilityContext = {
  locationIntervals: Interval[];
  staffAvailabilities: Map<string, Interval[]>;
  resourceAvailabilities: Map<string, ResourceAvailability>;
};

type ResourceAvailability = {
  resource: Resource;
  intervals: Interval[];
};

type AppointmentIndex = {
  staff: Map<string, Interval[]>;
  resource: Map<string, Interval[]>;
};

type BusyIndex = {
  location: Interval[];
  staff: Map<string, Interval[]>;
  resource: Map<string, Interval[]>;
};

type ServicePlanStep = {
  serviceId: string;
  step: ServiceStepDefinition;
  durationMs: number;
};

type ServicePlan = {
  services: ServiceDefinition[];
  steps: ServicePlanStep[];
  stepsByService: Map<string, ServicePlanStep[]>;
  firstBufferBeforeMs: number;
  bufferAfterByService: number[];
  totalStepsDurationMs: number;
  totalBufferAfterMs: number;
};

const DEFAULT_SLOT_GRANULARITY_MINUTES = 5;

export function findAvailability(request: AvailabilityRequest): AvailabilitySlot[] {
  if (request.window.to <= request.window.from) return [];
  if (!request.services.length) return [];

  const plan = buildServicePlan(request.services);
  if (!plan.steps.length) return [];

  const slotStep = Math.max(request.slotGranularityMinutes ?? DEFAULT_SLOT_GRANULARITY_MINUTES, 1) * MINUTE_IN_MS;
  const context = buildAvailabilityContext(request);

  if (!context.locationIntervals.length) {
    return [];
  }

  const staffCandidates = resolveStaffCandidates(request);
  if (!staffCandidates.length) return [];

  const origin = request.window.from.getTime();
  const maxStart = request.window.to.getTime() - (plan.totalStepsDurationMs + plan.totalBufferAfterMs);

  const slots: AvailabilitySlot[] = [];

  for (const staff of staffCandidates) {
    const staffIntervals = context.staffAvailabilities.get(staff.id);
    if (!staffIntervals || !staffIntervals.length) continue;

    for (const interval of staffIntervals) {
      if (interval.start > maxStart) continue;
      const intervalStart = Math.max(interval.start, request.window.from.getTime());
      let candidateStart = alignToGrid(intervalStart, origin, slotStep);
      while (candidateStart < interval.end && candidateStart <= maxStart) {
        const slot = evaluateCandidate({
          request,
          staff,
          plan,
          candidateStart,
          context,
        });
        if (slot) {
          slots.push(slot);
        }
        candidateStart += slotStep;
      }
    }
  }

  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return slots;
}

function resolveStaffCandidates(request: AvailabilityRequest): StaffMember[] {
  if (request.staffId) {
    return request.staff.filter((staff) => staff.id === request.staffId);
  }
  return [...request.staff];
}

function buildServicePlan(services: ServiceDefinition[]): ServicePlan {
  const steps: ServicePlanStep[] = [];
  let totalStepsDurationMs = 0;
  const bufferAfterByService: number[] = [];

  for (const service of services) {
    for (const step of service.steps) {
      const durationMs = step.duration * MINUTE_IN_MS;
      totalStepsDurationMs += durationMs;
      steps.push({
        serviceId: service.id,
        step,
        durationMs,
      });
    }
    bufferAfterByService.push((service.bufferAfter ?? 0) * MINUTE_IN_MS);
  }

  const stepsByService = new Map<string, ServicePlanStep[]>();
  for (const step of steps) {
    const list = stepsByService.get(step.serviceId) ?? [];
    list.push(step);
    stepsByService.set(step.serviceId, list);
  }

  return {
    services,
    steps,
    stepsByService,
    firstBufferBeforeMs: (services[0]?.bufferBefore ?? 0) * MINUTE_IN_MS,
    bufferAfterByService,
    totalStepsDurationMs,
    totalBufferAfterMs: bufferAfterByService.reduce((sum, value) => sum + value, 0),
  };
}

function buildAvailabilityContext(request: AvailabilityRequest): OwnerAvailabilityContext {
  const baseLocationIntervals = computeLocationAvailability(request);
  const busyIndex = buildBusyIndex(request);
  const locationIntervals = clampIntervals(
    mergeIntervals(subtractIntervals(baseLocationIntervals, busyIndex.location)),
    request.window,
  );

  const staffAvailabilities = new Map<string, Interval[]>();
  for (const staff of request.staff) {
    const intervals = computeStaffAvailability(request, staff, locationIntervals, busyIndex);
    if (intervals.length) {
      staffAvailabilities.set(staff.id, intervals);
    }
  }

  const resourceAvailabilities = new Map<string, ResourceAvailability>();
  for (const resource of request.resources) {
    const intervals = computeResourceAvailability(request, resource, locationIntervals, busyIndex);
    if (intervals.length) {
      resourceAvailabilities.set(resource.id, { resource, intervals });
    }
  }

  return {
    locationIntervals,
    staffAvailabilities,
    resourceAvailabilities,
  };
}

function computeLocationAvailability(request: AvailabilityRequest): Interval[] {
  const scheduleIntervals = buildScheduleIntervals(request.schedules, "LOCATION", request.locationId, request.window);
  if (!scheduleIntervals.length) return [];
  return clampIntervals(scheduleIntervals, request.window);
}

function buildBusyIndex(request: AvailabilityRequest): BusyIndex {
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

  const staffBusy = new Map<string, Interval[]>();
  const resourceBusy = new Map<string, Interval[]>();

  for (const timeOff of request.timeOffs) {
    const interval = { start: timeOff.startsAt.getTime(), end: timeOff.endsAt.getTime() };
    if (timeOff.staffId) {
      const list = staffBusy.get(timeOff.staffId) ?? [];
      list.push(interval);
      staffBusy.set(timeOff.staffId, list);
    }
    if (timeOff.resourceId) {
      const list = resourceBusy.get(timeOff.resourceId) ?? [];
      list.push(interval);
      resourceBusy.set(timeOff.resourceId, list);
    }
  }

  for (const exception of request.availabilityExceptions) {
    if (exception.type !== "BLOCK") continue;
    const interval = { start: exception.startsAt.getTime(), end: exception.endsAt.getTime() };
    if (exception.staffId) {
      const list = staffBusy.get(exception.staffId) ?? [];
      list.push(interval);
      staffBusy.set(exception.staffId, list);
    }
    if (exception.resourceId) {
      const list = resourceBusy.get(exception.resourceId) ?? [];
      list.push(interval);
      resourceBusy.set(exception.resourceId, list);
    }
  }

  const appointmentIndex = indexAppointments(request);
  for (const [staffId, intervals] of appointmentIndex.staff.entries()) {
    const list = staffBusy.get(staffId) ?? [];
    list.push(...intervals);
    staffBusy.set(staffId, list);
  }
  for (const [resourceId, intervals] of appointmentIndex.resource.entries()) {
    const list = resourceBusy.get(resourceId) ?? [];
    list.push(...intervals);
    resourceBusy.set(resourceId, list);
  }

  for (const [staffId, intervals] of staffBusy.entries()) {
    staffBusy.set(staffId, mergeIntervals(intervals));
  }
  for (const [resourceId, intervals] of resourceBusy.entries()) {
    resourceBusy.set(resourceId, mergeIntervals(intervals));
  }

  return {
    location: mergeIntervals(locationBlocks),
    staff: staffBusy,
    resource: resourceBusy,
  };
}

function indexAppointments(request: AvailabilityRequest): AppointmentIndex {
  const staff = new Map<string, Interval[]>();
  const resource = new Map<string, Interval[]>();

  for (const appointment of request.appointments) {
    const interval = { start: appointment.startsAt.getTime(), end: appointment.endsAt.getTime() };
    if (appointment.staffId) {
      const list = staff.get(appointment.staffId) ?? [];
      list.push(interval);
      staff.set(appointment.staffId, list);
    }
    if (appointment.resourceIds) {
      for (const resourceId of appointment.resourceIds) {
        const list = resource.get(resourceId) ?? [];
        list.push(interval);
        resource.set(resourceId, list);
      }
    }
  }

  return { staff, resource };
}

function computeStaffAvailability(
  request: AvailabilityRequest,
  staff: StaffMember,
  locationIntervals: Interval[],
  busyIndex: BusyIndex,
): Interval[] {
  const staffSchedule = buildScheduleIntervals(request.schedules, "STAFF", staff.id, request.window);
  const base = staffSchedule.length
    ? mergeIntervals(intersectIntervals(locationIntervals, staffSchedule))
    : [...locationIntervals];
  const busy = busyIndex.staff.get(staff.id) ?? [];
  const intervals = clampIntervals(mergeIntervals(subtractIntervals(base, busy)), request.window);
  return intervals;
}

function computeResourceAvailability(
  request: AvailabilityRequest,
  resource: Resource,
  locationIntervals: Interval[],
  busyIndex: BusyIndex,
): Interval[] {
  const resourceSchedule = buildScheduleIntervals(request.schedules, "RESOURCE", resource.id, request.window);
  const base = resourceSchedule.length
    ? mergeIntervals(intersectIntervals(locationIntervals, resourceSchedule))
    : [...locationIntervals];
  const busy = busyIndex.resource.get(resource.id) ?? [];
  const intervals = clampIntervals(mergeIntervals(subtractIntervals(base, busy)), request.window);
  return intervals;
}

interface EvaluateContext {
  request: AvailabilityRequest;
  staff: StaffMember;
  plan: ServicePlan;
  candidateStart: number;
  context: OwnerAvailabilityContext;
}

function evaluateCandidate(params: EvaluateContext): AvailabilitySlot | null {
  const { request, staff, plan, candidateStart, context } = params;
  const staffIntervals = context.staffAvailabilities.get(staff.id);
  if (!staffIntervals) return null;

  const reservedStart = candidateStart - plan.firstBufferBeforeMs;
  if (reservedStart < request.window.from.getTime()) return null;

  const locationAllowed = isRangeWithin(context.locationIntervals, reservedStart, candidateStart);
  const staffAllowed = isRangeWithin(staffIntervals, reservedStart, candidateStart);
  if (!locationAllowed || !staffAllowed) return null;

  const servicesAllocations: SlotServiceAllocation[] = [];

  let pointer = candidateStart;
  let lastStepEnd = candidateStart;

  for (let i = 0; i < plan.services.length; i++) {
    const service = plan.services[i];
    const bufferBeforeMs = (service.bufferBefore ?? 0) * MINUTE_IN_MS;
    if (bufferBeforeMs > 0) {
      const bufferStart = pointer - bufferBeforeMs;
      if (bufferStart < reservedStart) return null;
      if (
        !isRangeWithin(context.locationIntervals, bufferStart, pointer) ||
        !isRangeWithin(staffIntervals, bufferStart, pointer)
      ) {
        return null;
      }
    }

    const stepAllocations: SlotStepAllocation[] = [];

    const serviceSteps = plan.stepsByService.get(service.id) ?? [];
    for (const planStep of serviceSteps) {
      const stepStart = pointer;
      const stepEnd = stepStart + planStep.durationMs;

      if (!isRangeWithin(context.locationIntervals, stepStart, stepEnd)) {
        return null;
      }

      if (planStep.step.requiresStaff !== false && !isRangeWithin(staffIntervals, stepStart, stepEnd)) {
        return null;
      }

      if (planStep.step.allowedStaffIds && !planStep.step.allowedStaffIds.includes(staff.id)) {
        return null;
      }

      const allocatedResourceIds: string[] = [];
      if (planStep.step.resources) {
        for (const requirement of planStep.step.resources) {
          const allocation = allocateResources(requirement, stepStart, stepEnd, context);
          if (!allocation) {
            if (requirement.optional) continue;
            return null;
          }
          allocatedResourceIds.push(...allocation);
        }
      }

      stepAllocations.push({
        stepId: planStep.step.id,
        start: new Date(stepStart),
        end: new Date(stepEnd),
        requiresStaff: planStep.step.requiresStaff !== false,
        resourceIds: allocatedResourceIds,
      });

      pointer = stepEnd;
      lastStepEnd = stepEnd;
    }

    const bufferAfterMs = plan.bufferAfterByService[i];
    if (bufferAfterMs > 0) {
      const bufferEnd = pointer + bufferAfterMs;
      if (
        !isRangeWithin(context.locationIntervals, pointer, bufferEnd) ||
        !isRangeWithin(staffIntervals, pointer, bufferEnd)
      ) {
        return null;
      }
      pointer = bufferEnd;
    }

    servicesAllocations.push({
      serviceId: service.id,
      steps: stepAllocations,
    });
  }

  const reservedEnd = pointer;
  if (reservedEnd > request.window.to.getTime()) return null;

  if (!isRangeWithin(context.locationIntervals, reservedStart, reservedEnd)) return null;
  if (!isRangeWithin(staffIntervals, reservedStart, reservedEnd)) return null;

  const slotKey = createSlotKey(request.locationId, staff.id, candidateStart, servicesAllocations);

  return {
    slotKey,
    locationId: request.locationId,
    staffId: staff.id,
    services: servicesAllocations,
    start: new Date(candidateStart),
    end: new Date(lastStepEnd),
    reservedFrom: new Date(reservedStart),
    reservedTo: new Date(reservedEnd),
  };
}

function createSlotKey(
  locationId: string,
  staffId: string,
  candidateStart: number,
  services: SlotServiceAllocation[],
): string {
  const hash = createHash("sha1");
  hash.update(locationId);
  hash.update(staffId);
  hash.update(String(candidateStart));
  hash.update(JSON.stringify(services));
  return `${locationId}|${staffId}|${new Date(candidateStart).toISOString()}|${hash.digest("base64url")}`;
}

function allocateResources(
  requirement: ServiceStepResourceRequirement,
  start: number,
  end: number,
  context: OwnerAvailabilityContext,
): string[] | null {
  const quantity = Math.max(requirement.quantity ?? 1, 1);
  const candidateIds = resolveResourceCandidates(requirement, context);
  if (!candidateIds.length) return requirement.optional ? [] : null;

  const allocated: string[] = [];
  for (const resourceId of candidateIds) {
    if (allocated.includes(resourceId)) continue;
    const availability = context.resourceAvailabilities.get(resourceId);
    if (!availability) continue;
    if (!isRangeWithin(availability.intervals, start, end)) continue;
    allocated.push(resourceId);
    if (allocated.length === quantity) break;
  }

  if (allocated.length < quantity) {
    return requirement.optional ? [] : null;
  }
  return allocated;
}

function resolveResourceCandidates(
  requirement: ServiceStepResourceRequirement,
  context: OwnerAvailabilityContext,
): string[] {
  if (requirement.resourceIds?.length) {
    return requirement.resourceIds.filter((id) => context.resourceAvailabilities.has(id));
  }

  if (requirement.resourceType) {
    const ids: string[] = [];
    for (const availability of context.resourceAvailabilities.values()) {
      if (availability.resource.type === requirement.resourceType) {
        ids.push(availability.resource.id);
      }
    }
    return ids;
  }

  return [];
}
