import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { NewCustomerForm } from "@/components/dashboard/customers/NewCustomerForm";
import { getPrismaClient } from "@/lib/prisma";
import type { CustomerCategoryOption } from "@/types/customers";
import { createCustomerAction } from "../actions";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";

const prisma = getPrismaClient();

export default async function NewCustomerPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  const hdrs = await headers();
  const session = await getSessionOrNull();
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
  const locationName = locationRecord.name ?? locationSlug;

  const categories = await prisma.customerCategory.findMany({
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
    },
  });

  const categoryOptions: CustomerCategoryOption[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    color: category.color,
  }));

  async function handleCreate(formData: FormData) {
    "use server";
    return createCustomerAction(locationId, locationSlug, formData);
  }

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-5 py-10">
      <NewCustomerForm locationName={locationName} categories={categoryOptions} onSubmit={handleCreate} />
    </main>
  );
}
