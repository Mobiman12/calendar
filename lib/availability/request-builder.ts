import type {
  Prisma,
  Staff as PrismaStaff,
  Resource as PrismaResource,
  TimeOff as PrismaTimeOff,
  AvailabilityException as PrismaAvailabilityException,
} from "@prisma/client";
import type {
  AppointmentBlock,
  AvailabilityException,
  AvailabilityRequest,
  Resource,
  Schedule,
  ServiceDefinition,
  ServiceStepDefinition,
  ServiceStepResourceRequirement,
  StaffMember,
  TimeOff,
} from "./types";

type ServiceWithSteps = Prisma.ServiceGetPayload<{
  include: {
    steps: {
      include: {
        resources: {
          include: {
            resource: true;
          };
        };
      };
      orderBy: { order: "asc" };
    };
  };
}>;

type ScheduleWithRules = Prisma.ScheduleGetPayload<{
  include: { rules: true };
}>;

type AppointmentItemWithRelations = Prisma.AppointmentItemGetPayload<{
  include: {
    appointment: {
      select: {
        id: true;
        locationId: true;
      };
    };
  };
}>;

type DurationOverrideMap = Map<string, number> | Record<string, number>;

function toLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface BuildAvailabilityParams {
  locationId: string;
  window: { from: Date; to: Date };
  services: ServiceWithSteps[];
  staff: PrismaStaff[];
  resources: PrismaResource[];
  schedules: ScheduleWithRules[];
  timeOffs: PrismaTimeOff[];
  availabilityExceptions: PrismaAvailabilityException[];
  appointmentItems: AppointmentItemWithRelations[];
  staffId?: string;
  slotGranularityMinutes?: number;
  durationOverrides?: DurationOverrideMap;
}

export function buildAvailabilityRequest(params: BuildAvailabilityParams): AvailabilityRequest {
  const {
    locationId,
    window,
    services,
    staff,
    resources,
    schedules,
    timeOffs,
    availabilityExceptions,
    appointmentItems,
    staffId,
    slotGranularityMinutes,
    durationOverrides,
  } = params;

  const serviceDefinitions = services.map((service) => mapService(service, durationOverrides));
  const staffMembers: StaffMember[] = staff.map((s) => ({
    id: s.id,
    locationId: s.locationId,
  }));

  const resourceDefinitions: Resource[] = [...resources]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((resource) => ({
      id: resource.id,
      locationId: resource.locationId,
      type: resource.type,
      capacity: resource.capacity ?? 1,
    }));

  const scheduleDefinitions: Schedule[] = schedules.map((schedule) => ({
    id: schedule.id,
    ownerType: schedule.ownerType,
    ownerId:
      schedule.ownerType === "LOCATION"
        ? schedule.locationId
        : schedule.ownerType === "STAFF"
          ? schedule.staffId ?? null
          : schedule.resourceId ?? null,
    timezone: schedule.timezone,
    rules: schedule.rules.map((rule) => ({
      id: rule.id,
      type: rule.ruleType,
      weekday: rule.weekday ?? undefined,
      date: rule.ruleType === "DATE" && rule.effectiveFrom ? toLocalIsoDate(rule.effectiveFrom) : undefined,
      startMinute: rule.startsAt,
      endMinute: rule.endsAt,
      isActive: rule.isActive ?? true,
      effectiveFrom: rule.effectiveFrom ?? undefined,
      effectiveTo: rule.effectiveTo ?? undefined,
    })),
  }));

  const timeOffBlocks: TimeOff[] = timeOffs.map((entry) => ({
    id: entry.id,
    locationId: entry.locationId,
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
    staffId: entry.staffId,
  }));

  const exceptionBlocks: AvailabilityException[] = availabilityExceptions.map((entry) => ({
    id: entry.id,
    locationId: entry.locationId,
    startsAt: entry.startsAt,
    endsAt: entry.endsAt,
    type: entry.type,
    staffId: entry.staffId,
    resourceId: entry.resourceId,
  }));

  const appointmentBlocks = buildAppointmentBlocks(appointmentItems);

  return {
    locationId,
    window,
    services: serviceDefinitions,
    staff: staffMembers,
    resources: resourceDefinitions,
    schedules: scheduleDefinitions,
    timeOffs: timeOffBlocks,
    availabilityExceptions: exceptionBlocks,
    appointments: appointmentBlocks,
    staffId,
    slotGranularityMinutes,
  };
}

function mapService(service: ServiceWithSteps, durationOverrides?: DurationOverrideMap): ServiceDefinition {
  const extraMinutes = readDurationOverride(durationOverrides, service.id);
  const steps =
    service.steps.length > 0
      ? service.steps.map(mapServiceStep)
      : [
          {
            id: `${service.id}-fallback-step`,
            name: service.name,
            duration: Math.max(service.duration, 1),
            requiresStaff: true,
          },
        ];

  const adjustedSteps = extraMinutes > 0 ? applyDurationOverride(steps, extraMinutes) : steps;

  return {
    id: service.id,
    locationId: service.locationId,
    bufferBefore: service.bufferBefore ?? undefined,
    bufferAfter: service.bufferAfter ?? undefined,
    steps: adjustedSteps,
  };
}

function mapServiceStep(step: ServiceWithSteps["steps"][number]): ServiceStepDefinition {
  const requiresStaff = step.minStaff > 0;
  const resourceRequirements = (step.resources ?? [])
    .slice()
    .sort((a, b) => {
      const left = a.resourceId ?? a.resource?.id ?? "";
      const right = b.resourceId ?? b.resource?.id ?? "";
      return left.localeCompare(right);
    })
    .map(mapStepResource)
    .filter((entry): entry is ServiceStepResourceRequirement => Boolean(entry));
  return {
    id: step.id,
    name: step.name,
    duration: step.duration,
    requiresStaff,
    resources: resourceRequirements && resourceRequirements.length ? resourceRequirements : undefined,
  };
}

function readDurationOverride(overrides: DurationOverrideMap | undefined, serviceId: string): number {
  if (!overrides) return 0;
  const raw = overrides instanceof Map ? overrides.get(serviceId) : overrides[serviceId];
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function applyDurationOverride(steps: ServiceStepDefinition[], extraMinutes: number): ServiceStepDefinition[] {
  if (!steps.length || extraMinutes <= 0) return steps;
  const targetIndex = findLastStaffStepIndex(steps);
  if (targetIndex < 0) return steps;
  const target = steps[targetIndex];
  const updated = steps.slice();
  updated[targetIndex] = { ...target, duration: Math.max(1, target.duration + extraMinutes) };
  return updated;
}

function findLastStaffStepIndex(steps: ServiceStepDefinition[]): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].requiresStaff !== false) {
      return i;
    }
  }
  return steps.length - 1;
}

function mapStepResource(
  link: ServiceWithSteps["steps"][number]["resources"][number],
): ServiceStepResourceRequirement | null {
  if (!link) return null;
  return {
    resourceIds: link.resourceId ? [link.resourceId] : undefined,
    resourceType: link.resource?.type,
    quantity: link.quantity ?? undefined,
  };
}

function buildAppointmentBlocks(items: AppointmentItemWithRelations[]): AppointmentBlock[] {
  const blocks: AppointmentBlock[] = [];
  for (const item of items) {
    blocks.push({
      id: item.id,
      locationId: item.appointment.locationId,
      staffId: item.staffId ?? undefined,
      resourceIds: item.resourceId ? [item.resourceId] : undefined,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
    });
  }
  return blocks;
}
