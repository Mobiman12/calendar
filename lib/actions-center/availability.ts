import "server-only";

import { NextRequest } from "next/server";

import { GET as availabilityGet } from "@/app/book/[tenant]/[location]/availability/route";
import { getLogger } from "@/lib/logger";

type AvailabilitySlot = {
  slotKey: string;
  locationId: string;
  staffId: string;
  start?: string;
  end?: string;
  reservedFrom?: string;
  reservedTo?: string;
  isSmart?: boolean;
  services?: Array<{
    serviceId: string;
    steps?: Array<{
      stepId: string;
      start?: string;
      end?: string;
      requiresStaff?: boolean;
      resourceIds?: string[];
    }>;
  }>;
};

type AvailabilitySuccess = {
  ok: true;
  status: number;
  slots: AvailabilitySlot[];
  warnings?: string[] | null;
};

type AvailabilityFailure = {
  ok: false;
  status: number;
  error: {
    message: string;
    body?: string | null;
  };
};

const logger = getLogger();
const MAX_ERROR_BODY = 500;

function truncate(value: string | null) {
  if (!value) return null;
  if (value.length <= MAX_ERROR_BODY) return value;
  return `${value.slice(0, MAX_ERROR_BODY)}…`;
}

async function readResponseBody(response: Response) {
  const raw = await response.text().catch(() => "");
  if (!raw) return { raw: null as string | null, parsed: null as unknown };
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch {
    return { raw, parsed: raw };
  }
}

export async function fetchBookingAvailability(params: {
  tenantSlug: string;
  locationSlug: string;
  from: Date;
  to: Date;
  serviceIds: string[];
  staffId?: string | null;
  deviceId?: string | null;
  granularity?: number | null;
  requestId: string;
  ip: string | null;
}): Promise<AvailabilitySuccess | AvailabilityFailure> {
  const searchParams = new URLSearchParams();
  searchParams.set("from", params.from.toISOString());
  searchParams.set("to", params.to.toISOString());
  for (const serviceId of params.serviceIds) {
    searchParams.append("services", serviceId);
  }
  if (params.staffId) searchParams.set("staffId", params.staffId);
  if (params.deviceId) searchParams.set("deviceId", params.deviceId);
  if (params.granularity) searchParams.set("granularity", String(params.granularity));

  const url = `http://actions-center.local/book/${encodeURIComponent(params.tenantSlug)}/${encodeURIComponent(
    params.locationSlug,
  )}/availability?${searchParams.toString()}`;

  const headers = new Headers({ "x-request-id": params.requestId });
  if (params.ip) headers.set("x-forwarded-for", params.ip);

  const request = new NextRequest(url, { method: "GET", headers });
  const response = await availabilityGet(request, {
    params: Promise.resolve({ tenant: params.tenantSlug, location: params.locationSlug }),
  });

  const { raw, parsed } = await readResponseBody(response);

  if (!response.ok) {
    const errorMessage =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: string }).error)
        : "availability_failed";
    logger.warn({ requestId: params.requestId, status: response.status }, "[actions-center] availability failed");
    return {
      ok: false,
      status: response.status,
      error: {
        message: errorMessage,
        body: truncate(raw),
      },
    };
  }

  const slots = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown })?.data)
      ? (parsed as { data: AvailabilitySlot[] }).data
      : Array.isArray((parsed as { slots?: unknown })?.slots)
        ? (parsed as { slots: AvailabilitySlot[] }).slots
        : [];

  const warnings =
    typeof parsed === "object" && parsed && Array.isArray((parsed as { warnings?: unknown }).warnings)
      ? ((parsed as { warnings: string[] }).warnings as string[])
      : null;

  return { ok: true, status: response.status, slots: slots as AvailabilitySlot[], warnings };
}
