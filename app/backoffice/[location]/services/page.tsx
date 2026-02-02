import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { ServiceManager } from "@/components/services/ServiceManager";
import type { ServiceCreateInput, ServiceListEntry, StaffOption } from "@/types/services";
import { createServiceAction, updateServiceAction, deleteServiceAction } from "./actions";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { normalizeColorDurationConfig } from "@/lib/color-consultation";
import { isAdminRole } from "@/lib/access-control";

export default async function ServicesPage({
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
  const tillhubEnabled = await isTillhubEnabled(tenantId);

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

  const services = await prisma.service.findMany({
    where: { locationId },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      basePrice: true,
      duration: true,
      metadata: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

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
        select: {
          services: true,
        },
      },
    },
  });

  const membershipSupported = await supportsStaffMemberships(prisma);
  const staffRecords = await prisma.staff.findMany({
    where: membershipSupported
      ? {
          memberships: { some: { locationId } },
          status: "ACTIVE",
        }
      : {
          locationId,
          status: "ACTIVE",
        },
    orderBy: [{ displayName: "asc" }, { firstName: "asc" }, { lastName: "asc" }],
    select: {
      id: true,
      displayName: true,
      firstName: true,
      lastName: true,
      color: true,
    },
  });

  const staffOptions: StaffOption[] = staffRecords.map((member) => ({
    id: member.id,
    name: member.displayName?.trim() || `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || "Unbekannt",
    color: member.color ?? "#9ca3af",
  }));

  type ServiceMetadata = {
    priceVisible?: boolean;
    showDurationOnline?: boolean;
    onlineBookable?: boolean;
    assignedStaffIds?: string[];
    addOnServiceIds?: string[];
    tags?: string[];
    tillhubProductId?: string;
    tillhub?: {
      productId?: string;
    };
    colorConsultationDurations?: unknown;
  };

  const serviceEntries: ServiceListEntry[] = services.map((service) => {
    const metadata = (service.metadata ?? {}) as ServiceMetadata;
    const priceVisible = metadata.priceVisible ?? true;
    const showDurationOnline = metadata.showDurationOnline ?? true;
    const onlineBookable = metadata.onlineBookable ?? true;
    const staffIds = Array.isArray(metadata.assignedStaffIds)
      ? metadata.assignedStaffIds.filter((id): id is string => typeof id === "string")
      : [];
    const addOnServiceIds = Array.isArray(metadata.addOnServiceIds)
      ? metadata.addOnServiceIds.filter((id): id is string => typeof id === "string")
      : [];
    const colorConsultationDurations = normalizeColorDurationConfig(metadata.colorConsultationDurations);
    const tags = Array.isArray(metadata.tags)
      ? metadata.tags
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value): value is string => value.length > 0)
      : [];
    const tillhubProductId = normalizeString(
      metadata.tillhub?.productId ?? metadata.tillhubProductId ?? null,
    );

    return {
      id: service.id,
      name: service.name,
      description: service.description,
      price: decimalToNumber(service.basePrice),
      duration: service.duration,
      priceVisible,
      showDurationOnline,
      onlineBookable,
      tillhubProductId,
      colorConsultationDurations,
      staffIds,
      addOnServiceIds,
      tags,
      category: service.category
        ? {
            id: service.category.id,
            name: service.category.name,
            slug: service.category.slug,
          }
        : null,
      createdAt: service.createdAt.toISOString(),
      updatedAt: service.updatedAt.toISOString(),
    };
  });

  const categoryEntries = categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    color: category.color,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    serviceCount: category._count.services,
  }));

  async function handleCreate(input: ServiceCreateInput) {
    "use server";
    return createServiceAction(locationId, locationSlug, input);
  }

  async function handleUpdate(serviceId: string, input: ServiceCreateInput) {
    "use server";
    return updateServiceAction(locationId, locationSlug, serviceId, input);
  }

  async function handleDelete(serviceId: string) {
    "use server";
    return deleteServiceAction(locationId, locationSlug, serviceId);
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Leistungen</p>
        <h1 className="text-3xl font-semibold text-zinc-900">
          {locationRecord.name ?? locationSlug}
        </h1>
        <p className="text-sm text-zinc-600">
          Erfasse Leistungen, Preise und die verantwortlichen Mitarbeitenden für diesen Standort.
        </p>
      </header>
      <ServiceManager
        services={serviceEntries}
        staff={staffOptions}
        categories={categoryEntries}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        showTillhubFields={tillhubEnabled}
      />
    </section>
  );
}

function decimalToNumber(input: unknown): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === "number") return input;
  if (typeof input === "bigint") return Number(input);
  if (typeof input === "object" && "toNumber" in (input as { toNumber?: () => number })) {
    try {
      return (input as { toNumber: () => number }).toNumber();
    } catch {
      return 0;
    }
  }
  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeString(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function isTillhubEnabled(tenantId?: string | null): Promise<boolean> {
  if (!tenantId) return false;
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return false;
  const secret = process.env.PROVISION_SECRET?.trim();

  try {
    const url = new URL("/api/internal/tillhub/config", baseUrl);
    url.searchParams.set("tenantId", tenantId);
    const response = await fetch(url.toString(), {
      headers: secret ? { "x-provision-secret": secret } : undefined,
      cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { tillhub?: { enabled?: boolean } };
    return Boolean(payload?.tillhub?.enabled);
  } catch {
    return false;
  }
}
