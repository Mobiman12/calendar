"use server";

import { revalidatePath } from "next/cache";

import { getPrismaClient } from "@/lib/prisma";
import type { ReminderFormInput, ReminderRule } from "@/lib/reminders";
import { applyReminderRules, buildReminderFromInput, readReminderRules } from "@/lib/reminders";

export type ReminderActionResult = { success: true } | { success: false; error: string };

const prisma = getPrismaClient();

export async function createReminderAction(
  locationId: string,
  locationSlug: string,
  input: ReminderFormInput,
): Promise<ReminderActionResult> {
  const reminder = buildReminderFromInput(input);
  if (!reminder) {
    return {
      success: false,
      error: "Bitte Nachricht (für E-Mail/SMS), Zeitabstand und mindestens einen Versandkanal angeben.",
    };
  }

  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { metadata: true } });
  if (!location) {
    return { success: false, error: "Standort nicht gefunden." };
  }

  const reminders = readReminderRules(location.metadata);
  const nextReminders = [reminder, ...reminders];
  const updatedMeta = applyReminderRules(location.metadata, nextReminders);

  await prisma.location.update({
    where: { id: locationId },
    data: { metadata: updatedMeta },
  });

  revalidatePath(`/backoffice/${locationSlug}/reminders`);
  return { success: true };
}

export async function updateReminderAction(
  locationId: string,
  locationSlug: string,
  reminderId: string,
  input: ReminderFormInput,
): Promise<ReminderActionResult> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { metadata: true } });
  if (!location) {
    return { success: false, error: "Standort nicht gefunden." };
  }

  const reminders = readReminderRules(location.metadata);
  const existing = reminders.find((item) => item.id === reminderId);
  if (!existing) {
    return { success: false, error: "Erinnerung nicht gefunden." };
  }
  const updated = buildReminderFromInput(input, existing);
  if (!updated) {
    return {
      success: false,
      error: "Bitte Nachricht (für E-Mail/SMS), Zeitabstand und mindestens einen Versandkanal angeben.",
    };
  }

  const nextReminders = reminders.map((item) => (item.id === reminderId ? updated : item));
  const updatedMeta = applyReminderRules(location.metadata, nextReminders);

  await prisma.location.update({
    where: { id: locationId },
    data: { metadata: updatedMeta },
  });

  revalidatePath(`/backoffice/${locationSlug}/reminders`);
  return { success: true };
}

export async function deleteReminderAction(
  locationId: string,
  locationSlug: string,
  reminderId: string,
): Promise<ReminderActionResult> {
  const location = await prisma.location.findUnique({ where: { id: locationId }, select: { metadata: true } });
  if (!location) {
    return { success: false, error: "Standort nicht gefunden." };
  }

  const reminders = readReminderRules(location.metadata);
  const nextReminders = reminders.filter((item) => item.id !== reminderId);
  const updatedMeta = applyReminderRules(location.metadata, nextReminders);

  await prisma.location.update({
    where: { id: locationId },
    data: { metadata: updatedMeta },
  });

  revalidatePath(`/backoffice/${locationSlug}/reminders`);
  return { success: true };
}
