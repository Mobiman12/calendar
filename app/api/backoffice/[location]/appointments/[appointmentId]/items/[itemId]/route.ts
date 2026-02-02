"use server";

import { NextResponse } from "next/server";
import { AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { logAuditEvent } from "@/lib/audit/logger";
import type {
  PerformerCandidate,
  PerformerCandidateWithMemberships,
  PerformerCandidateWithoutMemberships,
} from "../../route";
import { buildUpdatedMetadata } from "@/lib/appointments/metadata";
import { formatPersonName } from "@/lib/staff/format-person-name";
import { buildServiceStaffAssignmentsFromItems } from "@/lib/appointments/service-assignments";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { publishAppointmentSync } from "@/lib/appointment-sync";

const prisma = getPrismaClient();

export async function DELETE(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string; itemId: string }> },
) {
  try {
    const { location, appointmentId, itemId } = await context.params;
    const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

    const body = await request.json().catch(() => null);
    const performedByRecord =
      body && typeof body === "object" ? (body as Record<string, unknown>).performedBy : null;

    if (
      !performedByRecord ||
      typeof performedByRecord !== "object" ||
      typeof (performedByRecord as Record<string, unknown>).staffId !== "string" ||
      typeof (performedByRecord as Record<string, unknown>).token !== "string"
    ) {
      return NextResponse.json({ error: "Buchungs-PIN fehlt." }, { status: 400 });
    }

    const performedBy = performedByRecord as { staffId: string; token: string };

    const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, location: { slug: location, tenantId } },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        status: true,
        locationId: true,
        metadata: true,
      },
    });

    if (!appointment) {
      return NextResponse.json({ error: "Termin wurde nicht gefunden." }, { status: 404 });
    }

    const targetItem = await prisma.appointmentItem.findFirst({
      where: { id: itemId, appointmentId: appointment.id },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        staffId: true,
        serviceId: true,
        staff: {
          select: {
            id: true,
            displayName: true,
            firstName: true,
            lastName: true,
          },
        },
        service: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!targetItem) {
      return NextResponse.json({ error: "Terminposition wurde nicht gefunden." }, { status: 404 });
    }

    const remainingCount = await prisma.appointmentItem.count({
      where: { appointmentId: appointment.id },
    });

    if (remainingCount <= 1) {
      return NextResponse.json(
        { error: "Ein Termin benötigt mindestens eine Mitarbeiter-Zuordnung." },
        { status: 400 },
      );
    }

    const now = new Date();
    const EDIT_GRACE_MS = 24 * 60 * 60 * 1000;
    const graceCutoff =
      appointment.endsAt
        ? new Date(appointment.endsAt.getTime() + EDIT_GRACE_MS)
        : new Date(appointment.startsAt.getTime() + EDIT_GRACE_MS);
    if (now > graceCutoff) {
      return NextResponse.json(
        { error: "Termine können nur bis 24h nach Beginn/Ende bearbeitet werden." },
        { status: 400 },
      );
    }

    const membershipSupported = await supportsStaffMemberships(prisma);

    let performer: PerformerCandidate | null = null;
    if (membershipSupported) {
      performer = (await prisma.staff.findFirst({
        where: {
          id: performedBy.staffId,
          memberships: { some: { locationId: appointment.locationId } },
          location: { tenantId },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          code: true,
          metadata: true,
          memberships: {
            where: { locationId: appointment.locationId },
            select: { role: true },
          },
        },
      })) as PerformerCandidateWithMemberships | null;
    } else {
      performer = (await prisma.staff.findFirst({
        where: {
          id: performedBy.staffId,
          locationId: appointment.locationId,
          location: { tenantId },
        },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
          code: true,
          metadata: true,
        },
      })) as PerformerCandidateWithoutMemberships | null;
    }

    if (!performer || !verifyBookingPinToken(performedBy.token, performer.id)) {
      return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
    }

    const performerName =
      performer.displayName?.trim() ||
      formatPersonName(performer.firstName, performer.lastName) ||
      "Mitarbeiter";
    const performerInfo = {
      staffId: performer.id,
      staffName: performerName,
    };

    const ipAddress = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null;
    const userAgent = request.headers.get("user-agent") ?? null;

    const result = await prisma.$transaction(async (tx) => {
      await tx.appointmentItem.delete({
        where: { id: targetItem.id },
      });

      const remainingItems = await tx.appointmentItem.findMany({
        where: { appointmentId },
        select: { id: true, startsAt: true, endsAt: true, staffId: true, serviceId: true },
      });

      const bounds = await tx.appointmentItem.aggregate({
        where: { appointmentId },
        _min: { startsAt: true },
        _max: { endsAt: true },
      });

      const assignedStaffIds = Array.from(
        new Set(
          remainingItems
            .map((entry) => entry.staffId)
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0),
        ),
      );

      const timestamp = new Date();

      const updatedAppointment = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          startsAt: bounds._min.startsAt ?? appointment.startsAt,
          endsAt: bounds._max.endsAt ?? appointment.endsAt,
          metadata: buildUpdatedMetadata(
            appointment.metadata,
            performerInfo,
            timestamp,
            assignedStaffIds,
            buildServiceStaffAssignmentsFromItems(
              remainingItems.map((entry) => ({
                serviceId: entry.serviceId ?? null,
                staffId: entry.staffId ?? null,
              })),
            ),
          ),
          updatedAt: timestamp,
        },
      });

      return {
        appointment: updatedAppointment,
        items: remainingItems,
      };
    });

    const removedStaffName =
      targetItem.staff?.displayName?.trim() ||
      formatPersonName(targetItem.staff?.firstName, targetItem.staff?.lastName) ||
      null;
    const removedServiceName = targetItem.service?.name ?? null;

    await logAuditEvent({
      locationId: appointment.locationId,
      actorType: AuditActorType.USER,
      actorId: null,
      action: AuditAction.UPDATE,
      entityType: "appointment",
      entityId: appointment.id,
      appointmentId: appointment.id,
      diff: {
        removedItem: {
          id: targetItem.id,
          staffId: targetItem.staffId ?? null,
          staffName: removedStaffName,
          serviceId: targetItem.serviceId ?? null,
          serviceName: removedServiceName,
          startsAt: targetItem.startsAt.toISOString(),
          endsAt: targetItem.endsAt.toISOString(),
        },
        performedByStaff: performerInfo,
      },
      context: { source: "backoffice_update", performedByStaff: performerInfo },
      ipAddress,
      userAgent,
    });

    await publishAppointmentSync({
      locationId: appointment.locationId,
      action: "updated",
      appointmentId: result.appointment.id,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      data: {
        appointmentId: result.appointment.id,
        items: result.items.map((entry) => ({
          id: entry.id,
          staffId: entry.staffId,
          startsAt: entry.startsAt.toISOString(),
          endsAt: entry.endsAt.toISOString(),
        })),
      },
    });
  } catch (error) {
    console.error("[appointment:item:remove] unexpected error", error);
    const message =
      error instanceof Error ? error.message : "Zuordnung konnte nicht entfernt werden.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
