import { getPrismaClient } from "@/lib/prisma";
import { createMailer } from "@/lib/notifications/mailer";
import { createIcsEvent } from "@/lib/notifications/ics";
import { NotificationJobNames, type AppointmentFollowUpJob, type AppointmentReminderJob } from "@/lib/notifications/jobs";
import { sendSms } from "@/lib/notifications/sms";
import { sendWhatsAppNotification } from "@/lib/notifications/whatsapp";
import {
  DEFAULT_WHATSAPP_TEMPLATE,
  WHATSAPP_TEMPLATE_OPTIONS,
  type WhatsAppTemplateKey,
} from "@/lib/notifications/whatsapp-templates";
import { resolveTenantName } from "@/lib/tenant";
import { resolveNotificationPreferences } from "@/lib/notifications/notification-preferences";

type NotificationDispatch =
  | { type: "REMINDER"; data: AppointmentReminderJob }
  | { type: "FOLLOW_UP"; data: AppointmentFollowUpJob };

export async function sendNotification(request: NotificationDispatch) {
  const prisma = getPrismaClient();
  const channel = request.data.channel ?? "EMAIL";
  const mailer = channel === "EMAIL" ? await createMailer() : null;

  switch (request.type) {
    case "REMINDER":
      await handleReminder(request.data, prisma, mailer);
      return;
    case "FOLLOW_UP":
      await handleFollowUp(request.data, prisma, mailer);
      return;
    default:
      throw new Error(`Unsupported notification type ${(request as any).type}`);
  }
}

async function handleReminder(
  payload: AppointmentReminderJob,
  prisma: ReturnType<typeof getPrismaClient>,
  mailer: Awaited<ReturnType<typeof createMailer>> | null,
) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: payload.appointmentId },
    include: {
      customer: true,
      items: {
        include: {
          service: true,
          staff: {
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
            },
          },
        },
      },
      location: {
        include: {
          tenant: {
            select: { name: true },
          },
        },
      },
    },
  });

  if (!appointment || !appointment.customer) {
    throw new Error(`Appointment ${payload.appointmentId} not found for reminder job.`);
  }

  const locationName = appointment.location?.name ?? "Standort";
  const companyName =
    (await resolveTenantName(appointment.location?.tenantId ?? null, appointment.location?.tenant?.name ?? locationName)) ??
    locationName;
  const notificationPrefs = resolveNotificationPreferences(appointment.location?.metadata);
  const emailSenderName = notificationPrefs.emailSenderName ?? companyName;
  const replyTo = notificationPrefs.emailReplyTo ?? undefined;
  const smsBrandName = notificationPrefs.smsBrandName ?? appointment.location?.name ?? "Salon";
  const smsSenderName = notificationPrefs.smsSenderName ?? undefined;
  const customMessage =
    typeof payload.message === "string" && payload.message.trim().length > 0 ? payload.message.trim() : null;

  if (payload.channel === "SMS" || payload.channel === "WHATSAPP") {
    if (!appointment.customer.phone) {
      throw new Error(`Appointment ${payload.appointmentId} missing customer phone for ${payload.channel}.`);
    }
    const timeZone = appointment.location?.timezone ?? "Europe/Berlin";
    const start = appointment.startsAt.toLocaleString("de-DE", {
      timeZone,
    });
    const dateLabel = appointment.startsAt.toLocaleDateString("de-DE", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const timeLabel = appointment.startsAt.toLocaleTimeString("de-DE", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
    const serviceNames = appointment.items.map((item) => item.service?.name ?? "Service").join(", ");
    const staff = appointment.items.find((item) => item.staff)?.staff ?? null;
    const staffFirstName =
      staff?.firstName?.trim() || staff?.displayName?.trim()?.split(" ")[0] || "Team";
    const body =
      customMessage ??
      `Hallo ${appointment.customer.firstName}, dein Termin (${serviceNames}) findet am ${start} im ${
        smsBrandName
      } statt.`;
    if (payload.channel === "SMS") {
      await sendSms({
        to: appointment.customer.phone,
        body,
        tenantId: appointment.location?.tenantId,
        sender: smsSenderName,
      });
      return;
    }
    if (!appointment.location?.tenantId) {
      throw new Error("Missing tenantId for WhatsApp reminder.");
    }
    const templateKey = resolveWhatsAppTemplateKey(payload.template);
    const placeholders = buildWhatsAppPlaceholders(templateKey, {
      customerFirstName: appointment.customer.firstName,
      customerLastName: appointment.customer.lastName,
      staffFirstName,
      dateLabel,
      timeLabel,
      startLabel: start,
      serviceNames,
      locationName,
      companyName,
    });
    await sendWhatsAppNotification({
      tenantId: appointment.location.tenantId,
      to: appointment.customer.phone,
      templateKey,
      placeholders,
      fallbackText: body,
    });
    return;
  }

  if (!mailer) {
    throw new Error("Mailer not available for reminder notification.");
  }

  const safeMessage = customMessage ? escapeHtml(customMessage) : null;
  const serviceNames = appointment.items.map((item) => item.service?.name ?? "Service").join(", ");
  const start = appointment.startsAt;
  const end = appointment.endsAt;

  const ics = createIcsEvent({
    summary: `Termin: ${serviceNames}`,
    description:
      customMessage ??
      `Wir sehen uns im ${appointment.location?.name ?? "Salon"}.\nBitte erscheine rechtzeitig.`,
    startsAt: start,
    endsAt: end,
    createdAt: appointment.createdAt,
    location: appointment.location?.addressLine1 ?? "",
  });

  await mailer.sendBookingConfirmation({
    to: {
      name: `${appointment.customer.firstName} ${appointment.customer.lastName}`.trim(),
      email: appointment.customer.email ?? "",
    },
    fromName: emailSenderName,
    replyTo,
    subject: "Erinnerung an deinen Termin",
    textBody:
      customMessage ??
      `Hallo ${appointment.customer.firstName},

du hast am ${start.toLocaleString("de-DE")} einen Termin für ${serviceNames}.
Wir freuen uns auf dich!`,
    htmlBody: safeMessage
      ? `<p>${safeMessage.replace(/\n/g, "<br />")}</p>`
      : `<p>Hallo ${appointment.customer.firstName},</p><p>du hast am <strong>${start.toLocaleString(
          "de-DE",
        )}</strong> einen Termin für ${serviceNames}. Wir freuen uns auf dich!</p>`,
    attachments: [
      {
        filename: "termin.ics",
        content: ics,
        contentType: "text/calendar",
      },
    ],
    metadata: {
      jobType: NotificationJobNames.AppointmentReminder,
      appointmentId: appointment.id,
    },
  });
}

async function handleFollowUp(
  payload: AppointmentFollowUpJob,
  prisma: ReturnType<typeof getPrismaClient>,
  mailer: Awaited<ReturnType<typeof createMailer>> | null,
) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: payload.appointmentId },
    include: {
      customer: true,
      location: true,
    },
  });

  if (!appointment || !appointment.customer) {
    throw new Error(`Appointment ${payload.appointmentId} not found for follow-up job.`);
  }

  const locationName = appointment.location?.name ?? "Standort";
  const companyName =
    (await resolveTenantName(appointment.location?.tenantId ?? null, appointment.location?.tenant?.name ?? locationName)) ??
    locationName;

  if (payload.channel === "SMS" || payload.channel === "WHATSAPP") {
    if (!appointment.customer.phone) {
      throw new Error(`Appointment ${payload.appointmentId} missing customer phone for ${payload.channel} follow-up.`);
    }
    const body =
      payload.outcome === "NO_SHOW"
        ? `Hallo ${appointment.customer.firstName}, wir haben dich heute vermisst. Melde dich gern für einen neuen Termin.`
        : `Hallo ${appointment.customer.firstName}, danke für deinen Besuch! Wir freuen uns schon auf das nächste Mal.`;
    if (payload.channel === "SMS") {
      await sendSms({
        to: appointment.customer.phone,
        body,
        tenantId: appointment.location?.tenantId,
        sender: smsSenderName,
      });
      return;
    }
    if (!appointment.location?.tenantId) {
      throw new Error("Missing tenantId for WhatsApp follow-up.");
    }
    await sendWhatsAppNotification({
      tenantId: appointment.location.tenantId,
      to: appointment.customer.phone,
      templateKey: payload.outcome === "NO_SHOW" ? "followUpNoShow" : "followUpThanks",
      placeholders: [appointment.customer.firstName],
      fallbackText: body,
    });
    return;
  }

  if (!mailer) {
    throw new Error("Mailer not available for follow-up notification.");
  }

  await mailer.sendBookingConfirmation({
    to: {
      name: `${appointment.customer.firstName} ${appointment.customer.lastName}`.trim(),
      email: appointment.customer.email ?? "",
    },
    fromName: emailSenderName,
    replyTo,
    subject: payload.outcome === "NO_SHOW" ? "Wir haben dich vermisst" : "Danke für deinen Besuch",
    textBody:
      payload.outcome === "NO_SHOW"
        ? `Hallo ${appointment.customer.firstName},\n\nwir haben dich heute vermisst. Wir helfen dir gern bei einer neuen Terminfindung.`
        : `Hallo ${appointment.customer.firstName},\n\ndanke für deinen Besuch! Wir freuen uns über dein Feedback.`,
    htmlBody:
      payload.outcome === "NO_SHOW"
        ? `<p>Hallo ${appointment.customer.firstName},</p><p>wir haben dich heute vermisst. Wir helfen dir gern bei einer neuen Terminfindung.</p>`
        : `<p>Hallo ${appointment.customer.firstName},</p><p>danke für deinen Besuch! Wir freuen uns über dein Feedback.</p>`,
    metadata: {
      jobType: NotificationJobNames.AppointmentFollowUp,
      appointmentId: appointment.id,
    },
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveWhatsAppTemplateKey(value?: string | null): WhatsAppTemplateKey {
  if (value && WHATSAPP_TEMPLATE_OPTIONS.some((option) => option.key === value)) {
    return value as WhatsAppTemplateKey;
  }
  return DEFAULT_WHATSAPP_TEMPLATE;
}

function buildWhatsAppPlaceholders(
  templateKey: WhatsAppTemplateKey,
  data: {
    customerFirstName: string;
    customerLastName: string;
    staffFirstName: string;
    dateLabel: string;
    timeLabel: string;
    startLabel: string;
    serviceNames: string;
    locationName: string;
    companyName: string;
  },
): string[] {
  const safe = (value: string | null | undefined, fallback: string) =>
    value && value.trim().length ? value.trim() : fallback;

  if (templateKey === "bookingConfirmation") {
    return [
      safe(data.customerFirstName, "Kunde"),
      safe(data.customerLastName, ""),
      safe(data.staffFirstName, "Team"),
      safe(data.dateLabel, data.startLabel),
      safe(data.timeLabel, ""),
      safe(data.serviceNames, "Service"),
      safe(data.locationName, "Standort"),
      safe(data.companyName, data.locationName),
    ];
  }
  if (templateKey === "followUpThanks" || templateKey === "followUpNoShow") {
    return [safe(data.customerFirstName, "Kunde")];
  }
  return [
    safe(data.customerFirstName, "Kunde"),
    safe(data.serviceNames, "Service"),
    safe(data.startLabel, ""),
    safe(data.locationName, "Standort"),
  ];
}
