import { NextRequest } from "next/server";

import { jsonResponse, verifyActionsCenterRequest } from "@/lib/actions-center/auth";
import { fetchBookingAvailability } from "@/lib/actions-center/availability";
import { parseDateValue, readString, readStringArray, resolveMerchantContext } from "@/lib/actions-center/mapper";

export const dynamic = "force-dynamic";

function collectServiceIds(searchParams: URLSearchParams): string[] {
  const candidates = [
    ...searchParams.getAll("serviceId"),
    ...searchParams.getAll("service_id"),
    ...searchParams.getAll("service"),
    ...searchParams.getAll("services"),
    ...searchParams.getAll("serviceIds"),
    ...searchParams.getAll("service_ids"),
  ];
  const ids = candidates.flatMap((entry) => readStringArray(entry));
  return Array.from(new Set(ids));
}

function parseWindow(searchParams: URLSearchParams) {
  const start =
    parseDateValue(searchParams.get("from")) ??
    parseDateValue(searchParams.get("start")) ??
    parseDateValue(searchParams.get("startTime")) ??
    parseDateValue(searchParams.get("start_time"));
  const end =
    parseDateValue(searchParams.get("to")) ??
    parseDateValue(searchParams.get("end")) ??
    parseDateValue(searchParams.get("endTime")) ??
    parseDateValue(searchParams.get("end_time"));
  return { start, end };
}

export async function GET(req: NextRequest) {
  const auth = await verifyActionsCenterRequest(req);
  if (!auth.ok) return auth.response;

  const searchParams = new URL(req.url).searchParams;
  const merchantId = searchParams.get("merchantId") ?? searchParams.get("merchant_id");
  const locationId = searchParams.get("locationId");
  const tenantSlug = searchParams.get("tenant") ?? searchParams.get("tenantSlug");
  const locationSlug = searchParams.get("location") ?? searchParams.get("locationSlug");

  const context = await resolveMerchantContext({
    merchantId,
    locationId,
    tenantSlug,
    locationSlug,
  });
  if (!context) {
    return jsonResponse(auth.requestId, { error: "merchant_not_found" }, { status: 404 });
  }

  const serviceIds = collectServiceIds(searchParams);
  if (!serviceIds.length) {
    return jsonResponse(auth.requestId, { error: "service_required" }, { status: 400 });
  }

  const { start, end } = parseWindow(searchParams);
  if (!start || !end || end <= start) {
    return jsonResponse(auth.requestId, { error: "invalid_window" }, { status: 400 });
  }

  const staffId = readString(searchParams.get("staffId"));
  const deviceId = readString(searchParams.get("deviceId"));
  const granularity = searchParams.get("granularity") ? Number(searchParams.get("granularity")) : null;

  const availability = await fetchBookingAvailability({
    tenantSlug: context.tenantSlug,
    locationSlug: context.locationSlug,
    from: start,
    to: end,
    serviceIds,
    staffId,
    deviceId,
    granularity,
    requestId: auth.requestId,
    ip: auth.ip,
  });

  if (!availability.ok) {
    return jsonResponse(auth.requestId, { error: "availability_failed", details: availability.error }, { status: availability.status });
  }

  const slots = availability.slots.map((slot) => ({
    slotKey: slot.slotKey,
    merchantId: slot.locationId,
    staffId: slot.staffId,
    startTime: slot.reservedFrom ?? slot.start,
    endTime: slot.reservedTo ?? slot.end,
    serviceIds: (slot.services ?? []).map((service) => service.serviceId),
    isSmart: slot.isSmart ?? false,
  }));

  return jsonResponse(auth.requestId, { slots, warnings: availability.warnings ?? null });
}
