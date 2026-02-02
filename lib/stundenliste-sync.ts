import { Prisma, ScheduleOwnerType, ScheduleRuleType, StaffStatus, Weekday } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import {
  type StundenlisteBranchScheduleRule,
  type StundenlisteBranchSummary,
  type StundenlisteEmployeeSummary,
  StundenlisteClient,
  getStundenlisteClient,
} from "@/lib/stundenliste-client";
import { getNextCalendarOrder, supportsCalendarOrder } from "@/lib/staff-ordering";
import { slugify } from "@/lib/slugify";

const prisma = getPrismaClient();

const WEEKDAY_ORDER: Weekday[] = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];

type NormalizedScheduleEntry = {
  weekday: Weekday;
  startsAt: number | null;
  endsAt: number | null;
};

type BranchLocation = {
  branchId: number;
  id: string;
  slug: string;
};

type StaffCacheEntry = {
  id: string;
  locationId: string;
  calendarOrder: number | null;
  color: string | null;
  bookingPin: string | null;
  metadata: Prisma.JsonValue | null;
  memberships: Record<string, string | null>;
};

const SYNC_THROTTLE_MS = 5 * 1000;

type SyncCacheEntry = {
  timestamp: number;
  result: Record<string, string[]> | null;
  promise: Promise<Record<string, string[]> | null> | null;
};

type GlobalSyncCache = {
  staffSync?: Map<string, SyncCacheEntry>;
};

function getGlobalSyncCache(): GlobalSyncCache {
  const globalObject = globalThis as typeof globalThis & { __stundenlisteSyncCache__?: GlobalSyncCache };
  if (!globalObject.__stundenlisteSyncCache__) {
    globalObject.__stundenlisteSyncCache__ = {};
  }
  if (!globalObject.__stundenlisteSyncCache__.staffSync) {
    globalObject.__stundenlisteSyncCache__.staffSync = new Map();
  }
  return globalObject.__stundenlisteSyncCache__;
}

type HiddenStaffStore = {
  map: Map<string, Set<string>>;
};

const hiddenStaffStore: HiddenStaffStore = { map: new Map<string, Set<string>>() };

export function getHiddenStaffByLocation(): Map<string, Set<string>> {
  return hiddenStaffStore.map;
}

function setHiddenStaffByLocation(next: Map<string, Set<string>>) {
  hiddenStaffStore.map = next;
}

function mergeStaffVisibilityMetadata(
  metadata: Prisma.JsonValue | null,
  updates: Record<string, boolean>,
): Prisma.InputJsonValue {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const stundenlisteEntry =
    base.stundenliste && typeof base.stundenliste === "object" && !Array.isArray(base.stundenliste)
      ? { ...(base.stundenliste as Record<string, unknown>) }
      : {};
  const visibilityEntry =
    stundenlisteEntry.visibility && typeof stundenlisteEntry.visibility === "object" && !Array.isArray(stundenlisteEntry.visibility)
      ? { ...(stundenlisteEntry.visibility as Record<string, boolean>) }
      : {};
  for (const [locationId, visible] of Object.entries(updates)) {
    visibilityEntry[locationId] = visible;
  }
  stundenlisteEntry.visibility = visibilityEntry;
  base.stundenliste = stundenlisteEntry;
  return base as Prisma.InputJsonValue;
}

function toWeekday(value: string | undefined): Weekday | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  if ((Weekday as Record<string, Weekday | undefined>)[upper]) {
    return (Weekday as Record<string, Weekday>)[upper];
  }
  return null;
}

function normalizeMinutes(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  const coerced = Math.max(0, Math.min(24 * 60, Math.round(value)));
  return coerced;
}

function normalizeText(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseTimeString(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^([0-1]?\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return normalizeMinutes(hours * 60 + minutes);
}

function normalizeBranchSchedule(entries?: StundenlisteBranchScheduleRule[]): NormalizedScheduleEntry[] {
  const map = new Map<Weekday, NormalizedScheduleEntry>();
  if (entries) {
    for (const entry of entries) {
      const weekday = toWeekday(entry.weekday);
      if (!weekday) continue;
      const startsAt = normalizeMinutes(
        entry.startsAtMinutes ?? entry.startMinutes ?? parseTimeString(entry.start),
      );
      const endsAt = normalizeMinutes(entry.endsAtMinutes ?? entry.endMinutes ?? parseTimeString(entry.end));
      if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
        map.set(weekday, { weekday, startsAt: null, endsAt: null });
      } else {
        map.set(weekday, { weekday, startsAt, endsAt });
      }
    }
  }

  for (const weekday of WEEKDAY_ORDER) {
    if (!map.has(weekday)) {
      map.set(weekday, { weekday, startsAt: null, endsAt: null });
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday),
  );
}

function mergeLocationMetadata(
  current: Prisma.JsonValue | null,
  branch: StundenlisteBranchSummary,
): Prisma.InputJsonValue {
  let base: Record<string, unknown> = {};
  if (current && typeof current === "object" && !Array.isArray(current)) {
    base = { ...(current as Record<string, unknown>) };
  }
  const existing =
    base.stundenliste && typeof base.stundenliste === "object" && base.stundenliste !== null
      ? { ...(base.stundenliste as Record<string, unknown>) }
      : {};

  existing.branchId = branch.id;
  existing.slug = branch.slug ?? null;
  existing.updatedAt = branch.updatedAt ?? null;
  if ("removedAt" in existing) {
    delete existing.removedAt;
  }

  base.stundenliste = existing;
  return base as Prisma.InputJsonValue;
}

function markLocationRemovalFlag(metadata: Prisma.JsonValue | null, removed: boolean): Prisma.InputJsonValue {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const stundenlisteEntry =
    base.stundenliste && typeof base.stundenliste === "object" && base.stundenliste !== null
      ? { ...(base.stundenliste as Record<string, unknown>) }
      : {};
  if (removed) {
    stundenlisteEntry.removedAt = new Date().toISOString();
  } else if ("removedAt" in stundenlisteEntry) {
    delete stundenlisteEntry.removedAt;
  }
  base.stundenliste = stundenlisteEntry;
  return base as Prisma.InputJsonValue;
}

function isLocationMarkedAsRemoved(metadata: Prisma.JsonValue | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const stundenlisteEntry = (metadata as Record<string, unknown>).stundenliste;
  if (!stundenlisteEntry || typeof stundenlisteEntry !== "object" || Array.isArray(stundenlisteEntry)) {
    return false;
  }
  return Boolean((stundenlisteEntry as Record<string, unknown>).removedAt);
}

function hasCustomCompanyName(metadata: Prisma.JsonValue | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const profile = (metadata as Record<string, unknown>).companyProfile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return false;
  }
  const record = profile as Record<string, unknown>;
  const custom = Boolean(record.customName);
  if (!custom) {
    return false;
  }
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  return displayName.length > 0;
}

function hasCentralSchedule(metadata: Prisma.JsonValue | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  if (record.centralSchedule === true) {
    return true;
  }
  const central = record.central;
  if (central && typeof central === "object" && !Array.isArray(central)) {
    return (central as Record<string, unknown>).schedule === true;
  }
  return false;
}

async function upsertLocationSchedule(
  locationId: string,
  timezone: string,
  remoteSchedule?: StundenlisteBranchScheduleRule[],
): Promise<void> {
  if (!remoteSchedule) return;

  const normalized = normalizeBranchSchedule(remoteSchedule);

  let schedule = await prisma.schedule.findFirst({
    where: {
      locationId,
      ownerType: ScheduleOwnerType.LOCATION,
      isDefault: true,
    },
  });

  if (!schedule) {
    schedule = await prisma.schedule.create({
      data: {
        locationId,
        ownerType: ScheduleOwnerType.LOCATION,
        name: "Standard",
        timezone,
        isDefault: true,
      },
    });
  } else if (schedule.timezone !== timezone) {
    await prisma.schedule.update({
      where: { id: schedule.id },
      data: { timezone },
    });
  }

  const existingRules = await prisma.scheduleRule.findMany({
    where: { scheduleId: schedule.id },
  });
  const existingByWeekday = new Map<Weekday, typeof existingRules[number]>();
  for (const rule of existingRules) {
    if (rule.weekday !== null) {
      existingByWeekday.set(rule.weekday, rule);
    }
  }

  for (const entry of normalized) {
    const existing = existingByWeekday.get(entry.weekday);
    const isActive = entry.startsAt !== null && entry.endsAt !== null;
    if (existing) {
      const startsAt = isActive ? entry.startsAt ?? 0 : 0;
      const endsAt = isActive ? entry.endsAt ?? 0 : 0;
      await prisma.scheduleRule.update({
        where: { id: existing.id },
        data: {
          startsAt,
          endsAt,
          isActive,
        },
      });
    } else {
      await prisma.scheduleRule.create({
        data: {
          scheduleId: schedule.id,
          ruleType: ScheduleRuleType.WEEKLY,
          weekday: entry.weekday,
          startsAt: isActive ? entry.startsAt ?? 0 : 0,
          endsAt: isActive ? entry.endsAt ?? 0 : 0,
          isActive,
        },
      });
    }
  }
}

export function deriveNames(employee: StundenlisteEmployeeSummary) {
  const displayName = (employee.displayName || `${employee.firstName ?? ""} ${employee.lastName ?? ""}`)
    .replace(/\s+/g, " ")
    .trim();

  const [fallbackFirst = "Team", fallbackLast = "Mitglied", ...rest] = displayName.split(" ");
  const firstName = (employee.firstName ?? fallbackFirst).trim() || "Team";
  const lastName = (employee.lastName ?? [fallbackLast, ...rest].join(" ").trim()).trim() || "Mitglied";

  return {
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`.trim(),
  };
}

function sanitizeSlug(name: string, branchId: number): string {
  const base = slugify(name ?? "") || `filiale-${branchId}`;
  return base;
}

function ensureUniqueSlug(base: string, taken: Set<string>): string {
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

async function supportsBranchColumn(): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'Location'
          AND column_name = 'stundenlisteBranchId'
      ) AS "exists"
    `);
    return Boolean(result?.[0]?.exists);
  } catch (error) {
    console.warn("[stundenliste:sync] Spaltenerkennung für Filialen fehlgeschlagen.", error);
    return false;
  }
}

export async function syncStundenlisteBranches(
  tenantId: string,
  existingClient?: StundenlisteClient,
): Promise<Map<number, BranchLocation> | null> {
  let client = existingClient;
  if (!client) {
    try {
      client = getStundenlisteClient(tenantId);
    } catch (error) {
      console.warn("[stundenliste:sync] Kein Stundenliste-Client verfügbar.", error);
      return null;
    }
  }

  let branchColumnAvailable = await supportsBranchColumn();

  let branches: StundenlisteBranchSummary[] = [];
  try {
    branches = await client.listBranches();
  } catch (error) {
    console.warn("[stundenliste:sync] Filialen konnten nicht geladen werden.", error);
    return null;
  }

  type ExistingLocation = {
    id: string;
    slug: string;
    name: string | null;
    timezone: string;
    branchId: number | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    metadata: Prisma.JsonValue | null;
  };

  let existingLocations: ExistingLocation[] = [];
  if (branchColumnAvailable) {
    try {
      const withBranch = await prisma.location.findMany({
        where: { tenantId },
        select: {
          id: true,
          slug: true,
          name: true,
          timezone: true,
          addressLine1: true,
          addressLine2: true,
          postalCode: true,
          city: true,
          country: true,
          metadata: true,
          stundenlisteBranchId: true,
        },
      });
      existingLocations = withBranch.map((entry) => ({
        id: entry.id,
        slug: entry.slug,
        name: entry.name,
        timezone: entry.timezone,
        branchId: entry.stundenlisteBranchId ?? null,
        addressLine1: entry.addressLine1 ?? null,
        addressLine2: entry.addressLine2 ?? null,
        postalCode: entry.postalCode ?? null,
        city: entry.city ?? null,
        country: entry.country ?? null,
        metadata: entry.metadata ?? null,
      }));
    } catch (error) {
      branchColumnAvailable = false;
      console.warn(
        "[stundenliste:sync] Prisma-Client kennt Location.stundenlisteBranchId nicht. Fallback ohne Branch-Spalte.",
        error,
      );
    }
  }

  if (!branchColumnAvailable) {
    console.warn(
      "[stundenliste:sync] Location.stundenlisteBranchId fehlt (Migration 20251101120000_add_branch_memberships). Die Zuordnung erfolgt ohne Branch-Spalte.",
    );
    const withoutBranch = await prisma.location.findMany({
      where: { tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        timezone: true,
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        country: true,
        metadata: true,
      },
    });
    existingLocations = withoutBranch.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      timezone: entry.timezone,
      branchId: null,
      addressLine1: entry.addressLine1 ?? null,
      addressLine2: entry.addressLine2 ?? null,
      postalCode: entry.postalCode ?? null,
      city: entry.city ?? null,
      country: entry.country ?? null,
      metadata: entry.metadata ?? null,
    }));
  }

  const takenSlugs = new Set(existingLocations.map((entry) => entry.slug));
  const branchLocationMap = new Map<number, BranchLocation>();

  for (const branch of branches) {
    const remoteSlug = branch.slug ? slugify(branch.slug) : null;
    const slugBase = remoteSlug ?? sanitizeSlug(branch.name, branch.id);
    let location =
      existingLocations.find((entry) => entry.branchId === branch.id) ??
      existingLocations.find((entry) => entry.slug === slugBase && entry.branchId === null);

    if (!location) {
      const slug = ensureUniqueSlug(slugBase, takenSlugs);
      const branchTimezone = branch.timezone ?? "Europe/Berlin";
      const createData: Prisma.LocationCreateInput = {
        tenant: { connect: { id: tenantId } },
        slug,
        name: branch.name?.trim().length ? branch.name : `Filiale ${branch.id}`,
        timezone: branchTimezone,
        addressLine1: normalizeText(branch.addressLine1),
        addressLine2: normalizeText(branch.addressLine2),
        postalCode: normalizeText(branch.postalCode),
        city: normalizeText(branch.city),
        country: normalizeText(branch.country),
        ...(branchColumnAvailable ? { stundenlisteBranchId: branch.id } : {}),
      };
      if (branch.slug || branch.updatedAt) {
        createData.metadata = mergeLocationMetadata(null, branch);
      }
      const created = await prisma.location.create({
        data: createData,
        select: {
          id: true,
          slug: true,
          name: true,
          timezone: true,
          addressLine1: true,
          addressLine2: true,
          postalCode: true,
          city: true,
          country: true,
          metadata: true,
        },
      });
      const normalized: ExistingLocation = {
        id: created.id,
        slug: created.slug,
        name: created.name,
        timezone: created.timezone,
        branchId: branchColumnAvailable ? branch.id : null,
        addressLine1: created.addressLine1 ?? null,
        addressLine2: created.addressLine2 ?? null,
        postalCode: created.postalCode ?? null,
        city: created.city ?? null,
        country: created.country ?? null,
        metadata: created.metadata ?? null,
      };
      existingLocations.push(normalized);
      location = normalized;
    } else {
      const updates: Prisma.LocationUpdateInput = {};
      if (branchColumnAvailable && location.branchId !== branch.id) {
        updates.stundenlisteBranchId = branch.id;
      }
      const hasNameOverride = hasCustomCompanyName(location.metadata ?? null);
      if (!hasNameOverride && branch.name && branch.name !== location.name) {
        updates.name = branch.name;
      }
      if (branch.timezone && branch.timezone !== location.timezone) {
        updates.timezone = branch.timezone;
      }
      const addressLine1 = normalizeText(branch.addressLine1);
      if (addressLine1 !== location.addressLine1) {
        updates.addressLine1 = addressLine1;
      }
      const addressLine2 = normalizeText(branch.addressLine2);
      if (addressLine2 !== location.addressLine2) {
        updates.addressLine2 = addressLine2;
      }
      const postalCode = normalizeText(branch.postalCode);
      if (postalCode !== location.postalCode) {
        updates.postalCode = postalCode;
      }
      const city = normalizeText(branch.city);
      if (city !== location.city) {
        updates.city = city;
      }
      const country = normalizeText(branch.country);
      if (country !== location.country) {
        updates.country = country;
      }
      const needsMetadataUpdate = Boolean(branch.slug || branch.updatedAt) || isLocationMarkedAsRemoved(location.metadata ?? null);
      if (needsMetadataUpdate) {
        updates.metadata = mergeLocationMetadata(location.metadata ?? null, branch);
      }
      if (Object.keys(updates).length) {
        await prisma.location.update({
          where: { id: location.id },
          data: updates,
        });
        if (typeof updates.name === "string") {
          location.name = updates.name;
        }
        if (typeof updates.timezone === "string") {
          location.timezone = updates.timezone;
        }
        if ("addressLine1" in updates) {
          location.addressLine1 = (updates.addressLine1 as string | null) ?? null;
        }
        if ("addressLine2" in updates) {
          location.addressLine2 = (updates.addressLine2 as string | null) ?? null;
        }
        if ("postalCode" in updates) {
          location.postalCode = (updates.postalCode as string | null) ?? null;
        }
        if ("city" in updates) {
          location.city = (updates.city as string | null) ?? null;
        }
        if ("country" in updates) {
          location.country = (updates.country as string | null) ?? null;
        }
        if (branchColumnAvailable && typeof updates.stundenlisteBranchId === "number") {
          location.branchId = updates.stundenlisteBranchId ?? null;
        }
        if (updates.metadata !== undefined) {
          location.metadata = (updates.metadata ?? null) as Prisma.JsonValue | null;
        }
      }
    }

    const effectiveTimezone = branch.timezone ?? location.timezone ?? "Europe/Berlin";
    if (!hasCentralSchedule(location.metadata ?? null)) {
      await upsertLocationSchedule(location.id, effectiveTimezone, branch.schedule);
    }

    branchLocationMap.set(branch.id, {
      branchId: branch.id,
      id: location.id,
      slug: location.slug,
    });
  }

  if (branchColumnAvailable) {
    const remoteIds = new Set(branches.map((branch) => branch.id));
    const orphanedLocations = existingLocations.filter(
      (location) => location.branchId !== null && !remoteIds.has(location.branchId),
    );
    if (orphanedLocations.length) {
      await Promise.all(
        orphanedLocations.map((location) =>
          prisma.location.update({
            where: { id: location.id },
            data: { metadata: markLocationRemovalFlag(location.metadata ?? null, true) },
          }),
        ),
      );
    }
  }

  return branchLocationMap;
}

function mapStaffCache(
  existingStaff: Array<{
    id: string;
    code: string | null;
    locationId: string;
    calendarOrder: number | null;
    color: string | null;
    bookingPin: string | null;
    metadata: Prisma.JsonValue | null;
    memberships: Array<{ locationId: string; role: string | null }>;
  }>,
): Map<string, StaffCacheEntry> {
  const map = new Map<string, StaffCacheEntry>();
  for (const staff of existingStaff) {
    const membershipMap: Record<string, string | null> = {};
    for (const membership of staff.memberships) {
      membershipMap[membership.locationId] = membership.role ?? null;
    }

    const entry: StaffCacheEntry = {
      id: staff.id,
      locationId: staff.locationId,
      calendarOrder: staff.calendarOrder,
      color: staff.color,
      bookingPin: staff.bookingPin,
      metadata: staff.metadata ?? null,
      memberships: membershipMap,
    };

    const addKey = (key: string) => {
      const existing = map.get(key);
      if (!existing) {
        map.set(key, entry);
        return;
      }
      if (existing.id !== key && staff.id === key) {
        map.set(key, entry);
      }
    };

    if (staff.code) addKey(staff.code);
    addKey(staff.id);
  }
  return map;
}

function normalizeRoleValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function deriveStaffRole(employee: StundenlisteEmployeeSummary): string | null {
  const direct =
    normalizeRoleValue(employee.roleId) ??
    normalizeRoleValue(employee.role);
  if (direct) {
    return direct;
  }
  if (Array.isArray(employee.permissions)) {
    const adminPermission = employee.permissions.find((entry) => {
      if (entry === null || entry === undefined) return false;
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return String(entry).trim() === "2";
      }
      if (typeof entry === "string") {
        const normalized = entry.trim().toLowerCase();
        return normalized === "admin" || normalized === "administrator" || normalized === "2";
      }
      return false;
    });
    if (adminPermission !== undefined) {
      return "2";
    }
  }
  return null;
}

async function syncEmployeeRecords(
  tenantId: string,
  employees: StundenlisteEmployeeSummary[],
  branchLocations: Map<number, BranchLocation>,
): Promise<{ staffCodesByLocation: Map<string, string[]>; hiddenStaffByLocation: Map<string, Set<string>> }> {
  const staffCodesByLocation = new Map<string, string[]>();
  const hiddenStaffByLocation = new Map<string, Set<string>>();
  if (!employees.length) {
    return { staffCodesByLocation, hiddenStaffByLocation };
  }

  const remoteCodes = employees.map((employee) => String(employee.id));
  const personnelNumbers = Array.from(
    new Set(
      employees
        .map((employee) => normalizeText(employee.personnelNumber))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const existingStaff = await prisma.staff.findMany({
    where: {
      OR: [
        { code: { in: remoteCodes } },
        { id: { in: remoteCodes } },
        ...(personnelNumbers.length ? [{ id: { in: personnelNumbers } }] : []),
      ],
      location: { tenantId },
    },
    select: {
      id: true,
      code: true,
      locationId: true,
      calendarOrder: true,
      color: true,
      bookingPin: true,
      metadata: true,
      memberships: { select: { locationId: true, role: true } },
    },
  });
  const existingByCode = mapStaffCache(existingStaff);

  const calendarOrderSupported = await supportsCalendarOrder(prisma);
  const nextOrderCache = new Map<string, number>();

  const acquireNextOrder = async (locationId: string): Promise<number | null> => {
    if (!calendarOrderSupported) {
      return null;
    }
    if (!nextOrderCache.has(locationId)) {
      const nextValue = await getNextCalendarOrder(prisma, locationId);
      nextOrderCache.set(locationId, nextValue ?? 0);
    }
    const value = nextOrderCache.get(locationId)!;
    nextOrderCache.set(locationId, value + 1);
    return value;
  };

  for (const employee of employees) {
    const remoteCode = String(employee.id);
    const personnelNumber = normalizeText(employee.personnelNumber);
    const names = deriveNames(employee);
    const existingByRemote = existingByCode.get(remoteCode);
    const existing = existingByRemote ?? (personnelNumber ? existingByCode.get(personnelNumber) : undefined);
    const remoteRole = deriveStaffRole(employee);
    const globalVisibility = employee.showInCalendar !== false;
    const visibilityByLocation = new Map<string, boolean>();

    let locationIds = Array.from(
      new Set(
        (employee.branches ?? [])
          .map((branch) => {
            const location = branchLocations.get(branch.id);
            if (!location) return null;
            const visibleField =
              branch.visibleInCalendar ?? (branch as { showInCalendar?: boolean | null }).showInCalendar;
            const branchVisible = visibleField === false ? false : true;
            const effectiveVisibility = globalVisibility && branchVisible;
            if (!visibilityByLocation.has(location.id)) {
              visibilityByLocation.set(location.id, effectiveVisibility);
            } else if (!effectiveVisibility) {
              visibilityByLocation.set(location.id, false);
            }
            return location.id;
          })
          .filter((id): id is string => Boolean(id)),
      ),
    );

    if (!locationIds.length && existing) {
      locationIds = Object.keys(existing.memberships);
    }

    if (!locationIds.length && !existing) {
      console.warn("[stundenliste:sync] Mitarbeiter ohne Filialzuordnung übersprungen.", { remoteId: remoteCode });
      continue;
    }

    for (const locationId of locationIds) {
      if (!visibilityByLocation.has(locationId)) {
        visibilityByLocation.set(locationId, globalVisibility);
      }
    }

    const primaryLocationId = locationIds[0] ?? existing?.locationId ?? null;
    const bookingPin = (employee.bookingPin ?? existing?.bookingPin ?? null) || null;

    const staffPayload = {
      firstName: names.firstName,
      lastName: names.lastName,
      displayName: names.displayName,
      email: employee.email,
      phone: employee.phone,
      status: employee.isActive ? StaffStatus.ACTIVE : StaffStatus.INACTIVE,
      bookingPin,
    };

    let staffId: string | null = existing?.id ?? null;
    let calendarOrder = existing?.calendarOrder ?? null;
    const color = existing?.color ?? "#1f2937";

    const desiredLocations = locationIds;
    const visibilityUpdates: Record<string, boolean> = {};
    for (const locationId of desiredLocations) {
      const visibilityFlag = visibilityByLocation.has(locationId)
        ? visibilityByLocation.get(locationId)!
        : globalVisibility;
      visibilityUpdates[locationId] = visibilityFlag;
    }

    const metadataPayload =
      Object.keys(visibilityUpdates).length > 0
        ? mergeStaffVisibilityMetadata(existing?.metadata ?? null, visibilityUpdates)
        : existing?.metadata ?? null;

    if (staffId) {
      const shouldUpdateCode =
        (!existingByRemote || existingByRemote.id === staffId) &&
        existing?.code !== remoteCode;
      await prisma.staff.update({
        where: { id: staffId },
        data: {
          ...staffPayload,
          ...(primaryLocationId ? { locationId: primaryLocationId } : {}),
          ...(metadataPayload !== null ? { metadata: metadataPayload } : {}),
          ...(shouldUpdateCode ? { code: remoteCode } : {}),
        },
      });
    } else {
      if (!primaryLocationId) {
        console.warn("[stundenliste:sync] Mitarbeiter konnte nicht angelegt werden (keine Filialzuordnung).", {
          remoteId: remoteCode,
        });
        continue;
      }

      const createData: Prisma.StaffUncheckedCreateInput = {
        ...staffPayload,
        code: remoteCode,
        color,
        bio: null,
        locationId: primaryLocationId,
        ...(metadataPayload !== null ? { metadata: metadataPayload } : {}),
      };

      if (calendarOrderSupported) {
        const orderValue = await acquireNextOrder(primaryLocationId);
        if (orderValue !== null) {
          createData.calendarOrder = orderValue;
          calendarOrder = orderValue;
        }
      }

      const created = await prisma.staff.create({ data: createData });
      staffId = created.id;
    }

    if (!staffId) {
      continue;
    }

    const existingMembershipMap = existing?.memberships ?? {};
    const existingMembershipIds = new Set(Object.keys(existingMembershipMap));
    const desiredSet = new Set(desiredLocations);

    const toRemove = [...existingMembershipIds].filter((locationId) => !desiredSet.has(locationId));
    const toAdd = desiredLocations.filter((locationId) => !existingMembershipIds.has(locationId));

    if (toRemove.length) {
      await prisma.staffLocationMembership.deleteMany({
        where: {
          staffId,
          locationId: { in: toRemove },
        },
      });
    }

    if (toAdd.length) {
      const records = toAdd.map((locationId) => {
        const fallbackRole = existingMembershipMap[locationId] ?? null;
        const roleValue = remoteRole ?? fallbackRole ?? "1";
        return {
          staffId,
          locationId,
          role: roleValue,
        };
      });
      await prisma.staffLocationMembership.createMany({
        data: records,
        skipDuplicates: true,
      });
    }

    const shared = desiredLocations.filter((locationId) => existingMembershipIds.has(locationId));
    for (const locationId of shared) {
      const currentRole = existingMembershipMap[locationId] ?? null;
      if (remoteRole !== null && currentRole !== remoteRole) {
        await prisma.staffLocationMembership.update({
          where: { staffId_locationId: { staffId, locationId } },
          data: { role: remoteRole ?? null },
        });
      } else if (remoteRole === null && !currentRole) {
        await prisma.staffLocationMembership.update({
          where: { staffId_locationId: { staffId, locationId } },
          data: { role: "1" },
        });
      }
    }

    for (const locationId of desiredLocations) {
      const list = staffCodesByLocation.get(locationId) ?? [];
      list.push(remoteCode);
      staffCodesByLocation.set(locationId, list);
      const visibilityFlag = visibilityUpdates[locationId] ?? globalVisibility;
      const hiddenSet = hiddenStaffByLocation.get(locationId) ?? new Set<string>();
      if (!visibilityFlag) {
        hiddenSet.add(staffId);
      } else {
        hiddenSet.delete(staffId);
      }
      hiddenStaffByLocation.set(locationId, hiddenSet);
    }

    const membershipMap: Record<string, string | null> = {};
    for (const locationId of desiredLocations) {
      const fallbackRole = existingMembershipMap[locationId] ?? null;
      membershipMap[locationId] = remoteRole ?? fallbackRole ?? "1";
    }

    const metadataForCache = (metadataPayload ?? null) as Prisma.JsonValue | null;
    existingByCode.set(remoteCode, {
      id: staffId,
      locationId: primaryLocationId ?? existing?.locationId ?? desiredLocations[0] ?? "",
      calendarOrder,
      color,
      bookingPin,
      metadata: metadataForCache,
      memberships: membershipMap,
    });
  }

  return { staffCodesByLocation, hiddenStaffByLocation };
}

function resolveSyncCacheKey(tenantId?: string | null): string {
  const trimmed = tenantId?.trim();
  return trimmed ? trimmed : "default";
}

export async function syncStundenlisteStaff(tenantId: string): Promise<Record<string, string[]> | null> {
  const now = Date.now();
  const globalCache = getGlobalSyncCache();
  const cacheKey = resolveSyncCacheKey(tenantId);
  const cacheEntry = globalCache.staffSync?.get(cacheKey);

  if (cacheEntry && now - cacheEntry.timestamp < SYNC_THROTTLE_MS && cacheEntry.result) {
    return cacheEntry.result;
  }
  if (cacheEntry?.promise) {
    return cacheEntry.promise;
  }

  const syncPromise = (async () => {
    let client: StundenlisteClient;
    try {
      client = getStundenlisteClient(tenantId);
    } catch (error) {
      console.warn("[stundenliste:sync] Stundenliste-Client konnte nicht initialisiert werden.", error);
      globalCache.staffSync?.set(cacheKey, { timestamp: Date.now(), result: null, promise: null });
      setHiddenStaffByLocation(new Map<string, Set<string>>());
      return null;
    }

    const branchLocations = await syncStundenlisteBranches(tenantId, client);
    if (!branchLocations) {
      globalCache.staffSync?.set(cacheKey, { timestamp: Date.now(), result: null, promise: null });
      setHiddenStaffByLocation(new Map<string, Set<string>>());
      return null;
    }

    let employees: StundenlisteEmployeeSummary[] = [];
    try {
      employees = await client.listEmployees();
    } catch (error) {
      console.warn("[stundenliste:sync] Mitarbeiter konnten nicht geladen werden.", error);
      globalCache.staffSync?.set(cacheKey, { timestamp: Date.now(), result: null, promise: null });
      setHiddenStaffByLocation(new Map<string, Set<string>>());
      return null;
    }

    const { staffCodesByLocation, hiddenStaffByLocation } = await syncEmployeeRecords(
      tenantId,
      employees,
      branchLocations,
    );
    setHiddenStaffByLocation(hiddenStaffByLocation);
    const result: Record<string, string[]> = {};
    for (const [locationId, codes] of staffCodesByLocation.entries()) {
      const unique = Array.from(new Set(codes));
      result[locationId] = unique;
    }

    globalCache.staffSync?.set(cacheKey, { timestamp: Date.now(), result, promise: null });
    return result;
  })()
    .catch((error) => {
      console.error("[stundenliste:sync] Synchronisierung fehlgeschlagen", error);
      globalCache.staffSync?.set(cacheKey, { timestamp: Date.now(), result: null, promise: null });
      setHiddenStaffByLocation(new Map<string, Set<string>>());
      return null;
    })
    .finally(() => {
      const latest = globalCache.staffSync?.get(cacheKey);
      if (latest) {
        latest.promise = null;
        globalCache.staffSync?.set(cacheKey, latest);
      }
    });

  globalCache.staffSync?.set(cacheKey, {
    timestamp: now,
    result: cacheEntry?.result ?? null,
    promise: syncPromise,
  });
  return syncPromise;
}
