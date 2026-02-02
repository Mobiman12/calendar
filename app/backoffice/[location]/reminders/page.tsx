import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { getPrismaClient } from "@/lib/prisma";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";
import { readReminderRules, type ReminderFormInput } from "@/lib/reminders";
import { ReminderManager } from "@/components/reminders/ReminderManager";
import {
  createReminderAction,
  deleteReminderAction,
  updateReminderAction,
  type ReminderActionResult,
} from "./actions";

export default async function RemindersPage({ params }: { params: Promise<{ location: string }> }) {
  const { location } = await params;
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect(`/backoffice/${location}/calendar`);
  }
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  let locationRecord = await prisma.location.findFirst(
    tenantId
      ? { where: { tenantId: tenantId, slug: location }, select: { id: true, name: true, slug: true, metadata: true } }
      : { where: { slug: location }, select: { id: true, name: true, slug: true, metadata: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({
      where: { slug: location },
      select: { id: true, name: true, slug: true, metadata: true },
    });
  }

  if (!locationRecord) {
    notFound();
  }

  const reminders = readReminderRules(locationRecord.metadata);
  const locationId = locationRecord.id;
  const locationSlug = locationRecord.slug;

  async function handleCreate(input: ReminderFormInput): Promise<ReminderActionResult> {
    "use server";
    return createReminderAction(locationId, locationSlug, input);
  }

  async function handleUpdate(id: string, input: ReminderFormInput): Promise<ReminderActionResult> {
    "use server";
    return updateReminderAction(locationId, locationSlug, id, input);
  }

  async function handleDelete(id: string): Promise<ReminderActionResult> {
    "use server";
    return deleteReminderAction(locationId, locationSlug, id);
  }

  return <ReminderManager reminders={reminders} onCreate={handleCreate} onUpdate={handleUpdate} onDelete={handleDelete} />;
}
