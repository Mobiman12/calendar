import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";
import { jsonResponse, verifyActionsCenterRequest } from "@/lib/actions-center/auth";
import { fetchBookingAvailability } from "@/lib/actions-center/availability";
import { buildBookingResponse } from "@/lib/actions-center/booking-response";
import { parseDateValue, readString, readStringArray, resolveMerchantContext } from "@/lib/actions-center/mapper";

export const dynamic = "force-dynamic";

const prisma = getPrismaClient();
const logger = getLogger();

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractBookingIdentifier(body: Record<string, unknown> | null, searchParams: URLSearchParams) {
  return (
    readString(body?.appointmentId) ??
    readString(body?.appointment_id) ??
    readString(body?.bookingId) ??
    readString(body?.booking_id) ??
    readString(body?.confirmationCode) ??
    readString(body?.confirmation_code) ??
    readString(readRecord(body?.booking)?.id) ??
    searchParams.get("appointmentId") ??
    searchParams.get("confirmationCode")
  );
}

function extractSlotKey(body: Record<string, unknown> | null) {
  const booking = readRecord(body?.booking);
  const slot = readRecord(body?.slot) ?? readRecord(booking?.slot) ?? readRecord(booking?.time_slot) ?? null;
  return (
    readString(body?.slotKey) ??
    readString(body?.slot_key) ??
    readString(body?.slotId) ??
    readString(body?.slot_id) ??
    readString(slot?.slotKey) ??
    readString(slot?.slot_key) ??
    readString(slot?.slotId) ??
    readString(slot?.slot_id) ??
    readString(slot?.key) ??
    readString(slot?.id)
  );
}

function extractSlotStart(body: Record<string, unknown> | null) {
  const booking = readRecord(body?.booking);
  const slot = readRecord(body?.slot) ?? readRecord(booking?.slot) ?? readRecord(booking?.time_slot) ?? null;
  return (
    parseDateValue(slot?.start) ??
    parseDateValue(slot?.startTime) ??
    parseDateValue(slot?.start_time) ??
    parseDateValue(slot?.start_sec) ??
    parseDateValue(slot?.startSec) ??
    parseDateValue(slot?.start_ms) ??
    parseDateValue(slot?.startMs) ??
    parseDateValue(body?.startTime) ??
    parseDateValue(body?.start)
  );
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

function extractStoredSlotKey(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const booking = (metadata as Record<string, unknown>).booking;
  if (!booking || typeof booking !== "object" || Array.isArray(booking)) return null;
  return readString((booking as Record<string, unknown>).slotKey);
}

function buildWindowFromStart(start: Date) {
  const windowStart = new Date(start.getTime() - 60 * 60 * 1000);
  const windowEnd = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { windowStart, windowEnd };
}

export async function POST(req: NextRequest) {
  const auth = await verifyActionsCenterRequest(req);
  if (!auth.ok) return auth.response;

  const body = readRecord(auth.body);
  const searchParams = new URL(req.url).searchParams;
  const merchantId =
    readString(body?.merchantId) ??
    readString(body?.merchant_id) ??
    searchParams.get("merchantId") ??
    searchParams.get("merchant_id");
  const locationId = readString(body?.locationId) ?? readString(body?.location_id) ?? searchParams.get("locationId");
  const tenantSlug = readString(body?.tenant) ?? readString(body?.tenantSlug) ?? searchParams.get("tenant");
  const locationSlug = readString(body?.location) ?? readString(body?.locationSlug) ?? searchParams.get("location");

  const context = await resolveMerchantContext({ merchantId, locationId, tenantSlug, locationSlug });
  if (!context) {
    return jsonResponse(auth.requestId, { error: "merchant_not_found" }, { status: 404 });
  }

  const bookingId = extractBookingIdentifier(body, searchParams);
  if (!bookingId) {
    return jsonResponse(auth.requestId, { error: "booking_id_required" }, { status: 400 });
  }

  const appointment = await prisma.appointment.findFirst({
    where: {
      locationId: context.locationId,
      OR: [{ id: bookingId }, { confirmationCode: bookingId }],
    },
    include: { items: true },
  });

  if (!appointment) {
    return jsonResponse(auth.requestId, { error: "booking_not_found" }, { status: 404 });
  }

  const slotKey = extractSlotKey(body);
  const storedSlotKey = extractStoredSlotKey(appointment.metadata);

  if (!slotKey || slotKey === storedSlotKey) {
    return jsonResponse(
      auth.requestId,
      buildBookingResponse({
        appointmentId: appointment.id,
        confirmationCode: appointment.confirmationCode,
        status: appointment.status,
        startsAt: appointment.startsAt.toISOString(),
        endsAt: appointment.endsAt.toISOString(),
        slotKey: storedSlotKey,
        merchantId: context.locationId,
      }),
    );
  }

  if (appointment.status === "CANCELLED") {
    return jsonResponse(auth.requestId, { error: "booking_cancelled" }, { status: 409 });
  }

  const serviceIds = extractServiceIds(body, searchParams);
  const effectiveServiceIds = serviceIds.length ? serviceIds : Array.from(new Set(appointment.items.map((item) => item.serviceId)));
  if (!effectiveServiceIds.length) {
    return jsonResponse(auth.requestId, { error: "service_required" }, { status: 400 });
  }

  const slotStart = extractSlotStart(body) ?? appointment.startsAt;
  const { windowStart, windowEnd } = buildWindowFromStart(slotStart);
  const availability = await fetchBookingAvailability({
    tenantSlug: context.tenantSlug,
    locationSlug: context.locationSlug,
    from: windowStart,
    to: windowEnd,
    serviceIds: effectiveServiceIds,
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
  const slotStaffId = matchingSlot.staffId ?? appointment.items.find((item) => item.staffId)?.staffId ?? null;
  if (!slotStaffId) {
    return jsonResponse(auth.requestId, { error: "slot_unavailable" }, { status: 409 });
  }

  const conflict = await prisma.appointmentItem.findFirst({
    where: {
      appointmentId: { not: appointment.id },
      staffId: slotStaffId,
      startsAt: { lt: bookingEnd },
      endsAt: { gt: bookingStart },
      appointment: {
        locationId: context.locationId,
        status: { not: "CANCELLED" },
      },
    },
    select: { id: true },
  });

  if (conflict) {
    return jsonResponse(auth.requestId, { error: "slot_unavailable" }, { status: 409 });
  }

  const updatedMetadata = (() => {
    const record =
      appointment.metadata && typeof appointment.metadata === "object" && !Array.isArray(appointment.metadata)
        ? (appointment.metadata as Record<string, unknown>)
        : {};
    const booking =
      record.booking && typeof record.booking === "object" && !Array.isArray(record.booking)
        ? (record.booking as Record<string, unknown>)
        : {};
    return { ...record, booking: { ...booking, slotKey } };
  })();

  const deltaMs = bookingStart.getTime() - appointment.startsAt.getTime();

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.appointment.update({
      where: { id: appointment.id },
      data: {
        startsAt: bookingStart,
        endsAt: bookingEnd,
        metadata: updatedMetadata,
      },
    });

    await Promise.all(
      appointment.items.map((item) => {
        const startsAt = new Date(item.startsAt.getTime() + deltaMs);
        const endsAt = new Date(item.endsAt.getTime() + deltaMs);
        return tx.appointmentItem.update({
          where: { id: item.id },
          data: {
            startsAt,
            endsAt,
            staffId: slotStaffId,
          },
        });
      }),
    );

    return updated;
  });

  logger.info({ requestId: auth.requestId, appointmentId: appointment.id }, "[actions-center] booking updated");

  return jsonResponse(
    auth.requestId,
    buildBookingResponse({
      appointmentId: result.id,
      confirmationCode: result.confirmationCode,
      status: result.status,
      startsAt: result.startsAt.toISOString(),
      endsAt: result.endsAt.toISOString(),
      slotKey,
      merchantId: context.locationId,
    }),
  );
}

export async function GET() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
