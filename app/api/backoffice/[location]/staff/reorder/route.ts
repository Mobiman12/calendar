import { NextResponse } from "next/server";

import { reorderStaffAction } from "@/app/backoffice/[location]/staff/actions";

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const payload = await request.json().catch(() => ({}));
  const order = Array.isArray(payload?.order) ? payload.order : [];
  const result = await reorderStaffAction(location, order);
  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Reihenfolge konnte nicht gespeichert werden." }, { status: 400 });
  }
  return NextResponse.json({ data: { staff: result.staff, order } });
}
