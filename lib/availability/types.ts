export type ScheduleOwnerType = "LOCATION" | "STAFF" | "RESOURCE";

export type ScheduleRuleType = "WEEKLY" | "DATE";

export type Weekday =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";

export type AvailabilityExceptionType = "BLOCK" | "OPEN";

export interface AvailabilityWindow {
  from: Date;
  to: Date;
}

export interface ServiceStepResourceRequirement {
  /**
   * Specific resource ids that can fulfil the requirement.
   */
  resourceIds?: string[];
  /**
   * Resource type fallback when ids are not provided.
   */
  resourceType?: string;
  /**
   * Number of resources required (defaults to 1).
   */
  quantity?: number;
  /**
   * Whether the requirement can be skipped if no resource is available.
   */
  optional?: boolean;
}

export interface ServiceStepDefinition {
  id: string;
  name: string;
  duration: number; // minutes
  /**
   * When false, the step does not require staff presence (e.g. processing time).
   */
  requiresStaff?: boolean;
  /**
   * Optional restriction to a subset of staff members.
   */
  allowedStaffIds?: string[];
  /**
   * Resource requirements for the step.
   */
  resources?: ServiceStepResourceRequirement[];
}

export interface ServiceDefinition {
  id: string;
  locationId: string;
  bufferBefore?: number; // minutes
  bufferAfter?: number; // minutes
  steps: ServiceStepDefinition[];
}

export interface StaffMember {
  id: string;
  locationId: string;
}

export interface Resource {
  id: string;
  locationId: string;
  type: string;
  capacity: number;
}

export interface ScheduleRule {
  id: string;
  type: ScheduleRuleType;
  weekday?: Weekday;
  date?: string; // ISO string (YYYY-MM-DD) when type === DATE
  startMinute: number;
  endMinute: number;
  isActive?: boolean;
  effectiveFrom?: Date;
  effectiveTo?: Date;
}

export interface Schedule {
  id: string;
  ownerType: ScheduleOwnerType;
  ownerId: string | null;
  timezone: string;
  rules: ScheduleRule[];
}

export interface TimeOff {
  id: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  staffId?: string | null;
  resourceId?: string | null;
}

export interface AvailabilityException {
  id: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  type: AvailabilityExceptionType;
  staffId?: string | null;
  resourceId?: string | null;
}

export interface AppointmentBlock {
  id: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  staffId?: string | null;
  resourceIds?: string[];
}

export interface AvailabilityRequest {
  locationId: string;
  window: AvailabilityWindow;
  services: ServiceDefinition[];
  staff: StaffMember[];
  resources: Resource[];
  schedules: Schedule[];
  timeOffs: TimeOff[];
  availabilityExceptions: AvailabilityException[];
  appointments: AppointmentBlock[];
  staffId?: string;
  slotGranularityMinutes?: number;
}

export interface SlotStepAllocation {
  stepId: string;
  start: Date;
  end: Date;
  requiresStaff: boolean;
  resourceIds: string[];
}

export interface SlotServiceAllocation {
  serviceId: string;
  steps: SlotStepAllocation[];
}

export interface AvailabilitySlot {
  slotKey: string;
  locationId: string;
  staffId: string;
  services: SlotServiceAllocation[];
  isSmart?: boolean;
  /**
   * First step start (excludes pre-buffer)
   */
  start: Date;
  /**
   * Last step end (excludes trailing buffer)
   */
  end: Date;
  /**
   * Full reserved window including buffers.
   */
  reservedFrom: Date;
  reservedTo: Date;
}
