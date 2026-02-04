import { NextResponse } from "next/server";
import { format } from "date-fns";
import { AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { formatPersonName } from "@/lib/staff/format-person-name";

const prisma = getPrismaClient();

const ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: "erstellt",
  UPDATE: "aktualisiert",
  DELETE: "gelöscht",
  ACCESS: "geöffnet",
};

const ENTITY_LABELS: Record<string, string> = {
  appointment: "Termin",
  staff: "Mitarbeiter",
  customer: "Kunde",
  time_blocker: "Zeitblocker",
  booking_preferences: "Buchungseinstellungen",
  location_settings: "Standorteinstellungen",
  company_profile: "Unternehmensprofil",
  company_settings: "Unternehmensdaten",
  company_absences: "Abwesenheiten",
  company_closures: "Schließzeiten",
  company_booking_schedule: "Buchungszeiten",
  appointment_payment_status: "Zahlungsstatus",
  notification_resend: "Benachrichtigung",
};

function formatSummary(action: AuditAction, entityType: string): string {
  const entityLabel = ENTITY_LABELS[entityType] ?? entityType;
  const actionLabel = ACTION_LABELS[action] ?? action.toLowerCase();
  return `${entityLabel} ${actionLabel}`;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractPerformerName(record: Record<string, unknown> | null): string | null {
  if (
    !record ||
    typeof record.performedByStaff !== "object" ||
    !record.performedByStaff ||
    Array.isArray(record.performedByStaff)
  ) {
    return null;
  }
  const performer = record.performedByStaff as Record<string, unknown>;
  return typeof performer.staffName === "string" && performer.staffName.trim().length ? performer.staffName : null;
}

function resolveAppointmentAction(log: {
  action: AuditAction;
  diff?: unknown;
  context?: unknown;
}): string {
  if (log.action === AuditAction.CREATE) return "Termin erstellt";
  if (log.action === AuditAction.DELETE) return "Termin gelöscht";
  if (log.action !== AuditAction.UPDATE) return formatSummary(log.action, "appointment");

  const diff = parseRecord(log.diff);
  const previousStatus = typeof diff?.previousStatus === "string" ? diff.previousStatus : null;
  const newStatus = typeof diff?.newStatus === "string" ? diff.newStatus : null;
  if (newStatus) {
    if (newStatus === "CANCELLED") return "Termin storniert";
    if (newStatus === "NO_SHOW") return "Termin als nicht erschienen markiert";
    if (newStatus === "COMPLETED") return "Termin abgeschlossen";
    if (previousStatus === "CANCELLED" && newStatus !== "CANCELLED") return "Termin wiederhergestellt";
    return "Terminstatus geaendert";
  }

  const hasTimeChange = Boolean(diff?.appointmentStartsAt || diff?.appointmentEndsAt || diff?.resultingItem);
  if (hasTimeChange) {
    return "Termin verschoben";
  }
  return "Termin aktualisiert";
}

function buildAppointmentLabel(log: {
  appointment?: { startsAt: Date; customer?: { firstName: string | null; lastName: string | null } | null } | null;
  context?: unknown;
  diff?: unknown;
}): string | null {
  const parts: string[] = [];
  if (log.appointment?.startsAt) {
    parts.push(format(log.appointment.startsAt, "dd.MM.yyyy HH:mm"));
  }
  const customerName = formatPersonName(log.appointment?.customer?.firstName ?? null, log.appointment?.customer?.lastName ?? null);
  if (customerName) {
    parts.push(customerName);
  }
  if (parts.length) {
    return parts.join(" · ");
  }

  const contextLabel = extractAppointmentLabel(parseRecord(log.context));
  if (contextLabel) {
    return contextLabel;
  }

  const diffLabel = extractAppointmentLabel(parseRecord(log.diff));
  return diffLabel;
}

function extractAppointmentLabel(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  const directLabel = typeof record.appointmentLabel === "string" ? record.appointmentLabel.trim() : "";
  if (directLabel) return directLabel;

  const snapshot = parseRecord(record.appointmentSnapshot);
  const source = snapshot ?? record;
  const startsAtRaw = typeof source.appointmentStartsAt === "string" ? source.appointmentStartsAt : null;
  const customerName =
    typeof source.customerName === "string" && source.customerName.trim().length
      ? source.customerName.trim()
      : null;
  const customerFirst =
    typeof source.customerFirstName === "string" && source.customerFirstName.trim().length
      ? source.customerFirstName.trim()
      : null;
  const customerLast =
    typeof source.customerLastName === "string" && source.customerLastName.trim().length
      ? source.customerLastName.trim()
      : null;
  const resolvedCustomer = customerName ?? formatPersonName(customerFirst, customerLast);

  const parts: string[] = [];
  if (startsAtRaw) {
    const parsed = new Date(startsAtRaw);
    if (!Number.isNaN(parsed.getTime())) {
      parts.push(format(parsed, "dd.MM.yyyy HH:mm"));
    }
  }
  if (resolvedCustomer) {
    parts.push(resolvedCustomer);
  }

  return parts.length ? parts.join(" · ") : null;
}

function extractCreatedByStaffName(metadata: unknown): string | null {
  const record = parseRecord(metadata);
  if (!record) return null;
  const createdBy = parseRecord(record.createdByStaff);
  if (!createdBy) return null;
  return typeof createdBy.staffName === "string" && createdBy.staffName.trim().length ? createdBy.staffName.trim() : null;
}

function buildAppointmentLabelFromRecord(appointment: {
  startsAt: Date;
  customer?: { firstName: string | null; lastName: string | null } | null;
}): string | null {
  const parts: string[] = [format(appointment.startsAt, "dd.MM.yyyy HH:mm")];
  const customerName = formatPersonName(appointment.customer?.firstName ?? null, appointment.customer?.lastName ?? null);
  if (customerName) {
    parts.push(customerName);
  }
  return parts.join(" · ");
}

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  const tenantId = await getTenantIdOrThrow(request.headers, { locationSlug: location });
  const locationRecord = await prisma.location.findFirst({
    where: { slug: location, tenantId },
    select: { id: true },
  });

  if (!locationRecord) {
    return NextResponse.json({ error: "Standort nicht gefunden." }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

  const logs = await prisma.auditLog.findMany({
    where: {
      entityType: "appointment",
      OR: [
        { locationId: locationRecord.id },
        { appointment: { locationId: locationRecord.id } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorType: true,
      context: true,
      diff: true,
      createdAt: true,
      appointment: {
        select: {
          id: true,
          startsAt: true,
          customer: {
            select: { firstName: true, lastName: true },
          },
        },
      },
      actor: {
        select: {
          email: true,
          staff: { select: { displayName: true, firstName: true, lastName: true } },
        },
      },
    },
  });

  const logEntries = logs
    .map((log) => {
      const contextRecord = parseRecord(log.context);
      const diffRecord = parseRecord(log.diff);
      const performerName = extractPerformerName(contextRecord) ?? extractPerformerName(diffRecord);
      const isStaffAction = log.actorType === AuditActorType.USER || Boolean(performerName);
      if (!isStaffAction) return null;
      const actorName =
        log.actor?.staff?.displayName ??
        formatPersonName(log.actor?.staff?.firstName, log.actor?.staff?.lastName) ??
        log.actor?.email ??
        performerName ??
        "Mitarbeiter";
      const appointmentLabel = log.entityType === "appointment" ? buildAppointmentLabel(log) : null;
      const actionText =
        log.entityType === "appointment" ? resolveAppointmentAction(log) : formatSummary(log.action, log.entityType);

      return {
        id: log.id,
        summary: appointmentLabel ? `${actionText} · ${appointmentLabel}` : actionText,
        appointmentId: log.entityType === "appointment" ? log.appointment?.id ?? null : null,
        appointmentStartsAt: log.entityType === "appointment" ? log.appointment?.startsAt.toISOString() ?? null : null,
        actorName,
        createdAt: log.createdAt.toISOString(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const createIds = new Set(
    logs
      .filter((log) => log.entityType === "appointment" && log.action === AuditAction.CREATE)
      .map((log) => log.appointment?.id ?? log.entityId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );

  const fallbackAppointments = await prisma.appointment.findMany({
    where: { locationId: locationRecord.id },
    orderBy: { createdAt: "desc" },
    take: limit * 2,
    select: {
      id: true,
      startsAt: true,
      createdAt: true,
      metadata: true,
      customer: { select: { firstName: true, lastName: true } },
    },
  });

  const fallbackEntries = fallbackAppointments
    .filter((appointment) => !createIds.has(appointment.id))
    .map((appointment) => {
      const creatorName = extractCreatedByStaffName(appointment.metadata);
      if (!creatorName) return null;
      const label = buildAppointmentLabelFromRecord(appointment);
      return {
        id: `create-${appointment.id}`,
        summary: label ? `Termin erstellt · ${label}` : "Termin erstellt",
        appointmentId: appointment.id,
        appointmentStartsAt: appointment.startsAt.toISOString(),
        actorName: creatorName,
        createdAt: appointment.createdAt.toISOString(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const entries = [...logEntries, ...fallbackEntries]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  return NextResponse.json({ entries });
}
