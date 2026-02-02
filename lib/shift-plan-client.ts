import "server-only";

const rawBaseUrl = process.env.CONTROL_PLANE_URL?.trim();
const baseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/$/, "") : null;

export type CentralShiftPlanDay = {
  isoDate: string;
  weekdayLabel: string;
  isPast: boolean;
  start: string;
  end: string;
  requiredPauseMinutes: number;
  label: string;
};

export type CentralShiftPlan = {
  staffId: string;
  monthKey: string;
  days: CentralShiftPlanDay[];
};

export type CentralShiftPlanPayload = {
  monthKey: string;
  days: Array<{
    isoDate: string;
    start: string | null;
    end: string | null;
    requiredPauseMinutes: number;
  }>;
};

type ShiftPlanStaffRef = {
  id: string;
  code?: string | null;
  metadata?: unknown;
};

const CONTROL_PLANE_SOURCE = "control-plane";
const CUID_PATTERN = /^c[a-z0-9]{20,}$/;
const RESOLVE_CACHE_TTL_MS = 5 * 60 * 1000;

type ShiftPlanStaffLookup = {
  staffId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
};

type ShiftPlanStaffLookupSource = ShiftPlanStaffRef & {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
};

type ResolvedStaffCacheEntry = {
  value: string | null;
  timestamp: number;
};

const resolvedStaffCache = new Map<string, ResolvedStaffCacheEntry>();

function normalizeLookupValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function buildShiftPlanStaffLookup(
  staff: ShiftPlanStaffLookupSource,
  baseId: string,
): ShiftPlanStaffLookup | null {
  const email = normalizeLookupValue(staff.email ?? undefined);
  const firstName = normalizeLookupValue(staff.firstName ?? undefined);
  const lastName = normalizeLookupValue(staff.lastName ?? undefined);
  const displayName = normalizeLookupValue(staff.displayName ?? undefined);
  if (!email && !(firstName && lastName) && !displayName) {
    return null;
  }
  return {
    staffId: baseId,
    email,
    firstName,
    lastName,
    displayName,
  };
}

function looksLikeCuid(value: string): boolean {
  return CUID_PATTERN.test(value);
}

export function resolveShiftPlanStaffId(staff: ShiftPlanStaffRef): string {
  const code = typeof staff.code === "string" ? staff.code.trim() : "";
  const metadata = staff.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    const source = record.source;
    if (source === CONTROL_PLANE_SOURCE && code) {
      return code;
    }
  }
  return staff.id;
}

export class ShiftPlanClient {
  constructor(
    private readonly base = baseUrl,
    private readonly secret?: string,
    public readonly tenantId?: string,
  ) {}

  private buildHeaders(extra?: HeadersInit): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.secret) {
      headers["x-provision-secret"] = this.secret;
    }
    return headers;
  }

  async resolveStaffId(lookup: ShiftPlanStaffLookup): Promise<string | null> {
    if (!this.base || !this.secret) {
      throw new Error("CONTROL_PLANE_URL/PROVISION_SECRET fehlt.");
    }
    const tenantId = this.tenantId?.trim();
    if (!tenantId) {
      throw new Error("Tenant fehlt.");
    }
    const url = new URL(`${this.base}/api/internal/staff/shift-plan`);
    url.searchParams.set("tenantId", tenantId);
    if (lookup.staffId) url.searchParams.set("staffId", lookup.staffId);
    if (lookup.email) url.searchParams.set("email", lookup.email);
    if (lookup.firstName) url.searchParams.set("firstName", lookup.firstName);
    if (lookup.lastName) url.searchParams.set("lastName", lookup.lastName);
    if (lookup.displayName) url.searchParams.set("displayName", lookup.displayName);
    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(),
      cache: "no-store",
    });
    if (response.status === 404) return null;
    const raw = await response.text();
    let payload: any = null;
    if (raw.trim().length) {
      try {
        payload = JSON.parse(raw);
      } catch {
        if (!response.ok) {
          throw new Error(`Shiftplan-Resolve fehlgeschlagen (${response.status})`);
        }
      }
    }
    if (!response.ok) {
      const message = typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`;
      throw new Error(message);
    }
    const resolved = typeof payload?.staffId === "string" ? payload.staffId.trim() : "";
    return resolved.length ? resolved : null;
  }

  async getShiftPlan(staffId: string, monthKey?: string): Promise<CentralShiftPlan> {
    if (!this.base || !this.secret) {
      throw new Error("CONTROL_PLANE_URL/PROVISION_SECRET fehlt.");
    }
    const tenantId = this.tenantId?.trim();
    if (!tenantId) {
      throw new Error("Tenant fehlt.");
    }
    const url = new URL(`${this.base}/api/internal/shift-plan/staff`);
    url.searchParams.set("tenantId", tenantId);
    url.searchParams.set("staffId", staffId);
    if (monthKey) {
      url.searchParams.set("month", monthKey);
    }
    const response = await fetch(url, {
      method: "GET",
      headers: this.buildHeaders(),
      cache: "no-store",
    });
    return this.parseResponse<CentralShiftPlan>(response);
  }

  async saveShiftPlan(staffId: string, payload: CentralShiftPlanPayload): Promise<CentralShiftPlan> {
    if (!this.base || !this.secret) {
      throw new Error("CONTROL_PLANE_URL/PROVISION_SECRET fehlt.");
    }
    const tenantId = this.tenantId?.trim();
    if (!tenantId) {
      throw new Error("Tenant fehlt.");
    }
    const url = new URL(`${this.base}/api/internal/shift-plan/staff`);
    url.searchParams.set("tenantId", tenantId);
    url.searchParams.set("staffId", staffId);
    const response = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });
    return this.parseResponse<CentralShiftPlan>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const raw = await response.text();
    let payload: any = null;

    if (raw.trim().length) {
      try {
        payload = JSON.parse(raw);
      } catch {
        if (!response.ok) {
          throw new Error(`Shiftplan-Request fehlgeschlagen (${response.status})`);
        }
        throw new Error("Antwort des Shiftplans konnte nicht gelesen werden.");
      }
    }

    if (!response.ok) {
      const message = typeof payload?.message === "string" ? payload.message : `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (payload && typeof payload === "object" && "data" in payload) {
      return payload.data as T;
    }

    return payload as T;
  }
}

export function getShiftPlanClient(tenantId?: string) {
  if (!baseUrl) {
    throw new Error("CONTROL_PLANE_URL ist nicht gesetzt.");
  }
  return new ShiftPlanClient(baseUrl, process.env.PROVISION_SECRET, tenantId);
}

export async function resolveShiftPlanStaffIdWithLookup(
  client: ShiftPlanClient,
  staff: ShiftPlanStaffLookupSource,
): Promise<string | null> {
  const baseId = resolveShiftPlanStaffId(staff);
  if (looksLikeCuid(baseId)) {
    return baseId;
  }
  const lookup = buildShiftPlanStaffLookup(staff, baseId);
  if (!lookup) return null;
  const cacheKey = `${client.tenantId ?? "unknown"}:${staff.id}`;
  const now = Date.now();
  const cached = resolvedStaffCache.get(cacheKey);
  if (cached && now - cached.timestamp < RESOLVE_CACHE_TTL_MS) {
    return cached.value;
  }
  const resolved = await client.resolveStaffId(lookup).catch(() => null);
  resolvedStaffCache.set(cacheKey, { value: resolved, timestamp: now });
  return resolved;
}
