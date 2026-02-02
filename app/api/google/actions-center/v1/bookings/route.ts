import { NextRequest, NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { jsonResponse, verifyActionsCenterRequest } from "@/lib/actions-center/auth";
import { buildBookingResponse } from "@/lib/actions-center/booking-response";
import { readString, resolveMerchantContext } from "@/lib/actions-center/mapper";

export const dynamic = "force-dynamic";

const prisma = getPrismaClient();

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

function extractStoredSlotKey(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const booking = (metadata as Record<string, unknown>).booking;
  if (!booking || typeof booking !== "object" || Array.isArray(booking)) return null;
  return readString((booking as Record<string, unknown>).slotKey);
}

async function handleRequest(req: NextRequest) {
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
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      startsAt: true,
      endsAt: true,
      metadata: true,
    },
  });

  if (!appointment) {
    return jsonResponse(auth.requestId, { error: "booking_not_found" }, { status: 404 });
  }

  return jsonResponse(
    auth.requestId,
    buildBookingResponse({
      appointmentId: appointment.id,
      confirmationCode: appointment.confirmationCode,
      status: appointment.status,
      startsAt: appointment.startsAt.toISOString(),
      endsAt: appointment.endsAt.toISOString(),
      slotKey: extractStoredSlotKey(appointment.metadata),
      merchantId: context.locationId,
    }),
  );
}

export async function GET(req: NextRequest) {
  return handleRequest(req);
}

export async function POST(req: NextRequest) {
  return handleRequest(req);
}

export async function PUT() {
  return NextResponse.json({ error: "method_not_allowed" }, { status: 405 });
}
