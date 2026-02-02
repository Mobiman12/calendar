"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import type { ServiceCreateInput, ServiceCreateResult } from "@/types/services";

const prisma = getPrismaClient();

type StaffMetadataRecord = {
  serviceIds?: unknown;
};

type ControlPlaneStaffRow = {
  id: string;
  metadata: Prisma.JsonValue | null;
};

type StaffServiceSyncParams = {
  locationId: string;
  serviceId: string;
  addedStaffIds: string[];
  removedStaffIds: string[];
};

function normalizeTillhubProductId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function applyTillhubProductId(
  metadata: Prisma.JsonObject,
  productId: string | null,
): Prisma.JsonObject {
  const next = { ...metadata };
  const rawTillhub = next.tillhub;
  const tillhub =
    rawTillhub && typeof rawTillhub === "object" && !Array.isArray(rawTillhub)
      ? { ...(rawTillhub as Record<string, unknown>) }
      : {};

  if (productId) {
    tillhub.productId = productId;
    next.tillhub = tillhub;
    next.tillhubProductId = productId;
    return next;
  }

  if ("productId" in tillhub) {
    delete (tillhub as Record<string, unknown>).productId;
  }
  if (Object.keys(tillhub).length > 0) {
    next.tillhub = tillhub;
  } else {
    delete next.tillhub;
  }
  if ("tillhubProductId" in next) {
    delete next.tillhubProductId;
  }
  return next;
}

function readAssignedStaffIds(metadata: Prisma.JsonValue | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const record = metadata as Record<string, unknown>;
  const assignedStaffIds = record.assignedStaffIds;
  if (!Array.isArray(assignedStaffIds)) {
    return [];
  }
  return Array.from(
    new Set(
      assignedStaffIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function readServiceIds(metadata: Prisma.JsonValue | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return [];
  }
  const record = metadata as StaffMetadataRecord;
  if (!Array.isArray(record.serviceIds)) {
    return [];
  }
  return Array.from(
    new Set(
      record.serviceIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ),
  );
}

function writeServiceIds(
  metadata: Prisma.JsonValue | null,
  serviceIds: string[],
): Prisma.InputJsonValue {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  base.serviceIds = serviceIds;
  return base as Prisma.InputJsonValue;
}

function applyServiceId(
  currentIds: string[],
  serviceId: string,
  shouldInclude: boolean,
): { next: string[]; changed: boolean } {
  const set = new Set(currentIds);
  const had = set.has(serviceId);
  if (shouldInclude) {
    set.add(serviceId);
  } else {
    set.delete(serviceId);
  }
  return { next: Array.from(set), changed: had !== shouldInclude };
}

async function syncServiceAssignmentsToStaff({
  locationId,
  serviceId,
  addedStaffIds,
  removedStaffIds,
}: StaffServiceSyncParams) {
  const operations = new Map<string, boolean>();
  addedStaffIds.forEach((id) => operations.set(id, true));
  removedStaffIds.forEach((id) => operations.set(id, false));
  const staffIds = Array.from(operations.keys());
  if (staffIds.length === 0) return;

  const calendarStaff = await prisma.staff.findMany({
    where: { id: { in: staffIds } },
    select: { id: true, metadata: true },
  });

  await Promise.all(
    calendarStaff.map(async (staff) => {
      const shouldInclude = operations.get(staff.id);
      if (shouldInclude === undefined) return;
      const currentIds = readServiceIds(staff.metadata);
      const { next, changed } = applyServiceId(currentIds, serviceId, shouldInclude);
      if (!changed) return;
      await prisma.staff.update({
        where: { id: staff.id },
        data: { metadata: writeServiceIds(staff.metadata, next) },
      });
    }),
  );

  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { tenantId: true },
  });
  if (!location?.tenantId) return;

  const controlPlaneStaff = await prisma.$queryRaw<ControlPlaneStaffRow[]>`
    SELECT id, metadata
    FROM "control_plane"."StaffMember"
    WHERE "tenantId" = ${location.tenantId}
      AND id IN (${Prisma.join(staffIds)})
  `;

  for (const staff of controlPlaneStaff) {
    const shouldInclude = operations.get(staff.id);
    if (shouldInclude === undefined) continue;
    const currentIds = readServiceIds(staff.metadata);
    const { next, changed } = applyServiceId(currentIds, serviceId, shouldInclude);
    if (!changed) continue;
    const nextMetadata = writeServiceIds(staff.metadata, next);
    const nextMetadataJson = JSON.stringify(nextMetadata);
    await prisma.$executeRaw`
      UPDATE "control_plane"."StaffMember"
      SET metadata = ${nextMetadataJson}::jsonb,
          "updatedAt" = NOW()
      WHERE id = ${staff.id}
    `;
  }
}

export async function createServiceAction(
  locationId: string,
  locationSlug: string,
  input: ServiceCreateInput,
): Promise<ServiceCreateResult> {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    return { success: false, error: "Name ist erforderlich." };
  }
  if (!Number.isFinite(input.price) || input.price < 0) {
    return { success: false, error: "Preis ist ungültig." };
  }
  if (!Number.isInteger(input.duration) || input.duration <= 0) {
    return { success: false, error: "Dauer ist ungültig." };
  }
  if (!input.categoryId) {
    return { success: false, error: "Kategorie ist erforderlich." };
  }
  const normalizedTags = Array.from(
    new Set(input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
  const tillhubProductId = normalizeTillhubProductId(input.tillhubProductId);

  try {
    const membershipSupported = await supportsStaffMemberships(prisma);
    const category = await prisma.serviceCategory.findFirst({
      where: { id: input.categoryId, locationId },
      select: { id: true },
    });

    if (!category) {
      return { success: false, error: "Kategorie wurde nicht gefunden." };
    }

    const staffIds = await prisma.staff
      .findMany({
        where: membershipSupported
          ? {
              id: { in: input.staffIds },
              memberships: {
                some: {
                  locationId,
                },
              },
            }
          : {
              id: { in: input.staffIds },
              locationId,
            },
        select: { id: true },
      })
      .then((records) => records.map((record) => record.id));

    const addOnServiceIds = await prisma.service
      .findMany({
        where: {
          locationId,
          id: { in: input.addOnServiceIds },
        },
        select: { id: true },
      })
      .then((records) => records.map((record) => record.id));

    const baseSlug =
      trimmedName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)+/g, "")
        .slice(0, 48) || "leistung";

    let slugCandidate = baseSlug;
    let counter = 1;
    while (
      await prisma.service.findFirst({
        where: {
          locationId,
          slug: slugCandidate,
        },
        select: { id: true },
      })
    ) {
      counter += 1;
      slugCandidate = `${baseSlug}-${counter}`;
    }

    const metadata: Prisma.JsonObject = {
      priceVisible: input.priceVisible,
      showDurationOnline: input.showDurationOnline,
      onlineBookable: input.onlineBookable,
      assignedStaffIds: staffIds,
      addOnServiceIds,
      voucherMode: "NONE",
      taxMode: "NONE",
      tags: normalizedTags,
    };
    if (input.colorConsultationDurations) {
      metadata.colorConsultationDurations = input.colorConsultationDurations as Prisma.InputJsonValue;
    }
    const metadataWithTillhub =
      input.tillhubProductId !== undefined ? applyTillhubProductId(metadata, tillhubProductId) : metadata;

    const createdService = await prisma.service.create({
      data: {
        locationId,
        name: trimmedName,
        slug: slugCandidate,
        description: input.description ?? null,
        duration: input.duration,
        basePrice: new Prisma.Decimal(input.price.toFixed(2)),
        status: "ACTIVE",
        categoryId: category.id,
        metadata: metadataWithTillhub,
        steps: {
          create: [
            {
              name: "Leistung",
              order: 0,
              duration: input.duration,
            },
          ],
        },
      },
      select: { id: true },
    });

    if (staffIds.length > 0) {
      try {
        await syncServiceAssignmentsToStaff({
          locationId,
          serviceId: createdService.id,
          addedStaffIds: staffIds,
          removedStaffIds: [],
        });
      } catch (syncError) {
        console.error("[services:create] staff sync failed", syncError);
      }
    }
  } catch (error) {
    console.error("[services:create] failed", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "Eine Leistung mit diesem Namen existiert bereits." };
    }
    return { success: false, error: "Leistung konnte nicht erstellt werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/services`);
  revalidatePath(`/backoffice/${locationSlug}/categories`);
  revalidatePath(`/backoffice/${locationSlug}/calendar`);
  return { success: true };
}

export async function updateServiceAction(
  locationId: string,
  locationSlug: string,
  serviceId: string,
  input: ServiceCreateInput,
): Promise<ServiceCreateResult> {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    return { success: false, error: "Name ist erforderlich." };
  }
  if (!Number.isFinite(input.price) || input.price < 0) {
    return { success: false, error: "Preis ist ungültig." };
  }
  if (!Number.isInteger(input.duration) || input.duration <= 0) {
    return { success: false, error: "Dauer ist ungültig." };
  }
  if (!input.categoryId) {
    return { success: false, error: "Kategorie ist erforderlich." };
  }
  const normalizedTags = Array.from(
    new Set(input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)),
  );
  const tillhubProductId = normalizeTillhubProductId(input.tillhubProductId);

  try {
    const membershipSupported = await supportsStaffMemberships(prisma);
    const [service, category] = await Promise.all([
      prisma.service.findFirst({
        where: { id: serviceId, locationId },
        select: { id: true, metadata: true },
      }),
      prisma.serviceCategory.findFirst({
        where: { id: input.categoryId, locationId },
        select: { id: true },
      }),
    ]);

    if (!service) {
      return { success: false, error: "Leistung wurde nicht gefunden." };
    }
    if (!category) {
      return { success: false, error: "Kategorie wurde nicht gefunden." };
    }

    const staffIds = await prisma.staff
      .findMany({
        where: membershipSupported
          ? {
              id: { in: input.staffIds },
              memberships: {
                some: {
                  locationId,
                },
              },
            }
          : {
              id: { in: input.staffIds },
              locationId,
            },
        select: { id: true },
      })
      .then((records) => records.map((record) => record.id));

    const addOnServiceIds = await prisma.service
      .findMany({
        where: {
          locationId,
          id: { in: input.addOnServiceIds.filter((id) => id !== serviceId) },
        },
        select: { id: true },
      })
      .then((records) => records.map((record) => record.id));

    const currentMetadata = (service.metadata ?? {}) as Prisma.JsonObject;
    const previousAssignedStaffIds = readAssignedStaffIds(service.metadata);
    const updatedMetadata: Prisma.JsonObject = {
      ...currentMetadata,
      priceVisible: input.priceVisible,
      showDurationOnline: input.showDurationOnline,
      onlineBookable: input.onlineBookable,
      assignedStaffIds: staffIds,
      addOnServiceIds,
      tags: normalizedTags,
    };
    if (input.colorConsultationDurations) {
      updatedMetadata.colorConsultationDurations = input.colorConsultationDurations as Prisma.InputJsonValue;
    } else {
      delete updatedMetadata.colorConsultationDurations;
    }
    const metadataWithTillhub =
      input.tillhubProductId !== undefined ? applyTillhubProductId(updatedMetadata, tillhubProductId) : updatedMetadata;

    await prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: service.id },
        data: {
          name: trimmedName,
          description: input.description ?? null,
          duration: input.duration,
          basePrice: new Prisma.Decimal(input.price.toFixed(2)),
          categoryId: category.id,
          metadata: metadataWithTillhub,
        },
      });

      await tx.serviceStep.updateMany({
        where: { serviceId: service.id, order: 0 },
        data: { duration: input.duration },
      });
    });

    const previousSet = new Set(previousAssignedStaffIds);
    const nextSet = new Set(staffIds);
    const addedStaffIds = staffIds.filter((id) => !previousSet.has(id));
    const removedStaffIds = previousAssignedStaffIds.filter((id) => !nextSet.has(id));
    if (addedStaffIds.length || removedStaffIds.length) {
      try {
        await syncServiceAssignmentsToStaff({
          locationId,
          serviceId: service.id,
          addedStaffIds,
          removedStaffIds,
        });
      } catch (syncError) {
        console.error("[services:update] staff sync failed", syncError);
      }
    }
  } catch (error) {
    console.error("[services:update] failed", error);
    return { success: false, error: "Leistung konnte nicht aktualisiert werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/services`);
  revalidatePath(`/backoffice/${locationSlug}/categories`);
  revalidatePath(`/backoffice/${locationSlug}/calendar`);
  return { success: true };
}

export async function deleteServiceAction(
  locationId: string,
  locationSlug: string,
  serviceId: string,
): Promise<ServiceCreateResult> {
  try {
    const service = await prisma.service.findFirst({
      where: { id: serviceId, locationId },
      select: { id: true, metadata: true },
    });

    if (!service) {
      return { success: false, error: "Leistung wurde nicht gefunden." };
    }

    const appointmentUsage = await prisma.appointmentItem.count({
      where: { serviceId: service.id },
    });

    if (appointmentUsage > 0) {
      return { success: false, error: "Leistung wird in bestehenden Terminen verwendet und kann nicht gelöscht werden." };
    }

    const assignedStaffIds = readAssignedStaffIds(service.metadata);

    await prisma.service.delete({
      where: { id: service.id },
    });

    if (assignedStaffIds.length > 0) {
      try {
        await syncServiceAssignmentsToStaff({
          locationId,
          serviceId: service.id,
          addedStaffIds: [],
          removedStaffIds: assignedStaffIds,
        });
      } catch (syncError) {
        console.error("[services:delete] staff sync failed", syncError);
      }
    }
  } catch (error) {
    console.error("[services:delete] failed", error);
    return { success: false, error: "Leistung konnte nicht gelöscht werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/services`);
  revalidatePath(`/backoffice/${locationSlug}/categories`);
  revalidatePath(`/backoffice/${locationSlug}/calendar`);
  return { success: true };
}
