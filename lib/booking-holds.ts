import { randomUUID } from "crypto";

import { getRedisClient } from "./redis";
import { releaseLock } from "./redis-lock";
import type { AvailabilitySlot } from "./availability/types";

type SlotHold = {
  token: string;
  expiresAt: number;
};

export type SlotHoldMetadata = {
  slotKey: string;
  locationId: string;
  staffId: string;
  createdByStaffId?: string | null;
  createdByName?: string | null;
  start: string;
  end: string;
  reservedFrom: string;
  reservedTo: string;
  expiresAt: number;
  serviceNames?: string[];
};

export type HoldIdentity = {
  slotKey: string;
  token: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __calendarSlotHolds: Map<string, SlotHold> | undefined;
  // eslint-disable-next-line no-var
  var __calendarSlotHoldMetadata: Map<string, SlotHoldMetadata> | undefined;
}

const HOLD_PREFIX = "booking-hold";
const HOLD_META_PREFIX = "booking-hold-meta";

export function buildSlotHoldKey(slotKey: string): string {
  return `${HOLD_PREFIX}:${slotKey}`;
}

function buildSlotHoldMetaKey(slotKey: string): string {
  return `${HOLD_META_PREFIX}:${slotKey}`;
}

function getMemoryHoldMap(): Map<string, SlotHold> {
  if (!global.__calendarSlotHolds) {
    global.__calendarSlotHolds = new Map();
  }
  return global.__calendarSlotHolds;
}

function getMemoryHoldMetadataMap(): Map<string, SlotHoldMetadata> {
  if (!global.__calendarSlotHoldMetadata) {
    global.__calendarSlotHoldMetadata = new Map();
  }
  return global.__calendarSlotHoldMetadata;
}

function readMemoryHold(key: string, now: number): SlotHold | null {
  const map = getMemoryHoldMap();
  const existing = map.get(key);
  if (!existing) {
    return null;
  }
  if (existing.expiresAt <= now) {
    map.delete(key);
    return null;
  }
  return existing;
}

function readMemoryHoldMetadata(key: string, now: number): SlotHoldMetadata | null {
  const map = getMemoryHoldMetadataMap();
  const existing = map.get(key);
  if (!existing) {
    return null;
  }
  if (existing.expiresAt <= now) {
    map.delete(key);
    return null;
  }
  return existing;
}

export function encodeHoldId(identity: HoldIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

export function decodeHoldId(value: string): HoldIdentity | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as HoldIdentity;
    if (!parsed?.slotKey || !parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function acquireSlotHold(
  slotKey: string,
  ttlMs: number,
): Promise<{ token: string; expiresAt: number } | null> {
  const holdKey = buildSlotHoldKey(slotKey);
  const redis = getRedisClient();
  const token = randomUUID();
  const expiresAt = Date.now() + ttlMs;

  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const result = await redis.set(holdKey, token, "PX", ttlMs, "NX");
    if (result === "OK") {
      return { token, expiresAt };
    }
    return null;
  }

  const now = Date.now();
  const existing = readMemoryHold(holdKey, now);
  if (existing) {
    return null;
  }
  getMemoryHoldMap().set(holdKey, { token, expiresAt });
  return { token, expiresAt };
}

export async function releaseSlotHold(slotKey: string, token: string): Promise<boolean> {
  const holdKey = buildSlotHoldKey(slotKey);
  const redis = getRedisClient();

  if (redis) {
    const released = await releaseLock(holdKey, token, redis);
    if (released) {
      await removeSlotHoldMetadata(slotKey);
    }
    return released;
  }

  const map = getMemoryHoldMap();
  const existing = map.get(holdKey);
  if (!existing || existing.token !== token) {
    return false;
  }
  map.delete(holdKey);
  await removeSlotHoldMetadata(slotKey);
  return true;
}

export async function verifySlotHold(slotKey: string, token: string): Promise<boolean> {
  const holdKey = buildSlotHoldKey(slotKey);
  const redis = getRedisClient();
  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const stored = await redis.get(holdKey);
    return stored === token;
  }

  const now = Date.now();
  const existing = readMemoryHold(holdKey, now);
  return Boolean(existing && existing.token === token);
}

export async function storeSlotHoldMetadata(
  metadata: SlotHoldMetadata,
  ttlMs: number,
): Promise<void> {
  const metaKey = buildSlotHoldMetaKey(metadata.slotKey);
  const redis = getRedisClient();
  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    await redis.set(metaKey, JSON.stringify(metadata), "PX", Math.max(0, ttlMs));
    return;
  }
  getMemoryHoldMetadataMap().set(metaKey, metadata);
}

export async function removeSlotHoldMetadata(slotKey: string): Promise<void> {
  const metaKey = buildSlotHoldMetaKey(slotKey);
  const redis = getRedisClient();
  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    await redis.del(metaKey);
    return;
  }
  getMemoryHoldMetadataMap().delete(metaKey);
}

export async function listSlotHoldMetadata(locationId: string): Promise<SlotHoldMetadata[]> {
  const redis = getRedisClient();
  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const pattern = `${HOLD_META_PREFIX}:${locationId}|*`;
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");

    if (!keys.length) {
      return [];
    }
    const values = await redis.mget(...keys);
    const now = Date.now();
    return values
      .map((value) => {
        if (!value) return null;
        try {
          return JSON.parse(value) as SlotHoldMetadata;
        } catch {
          return null;
        }
      })
      .filter((meta): meta is SlotHoldMetadata => Boolean(meta && meta.expiresAt > now));
  }

  const now = Date.now();
  const entries: SlotHoldMetadata[] = [];
  for (const meta of getMemoryHoldMetadataMap().values()) {
    if (meta.expiresAt <= now) continue;
    if (meta.locationId !== locationId) continue;
    entries.push(meta);
  }
  return entries;
}

export async function listHeldSlotKeys(slotKeys: string[]): Promise<Set<string>> {
  if (!slotKeys.length) {
    return new Set();
  }

  const redis = getRedisClient();
  if (redis) {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    const holdKeys = slotKeys.map(buildSlotHoldKey);
    const results = await redis.mget(...holdKeys);
    const held = new Set<string>();
    results.forEach((value, index) => {
      if (value) {
        held.add(slotKeys[index]);
      }
    });
    return held;
  }

  const now = Date.now();
  const held = new Set<string>();
  slotKeys.forEach((slotKey) => {
    const holdKey = buildSlotHoldKey(slotKey);
    if (readMemoryHold(holdKey, now)) {
      held.add(slotKey);
    }
  });
  return held;
}

export async function filterHeldSlots(slots: AvailabilitySlot[]): Promise<AvailabilitySlot[]> {
  if (!slots.length) {
    return slots;
  }
  const slotKeys = slots.map((slot) => slot.slotKey);
  const heldKeys = await listHeldSlotKeys(slotKeys);
  const withoutExactHolds = heldKeys.size ? slots.filter((slot) => !heldKeys.has(slot.slotKey)) : slots;
  if (!withoutExactHolds.length) {
    return withoutExactHolds;
  }

  const locationIds = Array.from(
    new Set(withoutExactHolds.map((slot) => slot.locationId).filter((value): value is string => Boolean(value))),
  );
  if (!locationIds.length) {
    return withoutExactHolds;
  }

  const holdLists = await Promise.all(locationIds.map(async (locationId) => listSlotHoldMetadata(locationId)));
  const holds = holdLists.flat();
  if (!holds.length) {
    return withoutExactHolds;
  }

  const holdsByStaff = new Map<string, SlotHoldMetadata[]>();
  for (const hold of holds) {
    const list = holdsByStaff.get(hold.staffId) ?? [];
    list.push(hold);
    holdsByStaff.set(hold.staffId, list);
  }

  return withoutExactHolds.filter((slot) => {
    const staffHolds = holdsByStaff.get(slot.staffId);
    if (!staffHolds?.length) return true;
    const slotStart = slot.reservedFrom?.getTime?.() ?? slot.start?.getTime?.() ?? NaN;
    const slotEnd = slot.reservedTo?.getTime?.() ?? slot.end?.getTime?.() ?? NaN;
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) return true;
    return !staffHolds.some((hold) => {
      if (hold.locationId !== slot.locationId) return false;
      const holdStart = Date.parse(hold.reservedFrom);
      const holdEnd = Date.parse(hold.reservedTo);
      if (!Number.isFinite(holdStart) || !Number.isFinite(holdEnd)) return false;
      return holdStart < slotEnd && holdEnd > slotStart;
    });
  });
}
