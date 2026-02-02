import { AppointmentItemStatus, AppointmentPaymentStatus, AppointmentStatus, type Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { publishAppointmentSync } from "@/lib/appointment-sync";
import { getPrismaClient } from "@/lib/prisma";

type TillhubPosSyncMeta = {
  enabled: boolean;
  branchMap: Record<string, string>;
  registerMap: Record<string, string>;
  fallbackProductName: string | null;
  fallbackProductId: string | null;
};

type TillhubConfig = {
  enabled: boolean;
  apiBase: string | null;
  loginId: string | null;
  accountId: string | null;
  email: string | null;
  password: string | null;
  staticToken: string | null;
  posSync: TillhubPosSyncMeta;
};

type TillhubCartMeta = {
  id: string;
  status: "OPEN" | "DONE" | "FAILED";
  branchId: string | null;
  registerId: string | null;
  openedAt?: string | null;
  doneAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

type CachedToken = { value: string; expiresAt: number | null };
type CachedConfig = { value: TillhubConfig | null; expiresAt: number };

const DEFAULT_TILLHUB_BASE = "https://api.tillhub.com/api/v0";
const tokenCache = new Map<string, CachedToken>();
const configCache = new Map<string, CachedConfig>();
const fallbackProductCache = new Map<string, string | null>();
const productTaxCache = new Map<string, string | null>();
const productAccountCache = new Map<string, string | null>();
const productDetailsCache = new Map<
  string,
  {
    taxId: string | null;
    accountId: string | null;
    locations: string[];
    currencies: string[];
  } | null
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Record<string, string> = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (typeof entry === "string" && entry.trim().length) {
      entries[key] = entry.trim();
    }
  });
  return entries;
}

function resolveTillhubBase(config: TillhubConfig): string {
  return (config.apiBase?.trim() || DEFAULT_TILLHUB_BASE).replace(/\/+$/, "");
}

function resolveTillhubBaseV1(config: TillhubConfig): string {
  const base = resolveTillhubBase(config);
  if (/\/api\/v1$/i.test(base)) return base;
  if (/\/api\/v0$/i.test(base)) return base.replace(/\/api\/v0$/i, "/api/v1");
  return `${base.replace(/\/+$/, "")}/api/v1`;
}

function resolveAccountId(config: TillhubConfig): string | null {
  return normalizeString(config.accountId) || normalizeString(config.loginId);
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

function resolveTokenCacheKey(config: TillhubConfig, tenantId: string | null): string {
  return tenantId || config.accountId || config.loginId || config.email || config.apiBase || "default";
}

async function fetchTillhubConfig(tenantId: string): Promise<TillhubConfig | null> {
  const cached = configCache.get(tenantId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return null;
  const url = new URL("/api/internal/tillhub/config", baseUrl);
  url.searchParams.set("tenantId", tenantId);
  const secret = process.env.PROVISION_SECRET?.trim();
  const response = await fetch(url.toString(), {
    headers: secret ? { "x-provision-secret": secret } : undefined,
    cache: "no-store",
  });
  if (!response.ok) {
    configCache.set(tenantId, { value: null, expiresAt: now + 60_000 });
    return null;
  }
  const payload = (await response.json()) as { tillhub?: Record<string, unknown> };
  const tillhub = isRecord(payload?.tillhub) ? payload.tillhub : null;
  if (!tillhub) {
    configCache.set(tenantId, { value: null, expiresAt: now + 60_000 });
    return null;
  }
  const posRaw = isRecord(tillhub.posSync) ? tillhub.posSync : {};
  const next: TillhubConfig = {
    enabled: Boolean(tillhub.enabled),
    apiBase: normalizeString(tillhub.apiBase),
    loginId: normalizeString(tillhub.loginId),
    accountId: normalizeString(tillhub.accountId),
    email: normalizeString(tillhub.email),
    password: normalizeString(tillhub.password),
    staticToken: normalizeString(tillhub.staticToken),
    posSync: {
      enabled: typeof posRaw.enabled === "boolean" ? posRaw.enabled : false,
      branchMap: normalizeStringMap(posRaw.branchMap),
      registerMap: normalizeStringMap(posRaw.registerMap),
      fallbackProductName: normalizeString(posRaw.fallbackProductName),
      fallbackProductId: normalizeString(posRaw.fallbackProductId),
    },
  };
  configCache.set(tenantId, { value: next, expiresAt: now + 60_000 });
  return next;
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
  let expiresAt: number | null = null;
  if (json.expires_at) {
    const parsed = Date.parse(json.expires_at);
    if (Number.isFinite(parsed)) expiresAt = parsed;
  } else {
    const payload = decodeJwtPayload(token);
    if (payload && typeof payload.exp === "number") {
      expiresAt = payload.exp * 1000;
    }
  }
  tokenCache.set(cacheKey, { value: token, expiresAt });
  return token;
}

async function tillhubRequest<T>(
  config: TillhubConfig,
  tenantId: string | null,
  path: string,
  options?: {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    searchParams?: Record<string, string | null | undefined>;
    baseOverride?: string | null;
  },
): Promise<T> {
  const token = await getTillhubToken(config, tenantId);
  const base = options?.baseOverride?.trim() || resolveTillhubBase(config);
  const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
  if (options?.searchParams) {
    Object.entries(options.searchParams).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (options?.body) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url.toString(), {
    method: options?.method ?? "GET",
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tillhub request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

function extractResults(payload: unknown): Record<string, unknown>[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.filter(isRecord) as Record<string, unknown>[];
  if (isRecord(payload) && Array.isArray(payload.results)) {
    return payload.results.filter(isRecord) as Record<string, unknown>[];
  }
  return [];
}

function extractId(payload: unknown): string | null {
  if (!payload) return null;
  if (isRecord(payload) && typeof payload.id === "string") return payload.id;
  const results = extractResults(payload);
  const first = results[0];
  if (first && typeof first.id === "string") return first.id;
  return null;
}

function readTillhubCustomerId(metadata: Prisma.JsonValue | null): string | null {
  if (!isRecord(metadata)) return null;
  const tillhub = isRecord(metadata.tillhub) ? (metadata.tillhub as Record<string, unknown>) : null;
  if (!tillhub) return null;
  return (
    normalizeString(tillhub.customerId) ??
    normalizeString(tillhub.id) ??
    normalizeString(tillhub.customer_id) ??
    normalizeString(tillhub.uuid)
  );
}

function readTillhubCartMeta(metadata: Prisma.JsonValue | null): TillhubCartMeta | null {
  if (!isRecord(metadata)) return null;
  const record = metadata.tillhubCart;
  if (!isRecord(record)) return null;
  const id = normalizeString(record.id);
  const status = normalizeString(record.status) as TillhubCartMeta["status"] | null;
  if (!id || !status) return null;
  return {
    id,
    status,
    branchId: normalizeString(record.branchId),
    registerId: normalizeString(record.registerId),
    openedAt: normalizeString(record.openedAt),
    doneAt: normalizeString(record.doneAt),
    lastError: normalizeString(record.lastError),
    updatedAt: normalizeString(record.updatedAt),
  };
}

function mergeTillhubCartMeta(
  metadata: Prisma.JsonValue | null,
  update: Partial<TillhubCartMeta>,
): Prisma.InputJsonValue {
  const base = isRecord(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const current = isRecord(base.tillhubCart) ? { ...(base.tillhubCart as Record<string, unknown>) } : {};
  const next = { ...current, ...update, updatedAt: new Date().toISOString() };
  base.tillhubCart = next;
  return base as Prisma.InputJsonValue;
}

function appendPaymentHistory(
  metadata: Prisma.JsonValue | null,
  entry: Record<string, unknown>,
): Prisma.InputJsonValue {
  const base = isRecord(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const history = Array.isArray(base.paymentHistory) ? [...(base.paymentHistory as Prisma.JsonArray)] : [];
  history.push(entry as Prisma.JsonValue);
  base.paymentHistory = history;
  return base as Prisma.InputJsonValue;
}

function readTimestamp(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string") return normalizeString(value);
  if (isRecord(value) && typeof value.iso === "string") return normalizeString(value.iso);
  return null;
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object" && value && "toNumber" in value) {
    try {
      const parsed = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeCurrencyCode(value: string | null | undefined): string {
  if (!value) return "EUR";
  const trimmed = value.trim();
  if (!trimmed) return "EUR";
  if (trimmed === "€") return "EUR";
  const upper = trimmed.toUpperCase();
  if (upper === "EURO" || upper === "EUROS") return "EUR";
  return upper;
}

function readTillhubProductLocations(product: Record<string, unknown>): string[] {
  const locations = product.locations;
  if (!Array.isArray(locations)) return [];
  return locations
    .map((value) => (typeof value === "string" ? normalizeString(value) : null))
    .filter((value): value is string => Boolean(value));
}

function collectTillhubCurrencies(
  target: Set<string>,
  entry: Record<string, unknown> | null,
): void {
  if (!entry) return;
  const currency = normalizeString(entry.currency);
  if (currency) target.add(normalizeCurrencyCode(currency));
  const nestedPrices = entry.prices;
  if (Array.isArray(nestedPrices)) {
    for (const nested of nestedPrices) {
      collectTillhubCurrencies(target, isRecord(nested) ? (nested as Record<string, unknown>) : null);
    }
  }
}

function readTillhubProductCurrencies(product: Record<string, unknown>): string[] {
  const prices = product.prices;
  if (!isRecord(prices)) return [];
  const target = new Set<string>();
  const buckets = ["default_prices", "branch_prices", "scaled_prices", "time_based_prices"];
  for (const bucket of buckets) {
    const entries = (prices as Record<string, unknown>)[bucket];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (isRecord(entry)) {
        collectTillhubCurrencies(target, entry as Record<string, unknown>);
      }
    }
  }
  return Array.from(target);
}

function resolveServiceProductId(metadata: Prisma.JsonValue | null): string | null {
  if (!isRecord(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const tillhub = isRecord(record.tillhub) ? (record.tillhub as Record<string, unknown>) : null;
  return normalizeString(tillhub?.productId ?? record.tillhubProductId);
}

function applyServiceProductId(
  metadata: Prisma.JsonValue | null,
  productId: string,
): Prisma.InputJsonValue {
  const base = isRecord(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const tillhub = isRecord(base.tillhub) ? { ...(base.tillhub as Record<string, unknown>) } : {};
  tillhub.productId = productId;
  base.tillhub = tillhub;
  return base as Prisma.InputJsonValue;
}

async function findTillhubProductId(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  branchId: string;
  name: string;
}): Promise<string | null> {
  const base = resolveTillhubBaseV1(params.config);
  const payload = await tillhubRequest<unknown>(params.config, params.tenantId, `products/${params.accountId}/search`, {
    searchParams: {
      q: params.name,
      branch: params.branchId,
      sellable: "true",
    },
    baseOverride: base,
  });
  const results = extractResults(payload);
  if (!results.length) return null;
  const normalizedName = params.name.trim().toLowerCase();
  const exact = results.find((entry) => normalizeString(entry.name)?.toLowerCase() === normalizedName);
  const match = exact ?? results[0];
  return typeof match.id === "string" ? match.id : null;
}

function readTillhubProductTaxId(product: Record<string, unknown>): string | null {
  const tax = product.tax;
  if (typeof tax === "string") return normalizeString(tax);
  if (isRecord(tax) && typeof tax.id === "string") return normalizeString(tax.id);
  const taxes = product.taxes;
  if (Array.isArray(taxes)) {
    for (const entry of taxes) {
      if (typeof entry === "string") return normalizeString(entry);
      if (isRecord(entry) && typeof entry.id === "string") return normalizeString(entry.id);
    }
  }
  return null;
}

async function resolveTillhubProductTaxId(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  productId: string;
}): Promise<string | null> {
  const cacheKey = `${params.tenantId}:${params.accountId}:${params.productId}`;
  if (productTaxCache.has(cacheKey)) {
    return productTaxCache.get(cacheKey) ?? null;
  }
  const base = resolveTillhubBaseV1(params.config);
  const payload = await tillhubRequest<unknown>(
    params.config,
    params.tenantId,
    `products/${params.accountId}/${params.productId}`,
    { baseOverride: base },
  );
  const results = extractResults(payload);
  const record = results[0] ?? (isRecord(payload) ? (payload as Record<string, unknown>) : null);
  const taxId = record ? readTillhubProductTaxId(record) : null;
  productTaxCache.set(cacheKey, taxId);
  return taxId;
}

function readTillhubProductAccountId(product: Record<string, unknown>): string | null {
  const directAccountId = normalizeString(product.account_id ?? product.accountId);
  if (directAccountId) return directAccountId;
  const account = product.account;
  if (typeof account === "string") return normalizeString(account);
  if (isRecord(account)) {
    if (typeof account.id === "string") return normalizeString(account.id);
    if (typeof account.account_id === "string") return normalizeString(account.account_id);
  }
  return null;
}

async function resolveTillhubProductAccountId(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  productId: string;
}): Promise<string | null> {
  const cacheKey = `${params.tenantId}:${params.accountId}:${params.productId}`;
  if (productAccountCache.has(cacheKey)) {
    return productAccountCache.get(cacheKey) ?? null;
  }
  const base = resolveTillhubBaseV1(params.config);
  const payload = await tillhubRequest<unknown>(
    params.config,
    params.tenantId,
    `products/${params.accountId}/${params.productId}`,
    { baseOverride: base },
  );
  const results = extractResults(payload);
  const record = results[0] ?? (isRecord(payload) ? (payload as Record<string, unknown>) : null);
  const accountId = record ? readTillhubProductAccountId(record) : null;
  productAccountCache.set(cacheKey, accountId);
  return accountId;
}

async function resolveTillhubProductDetails(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  productId: string;
}): Promise<{
  taxId: string | null;
  accountId: string | null;
  locations: string[];
  currencies: string[];
} | null> {
  const cacheKey = `${params.tenantId}:${params.accountId}:${params.productId}`;
  if (productDetailsCache.has(cacheKey)) {
    return productDetailsCache.get(cacheKey) ?? null;
  }
  const base = resolveTillhubBaseV1(params.config);
  const payload = await tillhubRequest<unknown>(
    params.config,
    params.tenantId,
    `products/${params.accountId}/${params.productId}`,
    { baseOverride: base },
  );
  const results = extractResults(payload);
  const record = results[0] ?? (isRecord(payload) ? (payload as Record<string, unknown>) : null);
  if (!record) {
    productDetailsCache.set(cacheKey, null);
    return null;
  }
  const details = {
    taxId: readTillhubProductTaxId(record),
    accountId: readTillhubProductAccountId(record),
    locations: readTillhubProductLocations(record),
    currencies: readTillhubProductCurrencies(record),
  };
  productDetailsCache.set(cacheKey, details);
  return details;
}
async function resolveFallbackProductId(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  branchId: string;
  name: string;
}): Promise<string | null> {
  const key = `${params.tenantId}:${params.branchId}:${params.name.toLowerCase()}`;
  if (fallbackProductCache.has(key)) {
    return fallbackProductCache.get(key) ?? null;
  }
  const productId = await findTillhubProductId(params);
  fallbackProductCache.set(key, productId);
  return productId;
}

async function openTillhubCart(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  cartId: string;
}): Promise<void> {
  const base = resolveTillhubBaseV1(params.config);
  await tillhubRequest(
    params.config,
    params.tenantId,
    `carts/${params.accountId}/${params.cartId}/open`,
    {
      method: "POST",
      baseOverride: base,
    },
  );
}

async function closeTillhubCart(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  cartId: string;
}): Promise<void> {
  const base = resolveTillhubBaseV1(params.config);
  await tillhubRequest(
    params.config,
    params.tenantId,
    `carts/${params.accountId}/${params.cartId}/done`,
    {
      method: "POST",
      baseOverride: base,
    },
  );
}

async function fetchTillhubCart(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  cartId: string;
}): Promise<{ doneAt: string | null }> {
  const base = resolveTillhubBaseV1(params.config);
  const payload = await tillhubRequest<unknown>(
    params.config,
    params.tenantId,
    `carts/${params.accountId}/${params.cartId}`,
    {
      baseOverride: base,
    },
  );
  const results = extractResults(payload);
  const cart = results[0] ?? null;
  if (!cart) return { doneAt: null };
  return {
    doneAt: readTimestamp(cart, "done_at") ?? readTimestamp(cart, "doneAt"),
  };
}

async function createTillhubCart(params: {
  config: TillhubConfig;
  tenantId: string;
  accountId: string;
  branchId: string;
  registerId: string;
  appointment: {
    id: string;
    startsAt: Date;
  };
  customer: {
    name: string | null;
    tillhubId: string | null;
  };
  items: Array<{
    productId: string;
    currency: string;
    name: string;
    taxId: string | null;
    accountId: string | null;
    amount: { gross: number } | null;
  }>;
}): Promise<string> {
  const base = resolveTillhubBaseV1(params.config);
  const payload = {
    type: "cart",
    branch: params.branchId,
    register: params.registerId,
    currency: params.items[0]?.currency ?? undefined,
    client_id: params.appointment.id,
    external_reference_id: params.appointment.id,
    name: params.customer.name
      ? `Termin ${params.customer.name}`
      : `Termin ${params.appointment.startsAt.toISOString()}`,
    customer: params.customer.tillhubId ?? undefined,
    customer_name: params.customer.tillhubId ? undefined : params.customer.name ?? undefined,
    items: params.items.map((item) => ({
      product: item.productId,
      qty: 1,
      currency: item.currency,
      name: item.name,
      tax: item.taxId ?? undefined,
      account: item.accountId ?? undefined,
      amount: item.amount ?? undefined,
    })),
  };
  const response = await tillhubRequest<unknown>(params.config, params.tenantId, `carts/${params.accountId}`, {
    method: "POST",
    body: payload,
    baseOverride: base,
  });
  const cartId = extractId(response);
  if (!cartId) {
    throw new Error("Tillhub cart response did not include an id.");
  }
  return cartId;
}

function getAppointmentCustomerName(customer: { firstName: string | null; lastName: string | null } | null): string | null {
  if (!customer) return null;
  const first = customer.firstName?.trim() ?? "";
  const last = customer.lastName?.trim() ?? "";
  const combined = `${first} ${last}`.trim();
  return combined.length ? combined : null;
}

function isAppointmentEligible(status: AppointmentStatus): boolean {
  return status === "CONFIRMED";
}

function isAppointmentCancellation(status: AppointmentStatus): boolean {
  return status === "CANCELLED" || status === "NO_SHOW";
}

export async function syncTillhubAppointmentCarts() {
  const logger = getLogger();
  const prisma = getPrismaClient();
  const now = Date.now();
  const windowMinutes = Number.parseInt(process.env.TILLHUB_POS_SYNC_WINDOW_MINUTES ?? "5", 10);
  const cancelWindowMinutes = Number.parseInt(process.env.TILLHUB_POS_CANCEL_WINDOW_MINUTES ?? "60", 10);
  const paymentWindowRaw = Number.parseInt(process.env.TILLHUB_POS_PAYMENT_WINDOW_MINUTES ?? "1440", 10);
  const paymentWindowMinutes = Number.isFinite(paymentWindowRaw) && paymentWindowRaw > 0 ? paymentWindowRaw : 1440;
  const startWindow = new Date(now - windowMinutes * 60 * 1000);
  const endWindow = new Date(now);
  const cancelWindow = new Date(now - cancelWindowMinutes * 60 * 1000);
  const paymentWindow = new Date(now - paymentWindowMinutes * 60 * 1000);

  const dueAppointments = await prisma.appointment.findMany({
    where: {
      startsAt: { gte: startWindow, lte: endWindow },
      status: { in: ["CONFIRMED"] },
    },
    select: {
      id: true,
      startsAt: true,
      status: true,
      metadata: true,
      currency: true,
      location: { select: { id: true, slug: true, tenantId: true } },
      customer: { select: { id: true, firstName: true, lastName: true, metadata: true } },
      items: {
        select: {
          id: true,
          price: true,
          currency: true,
          service: { select: { id: true, name: true, metadata: true } },
        },
      },
    },
  });

  const cancelledAppointments = await prisma.appointment.findMany({
    where: {
      OR: [
        { status: "NO_SHOW" },
        { status: "CANCELLED", updatedAt: { gte: cancelWindow } },
      ],
    },
    select: {
      id: true,
      status: true,
      metadata: true,
      location: { select: { id: true, slug: true, tenantId: true } },
    },
  });

  const paymentCandidates = await prisma.appointment.findMany({
    where: {
      startsAt: { gte: paymentWindow, lte: endWindow },
      status: { in: [AppointmentStatus.CONFIRMED, AppointmentStatus.COMPLETED] },
      metadata: { path: ["tillhubCart", "status"], equals: "OPEN" },
    },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      metadata: true,
      currency: true,
      totalAmount: true,
      location: { select: { id: true, slug: true, tenantId: true } },
    },
  });

  let created = 0;
  let skipped = 0;
  let failed = 0;
  let closed = 0;
  let paid = 0;

  const configByTenant = new Map<string, TillhubConfig | null>();

  for (const appointment of dueAppointments) {
    if (!isAppointmentEligible(appointment.status)) continue;
    const existingCart = readTillhubCartMeta(appointment.metadata);
    if (existingCart?.status === "OPEN" || existingCart?.status === "DONE") {
      skipped += 1;
      continue;
    }

    const tenantId = appointment.location.tenantId;
    let config = configByTenant.get(tenantId);
    if (!configByTenant.has(tenantId)) {
      config = await fetchTillhubConfig(tenantId);
      configByTenant.set(tenantId, config ?? null);
    }
    if (!config || !config.enabled || !config.posSync.enabled) {
      skipped += 1;
      continue;
    }

    const branchId = config.posSync.branchMap[appointment.location.slug];
    const registerId = config.posSync.registerMap[appointment.location.slug];
    if (!branchId || !registerId) {
      logger.warn(
        { appointmentId: appointment.id, slug: appointment.location.slug },
        "tillhub pos mapping missing for location",
      );
      skipped += 1;
      continue;
    }

    const accountId = resolveAccountId(config);
    if (!accountId) {
      logger.warn({ tenantId, appointmentId: appointment.id }, "tillhub account id missing");
      skipped += 1;
      continue;
    }

    try {
      const fallbackName = config.posSync.fallbackProductName?.trim() || null;
      const fallbackProductId = config.posSync.fallbackProductId?.trim() || null;
      const items: Array<{
        productId: string;
        currency: string;
        name: string;
        taxId: string | null;
        accountId: string | null;
        amount: { gross: number } | null;
      }> = [];
      const validateProduct = async (
        candidateId: string,
        source: string,
        currency: string,
      ): Promise<{
        valid: boolean;
        details: {
          taxId: string | null;
          accountId: string | null;
          locations: string[];
          currencies: string[];
        } | null;
      }> => {
        try {
          const details = await resolveTillhubProductDetails({
            config,
            tenantId,
            accountId,
            productId: candidateId,
          });
          if (!details) return { valid: false, details: null };
          const hasBranch = details.locations.length === 0 || details.locations.includes(branchId);
          const hasCurrency = details.currencies.includes(currency);
          const hasAccount = Boolean(details.accountId);
          const hasTax = Boolean(details.taxId);
          if (!hasBranch || !hasCurrency || !hasAccount || !hasTax) {
            logger.warn(
              {
                appointmentId: appointment.id,
                productId: candidateId,
                source,
                branchId,
                currency,
                hasBranch,
                hasCurrency,
                hasAccount,
                hasTax,
              },
              "tillhub product invalid for location or currency",
            );
            return { valid: false, details };
          }
          return { valid: true, details };
        } catch (error) {
          logger.warn(
            { err: error, appointmentId: appointment.id, productId: candidateId, source },
            "tillhub product validation failed",
          );
          return { valid: false, details: null };
        }
      };
      for (const entry of appointment.items) {
        const service = entry.service;
        if (!service) continue;
        const itemCurrency = normalizeCurrencyCode(entry.currency || appointment.currency || "EUR");
        const itemPrice = decimalToNumber(entry.price);
        const itemAmount = itemPrice != null ? { gross: roundCurrency(itemPrice) } : null;
        let productId = resolveServiceProductId(service.metadata ?? null);
        let productDetails: Awaited<ReturnType<typeof resolveTillhubProductDetails>> | null = null;
        if (productId) {
          const validation = await validateProduct(productId, "stored", itemCurrency);
          if (validation.valid) {
            productDetails = validation.details;
          } else {
            productId = null;
          }
        }
        if (!productId) {
          try {
            productId = await findTillhubProductId({
              config,
              tenantId,
              accountId,
              branchId,
              name: service.name,
            });
          } catch (error) {
            logger.warn({ err: error, appointmentId: appointment.id }, "tillhub product search failed");
            productId = null;
          }
          if (productId) {
            const validation = await validateProduct(productId, "search", itemCurrency);
            if (validation.valid) {
              productDetails = validation.details;
              await prisma.service.update({
                where: { id: service.id },
                data: { metadata: applyServiceProductId(service.metadata ?? null, productId) },
              });
            } else {
              productId = null;
            }
          }
        }
        if (!productId && fallbackProductId) {
          const validation = await validateProduct(fallbackProductId, "fallback-id", itemCurrency);
          if (validation.valid) {
            productId = fallbackProductId;
            productDetails = validation.details;
          }
        }
        if (!productId && fallbackName) {
          const fallbackId = await resolveFallbackProductId({
            config,
            tenantId,
            accountId,
            branchId,
            name: fallbackName,
          });
          if (fallbackId) {
            const validation = await validateProduct(fallbackId, "fallback-name", itemCurrency);
            if (validation.valid) {
              productId = fallbackId;
              productDetails = validation.details;
            }
          }
        }
        if (!productId || !productDetails) {
          throw new Error(`Tillhub product not found for service ${service.name}`);
        }
        const taxId = productDetails.taxId;
        const productAccountId = productDetails.accountId;
        if (!taxId || !productAccountId) {
          throw new Error(`Tillhub product missing financial references for service ${service.name}`);
        }
        items.push({
          productId,
          currency: itemCurrency,
          name: service.name,
          taxId,
          accountId: productAccountId,
          amount: itemAmount,
        });
      }

      if (!items.length) {
        throw new Error("No appointment items resolved for Tillhub cart.");
      }

      const customerName = getAppointmentCustomerName(appointment.customer);
      const cartId = await createTillhubCart({
        config,
        tenantId,
        accountId,
        branchId,
        registerId,
        appointment: { id: appointment.id, startsAt: appointment.startsAt },
        customer: {
          name: customerName,
          tillhubId: appointment.customer ? readTillhubCustomerId(appointment.customer.metadata ?? null) : null,
        },
        items,
      });
      await openTillhubCart({ config, tenantId, accountId, cartId });

      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          metadata: mergeTillhubCartMeta(appointment.metadata ?? null, {
            id: cartId,
            status: "OPEN",
            branchId,
            registerId,
            openedAt: new Date().toISOString(),
            lastError: null,
          }),
        },
      });
      created += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "unknown_error";
      logger.warn({ err: error, appointmentId: appointment.id }, "tillhub pos cart failed");
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          metadata: mergeTillhubCartMeta(appointment.metadata ?? null, {
            status: "FAILED",
            branchId,
            registerId,
            lastError: message,
          }),
        },
      });
    }
  }

  for (const appointment of cancelledAppointments) {
    if (!isAppointmentCancellation(appointment.status)) continue;
    const existingCart = readTillhubCartMeta(appointment.metadata);
    if (!existingCart || existingCart.status !== "OPEN") continue;

    const tenantId = appointment.location.tenantId;
    let config = configByTenant.get(tenantId);
    if (!configByTenant.has(tenantId)) {
      config = await fetchTillhubConfig(tenantId);
      configByTenant.set(tenantId, config ?? null);
    }
    if (!config || !config.enabled || !config.posSync.enabled) {
      continue;
    }

    const accountId = resolveAccountId(config);
    if (!accountId) continue;

    try {
      await closeTillhubCart({ config, tenantId, accountId, cartId: existingCart.id });
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          metadata: mergeTillhubCartMeta(appointment.metadata ?? null, {
            status: "DONE",
            doneAt: new Date().toISOString(),
            lastError: null,
          }),
        },
      });
      closed += 1;
    } catch (error) {
      logger.warn({ err: error, appointmentId: appointment.id }, "tillhub pos cart close failed");
    }
  }

  for (const appointment of paymentCandidates) {
    const existingCart = readTillhubCartMeta(appointment.metadata);
    if (!existingCart || existingCart.status !== "OPEN") continue;

    const tenantId = appointment.location.tenantId;
    let config = configByTenant.get(tenantId);
    if (!configByTenant.has(tenantId)) {
      config = await fetchTillhubConfig(tenantId);
      configByTenant.set(tenantId, config ?? null);
    }
    if (!config || !config.enabled || !config.posSync.enabled) {
      continue;
    }

    const accountId = resolveAccountId(config);
    if (!accountId) continue;

    try {
      const cart = await fetchTillhubCart({
        config,
        tenantId,
        accountId,
        cartId: existingCart.id,
      });
      if (!cart.doneAt) continue;

      const paidAt = cart.doneAt;
      const amount = decimalToNumber(appointment.totalAmount);
      const shouldMarkPaid =
        appointment.paymentStatus === AppointmentPaymentStatus.UNPAID ||
        appointment.paymentStatus === AppointmentPaymentStatus.AUTHORIZED;

      const metadataWithCart = mergeTillhubCartMeta(appointment.metadata ?? null, {
        status: "DONE",
        doneAt: paidAt,
        lastError: null,
      });
      const nextMetadata = shouldMarkPaid
        ? appendPaymentHistory(metadataWithCart, {
            status: AppointmentPaymentStatus.PAID,
            note: "Tillhub Zahlung bestaetigt.",
            amount: amount ?? null,
            currency: appointment.currency,
            at: paidAt,
            source: "tillhub",
          })
        : metadataWithCart;

      await prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: AppointmentStatus.COMPLETED,
            paymentStatus: shouldMarkPaid ? AppointmentPaymentStatus.PAID : appointment.paymentStatus,
            metadata: nextMetadata,
          },
        });
        await tx.appointmentItem.updateMany({
          where: {
            appointmentId: appointment.id,
            status: { in: [AppointmentItemStatus.PENDING, AppointmentItemStatus.SCHEDULED] },
          },
          data: { status: AppointmentItemStatus.COMPLETED },
        });
      });

      await publishAppointmentSync({
        locationId: appointment.location.id,
        action: "payment",
        appointmentId: appointment.id,
        timestamp: Date.now(),
      });

      paid += 1;
    } catch (error) {
      logger.warn({ err: error, appointmentId: appointment.id }, "tillhub pos payment check failed");
    }
  }

  return { created, skipped, failed, closed, paid };
}
