import { randomUUID } from "crypto";
import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { listSlotHoldMetadata, removeSlotHoldMetadata, storeSlotHoldMetadata } from "@/lib/booking-holds";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();
const MANUAL_HOLD_TTL_MS = 3 * 60 * 1000;

function withNoStore(response: NextResponse) {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  try {
    const { location } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
    const url = new URL(request.url);
    const startParam = url.searchParams.get("start");
    const endParam = url.searchParams.get("end");
    if (!startParam || !endParam) {
      return withNoStore(NextResponse.json({ error: "Start und Ende werden benötigt." }, { status: 400 }));
    }
    const rangeStart = new Date(startParam);
    const rangeEnd = new Date(endParam);
    if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
      return withNoStore(NextResponse.json({ error: "Ungültiger Zeitraum." }, { status: 400 }));
    }

    const locationRecord = await prisma.location.findFirst({
      where: { slug: location, tenantId },
      select: { id: true },
    });
    if (!locationRecord) {
      return withNoStore(NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 }));
    }

    const holds = await listSlotHoldMetadata(locationRecord.id);
    const data = holds
      .filter((hold) => {
        const start = Date.parse(hold.reservedFrom);
        const end = Date.parse(hold.reservedTo);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        return start < rangeEnd.getTime() && end > rangeStart.getTime();
      })
      .map((hold) => ({
        id: `hold:${hold.slotKey}`,
        staffId: hold.staffId,
        reason: "Reservierung in Arbeit",
        startsAt: hold.reservedFrom,
        endsAt: hold.reservedTo,
        metadata: {
          isHold: true,
          holdSource: hold.slotKey.includes("|manual:") ? "staff" : "online",
          expiresAt: new Date(hold.expiresAt).toISOString(),
          serviceNames: hold.serviceNames ?? [],
          createdByName: hold.createdByName ?? null,
          createdByStaffId: hold.createdByStaffId ?? null,
        },
      }));

    return withNoStore(NextResponse.json({ data }));
  } catch (error) {
    console.error("[booking-holds] failed", error);
    const message = error instanceof Error ? error.message : "Online-Reservierungen konnten nicht geladen werden.";
    return withNoStore(NextResponse.json({ error: message }, { status: 500 }));
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  try {
    const { location } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
    const payload = await request.json().catch(() => null);
    const staffId = typeof payload?.staffId === "string" ? payload.staffId : null;
    const startIso = typeof payload?.start === "string" ? payload.start : null;
    const endIso = typeof payload?.end === "string" ? payload.end : null;
    if (!staffId || !startIso || !endIso) {
      return withNoStore(NextResponse.json({ error: "Ungültige Hold-Daten." }, { status: 400 }));
    }
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      return withNoStore(NextResponse.json({ error: "Ungültiger Zeitraum." }, { status: 400 }));
    }

    const locationRecord = await prisma.location.findFirst({
      where: { slug: location, tenantId },
      select: { id: true },
    });
    if (!locationRecord) {
      return withNoStore(NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 }));
    }

    const staffExists = await prisma.staff.findFirst({
      where: { id: staffId, locationId: locationRecord.id },
      select: { id: true },
    });
    if (!staffExists) {
      return withNoStore(NextResponse.json({ error: "Mitarbeiter:in nicht gefunden." }, { status: 404 }));
    }

    const serviceNames = Array.isArray(payload?.serviceNames)
      ? payload.serviceNames.filter(
          (value: unknown): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : undefined;
    const createdByStaffId = typeof payload?.createdByStaffId === "string" ? payload.createdByStaffId : null;
    const createdByNameRaw = typeof payload?.createdByName === "string" ? payload.createdByName.trim() : "";
    const createdByName = createdByNameRaw.length ? createdByNameRaw : null;
    const slotKey = `${locationRecord.id}|${staffId}|${start.toISOString()}|manual:${randomUUID()}`;
    const expiresAt = Date.now() + MANUAL_HOLD_TTL_MS;

    await storeSlotHoldMetadata(
      {
        slotKey,
        locationId: locationRecord.id,
        staffId,
        createdByStaffId,
        createdByName,
        start: start.toISOString(),
        end: end.toISOString(),
        reservedFrom: start.toISOString(),
        reservedTo: end.toISOString(),
        expiresAt,
        serviceNames,
      },
      MANUAL_HOLD_TTL_MS,
    );

    return withNoStore(
      NextResponse.json({
        slotKey,
        expiresAt: new Date(expiresAt).toISOString(),
      }),
    );
  } catch (error) {
    console.error("[booking-holds] create failed", error);
    const message = error instanceof Error ? error.message : "Hold konnte nicht erstellt werden.";
    return withNoStore(NextResponse.json({ error: message }, { status: 500 }));
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  try {
    const { location } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
    const payload = await request.json().catch(() => null);
    const slotKey = typeof payload?.slotKey === "string" ? payload.slotKey : null;
    if (!slotKey || !slotKey.includes("|manual:")) {
      return withNoStore(NextResponse.json({ error: "Ungültiger Hold-Key." }, { status: 400 }));
    }

    const locationRecord = await prisma.location.findFirst({
      where: { slug: location, tenantId },
      select: { id: true },
    });
    if (!locationRecord) {
      return withNoStore(NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 }));
    }
    if (!slotKey.startsWith(`${locationRecord.id}|`)) {
      return withNoStore(NextResponse.json({ error: "Hold gehört nicht zum Standort." }, { status: 403 }));
    }

    await removeSlotHoldMetadata(slotKey);
    return withNoStore(NextResponse.json({ ok: true }));
  } catch (error) {
    console.error("[booking-holds] delete failed", error);
    const message = error instanceof Error ? error.message : "Hold konnte nicht entfernt werden.";
    return withNoStore(NextResponse.json({ error: message }, { status: 500 }));
  }
}
