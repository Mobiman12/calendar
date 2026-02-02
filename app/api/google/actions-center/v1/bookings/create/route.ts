import { NextRequest, NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";
import { jsonResponse, verifyActionsCenterRequest } from "@/lib/actions-center/auth";
import { fetchBookingAvailability } from "@/lib/actions-center/availability";
import { buildBookingResponse, extractCheckoutBooking } from "@/lib/actions-center/booking-response";
import { parseDateValue, readString, readStringArray, resolveMerchantContext } from "@/lib/actions-center/mapper";
import { POST as bookingCheckoutPost } from "@/app/book/[tenant]/[location]/checkout/route";

export const dynamic = "force-dynamic";

const prisma = getPrismaClient();
const logger = getLogger();

type ServiceSpec = { serviceId: string; price: number; currency: string };

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractIdempotencyKey(req: NextRequest, body: Record<string, unknown> | null) {
  return (
    readString(body?.idempotencyKey) ??
    readString(body?.idempotency_token) ??
    readString(body?.idempotencyToken) ??
    req.headers.get("idempotency-key") ??
    req.headers.get("x-idempotency-key")
  );
}

function extractSlotInfo(body: Record<string, unknown> | null) {
  const booking = readRecord(body?.booking);
  const slot = readRecord(body?.slot) ?? readRecord(booking?.slot) ?? readRecord(booking?.time_slot) ?? null;

  const slotKey =
    readString(body?.slotKey) ??
    readString(body?.slot_key) ??
    readString(body?.slotId) ??
    readString(body?.slot_id) ??
    readString(slot?.slotKey) ??
    readString(slot?.slot_key) ??
    readString(slot?.slotId) ??
    readString(slot?.slot_id) ??
    readString(slot?.key) ??
    readString(slot?.id);

  const start =
    parseDateValue(slot?.start) ??
    parseDateValue(slot?.startTime) ??
    parseDateValue(slot?.start_time) ??
    parseDateValue(slot?.start_sec) ??
    parseDateValue(slot?.startSec) ??
    parseDateValue(slot?.start_ms) ??
    parseDateValue(slot?.startMs) ??
    parseDateValue(body?.startTime) ??
    parseDateValue(body?.start) ??
    parseDateValue(booking?.startTime);

  const end =
    parseDateValue(slot?.end) ??
    parseDateValue(slot?.endTime) ??
    parseDateValue(slot?.end_time) ??
    parseDateValue(slot?.end_sec) ??
    parseDateValue(slot?.endSec) ??
    parseDateValue(slot?.end_ms) ??
    parseDateValue(slot?.endMs) ??
    parseDateValue(body?.endTime) ??
    parseDateValue(body?.end) ??
    parseDateValue(booking?.endTime);

  const durationMins =
    (typeof slot?.durationMins === "number" ? slot.durationMins : null) ??
    (typeof slot?.durationMinutes === "number" ? slot.durationMinutes : null) ??
    (typeof slot?.duration === "number" ? slot.duration : null);

  return { slotKey, start, end, durationMins };
}

function extractServiceIds(body: Record<string, unknown> | null, searchParams: URLSearchParams) {
  const booking = readRecord(body?.booking);
  const slot = readRecord(body?.slot) ?? readRecord(booking?.slot) ?? null;

  const candidates: unknown[] = [
    body?.serviceId,
    body?.service_id,
    body?.serviceIds,
    body?.service_ids,
    body?.services,
    body?.service,
    booking?.serviceId,
    booking?.service_id,
    booking?.serviceIds,
    booking?.service_ids,
    booking?.services,
    slot?.serviceId,
    slot?.service_id,
    slot?.serviceIds,
    slot?.service_ids,
    slot?.services,
  ];

  const ids = new Set<string>();
  for (const entry of candidates) {
    const parsed = Array.isArray(entry)
      ? entry.flatMap((value) => {
          if (typeof value === "string") return readStringArray(value);
          const record = readRecord(value);
          return readStringArray(record?.serviceId ?? record?.service_id ?? record?.id ?? null);
        })
      : readStringArray(entry);
    for (const id of parsed) {
      ids.add(id);
    }
  }

  const queryCandidates = [
    ...searchParams.getAll("serviceId"),
    ...searchParams.getAll("service_id"),
    ...searchParams.getAll("service"),
    ...searchParams.getAll("services"),
  ];
  for (const entry of queryCandidates.flatMap((value) => readStringArray(value))) {
    ids.add(entry);
  }

  return Array.from(ids);
}

function extractCustomer(body: Record<string, unknown> | null, requestId: string) {
  const booking = readRecord(body?.booking);
  const customer = readRecord(body?.customer) ?? readRecord(body?.customerInfo) ?? readRecord(booking?.customer) ?? null;
  const user = readRecord(body?.user) ?? readRecord(body?.userInformation) ?? readRecord(booking?.user) ?? null;

  const firstName =
    readString(customer?.firstName) ??
    readString(customer?.first_name) ??
    readString(user?.firstName) ??
    readString(user?.givenName) ??
    readString(user?.first_name) ??
    "Google";
  const lastName =
    readString(customer?.lastName) ??
    readString(customer?.last_name) ??
    readString(user?.lastName) ??
    readString(user?.familyName) ??
    readString(user?.last_name) ??
    "Guest";
  const email =
    readString(customer?.email) ?? readString(user?.email) ?? `actions-center+${requestId}@example.com`;
  const phone = readString(customer?.phone) ?? readString(user?.phone) ?? readString(user?.phone_number);

  return {
    firstName,
    lastName,
    email,
    phone,
  };
}

function buildServiceSpecs(services: Array<{ id: string; basePrice: any; priceCurrency: string | null }>): ServiceSpec[] {
  return services.map((service) => ({
    serviceId: service.id,
    price: Number(service.basePrice),
    currency: service.priceCurrency ?? "EUR",
  }));
}

function buildWindow(start: Date, end: Date | null, durationMins: number | null) {
  const windowStart = new Date(start.getTime() - 60 * 60 * 1000);
  const fallbackEnd = durationMins ? new Date(start.getTime() + durationMins * 60 * 1000) : null;
  const windowEndSource = end ?? fallbackEnd ?? new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const windowEnd = new Date(windowEndSource.getTime() + 60 * 60 * 1000);
  return { windowStart, windowEnd };
}

async function runCheckout(params: {
  tenantSlug: string;
  locationSlug: string;
  payload: Record<string, unknown>;
  idempotencyKey: string | null;
  requestId: string;
  ip: string | null;
}) {
  const url = `http://actions-center.local/book/${encodeURIComponent(params.tenantSlug)}/${encodeURIComponent(
    params.locationSlug,
  )}/checkout`;
  const headers = new Headers({
    "content-type": "application/json",
    "x-request-id": params.requestId,
  });
  if (params.idempotencyKey) {
    headers.set("idempotency-key", params.idempotencyKey);
  }
  if (params.ip) {
    headers.set("x-forwarded-for", params.ip);
  }

  const request = new NextRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(params.payload),
  });

  return bookingCheckoutPost(request, {
    params: Promise.resolve({ tenant: params.tenantSlug, location: params.locationSlug }),
  });
}

export async function POST(req: NextRequest) {
  const auth = await verifyActionsCenterRequest(req);
  if (!auth.ok) return auth.response;

  const body = readRecord(auth.body);
  if (!body) {
    return jsonResponse(auth.requestId, { error: "invalid_payload" }, { status: 400 });
  }

  const searchParams = new URL(req.url).searchParams;
  const merchantId =
    readString(body.merchantId) ??
    readString(body.merchant_id) ??
    searchParams.get("merchantId") ??
    searchParams.get("merchant_id");
  const locationId = readString(body.locationId) ?? readString(body.location_id) ?? searchParams.get("locationId");
  const tenantSlug = readString(body.tenant) ?? readString(body.tenantSlug) ?? searchParams.get("tenant");
  const locationSlug = readString(body.location) ?? readString(body.locationSlug) ?? searchParams.get("location");

  const context = await resolveMerchantContext({ merchantId, locationId, tenantSlug, locationSlug });
  if (!context) {
    return jsonResponse(auth.requestId, { error: "merchant_not_found" }, { status: 404 });
  }

  const idempotencyKey = extractIdempotencyKey(req, body);
  const { slotKey, start, end, durationMins } = extractSlotInfo(body);
  if (!slotKey) {
    return jsonResponse(auth.requestId, { error: "slot_required" }, { status: 400 });
  }
  if (!start) {
    return jsonResponse(auth.requestId, { error: "slot_start_required" }, { status: 400 });
  }

  const serviceIds = extractServiceIds(body, searchParams);
  if (!serviceIds.length) {
    return jsonResponse(auth.requestId, { error: "service_required" }, { status: 400 });
  }

  const { windowStart, windowEnd } = buildWindow(start, end, durationMins);
  const availability = await fetchBookingAvailability({
    tenantSlug: context.tenantSlug,
    locationSlug: context.locationSlug,
    from: windowStart,
    to: windowEnd,
    serviceIds,
    requestId: auth.requestId,
    ip: auth.ip,
  });

  if (!availability.ok) {
    return jsonResponse(auth.requestId, { error: "availability_failed", details: availability.error }, { status: availability.status });
  }

  const matchingSlot = availability.slots.find((slot) => slot.slotKey === slotKey);
  if (!matchingSlot) {
    return jsonResponse(auth.requestId, { error: "slot_unavailable" }, { status: 409 });
  }

  const bookingStart = new Date(matchingSlot.reservedFrom ?? matchingSlot.start);
  const bookingEnd = new Date(matchingSlot.reservedTo ?? matchingSlot.end);
  const slotStaffId = matchingSlot.staffId;
  if (!slotStaffId) {
    return jsonResponse(auth.requestId, { error: "slot_unavailable" }, { status: 409 });
  }

  const services = await prisma.service.findMany({
    where: { id: { in: serviceIds }, locationId: context.locationId, status: "ACTIVE" },
    select: { id: true, basePrice: true, priceCurrency: true },
  });

  if (services.length !== serviceIds.length) {
    logger.warn(
      { requestId: auth.requestId, expected: serviceIds.length, resolved: services.length },
      "[actions-center] service lookup incomplete",
    );
  }
  if (!services.length) {
    return jsonResponse(auth.requestId, { error: "service_not_found" }, { status: 404 });
  }

  const serviceSpecs = buildServiceSpecs(services);
  const customer = extractCustomer(body, auth.requestId);

  const checkoutPayload = {
    slotKey,
    staffId: slotStaffId,
    window: {
      from: bookingStart.toISOString(),
      to: bookingEnd.toISOString(),
    },
    services: serviceSpecs.map((service) => ({
      serviceId: service.serviceId,
      price: service.price,
      currency: service.currency,
      steps: [],
    })),
    customer,
    metadata: {
      source: "actions-center",
      requestId: auth.requestId,
    },
  };

  const response = await runCheckout({
    tenantSlug: context.tenantSlug,
    locationSlug: context.locationSlug,
    payload: checkoutPayload,
    idempotencyKey,
    requestId: auth.requestId,
    ip: auth.ip,
  });

  let responseBody: unknown = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    return jsonResponse(auth.requestId, { error: "booking_failed", details: responseBody }, { status: response.status });
  }

  const booking = extractCheckoutBooking(responseBody);
  const appointmentId = booking.appointmentId;
  if (!appointmentId) {
    return jsonResponse(auth.requestId, { error: "booking_failed", details: responseBody }, { status: 500 });
  }

  return jsonResponse(
    auth.requestId,
    buildBookingResponse({
      appointmentId,
      confirmationCode: booking.confirmationCode,
      status: booking.status,
      startsAt: booking.startsAt ?? bookingStart.toISOString(),
      endsAt: booking.endsAt ?? bookingEnd.toISOString(),
      slotKey,
      merchantId: context.locationId,
    }),
  );
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
