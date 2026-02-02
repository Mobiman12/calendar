import { randomUUID } from "crypto";

type FetchResult = {
  status: number;
  json: any;
  text: string;
  retried?: boolean;
};

type SmokeTestResult = {
  name: string;
  ok: boolean;
  info?: Record<string, unknown>;
};

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const LOCATION_SLUG = (process.env.LOCATION_SLUG ?? "demo-location").replace(/^\/+|\/+$/g, "");
const TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS ?? "15000", 10) || 15000;
const SERVICE_IDS_ENV = (process.env.SERVICE_IDS ?? "").trim();
const LOCATION_ID_ENV = (process.env.LOCATION_ID ?? "").trim();
const DAYS_AHEAD = Number.parseInt(process.env.DAYS_AHEAD ?? "1", 10) || 1;
const WINDOW_START_HOUR = Number.parseInt(process.env.WINDOW_START_HOUR ?? "9", 10);
const WINDOW_HOURS = Number.parseInt(process.env.WINDOW_HOURS ?? "2", 10) || 2;
const MAX_SCAN_DAYS = Number.parseInt(process.env.MAX_SCAN_DAYS ?? "7", 10) || 7;

function buildUrl(path: string) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${BASE_URL}${cleanPath}`;
}

function truncate(value: string, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

function safeString(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSlots(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.slots)) return payload.slots;
  if (Array.isArray(payload?.data?.slots)) return payload.data.slots;
  return [];
}

function extractLocationIdFromHtml(source: string): string | null {
  const patterns = [
    /"locationId"\s*:\s*"([^"]+)"/,
    /"location"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/,
    /\\"locationId\\"\s*:\s*\\"([^"]+)\\"/,
    /\\"location\\"\s*:\s*\{\s*\\"id\\"\s*:\s*\\"([^"]+)\\"/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchServiceIdsByLocationId(locationId: string): Promise<string[]> {
  const response = await fetchJson(buildUrl(`/api/services?locationId=${encodeURIComponent(locationId)}`));
  if (response.status !== 200) return [];
  const list = Array.isArray(response.json?.data) ? response.json.data : [];
  return list
    .map((entry: any) => (typeof entry?.id === "string" ? entry.id : null))
    .filter((id: string | null): id is string => Boolean(id));
}

function extractJsonArrayAfterKey(source: string, key: string): any[] | null {
  const direct = `"${key}":`;
  const escaped = `\\"${key}\\":`;
  let index = source.indexOf(direct);
  let escapedMode = false;
  if (index === -1) {
    index = source.indexOf(escaped);
    escapedMode = index !== -1;
  }
  if (index === -1) return null;
  const start = source.indexOf("[", index);
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  let raw = source.slice(start, end + 1);
  if (escapedMode) {
    raw = raw.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function discoverServiceIds(bookingUrl: string): Promise<string[]> {
  if (LOCATION_ID_ENV) {
    const fromEnv = await fetchServiceIdsByLocationId(LOCATION_ID_ENV);
    if (fromEnv.length) return fromEnv;
  }
  const page = await fetchJson(bookingUrl);
  if (page.status !== 200) return [];
  const locationId = extractLocationIdFromHtml(page.text);
  if (locationId) {
    const fromApi = await fetchServiceIdsByLocationId(locationId);
    if (fromApi.length) return fromApi;
  }
  const fromInitial = extractJsonArrayAfterKey(page.text, "initialServices");
  if (fromInitial) {
    return fromInitial
      .map((entry) => (typeof entry?.id === "string" ? entry.id : null))
      .filter((id): id is string => Boolean(id));
  }
  return [];
}

function resolveServiceIds(discovered: string[]): string[] {
  if (SERVICE_IDS_ENV.length > 0) {
    return SERVICE_IDS_ENV.split(",").map((value) => value.trim()).filter(Boolean);
  }
  return discovered;
}

function pickSlotTime(slot: any) {
  const from = slot.reservedFrom ?? slot.start ?? slot.window?.from;
  const to = slot.reservedTo ?? slot.end ?? slot.window?.to;
  return { from, to };
}

function ensureSteps(slot: any, services: any[]): any[] {
  const { from, to } = pickSlotTime(slot);
  return services.map((service, index) => {
    const steps = Array.isArray(service.steps) && service.steps.length > 0 ? service.steps : null;
    if (steps) {
      return {
        ...service,
        steps: steps.map((step: any) => ({
          stepId: step.stepId ?? `step-${index + 1}`,
          start: step.start ?? from,
          end: step.end ?? to,
          requiresStaff: step.requiresStaff ?? true,
          resourceIds: Array.isArray(step.resourceIds) ? step.resourceIds : [],
        })),
      };
    }
    return {
      ...service,
      steps: [
        {
          stepId: `step-${index + 1}`,
          start: from,
          end: to,
          requiresStaff: true,
          resourceIds: [],
        },
      ],
    };
  });
}

function buildCheckoutPayloadFromSlot(slot: any, serviceIds: string[]) {
  const { from, to } = pickSlotTime(slot);
  if (!from || !to) {
    throw new Error("Slot does not include reservedFrom/reservedTo or start/end");
  }

  const slotServices = Array.isArray(slot.services) ? slot.services : [];
  const baseServices =
    slotServices.length > 0
      ? slotServices.map((service: any) => ({
          serviceId: service.serviceId ?? service.id ?? serviceIds[0],
          price: 0,
          currency: "EUR",
          steps: service.steps ?? [],
        }))
      : serviceIds.slice(0, 1).map((serviceId) => ({
          serviceId,
          price: 0,
          currency: "EUR",
          steps: [],
        }));

  const services = ensureSteps(slot, baseServices);
  const nowSuffix = randomUUID().slice(0, 8);
  return {
    slotKey: slot.slotKey,
    staffId: slot.staffId,
    window: {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    },
    services,
    customer: {
      firstName: "Smoke",
      lastName: "Test",
      email: `smoke+${nowSuffix}@example.com`,
      phone: "+49123456789",
    },
    consents: [
      {
        type: "TERMS",
        scope: "EMAIL",
        granted: true,
      },
    ],
  };
}

function extractStableId(payload: any): string | null {
  const appointment = payload?.appointment ?? payload?.data?.appointment ?? null;
  if (typeof appointment?.id === "string") return appointment.id;
  if (typeof payload?.appointmentId === "string") return payload.appointmentId;
  if (typeof payload?.data?.appointmentId === "string") return payload.data.appointmentId;
  if (typeof appointment?.confirmationCode === "string") return appointment.confirmationCode;
  if (typeof payload?.confirmationCode === "string") return payload.confirmationCode;
  if (typeof payload?.data?.confirmationCode === "string") return payload.data.confirmationCode;
  return null;
}

async function postCheckout(payload: any, idempotencyKey?: string): Promise<FetchResult> {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey) {
    headers.set("idempotency-key", idempotencyKey);
  }
  const payloadWithChannels = { ...payload, notificationChannels: ["email"] };
  const first = await fetchJson(buildUrl(`/book/${LOCATION_SLUG}/checkout`), {
    method: "POST",
    headers,
    body: JSON.stringify(payloadWithChannels),
  });
  if (first.status !== 400) {
    return first;
  }
  const retry = await fetchJson(buildUrl(`/book/${LOCATION_SLUG}/checkout`), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  retry.retried = true;
  return retry;
}

function buildWindowForOffset(offsetDays: number) {
  const start = new Date();
  start.setDate(start.getDate() + Math.max(0, DAYS_AHEAD) + offsetDays);
  const safeStartHour = Number.isFinite(WINDOW_START_HOUR) ? Math.min(23, Math.max(0, WINDOW_START_HOUR)) : 9;
  start.setHours(safeStartHour, 0, 0, 0);
  if (start.getTime() < Date.now()) {
    start.setDate(start.getDate() + 1);
  }
  const rawWindowHours = Number.isFinite(WINDOW_HOURS) ? WINDOW_HOURS : 24;
  // Availability normalizes to local midnight, so use >= 24h windows to avoid zero-length days.
  const safeWindowHours = Math.max(24, Math.min(24 * 7, rawWindowHours));
  const end = new Date(start.getTime() + safeWindowHours * 60 * 60 * 1000);
  return { start, end };
}

async function fetchSlotsForWindow(serviceIds: string[], start: Date, end: Date) {
  const params = new URLSearchParams();
  params.set("from", start.toISOString());
  params.set("to", end.toISOString());
  for (const serviceId of serviceIds) {
    params.append("services", serviceId);
  }
  const availabilityUrl = buildUrl(`/book/${LOCATION_SLUG}/availability?${params.toString()}`);
  const response = await fetchJson(availabilityUrl);
  return { response, slots: normalizeSlots(response.json) };
}

async function findFirstSlot(serviceIds: string[]) {
  const attempts = Math.max(1, Math.min(31, MAX_SCAN_DAYS));
  let lastResponse: FetchResult | null = null;
  let lastWindow = buildWindowForOffset(0);
  for (let offset = 0; offset < attempts; offset += 1) {
    const window = buildWindowForOffset(offset);
    lastWindow = window;
    const result = await fetchSlotsForWindow(serviceIds, window.start, window.end);
    lastResponse = result.response;
    if (result.response.status !== 200) {
      return { ...result, window, daysScanned: offset + 1 };
    }
    if (result.slots.length > 0) {
      return { ...result, window, daysScanned: offset + 1 };
    }
  }
  return {
    response: lastResponse ?? { status: 0, json: null, text: "" },
    slots: [],
    window: lastWindow,
    daysScanned: attempts,
  };
}

async function main() {
  const report: {
    ok: boolean;
    startedAt: string;
    baseUrl: string;
    locationSlug: string;
    tests: SmokeTestResult[];
    error?: string;
    hint?: string;
  } = {
    ok: false,
    startedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    locationSlug: LOCATION_SLUG,
    tests: [],
  };

  try {
    const bookingPageUrl = buildUrl(`/book/${LOCATION_SLUG}`);
    const discovered = await discoverServiceIds(bookingPageUrl);
    const resolvedServiceIds = resolveServiceIds(discovered);
    const serviceIds = resolvedServiceIds.slice(0, 1);
    if (!serviceIds.length) {
      report.error = "No service IDs available for availability lookup.";
      report.hint =
        "Set SERVICE_IDS=\"<serviceId>\" or LOCATION_ID=\"<locationId>\", or ensure the booking page exposes initialServices.";
      report.ok = false;
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const availabilityCheck = await findFirstSlot(serviceIds);
    if (availabilityCheck.response.status !== 200) {
      report.error = `Availability request failed with status ${availabilityCheck.response.status}.`;
      report.tests.push({
        name: "availability_fetch",
        ok: false,
        info: {
          status: availabilityCheck.response.status,
          window: {
            from: availabilityCheck.window.start.toISOString(),
            to: availabilityCheck.window.end.toISOString(),
            daysScanned: availabilityCheck.daysScanned,
          },
          _raw: truncate(availabilityCheck.response.text || ""),
        },
      });
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    if (!availabilityCheck.slots.length) {
      report.error = "Availability returned no slots.";
      report.tests.push({
        name: "availability_empty",
        ok: false,
        info: { status: availabilityCheck.response.status },
      });
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }

    const slotA = availabilityCheck.slots[0];
    const payloadA = buildCheckoutPayloadFromSlot(slotA, serviceIds);

    const concurrencyResults = await Promise.all([postCheckout(payloadA), postCheckout(payloadA)]);
    const concurrencyStatuses = concurrencyResults.map((result) => result.status).sort();
    const concurrencyIds = concurrencyResults.map((result) => extractStableId(result.json));
    const concurrencyRaw = concurrencyResults
      .map((result) => (result.status >= 400 ? truncate(safeString(result.json ?? result.text)) : null))
      .filter(Boolean);
    const concurrencyOk =
      concurrencyStatuses.length === 2 &&
      concurrencyStatuses[0] === 200 &&
      concurrencyStatuses[1] === 409;
    report.tests.push({
      name: "concurrency_no_idempotency",
      ok: concurrencyOk,
      info: {
        statuses: concurrencyStatuses,
        ids: concurrencyIds.filter(Boolean),
        retried: concurrencyResults.map((result) => Boolean(result.retried)),
        _raw: concurrencyRaw.length ? concurrencyRaw : undefined,
      },
    });

    const availabilityCheck2 = await findFirstSlot(serviceIds);
    if (availabilityCheck2.response.status !== 200 || !availabilityCheck2.slots.length) {
      report.error = "Availability returned no slots for idempotency test.";
      report.tests.push({
        name: "availability_idempotency",
        ok: false,
        info: {
          status: availabilityCheck2.response.status,
          window: {
            from: availabilityCheck2.window.start.toISOString(),
            to: availabilityCheck2.window.end.toISOString(),
            daysScanned: availabilityCheck2.daysScanned,
          },
          _raw: truncate(availabilityCheck2.response.text || ""),
        },
      });
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    const slotB = availabilityCheck2.slots[0];
    const payloadB = buildCheckoutPayloadFromSlot(slotB, serviceIds);
    const idemKey = randomUUID();
    const idemResults = await Promise.all([postCheckout(payloadB, idemKey), postCheckout(payloadB, idemKey)]);
    const idemStatuses = idemResults.map((result) => result.status);
    const idemIds = idemResults.map((result) => extractStableId(result.json));
    const idemRaw = idemResults
      .map((result) => (result.status >= 400 ? truncate(safeString(result.json ?? result.text)) : null))
      .filter(Boolean);
    const idemOk =
      idemStatuses.every((status) => status === 200) &&
      idemIds[0] &&
      idemIds[1] &&
      idemIds[0] === idemIds[1];
    report.tests.push({
      name: "idempotency_retry",
      ok: idemOk,
      info: {
        statuses: idemStatuses,
        ids: idemIds,
        retried: idemResults.map((result) => Boolean(result.retried)),
        _raw: idemRaw.length ? idemRaw : undefined,
      },
    });

    const availabilityCheck3 = await findFirstSlot(serviceIds);
    if (availabilityCheck3.response.status !== 200 || !availabilityCheck3.slots.length) {
      report.error = "Availability returned no slots for synthetic slot test.";
      report.tests.push({
        name: "availability_synthetic",
        ok: false,
        info: {
          status: availabilityCheck3.response.status,
          window: {
            from: availabilityCheck3.window.start.toISOString(),
            to: availabilityCheck3.window.end.toISOString(),
            daysScanned: availabilityCheck3.daysScanned,
          },
          _raw: truncate(availabilityCheck3.response.text || ""),
        },
      });
      console.log(JSON.stringify(report, null, 2));
      process.exit(1);
    }
    const slotC = availabilityCheck3.slots[0];
    const payloadC = buildCheckoutPayloadFromSlot(slotC, serviceIds);
    payloadC.slotKey = `invalid-${randomUUID()}`;
    const syntheticResult = await postCheckout(payloadC);
    const syntheticOk = syntheticResult.status === 409;
    const syntheticInfo: Record<string, unknown> = {
      status: syntheticResult.status,
      retried: Boolean(syntheticResult.retried),
    };
    if (syntheticResult.status >= 400) {
      syntheticInfo._raw = truncate(safeString(syntheticResult.json ?? syntheticResult.text));
    }
    report.tests.push({
      name: "synthetic_slot_bypass",
      ok: syntheticOk,
      info: syntheticInfo,
    });

    report.ok = report.tests.every((test) => test.ok);
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    report.error = truncate(safeString(error));
    console.log(JSON.stringify(report, null, 2));
    process.exit(2);
  }
}

main();
