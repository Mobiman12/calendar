import { NextResponse } from "next/server";

import { decodeHoldId, releaseSlotHold } from "@/lib/booking-holds";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ holdId: string }> },
) {
  const { holdId } = await context.params;
  const decoded = decodeHoldId(holdId);
  if (!decoded) {
    return NextResponse.json({ ok: false, error: "Invalid holdId" }, { status: 400 });
  }
  await releaseSlotHold(decoded.slotKey, decoded.token);
  return new NextResponse(null, { status: 204 });
}
