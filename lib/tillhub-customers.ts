import "server-only";

import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";
import { applyCustomerProfile, type CustomerProfile } from "@/lib/customer-metadata";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";

type TillhubCustomerSyncConfig = {
  enabled: boolean;
  locationSlug: string | null;
  customerEndpoint: string | null;
  mode: "INCREMENTAL" | "FULL";
  filter: "ALL" | "ACTIVE";
  since: string | null;
  lastSyncAt: string | null;
};

type TillhubConfig = {
  enabled: boolean;
  apiBase: string | null;
  loginId: string | null;
  accountId: string | null;
  email: string | null;
  password: string | null;
  staticToken: string | null;
  customerSync: TillhubCustomerSyncConfig;
};

type CachedToken = { value: string; expiresAt: number | null };

type ParsedTillhubCustomer = {
  id: string;
  accountId: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  active: boolean;
  customerNumber: string | null;
  companyName: string | null;
  gender: string | null;
  birthDate: string | null;
  comment: string | null;
  firstSeenAt: string | null;
  address: CustomerProfile["address"];
  updatedAt: string | null;
};

type SyncSummary = {
  tenantId: string;
  locations: string[];
  total: number;
  created: number;
  updated: number;
  skipped: number;
};

const DEFAULT_TILLHUB_BASE = "https://api.tillhub.com/api/v0";
const DEFAULT_SYNC_FILTER: TillhubCustomerSyncConfig["filter"] = "ALL";
const DEFAULT_SYNC_MODE: TillhubCustomerSyncConfig["mode"] = "INCREMENTAL";
const tokenCache = new Map<string, CachedToken>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isLikelyId(value: string | null): boolean {
  if (!value) return false;
  return UUID_RE.test(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeEmail(value: unknown): string | null {
  const raw = normalizeString(value);
  return raw ? raw.toLowerCase() : null;
}

function digitsOnly(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function normalizeDateString(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeDateTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const base = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base.padEnd(base.length + ((4 - (base.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(json);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function collectAccountCandidates(value: unknown, target: string[]) {
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      const normalized = normalizeKey(key);
      if (
        normalized.includes("account") ||
        normalized.includes("clientaccount") ||
        normalized.includes("organisation") ||
        normalized.includes("organization") ||
        normalized.includes("org") ||
        normalized.includes("tenant")
      ) {
        const candidate = normalizeString(entry);
        if (candidate && isLikelyId(candidate) && !target.includes(candidate)) {
          target.push(candidate);
        }
      }
      continue;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => collectAccountCandidates(item, target));
      continue;
    }
    if (isRecord(entry)) {
      collectAccountCandidates(entry, target);
    }
  }
}

function splitLocationSlugs(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((slug) => slug.trim())
    .filter(Boolean);
}

function mergeCustomerMetadata(
  metadata: Prisma.JsonValue | null,
  profileUpdates: Partial<CustomerProfile>,
  tillhubMeta: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base = applyCustomerProfile(metadata, profileUpdates);
  if (!isRecord(base)) {
    return {
      customerProfile: profileUpdates,
      tillhub: tillhubMeta,
    } as Prisma.InputJsonValue;
  }
  return {
    ...base,
    tillhub: isRecord(base.tillhub) ? { ...(base.tillhub as Record<string, unknown>), ...tillhubMeta } : tillhubMeta,
  } as Prisma.InputJsonValue;
}

function resolveTillhubBase(config: TillhubConfig): string {
  return (config.apiBase?.trim() || DEFAULT_TILLHUB_BASE).replace(/\/+$/, "");
}

function resolveTillhubRoot(config: TillhubConfig): string {
  const base = resolveTillhubBase(config);
  return base.replace(/\/api\/v\d+$/i, "");
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function resolveTokenCacheKey(config: TillhubConfig): string {
  return (
    config.accountId ||
    config.loginId ||
    config.email ||
    config.apiBase ||
    "default"
  );
}

async function fetchTillhubConfig(tenantId: string): Promise<TillhubConfig | null> {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return null;
  const url = new URL("/api/internal/tillhub/config", baseUrl);
  url.searchParams.set("tenantId", tenantId);
  const secret = process.env.PROVISION_SECRET?.trim();
  const response = await fetch(url.toString(), {
    headers: secret ? { "x-provision-secret": secret } : undefined,
    cache: "no-store",
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { tillhub?: Record<string, unknown> };
  const tillhub = isRecord(payload?.tillhub) ? payload.tillhub : null;
  if (!tillhub) return null;
  const sync = isRecord(tillhub.customerSync) ? tillhub.customerSync : {};
  return {
    enabled: Boolean(tillhub.enabled),
    apiBase: normalizeString(tillhub.apiBase),
    loginId: normalizeString(tillhub.loginId),
    accountId: normalizeString(tillhub.accountId),
    email: normalizeEmail(tillhub.email),
    password: normalizeString(tillhub.password),
    staticToken: normalizeString(tillhub.staticToken),
    customerSync: {
      enabled: Boolean(sync.enabled),
      locationSlug: normalizeString(sync.locationSlug),
      customerEndpoint: normalizeString(sync.customerEndpoint),
      mode: sync.mode === "FULL" ? "FULL" : DEFAULT_SYNC_MODE,
      filter: sync.filter === "ACTIVE" ? "ACTIVE" : DEFAULT_SYNC_FILTER,
      since: normalizeString(sync.since),
      lastSyncAt: normalizeString(sync.lastSyncAt),
    },
  };
}

async function updateTillhubCustomerSyncStatus(
  tenantId: string,
  update: { lastSyncAt?: string | null; lastError?: string | null },
): Promise<void> {
  const prisma = getPrismaClient();
  const rows = await prisma.$queryRaw<{ metadata: Prisma.JsonValue | null }[]>(
    Prisma.sql`SELECT metadata FROM "control_plane"."Tenant" WHERE id = ${tenantId} LIMIT 1`,
  );
  const current = rows[0]?.metadata;
  if (!isRecord(current)) return;
  const tillhub = isRecord(current.tillhub) ? { ...(current.tillhub as Record<string, unknown>) } : {};
  const customerSync = isRecord(tillhub.customerSync) ? { ...(tillhub.customerSync as Record<string, unknown>) } : {};
  const nextCustomerSync = {
    ...customerSync,
    ...update,
  };
  const nextMeta = {
    ...current,
    tillhub: {
      ...tillhub,
      customerSync: nextCustomerSync,
    },
  };
  await prisma.$executeRaw(
    Prisma.sql`UPDATE "control_plane"."Tenant" SET metadata = ${JSON.stringify(nextMeta)}::jsonb WHERE id = ${tenantId}`,
  );
}

async function getTillhubToken(config: TillhubConfig): Promise<string> {
  if (config.staticToken) {
    return config.staticToken;
  }
  const cacheKey = resolveTokenCacheKey(config);
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && (!cached.expiresAt || cached.expiresAt > now + 60_000)) {
    return cached.value;
  }
  if (!config.email || !config.password) {
    throw new Error("Tillhub credentials missing.");
  }
  const response = await fetch(`${resolveTillhubBase(config)}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tillhub login failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { token?: string | null; expires_at?: string | null };
  const token = normalizeString(data?.token);
  if (!token) {
    throw new Error("Tillhub login returned no token.");
  }
  const expiresAt = data?.expires_at ? Date.parse(data.expires_at) : null;
  tokenCache.set(cacheKey, {
    value: token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
  });
  return token;
}

async function fetchTillhubMe(config: TillhubConfig): Promise<Record<string, unknown> | null> {
  try {
    const token = await getTillhubToken(config);
    const response = await fetch(`${resolveTillhubBase(config)}/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function resolveLoginIdCandidates(config: TillhubConfig): Promise<string[]> {
  const ordered: string[] = [];
  const add = (value: unknown) => {
    const candidate = normalizeString(value);
    if (!candidate || !isLikelyId(candidate)) return;
    if (!ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  };

  try {
    const token = await getTillhubToken(config);
    const payload = decodeJwtPayload(token);
    if (payload) {
      add(payload.sub);
      add(payload.userId);
      add(payload.user_id);
      add(payload.id);
      if (isRecord(payload.user)) {
        add(payload.user.id);
        add(payload.user.user_id);
      }
    }
  } catch {
    // ignore token parse failures
  }

  const me = await fetchTillhubMe(config);
  if (me) {
    add(me.id);
    add(me.user_id);
    if (isRecord(me.user)) {
      add(me.user.id);
      add(me.user.user_id);
    }
  }

  add(config.loginId);

  return ordered;
}

async function fetchAccountIdsFromClient(
  config: TillhubConfig,
  clientAccountId: string,
): Promise<string[]> {
  try {
    const token = await getTillhubToken(config);
    const root = resolveTillhubRoot(config);
    const url = new URL(`${root}/api/v0/accounts/${clientAccountId}`);
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as unknown;
    const list = extractList(payload);
    const ids = list
      .map((entry) => normalizeString(entry.id ?? entry.account_id ?? entry.accountId ?? entry.client_id))
      .filter((value): value is string => Boolean(value) && isLikelyId(value));
    return Array.from(new Set(ids));
  } catch {
    return [];
  }
}

async function resolveAccountIdCandidates(
  config: TillhubConfig,
  loginIdCandidates: string[] = [],
): Promise<string[]> {
  const ordered: string[] = [];
  const add = (value: unknown) => {
    const candidate = normalizeString(value);
    if (!candidate || !isLikelyId(candidate)) return;
    if (!ordered.includes(candidate)) {
      ordered.push(candidate);
    }
  };

  const loginIds = loginIdCandidates.length
    ? loginIdCandidates
    : config.loginId
      ? [config.loginId]
      : [];
  if (loginIds[0]) {
    const fromAccounts = await fetchAccountIdsFromClient(config, loginIds[0]);
    fromAccounts.forEach((id) => add(id));
  }

  try {
    const token = await getTillhubToken(config);
    const payload = decodeJwtPayload(token);
    if (payload) {
      collectAccountCandidates(payload, ordered);
    }
  } catch {
    // ignore token parse failures
  }

  const me = await fetchTillhubMe(config);
  if (me) {
    collectAccountCandidates(me, ordered);
  }

  add(config.accountId);

  return ordered;
}

function extractList(payload: unknown): Record<string, unknown>[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!isRecord(payload)) return [];
  const directKeys = ["results", "data", "items", "customers", "entries", "list"];
  for (const key of directKeys) {
    if (Array.isArray(payload[key])) {
      return payload[key] as Record<string, unknown>[];
    }
  }
  for (const key of directKeys) {
    const nested = payload[key];
    if (isRecord(nested) || Array.isArray(nested)) {
      const list = extractList(nested);
      if (list.length) return list;
    }
  }
  return [];
}

function extractCursor(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct =
    normalizeString(payload.cursor) ||
    normalizeString(payload.next_cursor) ||
    normalizeString(payload.nextCursor) ||
    normalizeString(payload.cursor_next);
  if (direct) {
    return extractCursorValue(direct);
  }

  const cursorObj = isRecord(payload.cursor) ? payload.cursor : null;
  if (cursorObj) {
    const nested =
      normalizeString(cursorObj.next) ||
      normalizeString(cursorObj.after) ||
      normalizeString(cursorObj.cursor) ||
      normalizeString(cursorObj.next_cursor) ||
      normalizeString(cursorObj.cursor_next);
    if (nested) {
      return extractCursorValue(nested);
    }
  }

  const cursorsObj = isRecord(payload.cursors) ? payload.cursors : null;
  if (cursorsObj) {
    const nested =
      normalizeString(cursorsObj.after) ||
      normalizeString(cursorsObj.next) ||
      normalizeString(cursorsObj.next_cursor);
    if (nested) {
      return extractCursorValue(nested);
    }
  }

  const requestObj = isRecord(payload.request) ? payload.request : null;
  const requestCursor = requestObj && isRecord(requestObj.cursor) ? requestObj.cursor : null;
  if (requestCursor) {
    const nested =
      normalizeString(requestCursor.next) ||
      normalizeString(requestCursor.after) ||
      normalizeString(requestCursor.cursor);
    if (nested) {
      return extractCursorValue(nested);
    }
  }

  return null;
}

function extractCursorValue(value: string): string {
  if (!value) return value;
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return (
      normalizeString(url.searchParams.get("cursor")) ||
      normalizeString(url.searchParams.get("after")) ||
      normalizeString(url.searchParams.get("page")) ||
      value
    );
  } catch {
    return value;
  }
}

function extractPagination(payload: unknown): { total: number; limit: number; offset: number } | null {
  if (!isRecord(payload)) return null;
  const total = Number(payload.total ?? payload.total_count ?? payload.count ?? NaN);
  const limit = Number(payload.limit ?? payload.page_size ?? payload.per_page ?? NaN);
  const offset = Number(payload.offset ?? payload.page ?? NaN);
  if (Number.isFinite(total) && Number.isFinite(limit) && Number.isFinite(offset)) {
    return { total, limit, offset };
  }
  return null;
}

function extractCursorUrl(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const pickUrl = (value: unknown) => {
    const str = normalizeString(value);
    if (!str) return null;
    return /^https?:\/\//i.test(str) ? str : null;
  };

  const direct =
    pickUrl(payload.cursor) ||
    pickUrl(payload.next_cursor) ||
    pickUrl(payload.nextCursor) ||
    pickUrl(payload.cursor_next);
  if (direct) return direct;

  const cursorObj = isRecord(payload.cursor) ? payload.cursor : null;
  if (cursorObj) {
    const nested =
      pickUrl(cursorObj.next) ||
      pickUrl(cursorObj.after) ||
      pickUrl(cursorObj.cursor) ||
      pickUrl(cursorObj.next_cursor) ||
      pickUrl(cursorObj.cursor_next);
    if (nested) return nested;
  }

  const cursorsObj = isRecord(payload.cursors) ? payload.cursors : null;
  if (cursorsObj) {
    const nested = pickUrl(cursorsObj.after) || pickUrl(cursorsObj.next) || pickUrl(cursorsObj.next_cursor);
    if (nested) return nested;
  }

  const requestObj = isRecord(payload.request) ? payload.request : null;
  const requestCursor = requestObj && isRecord(requestObj.cursor) ? requestObj.cursor : null;
  if (requestCursor) {
    const nested = pickUrl(requestCursor.next) || pickUrl(requestCursor.after) || pickUrl(requestCursor.cursor);
    if (nested) return nested;
  }

  return null;
}

async function fetchTillhubCustomersFromPath(
  config: TillhubConfig,
  path: string,
): Promise<Record<string, unknown>[]> {
  const token = await getTillhubToken(config);
  const baseUrl = resolveTillhubBase(config);
  const limit = 200;
  let cursor: string | null = null;
  let cursorField: string | null = null;
  let offset = 0;
  let page = 0;
  let nextUrl: string | null = null;
  const seenCursors = new Set<string>();
  const seenNextUrls = new Set<string>();
  let lastPageFingerprint: string | null = null;
  const results: Record<string, unknown>[] = [];
  const logger = getLogger();

  while (page < 200) {
    const url = nextUrl
      ? new URL(nextUrl)
      : isAbsoluteUrl(path)
        ? new URL(path)
        : new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
    if (!nextUrl) {
      url.searchParams.set("limit", String(limit));
      const accountId = config.accountId?.trim() || null;
      const hasAccountInPath = accountId ? url.pathname.includes(`/${accountId}`) : false;
      const hasScopedId = /\/(customers|users|accounts)\/[^/]+/i.test(url.pathname);
      if (
        accountId &&
        !hasAccountInPath &&
        !hasScopedId &&
        !url.searchParams.has("account") &&
        !url.searchParams.has("account_id")
      ) {
        url.searchParams.set("account", accountId);
      }
      if (cursorField) {
        url.searchParams.set("cursor_field", cursorField);
      }
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      } else if (offset > 0) {
        url.searchParams.set("offset", String(offset));
      }
    }
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(
        `Tillhub customers request failed (${response.status}): ${body}`,
      ) as Error & { status?: number; path?: string };
      error.status = response.status;
      error.path = path;
      throw error;
    }
    const payload = (await response.json()) as unknown;
    const list = extractList(payload);
    results.push(...list);

    const pageFingerprint = fingerprintList(list);
    if (pageFingerprint) {
      if (pageFingerprint === lastPageFingerprint) {
        logger.warn({ path }, "tillhub customers pagination stalled; returning partial results");
        break;
      }
      lastPageFingerprint = pageFingerprint;
    }

    const cursorUrl = extractCursorUrl(payload);
    if (cursorUrl) {
      if (seenNextUrls.has(cursorUrl)) break;
      seenNextUrls.add(cursorUrl);
      nextUrl = cursorUrl;
      cursor = null;
      cursorField = null;
      offset = 0;
      page += 1;
      continue;
    }

    const nextCursor = extractCursor(payload);
    if (nextCursor) {
      if (seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      cursorField = null;
      nextUrl = null;
      offset = 0;
      page += 1;
      continue;
    }

    const pagination = extractPagination(payload);
    if (pagination) {
      const nextOffset = pagination.offset + pagination.limit;
      if (nextOffset >= pagination.total) break;
      offset = nextOffset;
      nextUrl = null;
      cursor = null;
      cursorField = null;
      page += 1;
      continue;
    }

    if (!list.length || list.length < limit) break;

    const fallbackCursor = deriveCursorFromList(list);
    if (fallbackCursor && !seenCursors.has(fallbackCursor)) {
      seenCursors.add(fallbackCursor);
      cursor = fallbackCursor;
      cursorField = "id";
      nextUrl = null;
      offset = 0;
      page += 1;
      continue;
    }

    offset += limit;
    nextUrl = null;
    cursor = null;
    cursorField = null;
    page += 1;
    continue;
  }

  return results;
}

async function fetchTillhubCustomerCount(
  config: TillhubConfig,
  path: string,
): Promise<number | null> {
  const token = await getTillhubToken(config);
  const baseUrl = resolveTillhubBase(config);
  const url = isAbsoluteUrl(path)
    ? new URL(path)
    : new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
  url.searchParams.set("limit", "1");
  const accountId = config.accountId?.trim() || null;
  const hasAccountInPath = accountId ? url.pathname.includes(`/${accountId}`) : false;
  const hasScopedId = /\/(customers|users|accounts)\/[^/]+/i.test(url.pathname);
  if (
    accountId &&
    !hasAccountInPath &&
    !hasScopedId &&
    !url.searchParams.has("account") &&
    !url.searchParams.has("account_id")
  ) {
    url.searchParams.set("account", accountId);
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(
      `Tillhub customers request failed (${response.status}): ${body}`,
    ) as Error & { status?: number; path?: string };
    error.status = response.status;
    error.path = path;
    throw error;
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const count = Number(payload.count ?? payload.total ?? payload.total_count ?? NaN);
  if (Number.isFinite(count)) return count;
  const list = extractList(payload);
  return list.length;
}

async function fetchTillhubCustomers(config: TillhubConfig): Promise<Record<string, unknown>[]> {
  const loginIdCandidates = await resolveLoginIdCandidates(config);
  const accountIdCandidates = await resolveAccountIdCandidates(config, loginIdCandidates);
  const effectiveConfig =
    accountIdCandidates.length > 0 ? { ...config, accountId: accountIdCandidates[0] } : config;
  const candidates = resolveCustomerEndpointCandidates(
    effectiveConfig,
    loginIdCandidates,
    accountIdCandidates,
  );
  if (!candidates.length) {
    throw new Error("Tillhub customer endpoint missing (check customer sync settings).");
  }

  const aggregated: Record<string, unknown>[] = [];
  const aggregatedIds = new Set<string>();
  const root = resolveTillhubRoot(effectiveConfig);
  const accountIds = accountIdCandidates.length
    ? accountIdCandidates
    : effectiveConfig.accountId
      ? [effectiveConfig.accountId]
      : [];
  if (accountIds.length > 1) {
    for (const accountId of accountIds) {
      const path = `${root}/api/v1/customers/${accountId}`;
      try {
        const count = await fetchTillhubCustomerCount(effectiveConfig, path);
        if (!count) continue;
        const list = await fetchTillhubCustomersFromPath(effectiveConfig, path);
        for (const entry of list) {
          if (accountId) {
            (entry as Record<string, unknown>).__tillhubAccountId = accountId;
          }
          const id = pickFirstString(entry, ["id", "uuid", "customer_id", "customerId", "insert_id", "insertId"]);
          if (id && aggregatedIds.has(id)) continue;
          if (id) aggregatedIds.add(id);
          aggregated.push(entry);
        }
      } catch (error) {
        const candidateError = error as Error & { status?: number; path?: string };
        if (candidateError.status === 401 || candidateError.status === 403 || candidateError.status === 404) {
          continue;
        }
        throw error;
      }
    }
    if (aggregated.length) {
      return aggregated;
    }
  }

  let lastError: (Error & { status?: number; path?: string }) | null = null;
  let sawEmpty = false;
  for (const path of candidates) {
    try {
      const list = await fetchTillhubCustomersFromPath(effectiveConfig, path);
      if (!list.length) {
        sawEmpty = true;
        continue;
      }
      return list;
    } catch (error) {
      const candidateError = error as Error & { status?: number; path?: string; nonPageable?: boolean };
      if (
        candidateError.status === 404 ||
        candidateError.status === 401 ||
        candidateError.status === 403 ||
        candidateError.nonPageable
      ) {
        lastError = candidateError;
        continue;
      }
      throw error;
    }
  }

  if (sawEmpty) return [];

  if (lastError) {
    throw lastError;
  }
  throw new Error(
    `Tillhub customers endpoint not found (tried: ${candidates.join(", ")}).`,
  );
}

function pickFirstString(entry: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = normalizeString(entry[key]);
    if (value) return value;
  }
  return null;
}

function pickNestedString(
  entry: Record<string, unknown>,
  key: string,
  nestedKeys: string[],
): string | null {
  const value = entry[key];
  if (!isRecord(value)) return null;
  return pickFirstString(value, nestedKeys);
}

function deriveCursorFromList(list: Record<string, unknown>[]): string | null {
  if (!list.length) return null;
  const last = list[list.length - 1];
  return pickFirstString(last, ["id", "uuid", "customer_id", "customerId", "insert_id", "insertId"]);
}

function fingerprintList(list: Record<string, unknown>[]): string | null {
  if (!list.length) return null;
  const first = pickFirstString(list[0], ["id", "uuid", "customer_id", "customerId", "insert_id", "insertId"]);
  const last = deriveCursorFromList(list);
  if (!first || !last) return null;
  return `${first}|${last}|${list.length}`;
}

function pickFirstBoolean(entry: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;
  }
  return null;
}

function parseAddress(entry: Record<string, unknown>): CustomerProfile["address"] {
  const address = isRecord(entry.address) ? entry.address : {};
  return {
    street: normalizeString(address.street ?? address.line1 ?? entry.street ?? entry.address_line1 ?? entry.address1),
    houseNumber: normalizeString(address.houseNumber ?? entry.house_number ?? entry.housenumber ?? entry.address_line2),
    postalCode: normalizeString(address.postalCode ?? address.zip ?? entry.zip ?? entry.postal_code),
    city: normalizeString(address.city ?? entry.city),
    state: normalizeString(address.state ?? entry.state),
    country: normalizeString(address.country ?? entry.country),
  };
}

function parseTillhubCustomer(entry: Record<string, unknown>): ParsedTillhubCustomer | null {
  const id = pickFirstString(entry, ["id", "uuid", "customer_id", "customerId", "contact_id", "contactId"]);
  if (!id) return null;

  const accountId =
    pickFirstString(entry, ["account_id", "accountId", "client_id", "clientId", "account", "client"]) ||
    pickNestedString(entry, "account", ["id", "account_id", "accountId", "client_id", "clientId"]) ||
    pickNestedString(entry, "client", ["id", "account_id", "accountId", "client_id", "clientId"]) ||
    normalizeString(entry.__tillhubAccountId ?? null);

  const firstNameRaw = pickFirstString(entry, ["first_name", "firstName", "firstname", "given_name", "givenName"]);
  const lastNameRaw = pickFirstString(entry, ["last_name", "lastName", "lastname", "surname", "family_name", "familyName"]);
  const displayNameRaw = pickFirstString(entry, [
    "display_name",
    "displayName",
    "displayname",
    "name",
    "full_name",
    "fullName",
    "customer_name",
  ]);
  const displayName = displayNameRaw || [firstNameRaw, lastNameRaw].filter(Boolean).join(" ").trim() || "Kunde";
  let firstName = firstNameRaw;
  let lastName = lastNameRaw;
  if (!firstName && displayName) {
    const parts = displayName.split(" ");
    firstName = parts[0] ?? "Kunde";
    lastName = parts.slice(1).join(" ").trim() || "Kunde";
  }
  if (!lastName) {
    lastName = "Kunde";
  }

  const email = normalizeEmail(pickFirstString(entry, ["email", "email_address", "emailAddress", "mail"]));
  const phoneDirect = pickFirstString(entry, [
    "phone",
    "phone_number",
    "phoneNumber",
    "mobile",
    "mobile_number",
    "mobileNumber",
    "telephone",
    "tel",
    "contact_phone",
    "phone1",
  ]);
  const phoneFromNumbers = isRecord(entry.phonenumbers)
    ? pickFirstString(entry.phonenumbers, ["main", "mobile", "home", "work"])
    : null;
  const phoneFromContacts = isRecord(entry.contacts) && isRecord(entry.contacts.phone)
    ? pickFirstString(entry.contacts.phone, ["main", "mobile", "home", "work"])
    : null;
  const phone = normalizeString(phoneDirect ?? phoneFromNumbers ?? phoneFromContacts);

  const activeFlag = pickFirstBoolean(entry, ["active", "is_active", "isActive", "enabled", "is_enabled"]);
  const status = pickFirstString(entry, ["status", "state"]);
  let active = activeFlag ?? true;
  if (status && /inactive|disabled|archived|deleted/i.test(status)) {
    active = false;
  } else if (status && /active|enabled/i.test(status)) {
    active = true;
  }

  const customerNumber = pickFirstString(entry, ["customer_number", "customerNumber", "number", "client_number"]);
  const companyName = pickFirstString(entry, ["company", "company_name", "companyName", "business", "business_name"]);
  const gender = pickFirstString(entry, ["gender", "sex"]);
  const birthDate = normalizeDateString(
    pickFirstString(entry, ["birth_date", "birthDate", "birthday", "date_of_birth", "dob"]),
  );
  const comment = pickFirstString(entry, ["note", "notes", "comment", "remarks"]);
  const createdAt = normalizeDateString(pickFirstString(entry, ["created_at", "createdAt", "created"]));
  const updatedAt = normalizeDateTime(pickFirstString(entry, ["updated_at", "updatedAt", "modified_at", "modifiedAt"]));

  return {
    id,
    accountId,
    firstName: firstName ?? "Kunde",
    lastName,
    displayName,
    email,
    phone,
    active,
    customerNumber,
    companyName,
    gender,
    birthDate,
    comment,
    firstSeenAt: createdAt,
    address: parseAddress(entry),
    updatedAt,
  };
}

function resolveSyncLocationSlugs(config: TillhubConfig): string[] {
  const env = splitLocationSlugs(process.env.TILLHUB_CUSTOMER_SYNC_LOCATIONS ?? null);
  if (env.length) return env;
  return splitLocationSlugs(config.customerSync.locationSlug);
}

function resolveCustomerEndpointCandidates(
  config: TillhubConfig,
  loginIdCandidates: string[] = [],
  accountIdCandidates: string[] = [],
): string[] {
  const custom = normalizeString(config.customerSync.customerEndpoint);
  if (custom) {
    const accountId = config.accountId || accountIdCandidates[0] || null;
    const withAccount = custom.includes("{accountId}") ? accountId : custom;
    if (withAccount && withAccount.includes("{accountId}")) {
      return [];
    }
    const loginId = config.loginId || loginIdCandidates[0] || null;
    const withLogin = withAccount.includes("{loginId}") ? loginId : withAccount;
    if (withLogin && withLogin.includes("{loginId}")) {
      return [];
    }
    const normalized = withLogin
      .replace("{accountId}", accountId ?? "")
      .replace("{loginId}", loginId ?? "");
    return [normalized.replace(/^\/+/, "")];
  }

  const candidates: string[] = [];
  const loginIds = loginIdCandidates.length
    ? loginIdCandidates
    : config.loginId
      ? [config.loginId]
      : [];
  for (const loginId of loginIds) {
    const root = resolveTillhubRoot(config);
    candidates.push(`${root}/api/v1/customers/${loginId}`);
    candidates.push(`${root}/api/v0/customers/${loginId}`);
    candidates.push(`users/${loginId}/customers`);
    candidates.push(`customers/${loginId}`);
  }
  candidates.push("customers");
  const accountIds = accountIdCandidates.length
    ? accountIdCandidates
    : config.accountId
      ? [config.accountId]
      : [];
  for (const accountId of accountIds) {
    const root = resolveTillhubRoot(config);
    candidates.push(`${root}/api/v1/customers/${accountId}`);
    candidates.push(`${root}/api/v0/customers/${accountId}`);
    candidates.push(`${root}/api/v0/customers/${accountId}/legacy`);
    candidates.push(`accounts/${accountId}/customers`);
    candidates.push(`customers/${accountId}`);
  }

  return Array.from(new Set(candidates));
}

function buildEmailPhoneKey(email: string | null, phone: string | null): string | null {
  if (!email || !phone) return null;
  const digits = digitsOnly(phone);
  if (!digits) return null;
  return `${email.toLowerCase()}|${digits}`;
}

type ExistingCustomer = {
  id: string;
  email: string | null;
  phone: string | null;
  metadata: Prisma.JsonValue | null;
  locationId: string;
  firstName: string;
  lastName: string;
};

type ExistingCustomerIndex = {
  byTillhubId: Map<string, ExistingCustomer>;
  byEmailPhone: Map<string, ExistingCustomer>;
};

async function loadExistingCustomers(
  locationIds: string[],
  membershipSupported: boolean,
): Promise<ExistingCustomerIndex> {
  const prisma = getPrismaClient();
  const scope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        OR: [
          { locationId: { in: locationIds } },
          { memberships: { some: { locationId: { in: locationIds } } } },
        ],
      }
    : { locationId: { in: locationIds } };

  const rows = await prisma.customer.findMany({
    where: scope,
    select: { id: true, email: true, phone: true, metadata: true, locationId: true, firstName: true, lastName: true },
  });

  const byTillhubId = new Map<string, Customer>();
  const byEmailPhone = new Map<string, Customer>();

  for (const row of rows) {
    const meta = isRecord(row.metadata) ? (row.metadata as Record<string, unknown>) : null;
    const tillhub = meta && isRecord(meta.tillhub) ? (meta.tillhub as Record<string, unknown>) : null;
    const tillhubId = normalizeString(tillhub?.customerId ?? tillhub?.id);
    if (tillhubId) {
      byTillhubId.set(tillhubId, row);
    }
    const key = buildEmailPhoneKey(row.email ?? null, row.phone ?? null);
    if (key && !byEmailPhone.has(key)) {
      byEmailPhone.set(key, row);
    }
  }

  return { byTillhubId, byEmailPhone };
}

export async function syncTillhubCustomersForTenant(tenantId: string): Promise<SyncSummary> {
  const prisma = getPrismaClient();
  const logger = getLogger();
  const config = await fetchTillhubConfig(tenantId);
  const envLocations = splitLocationSlugs(process.env.TILLHUB_CUSTOMER_SYNC_LOCATIONS ?? null);
  if (!config) {
    logger.warn({ tenantId }, "tillhub customer sync skipped: config not found");
    return { tenantId, locations: [], total: 0, created: 0, updated: 0, skipped: 0 };
  }
  if (!config.enabled) {
    logger.info({ tenantId }, "tillhub customer sync skipped: tillhub disabled");
    return { tenantId, locations: [], total: 0, created: 0, updated: 0, skipped: 0 };
  }
  if (!config.customerSync?.enabled) {
    logger.info({ tenantId }, "tillhub customer sync skipped: customer sync disabled");
    return { tenantId, locations: [], total: 0, created: 0, updated: 0, skipped: 0 };
  }

  const locationSlugs = envLocations.length ? envLocations : resolveSyncLocationSlugs(config);
  if (!locationSlugs.length) {
    logger.warn({ tenantId }, "tillhub customer sync skipped: no location slugs configured");
    return { tenantId, locations: [], total: 0, created: 0, updated: 0, skipped: 0 };
  }

  let locations = await prisma.location.findMany({
    where: { tenantId, slug: { in: locationSlugs } },
    select: { id: true, slug: true, tenantId: true },
  });
  if (!locations.length) {
    locations = await prisma.location.findMany({
      where: { slug: { in: locationSlugs } },
      select: { id: true, slug: true, tenantId: true },
    });
    locations = locations.filter((loc) => !loc.tenantId || loc.tenantId === tenantId);
  }
  if (!locations.length) {
    logger.warn({ tenantId, locationSlugs }, "tillhub customer sync skipped: locations not found");
    return { tenantId, locations: locationSlugs, total: 0, created: 0, updated: 0, skipped: 0 };
  }

  const membershipSupported = await supportsCustomerMemberships(prisma);
  const locationIds = locations.map((loc) => loc.id);
  const primaryLocationId = locationIds[0];
  const existingIndex = await loadExistingCustomers(locationIds, membershipSupported);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  try {
    const rawCustomers = await fetchTillhubCustomers(config);
    const includeInactive = true;
    const sinceCutoff = normalizeDateTime(config.customerSync.since ?? config.customerSync.lastSyncAt ?? null);
    const sinceMs = sinceCutoff ? new Date(sinceCutoff).getTime() : null;

    for (const entry of rawCustomers) {
      const parsed = parseTillhubCustomer(entry);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      if (!includeInactive && !parsed.active) {
        skipped += 1;
        continue;
      }
      if (sinceMs && parsed.updatedAt) {
        const updatedAtMs = new Date(parsed.updatedAt).getTime();
        if (Number.isFinite(updatedAtMs) && updatedAtMs < sinceMs) {
          skipped += 1;
          continue;
        }
      }

      const key = buildEmailPhoneKey(parsed.email, parsed.phone);
      const existing =
        existingIndex.byTillhubId.get(parsed.id) ||
        (key ? existingIndex.byEmailPhone.get(key) ?? null : null);

      const profileUpdates: Partial<CustomerProfile> = {
        active: parsed.active,
        gender: parsed.gender,
        birthDate: parsed.birthDate,
        customerNumber: parsed.customerNumber,
        companyName: parsed.companyName,
        comment: parsed.comment,
        firstSeenAt: parsed.firstSeenAt,
        address: parsed.address,
      };
      const tillhubMeta: Record<string, unknown> = {
        customerId: parsed.id,
        customerNumber: parsed.customerNumber,
        active: parsed.active,
        updatedAt: parsed.updatedAt,
        importedAt: new Date().toISOString(),
        source: "TILLHUB",
      };
      if (parsed.accountId) {
        tillhubMeta.accountId = parsed.accountId;
      }

      if (existing) {
        const nextMetadata = mergeCustomerMetadata(existing.metadata ?? null, profileUpdates, tillhubMeta);
        const data: Prisma.CustomerUpdateInput = {
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          metadata: nextMetadata,
        };
        if (parsed.email) data.email = parsed.email;
        if (parsed.phone) data.phone = parsed.phone;
        const updatedRecord = await prisma.customer.update({ where: { id: existing.id }, data });
        updated += 1;
        existingIndex.byTillhubId.set(parsed.id, updatedRecord);
        if (key) existingIndex.byEmailPhone.set(key, updatedRecord);

        if (membershipSupported) {
          const membershipTargets = locationIds.filter((locId) => locId !== updatedRecord.locationId);
          if (membershipTargets.length) {
            await prisma.customerLocationMembership.createMany({
              data: membershipTargets.map((locationId) => ({ customerId: updatedRecord.id, locationId })),
              skipDuplicates: true,
            });
          }
        }
        continue;
      }

      const metadata = mergeCustomerMetadata(null, profileUpdates, tillhubMeta);
      const createdRecord = await prisma.customer.create({
        data: {
          locationId: primaryLocationId,
          firstName: parsed.firstName,
          lastName: parsed.lastName,
          email: parsed.email,
          phone: parsed.phone,
          metadata,
        },
      });
      created += 1;
      existingIndex.byTillhubId.set(parsed.id, createdRecord);
      if (key) existingIndex.byEmailPhone.set(key, createdRecord);

      if (membershipSupported) {
        const membershipTargets = locationIds.filter((locId) => locId !== createdRecord.locationId);
        if (membershipTargets.length) {
          await prisma.customerLocationMembership.createMany({
            data: membershipTargets.map((locationId) => ({ customerId: createdRecord.id, locationId })),
            skipDuplicates: true,
          });
        }
      }
    }

    await updateTillhubCustomerSyncStatus(tenantId, { lastSyncAt: new Date().toISOString(), lastError: null });
    return {
      tenantId,
      locations: locations.map((loc) => loc.slug),
      total: rawCustomers.length,
      created,
      updated,
      skipped,
    };
  } catch (error) {
    await updateTillhubCustomerSyncStatus(tenantId, {
      lastError: error instanceof Error ? error.message : "Sync failed",
    });
    throw error;
  }
}
