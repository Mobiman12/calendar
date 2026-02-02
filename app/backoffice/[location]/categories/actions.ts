"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import type { ServiceCategoryCreateInput, ServiceCategoryCreateResult } from "@/types/services";

const prisma = getPrismaClient();

export async function createCategoryAction(
  locationId: string,
  locationSlug: string,
  input: ServiceCategoryCreateInput,
): Promise<ServiceCategoryCreateResult> {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    return { success: false, error: "Name ist erforderlich." };
  }

  const baseSlug =
    trimmedName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 48) || "kategorie";

  let slugCandidate = baseSlug;
  let counter = 1;
  while (
    await prisma.serviceCategory.findFirst({
      where: { locationId, slug: slugCandidate },
      select: { id: true },
    })
  ) {
    counter += 1;
    slugCandidate = `${baseSlug}-${counter}`;
  }

  try {
    await prisma.serviceCategory.create({
      data: {
        locationId,
        name: trimmedName,
        slug: slugCandidate,
        description: input.description ?? null,
        color: input.color ?? null,
      },
    });
  } catch (error) {
    console.error("[categories:create] failed", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "Eine Kategorie mit diesem Namen existiert bereits." };
    }
    return { success: false, error: "Kategorie konnte nicht erstellt werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/categories`);
  revalidatePath(`/backoffice/${locationSlug}/services`);
  return { success: true };
}

export async function updateCategoryAction(
  locationId: string,
  locationSlug: string,
  categoryId: string,
  input: ServiceCategoryCreateInput,
): Promise<ServiceCategoryCreateResult> {
  const trimmedName = input.name.trim();
  if (!trimmedName) {
    return { success: false, error: "Name ist erforderlich." };
  }

  const existing = await prisma.serviceCategory.findFirst({
    where: { id: categoryId, locationId },
    select: { id: true },
  });
  if (!existing) {
    return { success: false, error: "Kategorie wurde nicht gefunden." };
  }

  try {
    await prisma.serviceCategory.update({
      where: { id: categoryId },
      data: {
        name: trimmedName,
        description: input.description ?? null,
        color: input.color ?? null,
      },
    });
  } catch (error) {
    console.error("[categories:update] failed", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "Eine Kategorie mit diesem Namen existiert bereits." };
    }
    return { success: false, error: "Kategorie konnte nicht gespeichert werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/categories`);
  revalidatePath(`/backoffice/${locationSlug}/services`);
  return { success: true };
}

export async function deleteCategoryAction(
  locationId: string,
  locationSlug: string,
  categoryId: string,
): Promise<ServiceCategoryCreateResult> {
  const existing = await prisma.serviceCategory.findFirst({
    where: { id: categoryId, locationId },
    select: { id: true },
  });
  if (!existing) {
    return { success: false, error: "Kategorie wurde nicht gefunden." };
  }

  try {
    await prisma.$transaction([
      prisma.service.deleteMany({ where: { locationId, categoryId } }),
      prisma.serviceCategory.delete({ where: { id: categoryId } }),
    ]);
  } catch (error) {
    console.error("[categories:delete] failed", error);
    return { success: false, error: "Kategorie konnte nicht geloescht werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/categories`);
  revalidatePath(`/backoffice/${locationSlug}/services`);
  return { success: true };
}
