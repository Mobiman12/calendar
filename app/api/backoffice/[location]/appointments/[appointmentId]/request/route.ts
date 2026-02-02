import { NextResponse } from "next/server";
import { z } from "zod";
import { AuditAction, AuditActorType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { sendMail } from "@/lib/notifications/smtp";
import { formatDateWithPatternInTimeZone, formatInTimeZone } from "@/lib/timezone";

const prisma = getPrismaClient();

const requestSchema = z.object({
  action: z.enum(["CANCEL", "DELETE"]),
  reason: z.string().trim().min(1).max(500),
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  const { location, appointmentId } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });

  let payload: z.infer<typeof requestSchema>;
  try {
    const body = await request.json();
    payload = requestSchema.parse(body);
  } catch (error) {
    const message =
      error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join(", ") : "Ungültige Eingabe";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, location: { slug: location, tenantId } },
    select: {
      id: true,
      confirmationCode: true,
      startsAt: true,
      endsAt: true,
      status: true,
      locationId: true,
      location: {
        select: {
          name: true,
          slug: true,
          email: true,
          timezone: true,
        },
      },
      customer: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
      items: {
        select: {
          service: {
            select: { name: true },
          },
        },
      },
    },
  });

  if (!appointment) {
    return NextResponse.json({ error: "Termin nicht gefunden." }, { status: 404 });
  }

  const membershipSupported = await supportsStaffMemberships(prisma);

  const performer = membershipSupported
    ? await prisma.staff.findFirst({
        where: {
          id: payload.performedBy.staffId,
          memberships: { some: { locationId: appointment.locationId } },
          location: { tenantId },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          email: true,
          metadata: true,
          memberships: {
            where: { locationId: appointment.locationId },
            select: { role: true },
          },
        },
      })
    : await prisma.staff.findFirst({
        where: {
          id: payload.performedBy.staffId,
          locationId: appointment.locationId,
          location: { tenantId },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          email: true,
          metadata: true,
        },
      });

  if (!performer || !verifyBookingPinToken(payload.performedBy.token, performer.id)) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  const performerRole = resolvePerformerRole(performer, membershipSupported);
  if (isAdminRole(performerRole)) {
    return NextResponse.json({ error: "Admins können Termine direkt bearbeiten." }, { status: 400 });
  }

  const performerName =
    performer.displayName?.trim() ||
    `${performer.firstName ?? ""} ${performer.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
    "Mitarbeiter";
  const performerInfo = {
    staffId: performer.id,
    staffName: performerName,
  };

  const timezone = appointment.location.timezone ?? "Europe/Berlin";
  const dateLabel = formatDateWithPatternInTimeZone(appointment.startsAt, "date", timezone);
  const startTime = formatInTimeZone(appointment.startsAt, timezone, { hour: "2-digit", minute: "2-digit", hour12: false });
  const endTime = formatInTimeZone(appointment.endsAt, timezone, { hour: "2-digit", minute: "2-digit", hour12: false });
  const timeLabel = `${startTime} – ${endTime}`;

  const customerName =
    appointment.customer
      ? `${appointment.customer.firstName ?? ""} ${appointment.customer.lastName ?? ""}`.replace(/\s+/g, " ").trim()
      : "";
  const serviceNames = Array.from(
    new Set(appointment.items.map((item) => item.service?.name).filter((name): name is string => Boolean(name && name.trim().length))),
  );
  const actionLabel = payload.action === "DELETE" ? "Loeschanfrage" : "Stornierungsanfrage";
  const actionSentence = payload.action === "DELETE" ? "Loeschung" : "Stornierung";

  const adminRecipients = await listAdminRecipients(
    appointment.locationId,
    tenantId,
    membershipSupported,
  );
  if (!adminRecipients.length && appointment.location.email) {
    adminRecipients.push({
      email: appointment.location.email,
      name: appointment.location.name ?? "Admin",
    });
  }

  if (!adminRecipients.length) {
    return NextResponse.json({ error: "Kein Admin-Empfänger gefunden." }, { status: 400 });
  }

  const to = Array.from(new Set(adminRecipients.map((recipient) => recipient.email))).join(", ");
  const subject = `${actionLabel}: Termin am ${dateLabel} (${appointment.location.name ?? appointment.location.slug})`;
  const requestReason = payload.reason.trim();
  const textBody = [
    `Ein Mitarbeiter hat eine ${actionSentence} für einen Termin angefragt.`,
    "",
    `Mitarbeiter: ${performerName}${performer.email ? ` (${performer.email})` : ""}`,
    `Termin: ${dateLabel} · ${timeLabel}`,
    customerName ? `Kunde: ${customerName}` : null,
    serviceNames.length ? `Leistungen: ${serviceNames.join(", ")}` : null,
    `Standort: ${appointment.location.name ?? appointment.location.slug}`,
    `Bestaetigungscode: ${appointment.confirmationCode}`,
    "",
    `Grund: ${requestReason}`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlBody = [
    `<p>Ein Mitarbeiter hat eine <strong>${actionSentence}</strong> für einen Termin angefragt.</p>`,
    "<ul>",
    `<li><strong>Mitarbeiter:</strong> ${performerName}${performer.email ? ` (${performer.email})` : ""}</li>`,
    `<li><strong>Termin:</strong> ${dateLabel} · ${timeLabel}</li>`,
    customerName ? `<li><strong>Kunde:</strong> ${customerName}</li>` : "",
    serviceNames.length ? `<li><strong>Leistungen:</strong> ${serviceNames.join(", ")}</li>` : "",
    `<li><strong>Standort:</strong> ${appointment.location.name ?? appointment.location.slug}</li>`,
    `<li><strong>Bestaetigungscode:</strong> ${appointment.confirmationCode}</li>`,
    "</ul>",
    `<p><strong>Grund:</strong> ${requestReason}</p>`,
  ]
    .filter((value) => value.length)
    .join("");

  try {
    await sendMail({
      to,
      subject,
      text: textBody,
      html: htmlBody,
    });
  } catch (error) {
    console.error("[appointment:request] mail failed", error);
    return NextResponse.json({ error: "Anfrage konnte nicht gesendet werden." }, { status: 500 });
  }

  await logAuditEvent({
    locationId: appointment.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "appointment",
    entityId: appointment.id,
    appointmentId: appointment.id,
    diff: {
      action: payload.action,
      reason: requestReason,
      performedByStaff: performerInfo,
    },
    context: { source: "backoffice_request", performedByStaff: performerInfo },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ ok: true });
}

type StaffMembershipRole = { role: string | null };
type PerformerWithMemberships = {
  metadata: Prisma.JsonValue | null;
  memberships: StaffMembershipRole[];
};
type PerformerWithoutMemberships = {
  metadata: Prisma.JsonValue | null;
};
type PerformerCandidate = PerformerWithMemberships | PerformerWithoutMemberships;

function resolvePerformerRole(performer: PerformerCandidate, membershipSupported: boolean): string | null {
  const membershipRole =
    membershipSupported && "memberships" in performer
      ? performer.memberships.find((entry) => typeof entry.role === "string" && entry.role.trim().length)?.role ?? null
      : null;
  const normalizedMembershipRole = normalizeRole(membershipRole);
  if (isAdminRole(normalizedMembershipRole)) {
    return normalizedMembershipRole;
  }
  const metadataRole = extractRoleFromStaffMetadata(performer.metadata);
  const normalizedMetadataRole = normalizeRole(metadataRole);
  if (isAdminRole(normalizedMetadataRole)) {
    return normalizedMetadataRole;
  }
  return normalizedMembershipRole ?? normalizedMetadataRole;
}

function isAdminRole(role: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return normalized === "2" || normalized === "admin";
}

function normalizeRole(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

function extractRoleFromStaffMetadata(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const stundenliste = record.stundenliste;
  if (!isPlainObject(stundenliste)) {
    return null;
  }

  const role =
    normalizeRole((stundenliste as Record<string, unknown>).roleId) ??
    normalizeRole((stundenliste as Record<string, unknown>).role);
  if (role) {
    return role;
  }

  const permissions = (stundenliste as Record<string, unknown>).permissions;
  if (Array.isArray(permissions)) {
    const adminPermission = permissions.find((permission) => {
      const normalized = normalizeRole(permission);
      return normalized && isAdminRole(normalized);
    });
    if (adminPermission) {
      return normalizeRole(adminPermission);
    }
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listAdminRecipients(
  locationId: string,
  tenantId: string,
  membershipSupported: boolean,
): Promise<Array<{ email: string; name: string }>> {
  if (membershipSupported) {
    const staff = await prisma.staff.findMany({
      where: {
        location: { tenantId },
        OR: [{ memberships: { some: { locationId } } }, { locationId }],
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        firstName: true,
        lastName: true,
        metadata: true,
        memberships: {
          where: { locationId },
          select: { role: true },
        },
      },
    });

    return staff
      .map((member) => {
        const role = resolvePerformerRole(member, true);
        if (!isAdminRole(role)) return null;
        const email = member.email?.trim();
        if (!email) return null;
        const name =
          member.displayName?.trim() ||
          `${member.firstName ?? ""} ${member.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
          "Admin";
        return { email, name };
      })
      .filter((entry): entry is { email: string; name: string } => Boolean(entry));
  }

  const staff = await prisma.staff.findMany({
    where: {
      locationId,
      location: { tenantId },
    },
    select: {
      id: true,
      email: true,
      displayName: true,
      firstName: true,
      lastName: true,
      metadata: true,
    },
  });

  return staff
    .map((member) => {
      const role = resolvePerformerRole(member, false);
      if (!isAdminRole(role)) return null;
      const email = member.email?.trim();
      if (!email) return null;
      const name =
        member.displayName?.trim() ||
        `${member.firstName ?? ""} ${member.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
        "Admin";
      return { email, name };
    })
    .filter((entry): entry is { email: string; name: string } => Boolean(entry));
}
