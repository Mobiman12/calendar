import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { resolveBookingTenant } from "@/lib/booking-tenant";
import { acquireSlotHold, releaseSlotHold, storeSlotHoldMetadata } from "@/lib/booking-holds";
import { bookingLimitToMinutes, deriveBookingPreferences } from "@/lib/booking-preferences";

const prisma = getPrismaClient();
const HOLD_TTL_MS = 5 * 60 * 1000;

const slotInfoSchema = z.object({
  locationId: z.string().min(1),
  staffId: z.string().min(1),
  start: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid start" }),
  end: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid end" }),
  reservedFrom: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid reservedFrom" }),
  reservedTo: z.string().refine((value) => !Number.isNaN(Date.parse(value)), { message: "Invalid reservedTo" }),
  serviceNames: z.array(z.string().min(1)).max(10).optional(),
});

const holdSchema = z.object({
  slotKey: z.string().min(1),
  slot: slotInfoSchema.optional(),
});

const releaseSchema = z.object({
  slotKey: z.string().min(1),
  token: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenant: string; location: string }> },
) {
  const payload = await request.json().catch(() => null);
  const parsed = holdSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const { tenant, location } = await context.params;
  const resolution = await resolveBookingTenant(tenant);
  if (!resolution) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: resolution.tenantId, slug: location },
    select: { id: true, metadata: true },
  });
  if (!locationRecord) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const locationMetadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  if (!bookingPreferences.onlineBookingEnabled) {
    return NextResponse.json({ error: "Online-Buchung ist deaktiviert." }, { status: 403 });
  }

  const slotParts = parsed.data.slotKey.split("|");
  const slotStartRaw = slotParts[2] ?? "";
  const slotStartMs = Number.isFinite(Date.parse(slotStartRaw))
    ? Date.parse(slotStartRaw)
    : parsed.data.slot
      ? Date.parse(parsed.data.slot.start)
      : NaN;
  const nowMs = Date.now();
  const minAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.minAdvance);
  const maxAdvanceMinutes = bookingLimitToMinutes(bookingPreferences.maxAdvance);
  const earliestStartMs = nowMs + minAdvanceMinutes * 60 * 1000;
  const latestStartMs = maxAdvanceMinutes > 0 ? nowMs + maxAdvanceMinutes * 60 * 1000 : null;
  if (
    Number.isFinite(slotStartMs) &&
    (slotStartMs < earliestStartMs || (latestStartMs !== null && slotStartMs > latestStartMs))
  ) {
    return NextResponse.json({ error: "Slot is no longer available" }, { status: 409 });
  }

  const hold = await acquireSlotHold(parsed.data.slotKey, HOLD_TTL_MS);
  if (!hold) {
    return NextResponse.json({ error: "Slot already reserved" }, { status: 409 });
  }

  if (parsed.data.slot) {
    const parts = parsed.data.slotKey.split("|");
    const slotLocationId = parts[0] ?? "";
    const slotStaffId = parts[1] ?? "";
    const slotStartRaw = parts[2] ?? "";
    const slotStartMs = Date.parse(slotStartRaw);
    const payloadStartMs = Date.parse(parsed.data.slot.start);
    const ttlMs = hold.expiresAt - Date.now();
    if (
      slotLocationId === locationRecord.id &&
      parsed.data.slot.locationId === locationRecord.id &&
      slotStaffId === parsed.data.slot.staffId &&
      Number.isFinite(slotStartMs) &&
      slotStartMs === payloadStartMs &&
      ttlMs > 0
    ) {
      await storeSlotHoldMetadata(
        {
          slotKey: parsed.data.slotKey,
          locationId: parsed.data.slot.locationId,
          staffId: parsed.data.slot.staffId,
          start: parsed.data.slot.start,
          end: parsed.data.slot.end,
          reservedFrom: parsed.data.slot.reservedFrom,
          reservedTo: parsed.data.slot.reservedTo,
          expiresAt: hold.expiresAt,
          serviceNames: parsed.data.slot.serviceNames,
        },
        ttlMs,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    token: hold.token,
    expiresAt: new Date(hold.expiresAt).toISOString(),
  });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ tenant: string; location: string }> },
) {
  const payload = await request.json().catch(() => null);
  const parsed = releaseSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
  }

  await context.params;
  const released = await releaseSlotHold(parsed.data.slotKey, parsed.data.token);
  return NextResponse.json({ ok: released });
}
