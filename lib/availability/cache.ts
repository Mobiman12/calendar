import type { AvailabilitySlot } from "./types";
import { getRedisClient } from "../redis";

const CACHE_PREFIX = "availability:v1";
const DEFAULT_TTL_SECONDS = 0;
const TTL_FROM_ENV = Number.parseInt(process.env.AVAILABILITY_CACHE_TTL_SECONDS ?? "", 10);
const EFFECTIVE_TTL_SECONDS = Number.isFinite(TTL_FROM_ENV) ? TTL_FROM_ENV : DEFAULT_TTL_SECONDS;
const CACHE_ENABLED = EFFECTIVE_TTL_SECONDS > 0;

export function makeAvailabilityCacheKey(params: {
  locationId: string;
  windowFrom: string;
  windowTo: string;
  serviceIds: string[];
  staffId?: string;
  deviceId?: string;
  mode?: string;
  slotGranularityMinutes?: number;
  smartSlotsKey?: string;
  colorPrecheck?: string;
}): string {
  const services = [...params.serviceIds].sort().join(",");
  const staff = params.staffId ?? "-";
  const device = params.deviceId ?? "-";
  const mode = params.mode ?? "-";
  const colorPrecheck = params.colorPrecheck ?? "-";
  const granularity =
    typeof params.slotGranularityMinutes === "number" && params.slotGranularityMinutes > 0
      ? String(params.slotGranularityMinutes)
      : "-";
  const smartKey = params.smartSlotsKey ?? "-";
  return `${CACHE_PREFIX}:${params.locationId}:${params.windowFrom}:${params.windowTo}:${mode}:${services}:${staff}:${granularity}:${smartKey}:${device}:${colorPrecheck}`;
}

export async function readAvailabilityCache(key: string): Promise<AvailabilitySlot[] | null> {
  if (!CACHE_ENABLED) return null;
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const raw = await redis.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SerializableSlot[];
    return parsed.map(deserializeSlot);
  } catch (error) {
    return null;
  }
}

export async function writeAvailabilityCache(key: string, slots: AvailabilitySlot[], ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!CACHE_ENABLED) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const ttl = ttlSeconds > 0 ? ttlSeconds : EFFECTIVE_TTL_SECONDS;
    if (ttl <= 0) return;
    await redis.set(key, JSON.stringify(slots.map(serializeSlot)), "EX", ttl);
  } catch (error) {
    // Fail silently; availability should not depend on cache.
  }
}

type SerializableSlot = Omit<AvailabilitySlot, "start" | "end" | "reservedFrom" | "reservedTo" | "services"> & {
  start: string;
  end: string;
  reservedFrom: string;
  reservedTo: string;
  services: Array<{
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  }>;
};

function serializeSlot(slot: AvailabilitySlot): SerializableSlot {
  return {
    ...slot,
    start: slot.start.toISOString(),
    end: slot.end.toISOString(),
    reservedFrom: slot.reservedFrom.toISOString(),
    reservedTo: slot.reservedTo.toISOString(),
    services: slot.services.map((service) => ({
      serviceId: service.serviceId,
      steps: service.steps.map((step) => ({
        ...step,
        start: step.start.toISOString(),
        end: step.end.toISOString(),
      })),
    })),
  };
}

function deserializeSlot(slot: SerializableSlot): AvailabilitySlot {
  return {
    ...slot,
    start: new Date(slot.start),
    end: new Date(slot.end),
    reservedFrom: new Date(slot.reservedFrom),
    reservedTo: new Date(slot.reservedTo),
    services: slot.services.map((service) => ({
      serviceId: service.serviceId,
      steps: service.steps.map((step) => ({
        ...step,
        start: new Date(step.start),
        end: new Date(step.end),
      })),
    })),
  };
}
