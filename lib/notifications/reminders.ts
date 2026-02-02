import { NotificationStatus, NotificationTrigger } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { getNotificationsQueue } from "@/lib/notifications/queue";
import { NotificationJobNames } from "@/lib/notifications/jobs";
import { isSmsConfigured, isWhatsappConfigured } from "@/lib/notifications/sms";
import { readReminderRules } from "@/lib/reminders";

type ScheduleRemindersParams = {
  appointment: {
    id: string;
    startsAt: Date;
    endsAt: Date;
  };
  customer: {
    id: string;
    email?: string | null;
    phone?: string | null;
  };
  location: {
    id: string;
  };
  locationMetadata: unknown;
};

export async function scheduleAppointmentReminders(params: ScheduleRemindersParams) {
  const reminders = readReminderRules(params.locationMetadata);
  if (!reminders.length) return;

  const now = Date.now();
  const prisma = getPrismaClient();
  let queue;
  try {
    queue = getNotificationsQueue();
  } catch (error) {
    console.warn("[reminders] queue unavailable", error);
    return;
  }

  for (const reminder of reminders) {
    const baseDate =
      reminder.timing === "AFTER" ? params.appointment.endsAt : params.appointment.startsAt;
    const sendAt = new Date(baseDate.getTime() + reminder.offsetMinutes * 60 * 1000 * (reminder.timing === "AFTER" ? 1 : -1));
    const delay = sendAt.getTime() - now;
    if (delay <= 0) continue;

    for (const channel of reminder.channels) {
      if (channel === "EMAIL" && !params.customer.email) continue;
      if (channel === "SMS") {
        if (!params.customer.phone) continue;
        if (!isSmsConfigured()) continue;
      }
      if (channel === "WHATSAPP") {
        if (!params.customer.phone) continue;
        if (!isWhatsappConfigured()) continue;
      }

      const jobPayload = {
        locationId: params.location.id,
        appointmentId: params.appointment.id,
        customerId: params.customer.id,
        channel,
        sendAt,
        template: channel === "WHATSAPP" ? reminder.whatsappTemplateKey : "custom",
        message: reminder.message,
      };

      try {
        await prisma.notification.create({
          data: {
            locationId: params.location.id,
            appointmentId: params.appointment.id,
            customerId: params.customer.id,
            channel,
            trigger: NotificationTrigger.APPOINTMENT_REMINDER,
            status: NotificationStatus.SCHEDULED,
            scheduledAt: sendAt,
            payload: jobPayload,
            metadata: { reminderId: reminder.id },
          },
        });
      } catch (error) {
        console.warn("[reminders] notification create failed", error);
      }

      const jobId = `${params.appointment.id}-reminder-${reminder.id}-${channel.toLowerCase()}`;
      try {
        await queue.add(NotificationJobNames.AppointmentReminder, jobPayload, {
          jobId,
          delay,
          removeOnComplete: true,
        });
      } catch (error) {
        console.warn("[reminders] enqueue failed", error);
      }
    }
  }
}
