"use server";

import { AuditAction, AuditActorType, ConsentScope, ConsentSource, ConsentType, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getPrismaClient } from "@/lib/prisma";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { appendCustomerNote, applyCustomerProfile } from "@/lib/customer-metadata";
import { logAuditEvent } from "@/lib/audit/logger";
import { normalizeConsentMethod } from "@/lib/consent-method";
import { getSessionOrNull } from "@/lib/session";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { sendCustomerPermissionEmail } from "@/lib/customer-booking-permissions";
import type { CustomerCategoryCreateInput, CustomerCategoryCreateResult } from "@/types/customers";

const prisma = getPrismaClient();

function parseString(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseOptionalString(value: FormDataEntryValue | null) {
  const trimmed = parseString(value);
  return trimmed.length ? trimmed : null;
}

function parseBoolean(value: FormDataEntryValue | null) {
  return value === "on" || value === "true" || value === "1";
}

function parseDiscount(value: FormDataEntryValue | null) {
  const raw = parseString(value).replace(",", ".");
  if (!raw.length) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(100, Math.max(0, parsed));
}

function parseDateTimeLocal(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseStringList(values: FormDataEntryValue[]): string[] {
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value): value is string => value.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function resolveIsAdmin(session: Awaited<ReturnType<typeof getSessionOrNull>>, locationId: string) {
  if (!session?.userId) return false;
  const staffMembershipSupported = await supportsStaffMemberships(prisma);
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

function readOnlineBookingEnabled(metadata: Prisma.JsonValue | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return true;
  }
  const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
  return typeof value === "boolean" ? value : true;
}

export type CreateCustomerActionResult = {
  success: boolean;
  error?: string;
  customer?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    categoryId: string | null;
  };
};

export async function createCustomerAction(
  locationId: string,
  locationSlug: string,
  formData: FormData,
): Promise<CreateCustomerActionResult> {
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const emailRaw = String(formData.get("email") ?? "").trim();
  const phoneRaw = String(formData.get("phone") ?? "").trim();
  const categoryIdRaw = String(formData.get("categoryId") ?? "").trim();

  if (!firstName) {
    return { success: false, error: "Vorname ist erforderlich." };
  }
  if (!lastName) {
    return { success: false, error: "Nachname ist erforderlich." };
  }

  const email = emailRaw.length ? emailRaw : null;
  const phone = phoneRaw.length ? phoneRaw : null;

  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { success: false, error: "Ungültige E-Mail-Adresse." };
  }

  let categoryId: string | null = null;
  if (categoryIdRaw.length) {
    const category = await prisma.customerCategory.findFirst({
      where: {
        id: categoryIdRaw,
        locationId,
      },
      select: { id: true },
    });
    if (!category) {
      return { success: false, error: "Kategorie wurde nicht gefunden." };
    }
    categoryId = category.id;
  }

  const membershipSupported = await supportsCustomerMemberships(prisma);

  try {
    const customer = await prisma.$transaction(async (tx) => {
      const record = await tx.customer.create({
        data: {
          locationId,
          firstName,
          lastName,
          email,
          phone,
          categoryId,
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          categoryId: true,
        },
      });

      if (membershipSupported) {
        await tx.customerLocationMembership.upsert({
          where: {
            customerId_locationId: {
              customerId: record.id,
              locationId,
            },
          },
          create: {
            customerId: record.id,
            locationId,
          },
          update: {},
        });
      }

      return record;
    });

    revalidatePath(`/backoffice/${locationSlug}/customers`);
    revalidatePath(`/backoffice/${locationSlug}/calendar`);
    revalidatePath(`/backoffice/${locationSlug}/dashboard`);

    return { success: true, customer };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "Ein Kunde mit diesen Daten existiert bereits." };
    }
    console.error("[customers:create] creation failed", error);
    return { success: false, error: "Kunde konnte nicht gespeichert werden." };
  }
}

export async function createCustomerCategoryAction(
  locationId: string,
  locationSlug: string,
  input: CustomerCategoryCreateInput,
): Promise<CustomerCategoryCreateResult> {
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
    await prisma.customerCategory.findFirst({
      where: { locationId, slug: slugCandidate },
      select: { id: true },
    })
  ) {
    counter += 1;
    slugCandidate = `${baseSlug}-${counter}`;
  }

  try {
    await prisma.customerCategory.create({
      data: {
        locationId,
        name: trimmedName,
        slug: slugCandidate,
        description: input.description ?? null,
        color: input.color ?? null,
      },
    });
  } catch (error) {
    console.error("[customer-categories:create] failed", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "Eine Kundenkategorie mit diesem Namen existiert bereits." };
    }
    return { success: false, error: "Kundenkategorie konnte nicht erstellt werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/customers`);
  revalidatePath(`/backoffice/${locationSlug}/customers/new`);
  return { success: true };
}

export type UpdateCustomerActionState = {
  success: boolean;
  error?: string | null;
};

export type DeleteCustomerActionState = {
  success: boolean;
  error?: string | null;
};

export async function deleteCustomerAction(
  locationId: string,
  locationSlug: string,
  customerId: string,
  _prevState: DeleteCustomerActionState,
  formData: FormData,
): Promise<DeleteCustomerActionState> {
  const session = await getSessionOrNull();
  const isAdmin = await resolveIsAdmin(session, locationId);
  if (!isAdmin) {
    return { success: false, error: "Nicht berechtigt." };
  }

  const customerMembershipSupported = await supportsCustomerMemberships(prisma);
  const customer = await prisma.customer.findFirst({
    where: customerMembershipSupported
      ? {
          id: customerId,
          OR: [{ locationId }, { memberships: { some: { locationId } } }],
        }
      : { id: customerId, locationId },
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  });

  if (!customer) {
    return { success: false, error: "Kunde wurde nicht gefunden." };
  }

  try {
    await prisma.customer.delete({ where: { id: customerId } });
  } catch (error) {
    console.error("[customers:delete] failed", error);
    return { success: false, error: "Kunde konnte nicht gelöscht werden." };
  }

  const hdrs = await headers();
  const ipAddress = hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip");
  const userAgent = hdrs.get("user-agent");
  const customerName = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || null;
  await logAuditEvent({
    locationId,
    actorType: AuditActorType.USER,
    actorId: session?.userId ?? null,
    action: AuditAction.DELETE,
    entityType: "customer",
    entityId: customerId,
    diff: {
      name: { from: customerName, to: null },
      email: { from: customer.email ?? null, to: null },
      phone: { from: customer.phone ?? null, to: null },
    },
    context: { source: "backoffice" },
    ipAddress: ipAddress ?? null,
    userAgent: userAgent ?? null,
  });

  revalidatePath(`/backoffice/${locationSlug}/customers`);
  revalidatePath(`/backoffice/${locationSlug}/calendar`);
  revalidatePath(`/backoffice/${locationSlug}/dashboard`);

  const returnTo = parseOptionalString(formData.get("returnTo"));
  const fallback = `/backoffice/${locationSlug}/customers`;
  const redirectTo = returnTo && returnTo.startsWith(fallback) ? returnTo : fallback;
  redirect(redirectTo);
}

const COMMUNICATION_CHANNELS = [
  { key: "email", scope: ConsentScope.EMAIL },
  { key: "sms", scope: ConsentScope.SMS },
  { key: "whatsapp", scope: ConsentScope.WHATSAPP },
] as const;

type CommunicationChannelKey = (typeof COMMUNICATION_CHANNELS)[number]["key"];

export type UpdateCustomerConsentsActionState = {
  success: boolean;
  error?: string | null;
};

export async function updateCustomerAction(
  locationId: string,
  locationSlug: string,
  customerId: string,
  _prevState: UpdateCustomerActionState,
  formData: FormData,
): Promise<UpdateCustomerActionState> {
  const firstName = parseString(formData.get("firstName"));
  const lastName = parseString(formData.get("lastName"));
  const emailRaw = parseString(formData.get("email"));
  const phoneRaw = parseString(formData.get("phone"));
  const categoryIdRaw = parseString(formData.get("categoryId"));
  const active = parseBoolean(formData.get("active"));
  const newsletter = parseBoolean(formData.get("newsletter"));
  const b2b = parseBoolean(formData.get("b2b"));
  const gender = parseOptionalString(formData.get("gender"));
  const birthDate = parseOptionalString(formData.get("birthDate"));
  const customerNumber = parseOptionalString(formData.get("customerNumber"));
  const companyName = parseOptionalString(formData.get("companyName"));
  const discountPercent = parseDiscount(formData.get("discount"));
  const comment = parseOptionalString(formData.get("comment"));
  const priceBook = parseOptionalString(formData.get("priceBook"));
  const firstSeenAt = parseOptionalString(formData.get("firstSeenAt"));
  const phoneType = parseOptionalString(formData.get("phoneType"));
  const photoUrl = parseOptionalString(formData.get("photoUrl"));
  const street = parseOptionalString(formData.get("street"));
  const houseNumber = parseOptionalString(formData.get("houseNumber"));
  const postalCode = parseOptionalString(formData.get("postalCode"));
  const city = parseOptionalString(formData.get("city"));
  const state = parseOptionalString(formData.get("state"));
  const country = parseOptionalString(formData.get("country"));
  const vipStaffIdsRaw = parseStringList(formData.getAll("vipStaffIds"));
  const session = await getSessionOrNull();
  const isAdmin = await resolveIsAdmin(session, locationId);
  const actorUserId = session?.userId ?? null;

  if (!firstName) {
    return { success: false, error: "Vorname ist erforderlich." };
  }
  if (!lastName) {
    return { success: false, error: "Nachname ist erforderlich." };
  }

  const email = emailRaw.length ? emailRaw : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { success: false, error: "Ungültige E-Mail-Adresse." };
  }
  if (isAdmin && vipStaffIdsRaw.length > 0 && !email) {
    return { success: false, error: "Für die Freigabe wird eine E-Mail-Adresse benötigt." };
  }

  const phone = phoneRaw.length ? phoneRaw : null;

  const customerMembershipSupported = await supportsCustomerMemberships(prisma);
  const customer = await prisma.customer.findFirst({
    where: customerMembershipSupported
      ? {
          id: customerId,
          OR: [{ locationId }, { memberships: { some: { locationId } } }],
        }
      : {
          id: customerId,
          locationId,
        },
    select: { id: true, metadata: true },
  });

  if (!customer) {
    return { success: false, error: "Kunde wurde nicht gefunden." };
  }

  let categoryId: string | null = null;
  if (categoryIdRaw.length) {
    const category = await prisma.customerCategory.findFirst({
      where: { id: categoryIdRaw, locationId },
      select: { id: true },
    });
    if (!category) {
      return { success: false, error: "Kategorie wurde nicht gefunden." };
    }
    categoryId = category.id;
  }

  const nextMetadata = applyCustomerProfile(customer.metadata ?? null, {
    active,
    newsletter,
    b2b,
    gender,
    birthDate,
    customerNumber,
    companyName,
    discountPercent,
    comment,
    priceBook,
    firstSeenAt,
    phoneType,
    photoUrl,
    address: {
      street,
      houseNumber,
      postalCode,
      city,
      state,
      country,
    },
  });

  try {
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        firstName,
        lastName,
        email,
        phone,
        categoryId,
        metadata: nextMetadata,
      },
    });
  } catch (error) {
    console.error("[customers:update] failed", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { success: false, error: "Ein Kunde mit diesen Daten existiert bereits." };
    }
    return { success: false, error: "Kunde konnte nicht gespeichert werden." };
  }

  if (isAdmin) {
    const staffMembershipSupported = await supportsStaffMemberships(prisma);
    const staffScope: Prisma.StaffWhereInput = staffMembershipSupported
      ? { status: "ACTIVE", memberships: { some: { locationId } } }
      : { status: "ACTIVE", locationId };
    const staffRecords = await prisma.staff.findMany({
      where: staffScope,
      select: { id: true, metadata: true },
    });
    const nonOnlineStaffIds = new Set(
      staffRecords
        .filter((staff) => !readOnlineBookingEnabled(staff.metadata ?? null))
        .map((staff) => staff.id),
    );
    const selectedVipStaffIds = Array.from(
      new Set(vipStaffIdsRaw.filter((staffId) => nonOnlineStaffIds.has(staffId))),
    );

    const existingPermissions = await prisma.customerStaffBookingPermission.findMany({
      where: { customerId, locationId },
      select: { staffId: true, isAllowed: true, revokedAt: true },
    });
    const currentAllowed = new Set(
      existingPermissions
        .filter((entry) => entry.isAllowed && !entry.revokedAt)
        .map((entry) => entry.staffId),
    );
    const selectedSet = new Set(selectedVipStaffIds);
    const toGrant = selectedVipStaffIds.filter((staffId) => !currentAllowed.has(staffId));
    const toRevoke = Array.from(currentAllowed).filter((staffId) => !selectedSet.has(staffId));

    if (toGrant.length || toRevoke.length) {
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        for (const staffId of toGrant) {
          await tx.customerStaffBookingPermission.upsert({
            where: { customerId_locationId_staffId: { customerId, locationId, staffId } },
            create: {
              customerId,
              locationId,
              staffId,
              isAllowed: true,
              grantedAt: now,
              grantedByUserId: actorUserId,
            },
            update: {
              isAllowed: true,
              grantedAt: now,
              grantedByUserId: actorUserId,
              revokedAt: null,
              revokedByUserId: null,
            },
          });
        }
        for (const staffId of toRevoke) {
          await tx.customerStaffBookingPermission.update({
            where: { customerId_locationId_staffId: { customerId, locationId, staffId } },
            data: {
              isAllowed: false,
              revokedAt: now,
              revokedByUserId: actorUserId,
            },
          });
        }
      });
    }

    if (toGrant.length && email) {
      const customerName = `${firstName} ${lastName}`.trim();
      try {
        await sendCustomerPermissionEmail({
          customerId,
          locationId,
          email,
          customerName,
          createdByUserId: actorUserId,
        });
      } catch (error) {
        console.error("[customers:permissions] email failed", error);
        return { success: false, error: "Bestätigungslink konnte nicht gesendet werden." };
      }
    }
  }

  revalidatePath(`/backoffice/${locationSlug}/customers`);
  revalidatePath(`/backoffice/${locationSlug}/calendar`);
  revalidatePath(`/backoffice/${locationSlug}/dashboard`);
  return { success: true };
}

export type ResendCustomerPermissionLinkState = {
  success: boolean;
  error?: string | null;
};

export async function resendCustomerPermissionLinkAction(
  locationId: string,
  locationSlug: string,
  customerId: string,
  _prevState: ResendCustomerPermissionLinkState,
  _formData: FormData,
): Promise<ResendCustomerPermissionLinkState> {
  const session = await getSessionOrNull();
  if (session?.role !== "ADMIN") {
    return { success: false, error: "Nicht berechtigt." };
  }

  const customerMembershipSupported = await supportsCustomerMemberships(prisma);
  const customer = await prisma.customer.findFirst({
    where: customerMembershipSupported
      ? {
          id: customerId,
          OR: [{ locationId }, { memberships: { some: { locationId } } }],
        }
      : { id: customerId, locationId },
    select: { id: true, email: true, firstName: true, lastName: true },
  });

  if (!customer?.email) {
    return { success: false, error: "Keine E-Mail-Adresse hinterlegt." };
  }

  const allowedPermissions = await prisma.customerStaffBookingPermission.findMany({
    where: {
      customerId,
      locationId,
      isAllowed: true,
      revokedAt: null,
    },
    select: { staffId: true },
  });

  if (!allowedPermissions.length) {
    return { success: false, error: "Keine Freigaben vorhanden." };
  }

  try {
    await sendCustomerPermissionEmail({
      customerId,
      locationId,
      email: customer.email,
      customerName: `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim(),
      createdByUserId: session.userId,
    });
  } catch (error) {
    console.error("[customers:permissions] resend failed", error);
    return { success: false, error: "Bestätigungslink konnte nicht gesendet werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/customers`);
  return { success: true };
}

export async function updateCustomerConsentsAction(
  locationId: string,
  locationSlug: string,
  customerId: string,
  _prevState: UpdateCustomerConsentsActionState,
  formData: FormData,
): Promise<UpdateCustomerConsentsActionState> {
  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customer = await prisma.customer.findFirst({
    where: membershipSupported
      ? {
          id: customerId,
          OR: [{ locationId }, { memberships: { some: { locationId } } }],
        }
      : {
          id: customerId,
          locationId,
        },
    select: { id: true },
  });

  if (!customer) {
    return { success: false, error: "Kunde wurde nicht gefunden." };
  }

  const session = await getSessionOrNull();
  const hdrs = await headers();
  const ipAddress = hdrs.get("x-forwarded-for") ?? hdrs.get("x-real-ip");
  const userAgent = hdrs.get("user-agent");
  const now = new Date();
  let performerInfo: { staffId: string; staffName: string } | null = null;

  if (session?.userId) {
    const membershipSupported = await supportsStaffMemberships(prisma);
    const staff = await prisma.staff.findFirst({
      where: membershipSupported
        ? { userId: session.userId, memberships: { some: { locationId } } }
        : { userId: session.userId, locationId },
      select: { id: true, displayName: true, firstName: true, lastName: true },
    });
    if (staff) {
      const staffName =
        staff.displayName?.trim() ||
        `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
        "Mitarbeiter";
      performerInfo = { staffId: staff.id, staffName };
    }
  }

  const existingConsents = await prisma.consent.findMany({
    where: {
      customerId,
      locationId,
      type: ConsentType.COMMUNICATION,
      scope: { in: COMMUNICATION_CHANNELS.map((channel) => channel.scope) },
    },
    select: {
      id: true,
      scope: true,
      granted: true,
      grantedAt: true,
      revokedAt: true,
      metadata: true,
    },
  });

  const consentByScope = new Map(existingConsents.map((consent) => [consent.scope, consent]));

  try {
    await prisma.$transaction(async (tx) => {
      for (const channel of COMMUNICATION_CHANNELS) {
        const key = channel.key;
        const scope = channel.scope;
        const existing = consentByScope.get(scope) ?? null;

        const granted = parseBoolean(formData.get(`consent_${key}_granted`));
        const grantedAtInput = parseDateTimeLocal(formData.get(`consent_${key}_grantedAt`));
        const revokedAtInput = parseDateTimeLocal(formData.get(`consent_${key}_revokedAt`));
        const method = normalizeConsentMethod(parseOptionalString(formData.get(`consent_${key}_method`)));
        const reference = parseOptionalString(formData.get(`consent_${key}_reference`));
        const textVersion = parseOptionalString(formData.get(`consent_${key}_textVersion`));
        const note = parseOptionalString(formData.get(`consent_${key}_note`));

        const hadMetadataInput = Boolean(method || reference || textVersion || note);

        if (!existing && !granted && !hadMetadataInput && !revokedAtInput && !grantedAtInput) {
          continue;
        }

        const existingMetadata = isRecord(existing?.metadata) ? { ...(existing!.metadata as Record<string, unknown>) } : {};
        const nextMetadata = {
          ...existingMetadata,
          method,
          reference,
          textVersion,
          note,
        };

        const nextGrantedAt = granted
          ? grantedAtInput ?? existing?.grantedAt ?? now
          : existing?.grantedAt ?? grantedAtInput ?? now;
        const nextRevokedAt = granted ? null : revokedAtInput ?? existing?.revokedAt ?? now;

        if (!existing) {
          const created = await tx.consent.create({
            data: {
              customerId,
              locationId,
              type: ConsentType.COMMUNICATION,
              scope,
              granted,
              grantedAt: nextGrantedAt,
              revokedAt: nextRevokedAt,
              source: ConsentSource.ADMIN,
              recordedById: session?.userId ?? null,
              metadata: nextMetadata as Prisma.InputJsonValue,
            },
          });
          await logAuditEvent(
            {
              locationId,
              actorType: AuditActorType.USER,
              actorId: session?.userId ?? null,
              action: AuditAction.CREATE,
              entityType: "consent",
              entityId: created.id,
              diff: {
                granted: { from: null, to: granted },
                grantedAt: { from: null, to: nextGrantedAt.toISOString() },
                revokedAt: { from: null, to: nextRevokedAt?.toISOString() ?? null },
                metadata: nextMetadata,
              },
              context: {
                type: ConsentType.COMMUNICATION,
                scope,
                source: "backoffice",
                ...(performerInfo ? { performedByStaff: performerInfo } : {}),
              },
              ipAddress: ipAddress ?? null,
              userAgent: userAgent ?? null,
            },
            tx,
          );
          continue;
        }

        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (existing.granted !== granted) {
          changes.granted = { from: existing.granted, to: granted };
        }
        if (existing.grantedAt.getTime() !== nextGrantedAt.getTime()) {
          changes.grantedAt = { from: existing.grantedAt.toISOString(), to: nextGrantedAt.toISOString() };
        }
        if ((existing.revokedAt?.getTime() ?? null) !== (nextRevokedAt?.getTime() ?? null)) {
          changes.revokedAt = {
            from: existing.revokedAt?.toISOString() ?? null,
            to: nextRevokedAt?.toISOString() ?? null,
          };
        }
        const existingMetadataNormalized = isRecord(existing.metadata) ? (existing.metadata as Record<string, unknown>) : {};
        if (JSON.stringify(existingMetadataNormalized) !== JSON.stringify(nextMetadata)) {
          changes.metadata = { from: existingMetadataNormalized, to: nextMetadata };
        }

        if (Object.keys(changes).length === 0) {
          continue;
        }

        await tx.consent.update({
          where: { id: existing.id },
          data: {
            granted,
            grantedAt: nextGrantedAt,
            revokedAt: nextRevokedAt,
            source: ConsentSource.ADMIN,
            recordedById: session?.userId ?? null,
            metadata: nextMetadata as Prisma.InputJsonValue,
          },
        });

        await logAuditEvent(
          {
            locationId,
            actorType: AuditActorType.USER,
            actorId: session?.userId ?? null,
            action: AuditAction.UPDATE,
            entityType: "consent",
            entityId: existing.id,
            diff: changes,
            context: {
              type: ConsentType.COMMUNICATION,
              scope,
              source: "backoffice",
              ...(performerInfo ? { performedByStaff: performerInfo } : {}),
            },
            ipAddress: ipAddress ?? null,
            userAgent: userAgent ?? null,
          },
          tx,
        );
      }
    });
  } catch (error) {
    console.error("[customers:consents] failed", error);
    return { success: false, error: "Einwilligungen konnten nicht gespeichert werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/customers`);
  revalidatePath(`/backoffice/${locationSlug}/calendar`);
  revalidatePath(`/backoffice/${locationSlug}/marketing`);
  return { success: true };
}

export type CreateCustomerNoteState = { success: boolean; error?: string | null };

export async function createCustomerNoteAction(
  locationId: string,
  locationSlug: string,
  customerId: string,
  _prevState: CreateCustomerNoteState,
  formData: FormData,
): Promise<CreateCustomerNoteState> {
  const noteText = parseString(formData.get("note"));
  if (!noteText) {
    return { success: false, error: "Notiz ist erforderlich." };
  }
  if (noteText.length > 1000) {
    return { success: false, error: "Notiz ist zu lang (max. 1000 Zeichen)." };
  }

  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customer = await prisma.customer.findFirst({
    where: membershipSupported
      ? {
          id: customerId,
          OR: [{ locationId }, { memberships: { some: { locationId } } }],
        }
      : {
          id: customerId,
          locationId,
        },
    select: { id: true, metadata: true },
  });

  if (!customer) {
    return { success: false, error: "Kunde wurde nicht gefunden." };
  }

  const note = {
    id: randomUUID(),
    text: noteText,
    createdAt: new Date().toISOString(),
  };

  try {
    await prisma.customer.update({
      where: { id: customerId },
      data: { metadata: appendCustomerNote(customer.metadata ?? null, note) },
    });
  } catch (error) {
    console.error("[customers:note] failed", error);
    return { success: false, error: "Notiz konnte nicht gespeichert werden." };
  }

  revalidatePath(`/backoffice/${locationSlug}/customers`);
  return { success: true };
}
