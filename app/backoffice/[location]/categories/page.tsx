import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";

import { getPrismaClient } from "@/lib/prisma";
import { CategoryManager } from "@/components/services/CategoryManager";
import type { ServiceCategoryCreateInput, ServiceCategoryListEntry } from "@/types/services";
import { createCategoryAction, deleteCategoryAction, updateCategoryAction } from "./actions";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

export default async function CategoriesPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
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
      ? { where: { tenantId: tenantId, slug: location }, select: { id: true, name: true, slug: true } }
      : { where: { slug: location }, select: { id: true, name: true, slug: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, select: { id: true, name: true, slug: true } });
  }

  if (!locationRecord) {
    notFound();
  }

  const locationId = locationRecord.id;
  const locationSlug = locationRecord.slug;

  const categories = await prisma.serviceCategory.findMany({
    where: { locationId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      color: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { services: true },
      },
    },
  });

  const categoryEntries: ServiceCategoryListEntry[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    color: category.color,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    serviceCount: category._count.services,
  }));

  async function handleCreate(input: ServiceCategoryCreateInput) {
    "use server";
    return createCategoryAction(locationId, locationSlug, input);
  }

  async function handleUpdate(categoryId: string, input: ServiceCategoryCreateInput) {
    "use server";
    return updateCategoryAction(locationId, locationSlug, categoryId, input);
  }

  async function handleDelete(categoryId: string) {
    "use server";
    return deleteCategoryAction(locationId, locationSlug, categoryId);
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Kategorien</p>
        <h1 className="text-3xl font-semibold text-zinc-900">
          {locationRecord.name ?? locationSlug}
        </h1>
        <p className="text-sm text-zinc-600">Verwalte die Kategorien deiner Leistungen.</p>
      </header>
      <CategoryManager
        categories={categoryEntries}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </section>
  );
}
