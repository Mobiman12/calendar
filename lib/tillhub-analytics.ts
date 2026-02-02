import "server-only";

import { getLogger } from "@/lib/logger";

type TillhubConfig = {
  enabled: boolean;
  apiBase: string | null;
  loginId: string | null;
  accountId: string | null;
  email: string | null;
  password: string | null;
  staticToken: string | null;
};

export type TillhubCustomerAnalytics = {
  source: "TILLHUB";
  customerId: string;
  fetchedAt: string;
  summary: {
    topStaff: string | null;
    lastVisit: string | null;
    mostUsedBranch: string | null;
    averageItemsPerTransaction: number | null;
    averageBasket: number | null;
    totalReturns: number | null;
    totalTransactions: number | null;
    totalProducts: number | null;
    currency: string | null;
  };
  transactions: TillhubCustomerTransaction[];
};

export type TillhubCustomerTransaction = {
  id: string;
  date: string | null;
  receiptNumber: string | null;
  staff: string | null;
  branchNumber: string | null;
  registerId: string | null;
  balanceId: string | null;
  totalGross: number | null;
  currency: string | null;
  type: string | null;
};

type CachedToken = { value: string; expiresAt: number | null };
type CachedAnalytics = { data: TillhubCustomerAnalytics; expiresAt: number };
type CachedClientIds = { ids: string[]; expiresAt: number };
type CachedAccountIds = { ids: string[]; expiresAt: number };

const DEFAULT_TILLHUB_BASE = "https://api.tillhub.com/api/v0";
const CACHE_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map<string, CachedToken>();
const analyticsCache = new Map<string, CachedAnalytics>();
const clientIdCache = new Map<string, CachedClientIds>();
const accountIdCache = new Map<string, CachedAccountIds>();

const logger = getLogger("tillhub:analytics");

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isEmail(value: string): boolean {
  return /@/.test(value);
}

function isLikelyId(value: string): boolean {
  if (!value.trim().length) return false;
  if (isEmail(value)) return false;
  if (value.startsWith("eyJ") && value.includes(".") && value.length > 50) return false;
  return value.length <= 120;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMoney(value: unknown): number | null {
  const numeric = normalizeNumber(value);
  if (numeric === null) return null;
  if (Number.isInteger(numeric) && Math.abs(numeric) >= 1000 && numeric % 100 === 0) {
    return numeric / 100;
  }
  return numeric;
}

function normalizeDateTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const raw = normalizeString(value);
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toISOString();
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findDirectValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  const normalized = new Map<string, string>();
  Object.keys(record).forEach((entry) => normalized.set(normalizeKey(entry), entry));
  for (const key of keys) {
    const match = normalized.get(normalizeKey(key));
    if (match) return record[match];
  }
  return undefined;
}

function flattenEntries(value: unknown): unknown[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  const candidates = [
    "results",
    "data",
    "values",
    "items",
    "transactions",
    "last_transactions_v0",
    "last_transactions",
    "lastTransactions",
    "rows",
    "entries",
  ];
  for (const key of candidates) {
    const found = (value as Record<string, unknown>)[key];
    if (Array.isArray(found)) return found;
  }
  const analytics = (value as Record<string, unknown>).analytics;
  if (isRecord(analytics)) {
    for (const key of candidates) {
      const found = (analytics as Record<string, unknown>)[key];
      if (Array.isArray(found)) return found;
    }
  }
  return [];
}

function resolveSummarySource(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.summary)) return value.summary as Record<string, unknown>;
  if (isRecord(value.analytics)) {
    const analytics = value.analytics as Record<string, unknown>;
    if (isRecord(analytics.summary)) return analytics.summary as Record<string, unknown>;
    return analytics;
  }
  const results = value.results;
  if (Array.isArray(results)) {
    for (const entry of results) {
      const summary = resolveSummarySource(entry);
      if (summary) return summary;
    }
  } else if (isRecord(results)) {
    const summary = resolveSummarySource(results);
    if (summary) return summary;
  }
  return null;
}

function resolveTransactionsEntries(payload: unknown): Record<string, unknown>[] {
  const direct = flattenEntries(payload).filter(isRecord) as Record<string, unknown>[];
  if (direct.length) return direct;
  if (!isRecord(payload)) return [];
  const directPayload = payload as Record<string, unknown>;
  const directTransactions =
    directPayload.transactions ??
    directPayload.last_transactions_v0 ??
    directPayload.last_transactions ??
    directPayload.lastTransactions;
  if (Array.isArray(directTransactions)) {
    return directTransactions.filter(isRecord) as Record<string, unknown>[];
  }
  if (isRecord(payload.analytics)) {
    const analytics = payload.analytics as Record<string, unknown>;
    const nestedTransactions =
      analytics.transactions ??
      analytics.last_transactions_v0 ??
      analytics.last_transactions ??
      analytics.lastTransactions;
    if (Array.isArray(nestedTransactions)) {
      return nestedTransactions.filter(isRecord) as Record<string, unknown>[];
    }
  }
  const results = payload.results;
  if (isRecord(results)) {
    const nested = flattenEntries(results).filter(isRecord) as Record<string, unknown>[];
    if (nested.length) return nested;
  }
  if (Array.isArray(results)) {
    for (const entry of results) {
      if (!isRecord(entry)) continue;
      if (Array.isArray(entry.transactions)) {
        return entry.transactions.filter(isRecord) as Record<string, unknown>[];
      }
      if (isRecord(entry.analytics) && Array.isArray(entry.analytics.transactions)) {
        return entry.analytics.transactions.filter(isRecord) as Record<string, unknown>[];
      }
    }
  }
  return [];
}

function extractValueFromSummary(
  payload: unknown,
  summarySource: Record<string, unknown> | null,
  keys: string[],
): unknown {
  if (summarySource) {
    const value = extractValue(summarySource, keys);
    if (value !== undefined) return value;
  }
  return extractValue(payload, keys);
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (Array.isArray(value)) {
    return value.find((entry) => isRecord(entry)) ?? null;
  }
  return null;
}

function resolveCustomerRecord(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  const results = payload.results;
  if (Array.isArray(results)) return firstRecord(results);
  if (isRecord(results)) return results;
  const data = payload.data;
  if (isRecord(data)) return data;
  const customer = payload.customer;
  if (isRecord(customer)) return customer;
  return payload;
}

function mergeSummary(
  primary: TillhubCustomerAnalytics["summary"],
  fallback: TillhubCustomerAnalytics["summary"],
): TillhubCustomerAnalytics["summary"] {
  return {
    topStaff: primary.topStaff ?? fallback.topStaff,
    lastVisit: primary.lastVisit ?? fallback.lastVisit,
    mostUsedBranch: primary.mostUsedBranch ?? fallback.mostUsedBranch,
    averageItemsPerTransaction: primary.averageItemsPerTransaction ?? fallback.averageItemsPerTransaction,
    averageBasket: primary.averageBasket ?? fallback.averageBasket,
    totalReturns: primary.totalReturns ?? fallback.totalReturns,
    totalTransactions: primary.totalTransactions ?? fallback.totalTransactions,
    totalProducts: primary.totalProducts ?? fallback.totalProducts,
    currency: primary.currency ?? fallback.currency,
  };
}

function resolveAggregateMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = resolveAggregateMoney(entry);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (isRecord(value)) {
    const gross = findDirectValue(value, ["gross", "amount_gross", "amountGross", "total_gross", "amount_gross_total", "gross_total"]);
    const net = findDirectValue(value, ["net", "amount_net", "amountNet", "total_net", "net_total"]);
    const direct = findDirectValue(value, ["amount", "total", "value", "sum"]);
    return normalizeMoney(gross ?? net ?? direct);
  }
  return normalizeMoney(value);
}

function resolveAggregateNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = resolveAggregateNumber(entry);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  if (isRecord(value)) {
    const direct = findDirectValue(value, ["value", "count", "total", "sum", "amount"]);
    return normalizeNumber(direct ?? value);
  }
  return normalizeNumber(value);
}

function resolveAggregateCurrency(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = resolveAggregateCurrency(entry);
      if (resolved) return resolved;
    }
    return null;
  }
  if (isRecord(value)) {
    return normalizeString(findDirectValue(value, ["currency", "currency_code", "currencyCode"]));
  }
  return null;
}

function extractAggregateMoney(
  payload: unknown,
  summarySource: Record<string, unknown> | null,
  keys: string[],
): number | null {
  return resolveAggregateMoney(extractValueFromSummary(payload, summarySource, keys));
}

function extractAggregateNumber(
  payload: unknown,
  summarySource: Record<string, unknown> | null,
  keys: string[],
): number | null {
  return resolveAggregateNumber(extractValueFromSummary(payload, summarySource, keys));
}

function extractAggregateCurrency(
  payload: unknown,
  summarySource: Record<string, unknown> | null,
  keys: string[],
): string | null {
  return resolveAggregateCurrency(extractValueFromSummary(payload, summarySource, keys));
}

function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("(404)") || message.includes("404") || message.includes("route not found");
}

function isInvalidRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("(422)") || message.includes("422");
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("(401)") || message.includes("(403)") || message.includes("401") || message.includes("403");
}

function matchesCustomerId(entry: Record<string, unknown>, identifiers: string[]): boolean {
  if (!identifiers.length) return false;
  const candidates: Array<unknown> = [
    entry.customerId,
    entry.customer_id,
    entry.customerID,
    entry.customer,
    entry.customer_uuid,
    entry.customerUuid,
    entry.customer_number,
    entry.customerNumber,
    entry.id,
  ];
  if (isRecord(entry.customer)) {
    candidates.push(
      entry.customer.id,
      entry.customer.customerId,
      entry.customer.customer_id,
      entry.customer.customer_number,
      entry.customer.customerNumber,
      entry.customer.uuid,
    );
  }
  const normalizedTargets = identifiers.map((value) => value.trim().toLowerCase());
  return candidates.some((value) => {
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      return normalizedTargets.includes(normalized);
    }
    return false;
  });
}

function hasCustomerIdFields(entry: Record<string, unknown>): boolean {
  const candidates: Array<unknown> = [
    entry.customerId,
    entry.customer_id,
    entry.customerID,
    entry.customer,
    entry.customer_uuid,
    entry.customerUuid,
    entry.customer_number,
    entry.customerNumber,
    entry.id,
  ];
  if (isRecord(entry.customer)) {
    candidates.push(
      entry.customer.id,
      entry.customer.customerId,
      entry.customer.customer_id,
      entry.customer.customer_number,
      entry.customer.customerNumber,
      entry.customer.uuid,
    );
  }
  return candidates.some((value) => typeof value === "string" && value.trim().length);
}

function pickCustomerEntry(payload: unknown, identifiers: string[]): Record<string, unknown> | null {
  const entries = flattenEntries(payload).filter(isRecord) as Record<string, unknown>[];
  return entries.find((entry) => matchesCustomerId(entry, identifiers)) ?? null;
}

function filterTransactionsByCustomer(
  payload: unknown,
  identifiers: string[],
): Record<string, unknown>[] {
  const entries = flattenEntries(payload).filter(isRecord) as Record<string, unknown>[];
  const matches = entries.filter((entry) => matchesCustomerId(entry, identifiers));
  if (matches.length) return matches;
  const anyCustomerFields = entries.some((entry) => hasCustomerIdFields(entry));
  if (!anyCustomerFields) return entries;
  if (entries.length <= 10) return entries;
  return [];
}

function collectCandidatesFromObject(value: unknown, target: Set<string>) {
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      const normalizedKey = normalizeKey(key);
      if (
        normalizedKey.includes("client") ||
        normalizedKey.includes("account") ||
        normalizedKey.includes("organisation") ||
        normalizedKey.includes("organization") ||
        normalizedKey.includes("org") ||
        normalizedKey.includes("tenant") ||
        normalizedKey.includes("login")
      ) {
        const trimmed = entry.trim();
        if (isLikelyId(trimmed)) target.add(trimmed);
      }
      continue;
    }
    if (isRecord(entry)) {
      collectCandidatesFromObject(entry, target);
    }
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    const json = Buffer.from(normalized, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractFromKeyValue(entries: unknown[], keys: string[]): unknown {
  const normalizedKeys = keys.map((key) => normalizeKey(key));
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const labelRaw =
      findDirectValue(entry, ["key", "name", "metric", "label", "id", "type"]) ?? null;
    const label = normalizeString(labelRaw);
    if (!label) continue;
    const normalizedLabel = normalizeKey(label);
    if (!normalizedKeys.includes(normalizedLabel)) continue;
    const value =
      findDirectValue(entry, ["value", "amount", "total", "sum", "count", "gross"]) ?? null;
    if (value !== null) return value;
  }
  return undefined;
}

function extractValue(payload: unknown, keys: string[]): unknown {
  if (isRecord(payload)) {
    const direct = findDirectValue(payload, keys);
    if (direct !== undefined) return direct;
  }
  const entries = flattenEntries(payload);
  if (entries.length) {
    const fromEntries = extractFromKeyValue(entries, keys);
    if (fromEntries !== undefined) return fromEntries;
  }
  return undefined;
}

function resolveNestedLabel(entry: Record<string, unknown>, nestedKeys: string[]): string | null {
  for (const key of nestedKeys) {
    const value = entry[key];
    if (!isRecord(value)) continue;
    const number = normalizeString(findDirectValue(value, ["number", "id", "code"]));
    const name = normalizeString(findDirectValue(value, ["name", "display_name", "displayName"]));
    if (number && name) return `${number} - ${name}`;
    if (name) return name;
    if (number) return number;
  }
  return null;
}

function resolveStaffLabel(entry: Record<string, unknown>): string | null {
  const numberRaw = findDirectValue(entry, [
    "staff_number",
    "staffNumber",
    "salesman_staff_number",
    "cashier_staff_number",
    "salesman_staff",
    "cashier_staff",
  ]);
  const number =
    normalizeString(numberRaw) ||
    (typeof numberRaw === "number" && Number.isFinite(numberRaw) ? `${numberRaw}` : null);
  const name = normalizeString(
    findDirectValue(entry, [
      "staff_name",
      "staffName",
      "salesman_name",
      "cashier_name",
      "employee_name",
      "salesman_staff_name",
      "cashier_staff_name",
    ]),
  );
  if (number && name) return `${number} - ${name}`;
  if (name) return name;
  if (number) return number;
  return resolveNestedLabel(entry, ["staff", "salesman", "cashier", "employee"]);
}

function resolveBranchLabel(entry: Record<string, unknown>): string | null {
  const numberRaw = findDirectValue(entry, ["branch_number", "branchNumber", "branch_id", "branchId"]);
  const number =
    normalizeString(numberRaw) ||
    (typeof numberRaw === "number" && Number.isFinite(numberRaw) ? `${numberRaw}` : null);
  const name = normalizeString(findDirectValue(entry, ["branch_name", "branchName", "branch"]));
  if (number && name) return `${number} - ${name}`;
  if (name) return name;
  if (number) return number;
  return resolveNestedLabel(entry, ["branch", "location"]);
}

function resolveTillhubBase(config: TillhubConfig): string {
  return (config.apiBase?.trim() || DEFAULT_TILLHUB_BASE).replace(/\/+$/, "");
}

function resolveTillhubRoot(config: TillhubConfig): string {
  const base = resolveTillhubBase(config);
  return base.replace(/\/api\/v\d+$/i, "");
}

function resolveAccountsBase(config: TillhubConfig): string {
  const base = resolveTillhubBase(config);
  if (/\/api\/v0$/i.test(base)) return base;
  if (/\/api\/v1$/i.test(base)) return base.replace(/\/api\/v1$/i, "/api/v0");
  return `${base.replace(/\/+$/, "")}/api/v0`;
}

function buildAnalyticsBases(config: TillhubConfig): string[] {
  const base = resolveTillhubBase(config);
  const bases = new Set<string>();
  const add = (value: string | null) => {
    if (!value) return;
    const trimmed = value.replace(/\/+$/, "");
    if (trimmed.length) bases.add(trimmed);
  };
  add(base);
  const lower = base.toLowerCase();
  if (/\/api\/v\d+$/.test(lower)) {
    if (lower.endsWith("/api/v1")) {
      add(base.replace(/\/api\/v1$/i, "/api/v0"));
    }
    if (lower.endsWith("/api/v0")) {
      add(base.replace(/\/api\/v0$/i, "/api/v1"));
    }
  } else {
    add(`${base}/api/v0`);
    add(`${base}/api/v1`);
  }
  return Array.from(bases);
}

function resolveTokenCacheKey(config: TillhubConfig, tenantId: string | null): string {
  return (
    tenantId ||
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
  return {
    enabled: Boolean(tillhub.enabled),
    apiBase: normalizeString(tillhub.apiBase),
    loginId: normalizeString(tillhub.loginId),
    accountId: normalizeString(tillhub.accountId),
    email: normalizeString(tillhub.email),
    password: normalizeString(tillhub.password),
    staticToken: normalizeString(tillhub.staticToken),
  };
}

async function getTillhubToken(config: TillhubConfig, tenantId: string | null): Promise<string> {
  if (config.staticToken) return config.staticToken;
  const cacheKey = resolveTokenCacheKey(config, tenantId);
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && (!cached.expiresAt || cached.expiresAt > now + 60_000)) {
    return cached.value;
  }
  if (!config.email || !config.password) {
    throw new Error("Tillhub credentials missing.");
  }
  const base = resolveTillhubBase(config);
  const response = await fetch(`${base}/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: config.email, password: config.password }),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tillhub login failed (${response.status}): ${body}`);
  }
  const json = (await response.json()) as { token?: string; expires_at?: string };
  const token = normalizeString(json.token);
  if (!token) {
    throw new Error("Tillhub login returned no token.");
  }
  const expiresAt = json.expires_at ? Date.parse(json.expires_at) : null;
  tokenCache.set(cacheKey, { value: token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null });
  return token;
}

async function tillhubFetch<T>(
  config: TillhubConfig,
  tenantId: string | null,
  path: string,
  searchParams?: Record<string, string | null | undefined>,
  baseOverride?: string | null,
): Promise<T> {
  const token = await getTillhubToken(config, tenantId);
  const base = baseOverride?.trim() || resolveTillhubBase(config);
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  if (searchParams) {
    Object.entries(searchParams).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
  }
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tillhub request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

async function tryFetchPaths(
  config: TillhubConfig,
  tenantId: string | null,
  bases: string[],
  paths: string[],
  searchParams?: Record<string, string | null | undefined>[],
  acceptPayload?: (payload: unknown) => boolean,
): Promise<{ payload: unknown; base: string; path: string }> {
  let lastError: unknown = null;
  for (const base of bases) {
    for (const path of paths) {
      const queries = searchParams && searchParams.length ? searchParams : [undefined];
      for (const query of queries) {
        try {
          const payload = await tillhubFetch<unknown>(config, tenantId, path, query, base);
          if (acceptPayload && !acceptPayload(payload)) {
            lastError = new Error("Tillhub analytics response did not include the requested customer.");
            continue;
          }
          return { payload, base, path };
        } catch (error) {
          lastError = error;
          if (!isNotFoundError(error) && !isInvalidRequestError(error) && !isAuthError(error)) {
            throw error;
          }
        }
      }
    }
  }
  throw lastError ?? new Error("Tillhub endpoint not found.");
}

async function fetchTillhubMe(config: TillhubConfig, tenantId: string | null, base: string): Promise<unknown | null> {
  try {
    return await tillhubFetch<unknown>(config, tenantId, "me", undefined, base);
  } catch (error) {
    return null;
  }
}

async function resolveClientIdCandidates(
  config: TillhubConfig,
  tenantId: string | null,
): Promise<string[]> {
  const cacheKey = resolveTokenCacheKey(config, tenantId);
  const cached = clientIdCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.ids;

  const ids = new Set<string>();
  if (config.loginId && isLikelyId(config.loginId)) ids.add(config.loginId);
  if (config.accountId && isLikelyId(config.accountId)) ids.add(config.accountId);

  try {
    const token = await getTillhubToken(config, tenantId);
    const payload = decodeJwtPayload(token);
    if (payload) collectCandidatesFromObject(payload, ids);
  } catch (error) {
    logger.warn({ err: error }, "tillhub analytics token parse failed");
  }

  const bases = buildAnalyticsBases(config);
  for (const base of bases) {
    const me = await fetchTillhubMe(config, tenantId, base);
    if (!me) continue;
    collectCandidatesFromObject(me, ids);
  }

  const resolved = Array.from(ids).filter(Boolean);
  clientIdCache.set(cacheKey, { ids: resolved, expiresAt: now + CACHE_TTL_MS });
  return resolved;
}

async function fetchAccountIdsForClient(
  config: TillhubConfig,
  tenantId: string | null,
  clientId: string,
): Promise<string[]> {
  const cacheKey = `${resolveTokenCacheKey(config, tenantId)}:${clientId}`;
  const cached = accountIdCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.ids;

  try {
    const base = resolveAccountsBase(config);
    const payload = await tillhubFetch<unknown>(config, tenantId, `accounts/${clientId}`, undefined, base);
    const entries = flattenEntries(payload).filter(isRecord) as Record<string, unknown>[];
    const ids = Array.from(
      new Set(
        entries
          .map((entry) => normalizeString(entry.id ?? entry.account_id ?? entry.accountId ?? entry.client_id))
          .filter((value): value is string => Boolean(value) && isLikelyId(value)),
      ),
    );
    accountIdCache.set(cacheKey, { ids, expiresAt: now + CACHE_TTL_MS });
    return ids;
  } catch (error) {
    if (isAuthError(error) || isNotFoundError(error)) {
      accountIdCache.set(cacheKey, { ids: [], expiresAt: now + CACHE_TTL_MS });
      return [];
    }
    logger.warn({ err: error, clientId }, "tillhub analytics account lookup failed");
    return [];
  }
}

async function resolveAnalyticsIdCandidates(
  config: TillhubConfig,
  tenantId: string | null,
): Promise<string[]> {
  const clientIds = await resolveClientIdCandidates(config, tenantId);
  const ids = new Set<string>(clientIds);
  if (clientIds[0]) {
    const accountIds = await fetchAccountIdsForClient(config, tenantId, clientIds[0]);
    accountIds.forEach((id) => ids.add(id));
  }
  return Array.from(ids);
}

function describeTillhubError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("credentials missing")) {
    return "Tillhub-Zugangsdaten fehlen.";
  }
  if (
    message.includes("did not include the requested customer") ||
    message.includes("contained no usable data")
  ) {
    return "Keine Tillhub-Analytik für diesen Kunden gefunden.";
  }
  if (message.includes("401") || message.includes("403")) {
    return "Tillhub-Zugriff verweigert. Bitte Token/Zugangsdaten prüfen.";
  }
  if (message.includes("404")) {
    return "Tillhub-Analytik nicht erreichbar. Bitte API-Basis und Login-ID/Account-ID prüfen.";
  }
  if (message.includes("429") || message.includes("rate")) {
    return "Tillhub ist vorübergehend blockiert. Bitte später erneut versuchen.";
  }
  if (
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND")
  ) {
    return "Tillhub ist aktuell nicht erreichbar.";
  }
  return "Tillhub-Analytik konnte nicht geladen werden.";
}

function parseOverview(payload: unknown, currencyFallback: string | null) {
  const entries = flattenEntries(payload).filter(isRecord) as Record<string, unknown>[];
  const summarySource =
    resolveSummarySource(payload) ??
    (entries[0] ? resolveSummarySource(entries[0]) ?? entries[0] : null);
  const topStaffSource = extractValueFromSummary(payload, summarySource, [
    "top_seller",
    "topSeller",
    "top_staff",
    "top_salesman",
    "top_cashier",
    "best_staff",
    "best_salesman",
    "top_employee",
    "topStaff",
    "bestStaff",
    "topSalesman",
  ]);
  const topStaffEntry = firstRecord(topStaffSource);
  const topStaffRaw = extractValueFromSummary(payload, summarySource, [
    "top_staff",
    "top_salesman",
    "top_cashier",
    "best_staff",
    "best_salesman",
    "top_employee",
    "topStaff",
    "bestStaff",
    "topSalesman",
  ]);
  const topStaff =
    (topStaffEntry ? resolveStaffLabel(topStaffEntry) : summarySource ? resolveStaffLabel(summarySource) : null) ||
    normalizeString(topStaffRaw) ||
    normalizeString(extractValueFromSummary(payload, summarySource, ["top_product", "top_product_name", "topProductName"])) ||
    null;

  const lastVisit = normalizeDateTime(
    extractValueFromSummary(payload, summarySource, [
      "last_visit",
      "lastVisit",
      "last_transaction",
      "lastTransaction",
      "last_purchase",
      "lastPurchase",
      "last_booking",
      "lastBooking",
      "last_date",
      "lastDate",
      "last_seen",
      "lastSeen",
    ]),
  );

  const mostUsedBranchSource = extractValueFromSummary(payload, summarySource, [
    "most_used_branch",
    "mostUsedBranch",
    "top_branch",
    "topBranch",
  ]);
  const mostUsedBranch =
    normalizeString(mostUsedBranchSource) ||
    (() => {
      const branchEntry = firstRecord(mostUsedBranchSource);
      if (branchEntry) return resolveBranchLabel(branchEntry);
      if (summarySource) return resolveBranchLabel(summarySource);
      return null;
    })();

  const averageItemsPerTransaction = extractAggregateNumber(payload, summarySource, [
    "average_items_per_transaction",
    "avg_items_per_transaction",
    "average_products_per_transaction",
    "avg_products_per_transaction",
    "avgItemsPerTransaction",
    "avgProductsPerTransaction",
  ]);

  const averageBasket = extractAggregateMoney(payload, summarySource, [
    "average_purchase_value",
    "average_cart_value",
    "avg_cart_value",
    "average_cart",
    "avg_cart",
    "average_amount",
    "avg_amount",
    "average_purchase",
    "avg_purchase",
  ]);

  const totalReturnsMoney = extractAggregateMoney(payload, summarySource, [
    "total_amount_returns",
    "returns_sum",
    "return_sum",
    "refunds_sum",
    "returns_total",
    "refunds_total",
  ]);
  const totalReturnsCount = extractAggregateNumber(payload, summarySource, [
    "total_quantity_returns",
    "returns_count",
    "return_count",
  ]);
  const totalReturns = totalReturnsMoney ?? totalReturnsCount;

  const totalTransactions = extractAggregateNumber(payload, summarySource, [
    "total_transactions",
    "transactions_count",
    "transaction_count",
    "sales_count",
  ]);

  const totalProductsMoney = extractAggregateMoney(payload, summarySource, [
    "total_amount_items_sold",
    "total_products",
    "products_total",
    "products_sum",
    "total_product_amount",
    "total_products_amount",
    "total_revenue",
    "total_revenue_gross",
    "revenue_total",
    "revenue_gross",
  ]);
  const totalProductsCount = extractAggregateNumber(payload, summarySource, [
    "total_quantity_cartitems",
    "total_quantity_items",
    "total_items_sold",
  ]);
  const totalProducts = totalProductsMoney ?? totalProductsCount;

  const currencyFromPayload = normalizeString(
    extractValueFromSummary(payload, summarySource, ["currency", "currency_code", "currencyCode"]),
  );
  const currencyFromAggregates =
    extractAggregateCurrency(payload, summarySource, [
      "average_purchase_value",
      "average_cart_value",
      "total_amount_items_sold",
      "total_amount_returns",
      "top_seller",
      "top_branch",
    ]);
  const hasMonetaryData =
    averageBasket !== null || totalReturnsMoney !== null || totalProductsMoney !== null;
  const currency =
    currencyFromPayload || currencyFromAggregates || (hasMonetaryData ? currencyFallback : null);

  return {
    topStaff,
    lastVisit,
    mostUsedBranch,
    averageItemsPerTransaction,
    averageBasket,
    totalReturns,
    totalTransactions,
    totalProducts,
    currency,
  };
}

function parseTransactions(payload: unknown, currencyFallback: string | null): TillhubCustomerTransaction[] {
  const entries = resolveTransactionsEntries(payload);
  return entries.map((entry, index) => {
    const nestedCandidates = [
      entry.transaction,
      entry.receipt,
      entry.order,
      entry.cart,
      entry.sale,
      entry.document,
      entry.payload,
      entry.data,
      entry.details,
    ];
    const nested = nestedCandidates.find((candidate) => isRecord(candidate)) as Record<string, unknown> | undefined;
    const source = nested ? ({ ...entry, ...nested } as Record<string, unknown>) : entry;

    const date = normalizeDateTime(
      findDirectValue(source, [
        "created_at",
        "createdAt",
        "date",
        "timestamp",
        "time",
        "booked_at",
        "starts_at",
        "transaction_time",
        "transaction_date",
        "finished_at",
        "closed_at",
        "time_start",
        "time_end",
      ]),
    );
    const receiptNumber = normalizeString(
      findDirectValue(source, [
        "receipt_number",
        "receiptNumber",
        "receipt_no",
        "receiptNo",
        "receipt_id",
        "receiptId",
        "bon",
        "bonnummer",
        "receipt",
        "transaction_number",
        "transactionNumber",
        "number",
      ]),
    );
    const staff = resolveStaffLabel(source) || resolveStaffLabel(entry);
    const branchNumber =
      normalizeString(findDirectValue(source, ["branch_number", "branchNumber", "branch_id", "branchId"])) ||
      normalizeString(findDirectValue(entry, ["branch_number", "branchNumber", "branch_id", "branchId"]));
    const registerId = normalizeString(
      findDirectValue(source, [
        "register_id",
        "registerId",
        "register",
        "cash_register_id",
        "cash_register",
        "register_number",
        "registerNumber",
      ]),
    );
    const balanceId = normalizeString(
      findDirectValue(source, [
        "balance_id",
        "balanceId",
        "closing_id",
        "closingId",
        "balance_number",
        "balanceNumber",
        "z_report",
        "zReport",
      ]),
    );
    const totalGross = normalizeMoney(
      findDirectValue(source, [
        "amount_gross_total",
        "gross_total",
        "total_gross",
        "revenue_gross",
        "total_amount",
        "gross_amount",
        "grand_total",
        "total",
        "amount",
        "selling_price_total",
      ]),
    );
    const currency =
      normalizeString(findDirectValue(source, ["currency", "currency_code", "currencyCode"])) || currencyFallback;
    const type = normalizeString(findDirectValue(source, ["type", "status", "transaction_type", "kind"]));

    return {
      id:
        normalizeString(findDirectValue(source, ["id", "uuid", "_id"])) ??
        `tillhub-${index}`,
      date,
      receiptNumber,
      staff,
      branchNumber,
      registerId,
      balanceId,
      totalGross,
      currency,
      type,
    };
  });
}

function hasDetailedSummaryData(summary: TillhubCustomerAnalytics["summary"]): boolean {
  return Boolean(
    summary.lastVisit ||
      summary.averageItemsPerTransaction !== null ||
      summary.averageBasket !== null ||
      summary.totalReturns !== null ||
      summary.totalTransactions !== null ||
      summary.totalProducts !== null,
  );
}

function hasSummaryData(summary: TillhubCustomerAnalytics["summary"]): boolean {
  return Boolean(
    summary.topStaff ||
      summary.lastVisit ||
      summary.mostUsedBranch ||
      summary.averageItemsPerTransaction !== null ||
      summary.averageBasket !== null ||
      summary.totalReturns !== null ||
      summary.totalTransactions !== null ||
      summary.totalProducts !== null,
  );
}

async function fetchCustomerAnalyticsFromCustomerEndpoint(params: {
  config: TillhubConfig;
  tenantId: string | null;
  base: string;
  clientId: string;
  customerId: string;
  currency: string | null;
}): Promise<{ summary: TillhubCustomerAnalytics["summary"]; transactions: TillhubCustomerTransaction[] } | null> {
  try {
    const payload = await tillhubFetch<unknown>(
      params.config,
      params.tenantId,
      `customers/${params.clientId}/${params.customerId}`,
      { extended: "true" },
      params.base,
    );
    const customer = resolveCustomerRecord(payload);
    if (!customer) return null;
    const analytics = isRecord(customer.analytics) ? (customer.analytics as Record<string, unknown>) : null;
    const summaryPayload = analytics?.summary ?? analytics ?? customer;
    const transactionsPayload =
      analytics?.last_transactions_v0 ?? analytics?.last_transactions ?? analytics?.transactions ?? customer;
    const summary = parseOverview(summaryPayload, params.currency ?? null);
    const transactions = parseTransactions(transactionsPayload, summary.currency ?? params.currency ?? null);
    if (!hasSummaryData(summary) && transactions.length === 0) return null;
    return { summary, transactions };
  } catch (error) {
    if (isAuthError(error) || isNotFoundError(error)) return null;
    logger.warn({ err: error, base: params.base, clientId: params.clientId }, "tillhub customer analytics fallback failed");
    return null;
  }
}

function buildCustomerQueries(params: {
  customerId: string;
  customerNumber?: string | null;
  currency?: string | null;
}): Array<Record<string, string | null>> {
  const base = {
    currency: params.currency ?? null,
  };
  const variants = [
    { customerId: params.customerId },
    { customer_id: params.customerId },
    { customer: params.customerId },
    { id: params.customerId },
    { customer_uuid: params.customerId },
    { customer_number: params.customerId },
  ];
  if (params.customerNumber) {
    variants.push(
      { customerId: params.customerNumber },
      { customer_id: params.customerNumber },
      { customer: params.customerNumber },
      { id: params.customerNumber },
      { customer_uuid: params.customerNumber },
      { customer_number: params.customerNumber },
      { number: params.customerNumber },
    );
  }
  return [
    ...variants.map((variant) => ({ ...base, ...variant })),
    base,
    {},
  ];
}

export async function fetchTillhubCustomerAnalytics(params: {
  tenantId: string | null;
  customerId: string | null;
  customerNumber?: string | null;
  currency?: string | null;
  accountId?: string | null;
}): Promise<{ analytics: TillhubCustomerAnalytics | null; error: string | null }> {
  const tenantId = params.tenantId?.trim() || null;
  const customerId = params.customerId?.trim() || null;
  const accountId = params.accountId?.trim() || null;
  const customerNumber = params.customerNumber?.trim() || null;
  if (!tenantId) {
    return { analytics: null, error: null };
  }

  const cacheKeyId = customerId ?? customerNumber ?? "unknown";
  const cacheKey = `${tenantId}:${cacheKeyId}`;
  const cached = analyticsCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { analytics: cached.data, error: null };
  }

  let config: TillhubConfig | null = null;
  try {
    config = await fetchTillhubConfig(tenantId);
  } catch (error) {
    logger.warn({ err: error }, "tillhub analytics config fetch failed");
    return { analytics: null, error: "Tillhub-Konfiguration nicht erreichbar." };
  }

  if (!config || !config.enabled) {
    return { analytics: null, error: null };
  }
  if (!customerId && !customerNumber) {
    return { analytics: null, error: "Keine Tillhub-ID am Kunden gefunden." };
  }

  const identifiers = [customerId, customerNumber].filter(
    (value): value is string => Boolean(value && value.trim().length),
  );

  const configIdCandidates = new Set<string>();
  if (config.loginId && isLikelyId(config.loginId)) configIdCandidates.add(config.loginId);
  if (config.accountId && isLikelyId(config.accountId)) configIdCandidates.add(config.accountId);
  const clientIdCandidates: string[] = [];
  if (accountId && isLikelyId(accountId)) clientIdCandidates.push(accountId);
  for (const candidate of configIdCandidates) {
    if (!clientIdCandidates.includes(candidate)) clientIdCandidates.push(candidate);
  }
  if (!clientIdCandidates.length) {
    const resolvedCandidates = await resolveAnalyticsIdCandidates(config, tenantId);
    resolvedCandidates.slice(0, 4).forEach((candidate) => {
      if (!clientIdCandidates.includes(candidate)) clientIdCandidates.push(candidate);
    });
  }
  if (!clientIdCandidates.length) {
    return { analytics: null, error: "Tillhub Login-ID/Account-ID konnte nicht ermittelt werden." };
  }

  try {
    const bases = buildAnalyticsBases(config);
    let lastError: unknown = null;
    for (const clientId of clientIdCandidates) {
      for (const base of bases) {
        let summary: TillhubCustomerAnalytics["summary"] | null = null;
        let list: TillhubCustomerTransaction[] = [];
        let hasAnalytics = false;
        try {
          const overviewCandidates = [
            `analytics/${clientId}/reports/customer/overview`,
            `analytics/${clientId}/reports/customer`,
            `analytics/${clientId}/reports/customers/overview`,
            `analytics/${clientId}/reports/customers`,
          ];
          const transactionCandidates = [
            `analytics/${clientId}/reports/customer/transactions`,
            `analytics/${clientId}/reports/customer/transaction`,
            `analytics/${clientId}/reports/customers/transactions`,
            `analytics/${clientId}/reports/customers/transaction`,
          ];
          const querySets = buildCustomerQueries({
            customerId: identifiers[0],
            customerNumber,
            currency: params.currency ?? null,
          });
          const overviewResult = await tryFetchPaths(
            config,
            tenantId,
            [base],
            overviewCandidates,
            querySets,
            (payload) => {
              const entries = flattenEntries(payload).filter(isRecord) as Record<string, unknown>[];
              if (entries.length <= 1) return true;
              const matched = pickCustomerEntry(payload, identifiers);
              if (matched) return true;
              return !entries.some((entry) => hasCustomerIdFields(entry));
            },
          );
          const overviewEntry = pickCustomerEntry(overviewResult.payload, identifiers);
          const overviewEntries = flattenEntries(overviewResult.payload).filter(isRecord) as Record<string, unknown>[];
          let overviewPayload: unknown = null;
          if (overviewEntry) {
            overviewPayload = overviewEntry;
          } else if (overviewEntries.length === 0) {
            overviewPayload = overviewResult.payload;
          } else if (overviewEntries.length === 1) {
            overviewPayload = overviewEntries[0];
          } else if (!overviewEntries.some((entry) => hasCustomerIdFields(entry))) {
            const currency = params.currency?.toLowerCase() ?? null;
            const byCurrency = currency
              ? overviewEntries.find((entry) => {
                  const code = normalizeString(
                    findDirectValue(entry, ["currency", "currency_code", "currencyCode"]),
                  );
                  return code?.toLowerCase() === currency;
                })
              : null;
            overviewPayload = byCurrency ?? overviewEntries[0];
          } else {
            throw new Error("Tillhub analytics response did not include the requested customer.");
          }
          let transactionsPayload: unknown = [];
          try {
            const transactionsResult = await tryFetchPaths(
              config,
              tenantId,
              [base],
              transactionCandidates,
              querySets,
            );
            const filteredTransactions = filterTransactionsByCustomer(transactionsResult.payload, identifiers);
            const transactionEntries = flattenEntries(transactionsResult.payload);
            transactionsPayload = filteredTransactions.length
              ? filteredTransactions
              : transactionEntries.length > 1
                ? []
                : transactionsResult.payload;
          } catch (error) {
            logger.warn({ err: error, tenantId, customerId, base, clientId }, "tillhub transactions not available");
          }
          summary = parseOverview(overviewPayload, params.currency ?? null);
          list = parseTransactions(transactionsPayload, summary.currency ?? params.currency ?? null);
          hasAnalytics = true;
        } catch (error) {
          lastError = error;
          logger.warn({ err: error, tenantId, customerId, base, clientId }, "tillhub analytics fetch failed");
        }
        const needsFallback = !hasAnalytics || !hasDetailedSummaryData(summary ?? {
          topStaff: null,
          lastVisit: null,
          mostUsedBranch: null,
          averageItemsPerTransaction: null,
          averageBasket: null,
          totalReturns: null,
          totalTransactions: null,
          totalProducts: null,
          currency: null,
        }) || list.length === 0;
        if (needsFallback && customerId) {
          const fallback = await fetchCustomerAnalyticsFromCustomerEndpoint({
            config,
            tenantId,
            base,
            clientId,
            customerId,
            currency: params.currency ?? null,
          });
          if (fallback) {
            summary = hasAnalytics && summary ? mergeSummary(summary, fallback.summary) : fallback.summary;
            if (list.length === 0) list = fallback.transactions;
            hasAnalytics = true;
          }
        }
        if (!hasAnalytics || !summary) continue;
        if (!hasSummaryData(summary) && list.length === 0) {
          lastError = new Error("Tillhub analytics response contained no usable data.");
          continue;
        }
        const analytics: TillhubCustomerAnalytics = {
          source: "TILLHUB",
          customerId: customerId ?? customerNumber ?? cacheKeyId,
          fetchedAt: new Date().toISOString(),
          summary,
          transactions: list,
        };
        analyticsCache.set(cacheKey, { data: analytics, expiresAt: now + CACHE_TTL_MS });
        return { analytics, error: null };
      }
    }
    return { analytics: null, error: describeTillhubError(lastError) };
  } catch (error) {
    logger.warn({ err: error, tenantId, customerId }, "tillhub analytics fetch failed");
    return { analytics: null, error: describeTillhubError(error) };
  }
}
