import { NextResponse } from "next/server";
import { NotificationTrigger, NotificationStatus, AuditAction, AuditActorType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getNotificationsQueue } from "@/lib/notifications/queue";
import {
  NotificationJobNames,
  appointmentReminderJobSchema,
  appointmentFollowUpJobSchema,
} from "@/lib/notifications/jobs";
import { logAuditEvent } from "@/lib/audit/logger";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

const SUPPORTED_TRIGGERS = new Set<NotificationTrigger>([
  NotificationTrigger.APPOINTMENT_REMINDER,
  NotificationTrigger.NO_SHOW_FOLLOW_UP,
]);

export async function POST(
  request: Request,
  context: {
    params: Promise<{
      location: string;
      appointmentId: string;
      notificationId: string;
    }>;
  },
) {
  const { location, appointmentId, notificationId } = await context.params;
  const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });

  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      appointmentId,
      location: { slug: location, tenantId },
    },
    select: {
      id: true,
      trigger: true,
      status: true,
      payload: true,
      locationId: true,
      appointmentId: true,
      customerId: true,
    },
  });

  if (!notification) {
    return NextResponse.json({ error: "Benachrichtigung nicht gefunden." }, { status: 404 });
  }

  if (!SUPPORTED_TRIGGERS.has(notification.trigger)) {
    return NextResponse.json({ error: "Diese Benachrichtigung kann nicht erneut gesendet werden." }, { status: 422 });
  }

  if (!notification.payload) {
    return NextResponse.json({ error: "Keine Payload für erneuten Versand vorhanden." }, { status: 422 });
  }

  const payload = notification.payload as Record<string, unknown>;

  try {
    const queue = getNotificationsQueue();

    switch (notification.trigger) {
      case NotificationTrigger.APPOINTMENT_REMINDER: {
        const jobPayload = appointmentReminderJobSchema.parse(payload);
        await queue.add(NotificationJobNames.AppointmentReminder, jobPayload, { removeOnComplete: true });
        break;
      }
      case NotificationTrigger.NO_SHOW_FOLLOW_UP: {
        const jobPayload = appointmentFollowUpJobSchema.parse(payload);
        await queue.add(NotificationJobNames.AppointmentFollowUp, jobPayload, { removeOnComplete: true });
        break;
      }
      default:
        return NextResponse.json({ error: "Diese Benachrichtigung kann nicht erneut gesendet werden." }, { status: 422 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.PENDING,
          scheduledAt: new Date(),
          sentAt: null,
          error: null,
        },
        select: {
          id: true,
          status: true,
          scheduledAt: true,
        },
      });

      await logAuditEvent({
        locationId: notification.locationId,
        actorType: AuditActorType.USER,
        actorId: null,
        action: AuditAction.UPDATE,
        entityType: "notification_resend",
        entityId: notification.id,
        appointmentId: notification.appointmentId ?? null,
        diff: {
          notificationId: notification.id,
          trigger: notification.trigger,
          status: "resent",
        },
        context: { source: "backoffice_notification_resend" },
        ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
        userAgent: request.headers.get("user-agent") ?? null,
      });

      return result;
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("[notification:resend] failed", error);
    return NextResponse.json({ error: "Benachrichtigung konnte nicht erneut versendet werden." }, { status: 500 });
  }
}
