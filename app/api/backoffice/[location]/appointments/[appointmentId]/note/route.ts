import { NextResponse } from "next/server";
import { z } from "zod";
import { AuditAction, AuditActorType, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { verifyBookingPinToken } from "@/lib/booking-auth";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { publishAppointmentSync } from "@/lib/appointment-sync";

const prisma = getPrismaClient();

const requestSchema = z.object({
  note: z
    .string()
    .max(4000)
    .transform((value) => value.trim()),
  internalNote: z
    .string()
    .max(4000)
    .transform((value) => value.trim())
    .optional(),
  performedBy: z.object({
    staffId: z.string().min(1),
    token: z.string().min(1),
  }),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string }> },
) {
  const { location, appointmentId } = await context.params;
  const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

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
    select: { id: true, locationId: true, note: true, metadata: true },
  });

  if (!appointment) {
    return NextResponse.json({ error: "Termin nicht gefunden." }, { status: 404 });
  }

  const performer = await prisma.staff.findFirst({
    where: { id: payload.performedBy.staffId, location: { slug: location, tenantId } },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });

  if (!performer) {
    return NextResponse.json({ error: "Buchungs-PIN konnte nicht verifiziert werden." }, { status: 401 });
  }

  const pinVerified = verifyBookingPinToken(payload.performedBy.token, performer.id);

  const performerName =
    performer.displayName?.trim() ||
    `${performer.firstName ?? ""} ${performer.lastName ?? ""}`.replace(/\s+/g, " ").trim() ||
    "Mitarbeiter";

  const performerInfo = {
    staffId: performer.id,
    staffName: performerName,
  };

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const baseMetadata =
        appointment.metadata && typeof appointment.metadata === "object" && !Array.isArray(appointment.metadata)
          ? (appointment.metadata as Prisma.JsonObject)
          : ({} as Prisma.JsonObject);
      const nextMetadata: Prisma.JsonObject = { ...baseMetadata };
      if (payload.internalNote !== undefined) {
        if (payload.internalNote.length) {
          nextMetadata.internalNote = payload.internalNote;
        } else {
          delete nextMetadata.internalNote;
        }
      }

      const result = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          note: payload.note.length ? payload.note : null,
          metadata: nextMetadata,
        },
        select: {
          id: true,
          note: true,
          metadata: true,
        },
      });

      await logAuditEvent({
        locationId: appointment.locationId,
        actorType: AuditActorType.USER,
        actorId: null,
        action: AuditAction.UPDATE,
        entityType: "appointment",
        entityId: appointment.id,
        appointmentId: appointment.id,
        diff: {
          previousNote: appointment.note ?? null,
          newNote: result.note ?? null,
          previousInternalNote:
            appointment.metadata && typeof appointment.metadata === "object" && !Array.isArray(appointment.metadata)
              ? (appointment.metadata as Record<string, unknown>).internalNote ?? null
              : null,
          newInternalNote: payload.internalNote ?? null,
          pinVerified,
          performedByStaff: performerInfo,
        },
        context: { source: "backoffice_note_update", performedByStaff: performerInfo },
        ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
        userAgent: request.headers.get("user-agent") ?? null,
      });

      return result;
    });

    await publishAppointmentSync({
      locationId: appointment.locationId,
      action: "note",
      appointmentId: appointment.id,
      timestamp: Date.now(),
    });

    return NextResponse.json({ data: updated, pinVerified });
  } catch (error) {
    console.error("[appointment:note] failed", error);
    return NextResponse.json({ error: "Notiz konnte nicht aktualisiert werden." }, { status: 500 });
  }
}
