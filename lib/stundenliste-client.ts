import "server-only";

const rawBaseUrl = process.env.STUNDENLISTE_BASE_URL?.trim();
const baseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/$/, "") : null;

export class StundenlisteClient {
  constructor(
    private readonly base = baseUrl,
    private readonly apiKey?: string,
    public readonly tenantId?: string,
  ) {}

  async listBranches(): Promise<StundenlisteBranchSummary[]> {
    return this.get<Array<StundenlisteBranchSummary>>("/api/branches");
  }

  private buildHeaders(extra?: HeadersInit): HeadersInit {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
      ...extra,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.tenantId) {
      headers["x-tenant-id"] = this.tenantId;
    }
    return headers;
  }

  async listEmployees(): Promise<Array<StundenlisteEmployeeSummary>> {
    return this.get<Array<StundenlisteEmployeeSummary>>("/api/employees");
  }

  async getShiftPlan(employeeId: number, monthKey?: string): Promise<StundenlisteEditableShiftPlan> {
    const params = new URLSearchParams();
    if (monthKey) params.set("month", monthKey);
    return this.get<StundenlisteEditableShiftPlan>(`/api/shift-plan/${employeeId}${params.size ? `?${params}` : ""}`);
  }

  async saveShiftPlan(employeeId: number, payload: StundenlisteUpdateShiftPlanPayload): Promise<StundenlisteEditableShiftPlan> {
    return this.post<StundenlisteEditableShiftPlan>(`/api/shift-plan/${employeeId}`, payload);
  }

  private async get<T>(path: string): Promise<T> {
    if (!this.base) {
      throw new Error("Stundenliste-Client ist nicht konfiguriert.");
    }
    const response = await fetch(`${this.base}${path}`, {
      method: "GET",
      headers: this.buildHeaders(),
      cache: "no-store",
    });
    return this.parseResponse<T>(response);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (!this.base) {
      throw new Error("Stundenliste-Client ist nicht konfiguriert.");
    }
    const response = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });
    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const raw = await response.text();
    let payload: any = null;

    if (raw.trim().length) {
      try {
        payload = JSON.parse(raw);
      } catch (error) {
        if (!response.ok) {
          throw new Error(`Stundenliste-Request fehlgeschlagen (${response.status})`);
        }
        throw new Error("Antwort der Stundenliste konnte nicht gelesen werden.");
      }
    }

    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
      throw new Error(message);
    }

    if (payload && typeof payload === "object" && "data" in payload) {
      return payload.data as T;
    }

    return payload as T;
  }
}

export type StundenlisteEmployeeSummary = {
  id: number;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  bookingPin: string | null;
  showInCalendar?: boolean | null;
  personnelNumber?: string | null;
  branches?: Array<{ id: number; name: string; visibleInCalendar?: boolean | null; showInCalendar?: boolean | null }>;
  roleId?: number | null;
  role?: string | null;
  permissions?: Array<string | number> | null;
};

export type StundenlisteBranchScheduleRule = {
  weekday:
    | "MONDAY"
    | "TUESDAY"
    | "WEDNESDAY"
    | "THURSDAY"
    | "FRIDAY"
    | "SATURDAY"
    | "SUNDAY";
  startsAtMinutes?: number | null;
  endsAtMinutes?: number | null;
  startMinutes?: number | null;
  endMinutes?: number | null;
  start?: string | null;
  end?: string | null;
};

export type StundenlisteBranchSummary = {
  id: number;
  slug?: string | null;
  name: string;
  timezone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  updatedAt?: string | null;
  schedule?: StundenlisteBranchScheduleRule[];
};

export type StundenlisteEditableShiftPlanDay = {
  isoDate: string;
  weekdayLabel: string;
  isPast: boolean;
  start: string;
  end: string;
  requiredPauseMinutes: number;
};

export type StundenlisteEditableShiftPlan = {
  employeeId: number;
  monthKey: string;
  days: StundenlisteEditableShiftPlanDay[];
};

export type StundenlisteUpdateShiftPlanPayload = {
  monthKey: string;
  days: Array<{
    isoDate: string;
    start: string | null;
    end: string | null;
    requiredPauseMinutes: number;
  }>;
};

export function getStundenlisteClient(tenantId?: string) {
  if (!baseUrl) {
    throw new Error("STUNDENLISTE_BASE_URL ist nicht gesetzt.");
  }
  const resolvedTenantId = tenantId ?? process.env.DEFAULT_TENANT_ID;
  return new StundenlisteClient(baseUrl, process.env.STUNDENLISTE_API_KEY, resolvedTenantId);
}

type EmployeeCacheState = {
  timestamp: number;
  data: StundenlisteEmployeeSummary[] | null;
  promise: Promise<StundenlisteEmployeeSummary[]> | null;
};

const EMPLOYEE_CACHE_TTL_MS = 60 * 1000;

function getGlobalEmployeeCache(): Map<string, EmployeeCacheState> {
  const globalObject = globalThis as typeof globalThis & {
    __stundenlisteEmployeeCache__?: Map<string, EmployeeCacheState>;
  };
  if (!globalObject.__stundenlisteEmployeeCache__) {
    globalObject.__stundenlisteEmployeeCache__ = new Map();
  }
  return globalObject.__stundenlisteEmployeeCache__;
}

function resolveEmployeeCacheKey(tenantId?: string | null): string {
  const trimmed = tenantId?.trim();
  return trimmed ? trimmed : "default";
}

export async function listEmployeesCached(
  tenantId?: string,
  existingClient?: StundenlisteClient,
): Promise<StundenlisteEmployeeSummary[]> {
  const cacheStore = getGlobalEmployeeCache();
  const key = resolveEmployeeCacheKey(tenantId ?? existingClient?.tenantId);
  const cache = cacheStore.get(key) ?? { timestamp: 0, data: null, promise: null };
  const now = Date.now();
  if (cache.data && now - cache.timestamp < EMPLOYEE_CACHE_TTL_MS) {
    return cache.data;
  }
  if (cache.promise) {
    return cache.promise;
  }
  const client = existingClient ?? getStundenlisteClient(tenantId);
  const promise = client
    .listEmployees()
    .then((employees) => {
      cache.timestamp = Date.now();
      cache.data = employees;
      cache.promise = null;
      cacheStore.set(key, cache);
      return employees;
    })
    .catch((error) => {
      cache.promise = null;
      cacheStore.set(key, cache);
      throw error;
    });
  cache.promise = promise;
  cacheStore.set(key, cache);
  return promise;
}
