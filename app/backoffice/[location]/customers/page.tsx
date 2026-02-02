import Link from "next/link";
import { formatDistanceToNow, subDays } from "date-fns";
import { de } from "date-fns/locale";
import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { ConsentScope, ConsentType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { CustomerCategoryManager } from "@/components/customers/CustomerCategoryManager";
import { CustomerDetailForm } from "@/components/customers/CustomerDetailForm";
import { NewCustomerButton } from "@/components/customers/NewCustomerButton";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { readCustomerNotes, readCustomerProfile } from "@/lib/customer-metadata";
import { normalizeConsentMethod } from "@/lib/consent-method";
import type { CustomerCategoryCreateInput, CustomerCategoryListEntry } from "@/types/customers";
import {
  createCustomerCategoryAction,
  createCustomerNoteAction,
  deleteCustomerAction,
  updateCustomerAction,
  updateCustomerConsentsAction,
  resendCustomerPermissionLinkAction,
} from "./actions";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";

function formatRelative(date: Date) {
  return formatDistanceToNow(date, { addSuffix: true, locale: de });
}

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const SORT_OPTIONS = [
  { value: "created_desc", label: "Neueste zuerst" },
  { value: "created_asc", label: "Älteste zuerst" },
  { value: "name_asc", label: "Name A-Z" },
  { value: "name_desc", label: "Name Z-A" },
  { value: "appointments_desc", label: "Termine (meiste)" },
] as const;
const ACTIVITY_OPTIONS = [
  { value: "", label: "Alle Aktivitaeten" },
  { value: "active", label: "Aktiv (90 Tage)" },
  { value: "new", label: "Neu (30 Tage)" },
  { value: "inactive", label: "Inaktiv (90 Tage)" },
  { value: "none", label: "Ohne Termine" },
] as const;
const CONSENT_OPTIONS = [
  { value: "", label: "Alle Einwilligungen" },
  { value: "any", label: "Einwilligung vorhanden" },
  { value: "email", label: "E-Mail" },
  { value: "sms", label: "SMS" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "none", label: "Keine" },
] as const;
const CONTACT_OPTIONS = [
  { value: "", label: "Alle Kontakte" },
  { value: "phone", label: "Nur Telefon" },
  { value: "email", label: "Nur E-Mail" },
  { value: "both", label: "Telefon + E-Mail" },
  { value: "none", label: "Kein Kontakt" },
] as const;

type SortKey = (typeof SORT_OPTIONS)[number]["value"];
const SORT_ORDER_BY: Record<SortKey, Prisma.CustomerOrderByWithRelationInput[]> = {
  created_desc: [{ createdAt: "desc" }],
  created_asc: [{ createdAt: "asc" }],
  name_asc: [{ lastName: "asc" }, { firstName: "asc" }],
  name_desc: [{ lastName: "desc" }, { firstName: "desc" }],
  appointments_desc: [{ appointments: { _count: "desc" } }, { createdAt: "desc" }],
};

function toNumber(value: Prisma.Decimal | null | undefined) {
  if (!value) return null;
  if (typeof value === "number") return value;
  if (typeof (value as Prisma.Decimal).toNumber === "function") {
    return (value as Prisma.Decimal).toNumber();
  }
  return Number(value);
}

function readConsentMetadata(metadata: Prisma.JsonValue | null) {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const readString = (value: unknown) => (typeof value === "string" && value.trim().length ? value : null);
  return {
    method: normalizeConsentMethod(readString(record.method)),
    reference: readString(record.reference),
    textVersion: readString(record.textVersion),
    note: readString(record.note),
  };
}

function readTillhubCustomerId(
  metadata: Prisma.JsonValue | null,
  profile?: { customerNumber?: string | null },
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const tillhub = (metadata as Record<string, unknown>).tillhub;
  if (!tillhub || typeof tillhub !== "object" || Array.isArray(tillhub)) return null;
  const candidate =
    (tillhub as Record<string, unknown>).customerId ??
    (tillhub as Record<string, unknown>).id ??
    (tillhub as Record<string, unknown>).customer_id ??
    (tillhub as Record<string, unknown>).uuid ??
    null;
  if (typeof candidate === "string" && candidate.trim().length) return candidate.trim();
  const fallback = profile?.customerNumber ?? null;
  return typeof fallback === "string" && fallback.trim().length ? fallback.trim() : null;
}

function readTillhubAccountId(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const tillhub = (metadata as Record<string, unknown>).tillhub;
  if (!tillhub || typeof tillhub !== "object" || Array.isArray(tillhub)) return null;
  const candidate =
    (tillhub as Record<string, unknown>).accountId ??
    (tillhub as Record<string, unknown>).account_id ??
    (tillhub as Record<string, unknown>).clientAccountId ??
    (tillhub as Record<string, unknown>).clientId ??
    null;
  return typeof candidate === "string" && candidate.trim().length ? candidate.trim() : null;
}

const CONSENT_SCOPE_LABELS: Record<string, string> = {
  EMAIL: "E-Mail",
  SMS: "SMS",
  WHATSAPP: "WhatsApp",
};

function formatConsentLabel(type: string, scope: string) {
  if (type === "COMMUNICATION") {
    return CONSENT_SCOPE_LABELS[scope] ?? scope;
  }
  return type;
}

async function resolveIsAdmin(
  prisma: ReturnType<typeof getPrismaClient>,
  session: Awaited<ReturnType<typeof getSessionOrNull>>,
  locationId: string,
  staffMembershipSupported: boolean,
) {
  if (!session?.userId) return false;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      role: true,
      staff: staffMembershipSupported
        ? { select: { memberships: { where: { locationId }, select: { role: true } } } }
        : { select: { id: true } },
    },
  });
  const role = user?.role ?? session.role ?? null;
  const isAdminRole = role === "ADMIN" || role === "OWNER";
  if (!isAdminRole) return false;
  if (!staffMembershipSupported) return isAdminRole;
  const membershipRole =
    user?.staff?.memberships?.find((entry) => typeof entry.role === "string" && entry.role.trim().length)?.role ??
    null;
  if (!membershipRole) return isAdminRole;
  const normalized = membershipRole.trim().toLowerCase();
  const adminTokens = new Set(["admin", "administrator", "superadmin", "super-admin", "owner"]);
  return adminTokens.has(normalized);
}

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ location: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ location }, query] = await Promise.all([params, searchParams]);
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const session = await getSessionOrNull();
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  let locationRecord = await prisma.location.findFirst(
    tenantId
      ? { where: { tenantId: tenantId, slug: location }, select: { id: true, name: true, slug: true, currency: true } }
      : { where: { slug: location }, select: { id: true, name: true, slug: true, currency: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({
      where: { slug: location },
      select: { id: true, name: true, slug: true, currency: true },
    });
  }

  if (!locationRecord) {
    notFound();
  }

  const locationId = locationRecord.id;
  const locationSlug = locationRecord.slug;
  const locationName = locationRecord.name ?? locationSlug;
  const locationCurrency = locationRecord.currency ?? "EUR";

  const rawQuery = Array.isArray(query.q) ? query.q[0] : query.q;
  const searchQuery = typeof rawQuery === "string" ? rawQuery.trim() : "";
  const searchDigits = searchQuery.replace(/\D/g, "");
  const rawSort = Array.isArray(query.sort) ? query.sort[0] : query.sort;
  const sortKey = (typeof rawSort === "string" ? rawSort : "created_desc") as SortKey;
  const resolvedSort = SORT_OPTIONS.some((option) => option.value === sortKey) ? sortKey : "created_desc";
  const rawPageSize = Array.isArray(query.pageSize) ? query.pageSize[0] : query.pageSize;
  const requestedPageSize = Number.parseInt(typeof rawPageSize === "string" ? rawPageSize : "", 10);
  const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;
  const rawCategory = Array.isArray(query.category) ? query.category[0] : query.category;
  const categoryValue = typeof rawCategory === "string" ? rawCategory : "";
  const rawActivity = Array.isArray(query.activity) ? query.activity[0] : query.activity;
  const activityValue = typeof rawActivity === "string" ? rawActivity : "";
  const rawConsent = Array.isArray(query.consent) ? query.consent[0] : query.consent;
  const consentValue = typeof rawConsent === "string" ? rawConsent : "";
  const rawContact = Array.isArray(query.contact) ? query.contact[0] : query.contact;
  const contactValue = typeof rawContact === "string" ? rawContact : "";
  const rawPage = Array.isArray(query.page) ? query.page[0] : query.page;
  const requestedPage = Number.parseInt(typeof rawPage === "string" ? rawPage : "", 10);
  const rawEmbed = Array.isArray(query.embed) ? query.embed[0] : query.embed;
  const isEmbedded = rawEmbed === "1" || rawEmbed === "true";
  const shouldLoadList = !isEmbedded;

  const now = new Date();
  const last30 = subDays(now, 30);
  const last90 = subDays(now, 90);

  const [membershipSupported, staffMembershipSupported] = await Promise.all([
    supportsCustomerMemberships(prisma),
    supportsStaffMemberships(prisma),
  ]);
  const isAdmin = await resolveIsAdmin(prisma, session, locationId, staffMembershipSupported);

  const locationScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        OR: [
          { locationId },
          { memberships: { some: { locationId } } },
        ],
      }
    : {
        locationId,
      };

  const searchFilter: Prisma.CustomerWhereInput | null = searchQuery
    ? {
        OR: [
          { firstName: { contains: searchQuery, mode: "insensitive" } },
          { lastName: { contains: searchQuery, mode: "insensitive" } },
          { email: { contains: searchQuery, mode: "insensitive" } },
          { phone: { contains: searchQuery, mode: "insensitive" } },
          ...(searchDigits.length >= 3 && searchDigits !== searchQuery
            ? [{ phone: { contains: searchDigits, mode: "insensitive" } }]
            : []),
        ],
      }
    : null;

  const categoryFilter: Prisma.CustomerWhereInput | null = categoryValue
    ? categoryValue === "none"
      ? { categoryId: null }
      : { categoryId: categoryValue }
    : null;
  const activityFilter: Prisma.CustomerWhereInput | null = activityValue
    ? activityValue === "active"
      ? {
          appointments: {
            some: {
              locationId,
              startsAt: { gte: last90 },
              status: { in: ["COMPLETED", "CONFIRMED"] },
            },
          },
        }
      : activityValue === "new"
        ? { createdAt: { gte: last30 } }
        : activityValue === "inactive"
          ? {
              appointments: {
                none: {
                  locationId,
                  startsAt: { gte: last90 },
                  status: { in: ["COMPLETED", "CONFIRMED"] },
                },
              },
            }
          : activityValue === "none"
            ? {
                appointments: {
                  none: { locationId },
                },
              }
            : null
    : null;
  const consentFilter: Prisma.CustomerWhereInput | null = consentValue
    ? consentValue === "none"
      ? {
          consents: {
            none: {
              type: ConsentType.COMMUNICATION,
              granted: true,
            },
          },
        }
      : consentValue === "any"
        ? {
            consents: {
              some: {
                type: ConsentType.COMMUNICATION,
                granted: true,
              },
            },
          }
        : consentValue === "email"
          ? {
              consents: {
                some: {
                  type: ConsentType.COMMUNICATION,
                  scope: ConsentScope.EMAIL,
                  granted: true,
                },
              },
            }
          : consentValue === "sms"
            ? {
                consents: {
                  some: {
                    type: ConsentType.COMMUNICATION,
                    scope: ConsentScope.SMS,
                    granted: true,
                  },
                },
              }
            : consentValue === "whatsapp"
              ? {
                  consents: {
                    some: {
                      type: ConsentType.COMMUNICATION,
                      scope: ConsentScope.WHATSAPP,
                      granted: true,
                    },
                  },
                }
              : null
    : null;
  const contactFilter: Prisma.CustomerWhereInput | null = contactValue
    ? contactValue === "phone"
      ? { phone: { not: null } }
      : contactValue === "email"
        ? { email: { not: null } }
        : contactValue === "both"
          ? { AND: [{ phone: { not: null } }, { email: { not: null } }] }
          : contactValue === "none"
            ? { AND: [{ phone: null }, { email: null }] }
            : null
    : null;

  const filterClauses: Prisma.CustomerWhereInput[] = [locationScope];
  if (searchFilter) filterClauses.push(searchFilter);
  if (categoryFilter) filterClauses.push(categoryFilter);
  if (activityFilter) filterClauses.push(activityFilter);
  if (consentFilter) filterClauses.push(consentFilter);
  if (contactFilter) filterClauses.push(contactFilter);

  const listWhere: Prisma.CustomerWhereInput = filterClauses.length > 1 ? { AND: filterClauses } : locationScope;

  let totalCustomers = 0;
  let newCustomers = 0;
  let activeCustomers = 0;
  let listCount = 0;
  let categories: Array<{
    id: string;
    name: string;
    slug: string | null;
    description: string | null;
    color: string | null;
    createdAt: Date;
    updatedAt: Date;
    _count: { customers: number };
  }> = [];

  if (shouldLoadList) {
    [totalCustomers, newCustomers, activeCustomers, listCount, categories] = await Promise.all([
      prisma.customer.count({ where: locationScope }),
      prisma.customer.count({
        where: {
          ...locationScope,
          createdAt: { gte: last30 },
        },
      }),
      prisma.customer.count({
        where: {
          ...locationScope,
          appointments: {
            some: {
              locationId,
              startsAt: { gte: last90 },
              status: { in: ["COMPLETED", "CONFIRMED"] },
            },
          },
        },
      }),
      prisma.customer.count({ where: listWhere }),
      prisma.customerCategory.findMany({
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
            select: { customers: true },
          },
        },
      }),
    ]);
  }

  const totalPages = Math.max(1, Math.ceil(listCount / pageSize));
  const currentPage = Number.isFinite(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, totalPages)
    : 1;
  const skip = (currentPage - 1) * pageSize;
  const baseParams = new URLSearchParams();
  if (searchQuery) baseParams.set("q", searchQuery);
  if (resolvedSort !== "created_desc") baseParams.set("sort", resolvedSort);
  if (pageSize !== DEFAULT_PAGE_SIZE) baseParams.set("pageSize", String(pageSize));
  if (categoryValue) baseParams.set("category", categoryValue);
  if (activityValue) baseParams.set("activity", activityValue);
  if (consentValue) baseParams.set("consent", consentValue);
  if (contactValue) baseParams.set("contact", contactValue);
  const backParams = new URLSearchParams(baseParams);
  if (currentPage > 1) backParams.set("page", String(currentPage));
  const backHref = `/backoffice/${locationSlug}/customers${backParams.toString() ? `?${backParams}` : ""}`;

  const customerSelect = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    createdAt: true,
    metadata: true,
    category: {
      select: {
        id: true,
        name: true,
        slug: true,
        color: true,
      },
    },
    consents: {
      select: { type: true, scope: true, granted: true },
    },
    appointments: {
      where: { locationId },
      orderBy: { startsAt: "desc" },
      take: 1,
      select: { startsAt: true, status: true },
    },
  } satisfies Prisma.CustomerSelect;

  const customers = shouldLoadList
    ? await prisma.customer.findMany({
        where: listWhere,
        orderBy: SORT_ORDER_BY[resolvedSort],
        take: pageSize,
        skip,
        select: customerSelect,
      })
    : [];

  const customerIds = customers.map((customer) => customer.id);
  const appointmentCounts = shouldLoadList && customerIds.length
    ? await prisma.appointment.groupBy({
        by: ["customerId"],
        where: {
          locationId,
          customerId: { in: customerIds },
        },
        _count: {
          _all: true,
        },
      })
    : [];
  const appointmentCountMap = new Map<string, number>();
  for (const entry of appointmentCounts) {
    if (entry.customerId) {
      appointmentCountMap.set(entry.customerId, entry._count._all);
    }
  }

  const categoryEntries: CustomerCategoryListEntry[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    color: category.color,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
    customerCount: category._count.customers,
  }));

  const customerRows = customers.map((customer) => {
    const lastAppointment = customer.appointments[0];
    const profile = readCustomerProfile(customer.metadata ?? null);
    const tillhubCustomerId = readTillhubCustomerId(customer.metadata ?? null, profile);
    const tillhubAccountId = readTillhubAccountId(customer.metadata ?? null);
    return {
      id: customer.id,
      name: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unbekannt",
      email: customer.email ?? "–",
      phone: customer.phone ?? "–",
      createdAt: customer.createdAt,
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      rawEmail: customer.email ?? null,
      rawPhone: customer.phone ?? null,
      appointmentCount: appointmentCountMap.get(customer.id) ?? 0,
      lastAppointment,
      profile,
      notes: readCustomerNotes(customer.metadata ?? null),
      tillhubCustomerId,
      tillhubAccountId,
      tillhubCustomerNumber: profile?.customerNumber ?? null,
      consents: customer.consents.filter((consent) => consent.granted),
      category: customer.category
        ? {
          id: customer.category.id,
            name: customer.category.name,
            color: customer.category.color,
          }
        : null,
    };
  });

  const hasActiveFilters = Boolean(
    searchQuery ||
      categoryValue ||
      activityValue ||
      consentValue ||
      contactValue ||
      resolvedSort !== "created_desc" ||
      pageSize !== DEFAULT_PAGE_SIZE,
  );

  const requestedCustomerIdRaw = query.customer;
  const requestedCustomerId = Array.isArray(requestedCustomerIdRaw)
    ? requestedCustomerIdRaw[0]
    : requestedCustomerIdRaw ?? null;
  const selectedFromList = requestedCustomerId
    ? customerRows.find((entry) => entry.id === requestedCustomerId) ?? null
    : null;
  const selectedCustomerRecord =
    requestedCustomerId && !selectedFromList
      ? await prisma.customer.findFirst({
          where: { AND: [locationScope, { id: requestedCustomerId }] },
          select: customerSelect,
        })
      : null;
  const selectedCustomerBase = selectedFromList
    ? selectedFromList
    : selectedCustomerRecord
      ? (() => {
          const lastAppointment = selectedCustomerRecord.appointments[0];
          const profile = readCustomerProfile(selectedCustomerRecord.metadata ?? null);
          return {
            id: selectedCustomerRecord.id,
            name:
              `${selectedCustomerRecord.firstName ?? ""} ${selectedCustomerRecord.lastName ?? ""}`.trim() || "Unbekannt",
            email: selectedCustomerRecord.email ?? "–",
            phone: selectedCustomerRecord.phone ?? "–",
            createdAt: selectedCustomerRecord.createdAt,
            firstName: selectedCustomerRecord.firstName ?? "",
            lastName: selectedCustomerRecord.lastName ?? "",
            rawEmail: selectedCustomerRecord.email ?? null,
            rawPhone: selectedCustomerRecord.phone ?? null,
            appointmentCount: 0,
            lastAppointment,
            profile,
            notes: readCustomerNotes(selectedCustomerRecord.metadata ?? null),
            tillhubCustomerId: readTillhubCustomerId(selectedCustomerRecord.metadata ?? null, profile),
            tillhubAccountId: readTillhubAccountId(selectedCustomerRecord.metadata ?? null),
            tillhubCustomerNumber: profile?.customerNumber ?? null,
            consents: selectedCustomerRecord.consents.filter((consent) => consent.granted),
            category: selectedCustomerRecord.category
              ? {
                  id: selectedCustomerRecord.category.id,
                  name: selectedCustomerRecord.category.name,
                  color: selectedCustomerRecord.category.color,
                }
              : null,
          };
        })()
      : null;
  const selectedCustomerId = selectedCustomerBase?.id ?? null;

  const [
    selectedCustomerStats,
    selectedCustomerAppointments,
    selectedCustomerConsents,
    selectedCustomerVisitCount,
    topServiceRow,
    vipStaffOptions,
    vipSelectedStaffEntries,
    vipVerificationExists,
    vipLatestToken,
  ] = await Promise.all([
    selectedCustomerId
      ? prisma.appointment.aggregate({
          where: {
            locationId,
            customerId: selectedCustomerId,
          },
          _sum: { totalAmount: true },
          _avg: { totalAmount: true },
          _count: { _all: true },
          _max: { startsAt: true },
        })
      : Promise.resolve(null),
    selectedCustomerId
      ? prisma.appointment.findMany({
          where: {
            locationId,
            customerId: selectedCustomerId,
          },
          orderBy: { startsAt: "desc" },
          take: 12,
          select: {
            id: true,
            startsAt: true,
            status: true,
            totalAmount: true,
            currency: true,
            confirmationCode: true,
            items: {
              select: {
                service: { select: { name: true } },
                staff: { select: { displayName: true, firstName: true, lastName: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
    selectedCustomerId
      ? prisma.consent.findMany({
          where: {
            customerId: selectedCustomerId,
            locationId,
            type: ConsentType.COMMUNICATION,
            scope: { in: [ConsentScope.EMAIL, ConsentScope.SMS, ConsentScope.WHATSAPP] },
          },
          orderBy: { grantedAt: "desc" },
          select: {
            id: true,
            scope: true,
            granted: true,
            grantedAt: true,
            revokedAt: true,
            source: true,
            metadata: true,
            recordedBy: {
              select: {
                email: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    selectedCustomerId
      ? prisma.appointment.count({
          where: {
            locationId,
            customerId: selectedCustomerId,
            status: "COMPLETED",
          },
        })
      : Promise.resolve(0),
    selectedCustomerId
      ? prisma.appointmentItem.groupBy({
          by: ["serviceId"],
          where: {
            appointment: {
              locationId,
              customerId: selectedCustomerId,
            },
          },
          _count: { serviceId: true },
          orderBy: { _count: { serviceId: "desc" } },
          take: 1,
        })
      : Promise.resolve([]),
    selectedCustomerId && isAdmin
      ? prisma.staff.findMany({
          where: staffMembershipSupported
            ? { status: "ACTIVE", memberships: { some: { locationId } } }
            : { status: "ACTIVE", locationId },
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
            metadata: true,
          },
        })
      : Promise.resolve([]),
    selectedCustomerId && isAdmin
      ? prisma.customerStaffBookingPermission.findMany({
          where: {
            customerId: selectedCustomerId,
            locationId,
            isAllowed: true,
            revokedAt: null,
          },
          select: { staffId: true },
        })
      : Promise.resolve([]),
    selectedCustomerId && isAdmin
      ? prisma.customerDeviceVerification.findFirst({
          where: {
            customerId: selectedCustomerId,
            locationId,
          },
          select: { id: true },
        })
      : Promise.resolve(null),
    selectedCustomerId && isAdmin
      ? prisma.customerPermissionToken.findFirst({
          where: {
            customerId: selectedCustomerId,
            locationId,
            usedAt: null,
          },
          orderBy: { createdAt: "desc" },
          select: { expiresAt: true },
        })
      : Promise.resolve(null),
  ]);

  const selectedCustomer = selectedCustomerBase
    ? {
        ...selectedCustomerBase,
        appointmentCount:
          selectedCustomerBase.appointmentCount ||
          selectedCustomerStats?._count?._all ||
          0,
      }
    : null;

  const tillhubAnalyticsResult = { analytics: null, error: null };

  const vipEligibleStaff = vipStaffOptions.filter((staff) => {
    const metadata = staff.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
    return typeof value === "boolean" ? value === false : false;
  });
  const vipEligibleStaffIds = new Set(vipEligibleStaff.map((staff) => staff.id));
  const vipSelectedStaffIds = vipSelectedStaffEntries
    .map((entry) => entry.staffId)
    .filter((staffId) => vipEligibleStaffIds.has(staffId));
  const vipTokenExpired =
    Boolean(vipSelectedStaffIds.length) &&
    !vipVerificationExists &&
    Boolean(vipLatestToken && vipLatestToken.expiresAt.getTime() <= now.getTime());
  const topServiceId = topServiceRow.find((row) => row.serviceId)?.serviceId ?? null;
  const topService = topServiceId
    ? await prisma.service.findUnique({
        where: { id: topServiceId },
        select: { name: true },
      })
    : null;
  const consentIdList = selectedCustomerConsents.map((consent) => consent.id);
  const consentAuditLogs = consentIdList.length
    ? await prisma.auditLog.findMany({
        where: {
          entityType: "consent",
          entityId: { in: consentIdList },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
          id: true,
          entityId: true,
          action: true,
          actorType: true,
          createdAt: true,
          diff: true,
          context: true,
          actor: {
            select: {
              email: true,
            },
          },
        },
      })
    : [];
  const consentScopeById = new Map(selectedCustomerConsents.map((consent) => [consent.id, consent.scope]));
  const consentRecords = selectedCustomerConsents.map((consent) => ({
    id: consent.id,
    scope: consent.scope,
    granted: consent.granted,
    grantedAt: consent.grantedAt.toISOString(),
    revokedAt: consent.revokedAt?.toISOString() ?? null,
    source: consent.source,
    recordedBy: consent.recordedBy?.email ?? null,
    metadata: readConsentMetadata(consent.metadata ?? null),
  }));
  const consentAudits = consentAuditLogs.map((entry) => ({
    id: entry.id,
    scope: consentScopeById.get(entry.entityId) ?? null,
    action: entry.action,
    actorType: entry.actorType,
    actorName: entry.actor?.email ?? null,
    createdAt: entry.createdAt.toISOString(),
    diff: (entry.diff as Record<string, unknown> | null) ?? null,
    context: (entry.context as Record<string, unknown> | null) ?? null,
  }));
  async function handleCreateCategory(input: CustomerCategoryCreateInput) {
    "use server";
    return createCustomerCategoryAction(locationId, locationSlug, input);
  }
  async function handleCreateNote(_prevState: { success: boolean; error?: string | null }, formData: FormData) {
    "use server";
    return createCustomerNoteAction(locationId, locationSlug, selectedCustomer?.id ?? "", formData);
  }

  return (
    <section className={isEmbedded ? "space-y-4" : "space-y-6"}>
      {!isEmbedded && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-widest text-zinc-500">Kunden</p>
              <h1 className="text-3xl font-semibold text-zinc-900">
                {locationName}
              </h1>
              <p className="text-sm text-zinc-600">
                Übersicht über aktive Kund:innen inklusive Historie und Einwilligungen.
              </p>
            </div>
            <NewCustomerButton href={`/backoffice/${locationSlug}/customers/new`} />
          </header>

          <div className="grid gap-4 md:grid-cols-3">
            <KpiCard label="Gesamt" value={`${totalCustomers}`} helper="Alle Kund:innen im Standort" />
            <KpiCard label="Neu (30 Tage)" value={`${newCustomers}`} helper="Frisch angelegte Kund:innen" />
            <KpiCard label="Aktiv (90 Tage)" value={`${activeCustomers}`} helper="Mind. 1 Termin in den letzten 90 Tagen" />
          </div>
        </>
      )}

      {selectedCustomer ? (
        <CustomerDetailForm
          locationSlug={locationSlug}
          locationName={locationName}
          backHref={!isEmbedded ? backHref : null}
          customer={{
            id: selectedCustomer.id,
            firstName: selectedCustomer.firstName,
            lastName: selectedCustomer.lastName,
            email: selectedCustomer.rawEmail,
            phone: selectedCustomer.rawPhone,
            categoryId: selectedCustomer.category?.id ?? null,
            appointmentCount: selectedCustomer.appointmentCount,
            createdAt: selectedCustomer.createdAt,
            profile: selectedCustomer.profile,
            notes: selectedCustomer.notes,
          }}
          appointmentHistory={selectedCustomerAppointments.map((entry) => ({
            id: entry.id,
            startsAt: entry.startsAt.toISOString(),
            status: entry.status,
            confirmationCode: entry.confirmationCode,
            totalAmount: toNumber(entry.totalAmount),
            currency: entry.currency,
            serviceNames: Array.from(
              new Set(
                entry.items
                  .map((item) => item.service?.name)
                  .filter((name): name is string => Boolean(name && name.trim().length)),
              ),
            ),
            staffNames: Array.from(
              new Set(
                entry.items
                  .map((item) => {
                    if (!item.staff) return null;
                    const staffName =
                      item.staff.displayName?.trim() ||
                      `${item.staff.firstName ?? ""} ${item.staff.lastName ?? ""}`.trim();
                    return staffName.length ? staffName : null;
                  })
                  .filter((name): name is string => Boolean(name && name.trim().length)),
              ),
            ),
          }))}
          tillhubAnalytics={tillhubAnalyticsResult.analytics}
          tillhubAnalyticsError={tillhubAnalyticsResult.error}
          allowTillhubFetch
          analytics={{
            lastVisit: selectedCustomerStats?._max?.startsAt?.toISOString() ?? null,
            appointmentCount: selectedCustomerStats?._count?._all ?? 0,
            totalAmount: toNumber(selectedCustomerStats?._sum?.totalAmount ?? null),
            averageAmount: toNumber(selectedCustomerStats?._avg?.totalAmount ?? null),
            topServiceName: topService?.name ?? null,
          }}
          visitCount={selectedCustomerVisitCount}
          categories={categoryEntries}
          action={updateCustomerAction.bind(null, locationId, locationSlug, selectedCustomer.id)}
          noteAction={handleCreateNote}
          consents={consentRecords}
          consentAudits={consentAudits}
          consentAction={updateCustomerConsentsAction.bind(null, locationId, locationSlug, selectedCustomer.id)}
          deleteAction={deleteCustomerAction.bind(null, locationId, locationSlug, selectedCustomer.id)}
          isAdmin={isAdmin}
          vipStaffOptions={vipEligibleStaff.map((staff) => ({
            id: staff.id,
            name:
              staff.displayName?.trim() ||
              `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
              "Mitarbeiter",
          }))}
          vipSelectedStaffIds={vipSelectedStaffIds}
          vipTokenExpired={vipTokenExpired}
          resendPermissionAction={resendCustomerPermissionLinkAction.bind(
            null,
            locationId,
            locationSlug,
            selectedCustomer.id,
          )}
        />
      ) : null}

      {!selectedCustomer && isEmbedded && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          Kein Kunde ausgewaehlt.
        </p>
      )}

      {!selectedCustomer && !isEmbedded && (
        <>
          <CustomerCategoryManager categories={categoryEntries} onCreate={handleCreateCategory} />

          <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-zinc-900">Kundenliste</h2>
                <p className="text-xs text-zinc-500">
                  {searchQuery
                    ? `${listCount} Treffer`
                    : `${listCount} Kund:innen im Standort`}
                  {listCount > pageSize && (
                    <>
                      {" "}
                      · Seite {currentPage} von {totalPages}
                    </>
                  )}
                </p>
              </div>
              <form
                method="get"
                action={`/backoffice/${locationSlug}/customers`}
                className="flex flex-wrap items-end gap-3"
              >
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Suche</label>
                  <input
                    type="search"
                    name="q"
                    defaultValue={searchQuery}
                    placeholder="Name, E-Mail oder Telefon"
                    className="h-9 w-56 rounded-full border border-zinc-200 px-4 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Kategorie</label>
                  <select
                    name="category"
                    defaultValue={categoryValue}
                    className="h-9 min-w-[180px] rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    <option value="">Alle Kategorien</option>
                    <option value="none">Ohne Kategorie</option>
                    {categoryEntries.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Aktivität</label>
                  <select
                    name="activity"
                    defaultValue={activityValue}
                    className="h-9 min-w-[170px] rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    {ACTIVITY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Einwilligung</label>
                  <select
                    name="consent"
                    defaultValue={consentValue}
                    className="h-9 min-w-[170px] rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    {CONSENT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Kontakt</label>
                  <select
                    name="contact"
                    defaultValue={contactValue}
                    className="h-9 min-w-[160px] rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    {CONTACT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Sortierung</label>
                  <select
                    name="sort"
                    defaultValue={resolvedSort}
                    className="h-9 min-w-[190px] rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    {SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">Pro Seite</label>
                  <select
                    name="pageSize"
                    defaultValue={String(pageSize)}
                    className="h-9 min-w-[120px] rounded-full border border-zinc-200 bg-white px-3 text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                  >
                    {PAGE_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option} Einträge
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  className="h-9 rounded-full bg-emerald-500 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-600"
                >
                  Anwenden
                </button>
                {hasActiveFilters && (
                  <Link
                    href={`/backoffice/${locationSlug}/customers`}
                    className="text-xs font-semibold text-zinc-500 transition hover:text-zinc-700"
                  >
                    Zurücksetzen
                  </Link>
                )}
              </form>
            </header>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-200 text-sm">
                <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-widest text-zinc-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Kategorie</th>
                    <th className="px-4 py-3">Kontakt</th>
                    <th className="px-4 py-3">Einwilligungen</th>
                    <th className="px-4 py-3">Letzter Termin</th>
                    <th className="px-4 py-3 text-right">Termine</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 bg-white">
                  {customerRows.length === 0 && (
                    <tr>
                      <td className="px-4 py-6 text-center text-xs text-zinc-500" colSpan={6}>
                        Noch keine Kund:innen vorhanden.
                      </td>
                    </tr>
                  )}
                  {customerRows.map((customer) => {
                    const isSelected = requestedCustomerId === customer.id;
                    const linkParams = new URLSearchParams(baseParams);
                    if (currentPage > 1) linkParams.set("page", String(currentPage));
                    linkParams.set("customer", customer.id);
                    return (
                      <tr
                        key={customer.id}
                        className={`whitespace-nowrap transition ${
                          isSelected ? "bg-emerald-50" : "hover:bg-zinc-50"
                        }`}
                      >
                      <td className="px-4 py-3 text-zinc-700">
                        <p className="font-medium text-zinc-900">{customer.name}</p>
                        <Link
                          href={`/backoffice/${locationSlug}/customers?${linkParams.toString()}`}
                          className="text-xs text-emerald-600 hover:underline"
                        >
                          Details anzeigen
                        </Link>
                        <p className="text-xs text-zinc-500">Seit {formatRelative(customer.createdAt)}</p>
                      </td>
                      <td className="px-4 py-3 text-zinc-700">
                        {customer.category ? (
                          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
                            <span
                              aria-hidden
                              className="h-2.5 w-2.5 rounded-full"
                              style={{
                                backgroundColor: customer.category.color ?? "#a1a1aa",
                              }}
                            />
                            {customer.category.name}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">Keine Zuordnung</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-700">
                        <p>{customer.email}</p>
                        <p className="text-xs text-zinc-500">{customer.phone}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {customer.consents.length === 0 && (
                            <span className="text-xs text-zinc-400">Keine</span>
                          )}
                          {customer.consents.map((consent) => (
                            <span
                              key={`${consent.type}-${consent.scope}`}
                              className="inline-flex rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500"
                            >
                              {formatConsentLabel(consent.type, consent.scope)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-700">
                        {customer.lastAppointment ? (
                          <>
                            <p>{formatRelative(customer.lastAppointment.startsAt)}</p>
                            <p className="text-xs text-zinc-500">{statusLabel(customer.lastAppointment.status)}</p>
                          </>
                        ) : (
                          <p className="text-xs text-zinc-400">Kein Termin</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-700">{customer.appointmentCount}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {listCount > pageSize && (
              <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3 text-xs text-zinc-600">
                <span>
                  Seite {currentPage} von {totalPages}
                </span>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    {currentPage > 1 && (
                      <Link
                        href={`/backoffice/${locationSlug}/customers?${(() => {
                          const params = new URLSearchParams(baseParams);
                          const target = currentPage - 1;
                          if (target > 1) params.set("page", String(target));
                          return params.toString();
                        })()}`}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-50"
                      >
                        Zurück
                      </Link>
                    )}
                    {currentPage < totalPages && (
                      <Link
                        href={`/backoffice/${locationSlug}/customers?${(() => {
                          const params = new URLSearchParams(baseParams);
                          const target = currentPage + 1;
                          if (target > 1) params.set("page", String(target));
                          return params.toString();
                        })()}`}
                        className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-50"
                      >
                        Weiter
                      </Link>
                    )}
                  </div>
                  <form
                    method="get"
                    action={`/backoffice/${locationSlug}/customers`}
                    className="flex items-center gap-2"
                  >
                    {Array.from(baseParams.entries()).map(([key, value]) => (
                      <input key={`${key}-${value}`} type="hidden" name={key} value={value} />
                    ))}
                    <label className="text-xs text-zinc-500">Seite</label>
                    <input
                      type="number"
                      name="page"
                      min={1}
                      max={totalPages}
                      defaultValue={currentPage}
                      className="h-8 w-16 rounded-full border border-zinc-200 px-2 text-center text-xs text-zinc-700 shadow-sm outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
                    />
                    <button
                      type="submit"
                      className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-50"
                    >
                      Springen
                    </button>
                  </form>
                </div>
              </footer>
            )}
          </section>
        </>
      )}
    </section>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "CONFIRMED":
      return "Bestätigt";
    case "PENDING":
      return "Offen";
    case "COMPLETED":
      return "Abgeschlossen";
    case "CANCELLED":
      return "Storniert";
    case "NO_SHOW":
      return "Nicht erschienen";
    default:
      return status;
  }
}
