import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { AuditAction, AuditActorType, Prisma } from "@prisma/client";
import { logAuditEvent } from "@/lib/audit/logger";
import { getTenantIdOrThrow } from "@/lib/tenant";

const limitSchema = z.object({
  value: z.number(),
  unit: z.enum(["minutes", "hours", "days", "weeks"]),
});

const requestSchema = z.object({
  onlineBookingEnabled: z.boolean().optional(),
  bookingButtonFloating: z.boolean().optional(),
  bookingButtonUseLocation: z.boolean().optional(),
  bookingButtonPosition: z.enum(["left", "right"]).optional(),
  bookingButtonText: z.string().trim().max(80).optional(),
  bookingButtonColor: z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Ungültige Button-Farbe.")
    .optional(),
  bookingButtonTextColor: z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Ungültige Text-Farbe.")
    .optional(),
  customerNoticeEnabled: z.boolean().optional(),
  customerNoticeText: z.string().trim().max(280, "Maximal 280 Zeichen.").optional(),
  emailReplyToEnabled: z.boolean().optional(),
  emailReplyTo: z
    .string()
    .trim()
    .max(120)
    .optional()
    .refine((value) => !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "Ungültige E-Mail-Adresse."),
  emailSenderName: z.string().trim().max(80, "Maximal 80 Zeichen.").optional(),
  smsBrandName: z.string().trim().max(20, "Maximal 20 Zeichen.").optional(),
  smsSenderName: z.string().trim().max(11, "Maximal 11 Zeichen.").optional(),
  bookingBannerHeight: z.number().min(120).max(360).optional(),
  bookingBannerFit: z.enum(["cover", "contain"]).optional(),
  autoConfirm: z.boolean().optional(),
  manualConfirmationMode: z.enum(["single", "both"]).optional(),
  interval: z.string().optional(),
  minAdvance: limitSchema.optional(),
  maxAdvance: limitSchema.optional(),
  cancelLimit: limitSchema.optional(),
  expandCategories: z.boolean().optional(),
  servicesPerBooking: z.number().optional(),
  askPeopleCount: z.boolean().optional(),
  autoPriceAdjust: z.boolean().optional(),
  showAnyStaffOption: z.boolean().optional(),
  shiftPlan: z.boolean().optional(),
  combineStaffResources: z.boolean().optional(),
  hideLastNames: z.boolean().optional(),
  smartSlotsEnabled: z.boolean().optional(),
  stepEngineMin: z.number().int().min(1).optional(),
  bufferMin: z.number().int().min(0).max(15).optional(),
  minGapMin: z.number().int().min(5).max(30).optional(),
  maxSmartSlotsPerHour: z.number().int().min(0).max(2).optional(),
  minWasteReductionMin: z.number().int().min(0).max(60).optional(),
  maxOffGridOffsetMin: z.number().int().min(0).optional(),
  popularServicesWindowDays: z
    .number()
    .int()
    .refine((value) => value === 30 || value === 90, "Nur 30 oder 90 Tage erlaubt.")
    .optional(),
  popularServicesLimit: z.number().int().min(4).max(6).optional(),
  serviceListLimit: z.number().int().min(4).max(12).optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: tenantId, slug: location },
    select: { id: true, metadata: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  let payload: z.infer<typeof requestSchema>;
  try {
    payload = requestSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const metadataRecord =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : {};

  const preferences = deriveBookingPreferences((metadataRecord as Record<string, unknown>).bookingPreferences ?? null);
  const updatedPreferences = deriveBookingPreferences({ ...preferences, ...payload });

  metadataRecord.bookingPreferences = updatedPreferences;

  try {
    await prisma.location.update({
      where: { id: locationRecord.id },
      data: { metadata: metadataRecord as Prisma.JsonObject },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Einstellungen konnten nicht gespeichert werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "booking_preferences",
    entityId: locationRecord.id,
    diff: payload,
    context: { source: "booking_preferences" },
  });

  return NextResponse.json({ success: true, data: updatedPreferences });
}
