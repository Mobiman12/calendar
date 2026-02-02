import { z } from "zod";

export const NotificationJobNames = {
  AppointmentReminder: "notification.appointment.reminder",
  AppointmentFollowUp: "notification.appointment.followup",
} as const;

export type NotificationJobName = (typeof NotificationJobNames)[keyof typeof NotificationJobNames];

const dateSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return value;
}, z.date());

const baseJobSchema = z.object({
  locationId: z.string().min(1),
  appointmentId: z.string().min(1),
  customerId: z.string().min(1),
  channel: z.enum(["EMAIL", "SMS", "WHATSAPP", "PUSH"]).default("EMAIL"),
});

export const appointmentReminderJobSchema = baseJobSchema.extend({
  sendAt: dateSchema,
  template: z.string().min(1).default("reminder"),
  message: z.string().max(1000).optional(),
});

export const appointmentFollowUpJobSchema = baseJobSchema.extend({
  outcome: z.enum(["NO_SHOW", "COMPLETED"]).default("COMPLETED"),
  sentAt: dateSchema.optional(),
});

export type AppointmentReminderJob = z.infer<typeof appointmentReminderJobSchema>;
export type AppointmentFollowUpJob = z.infer<typeof appointmentFollowUpJobSchema>;

export type NotificationJobPayloads = {
  [NotificationJobNames.AppointmentReminder]: AppointmentReminderJob;
  [NotificationJobNames.AppointmentFollowUp]: AppointmentFollowUpJob;
};

export const notificationJobSchemas: Record<NotificationJobName, z.ZodTypeAny> = {
  [NotificationJobNames.AppointmentReminder]: appointmentReminderJobSchema,
  [NotificationJobNames.AppointmentFollowUp]: appointmentFollowUpJobSchema,
};
