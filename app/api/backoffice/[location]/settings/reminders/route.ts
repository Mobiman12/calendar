import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { applyReminderRules, buildReminderFromInput, readReminderRules } from "@/lib/reminders";

const reminderInputSchema = z.object({
  message: z.string().trim().default(""),
  days: z.number().int().min(0).max(365),
  hours: z.number().int().min(0).max(23),
  minutes: z.number().int().min(0).max(59),
  timing: z.enum(["BEFORE", "AFTER"]),
  sendEmail: z.boolean(),
  sendSms: z.boolean(),
  sendWhatsapp: z.boolean(),
  whatsappTemplateKey: z.enum(["bookingConfirmation", "reminder", "followUpThanks", "followUpNoShow"]).default("reminder"),
});

const reminderUpdateSchema = reminderInputSchema.extend({
  id: z.string().min(1),
});

const reminderDeleteSchema = z.object({
  id: z.string().min(1),
});

export async function POST(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  let payload: z.infer<typeof reminderInputSchema>;
  try {
    payload = reminderInputSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const reminder = buildReminderFromInput(payload);
  if (!reminder) {
    return NextResponse.json(
      { error: "Bitte Nachricht (für E-Mail/SMS), Zeitabstand und mindestens einen Versandkanal angeben." },
      { status: 400 },
    );
  }

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, metadata: true },
  });
  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const reminders = readReminderRules(locationRecord.metadata);
  const nextReminders = [reminder, ...reminders];
  const updatedMeta = applyReminderRules(locationRecord.metadata, nextReminders);

  try {
    await prisma.location.update({
      where: { id: locationRecord.id },
      data: { metadata: updatedMeta as Prisma.JsonObject },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erinnerung konnte nicht gespeichert werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  let payload: z.infer<typeof reminderUpdateSchema>;
  try {
    payload = reminderUpdateSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, metadata: true },
  });
  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const reminders = readReminderRules(locationRecord.metadata);
  const existing = reminders.find((item) => item.id === payload.id);
  if (!existing) {
    return NextResponse.json({ error: "Erinnerung nicht gefunden." }, { status: 404 });
  }

  const updated = buildReminderFromInput(payload, existing);
  if (!updated) {
    return NextResponse.json(
      { error: "Bitte Nachricht (für E-Mail/SMS), Zeitabstand und mindestens einen Versandkanal angeben." },
      { status: 400 },
    );
  }

  const nextReminders = reminders.map((item) => (item.id === payload.id ? updated : item));
  const updatedMeta = applyReminderRules(locationRecord.metadata, nextReminders);

  try {
    await prisma.location.update({
      where: { id: locationRecord.id },
      data: { metadata: updatedMeta as Prisma.JsonObject },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erinnerung konnte nicht gespeichert werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  let payload: z.infer<typeof reminderDeleteSchema>;
  try {
    payload = reminderDeleteSchema.parse(await request.json());
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId, slug: location },
    select: { id: true, metadata: true },
  });
  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const reminders = readReminderRules(locationRecord.metadata);
  const nextReminders = reminders.filter((item) => item.id !== payload.id);
  const updatedMeta = applyReminderRules(locationRecord.metadata, nextReminders);

  try {
    await prisma.location.update({
      where: { id: locationRecord.id },
      data: { metadata: updatedMeta as Prisma.JsonObject },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erinnerung konnte nicht gelöscht werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
