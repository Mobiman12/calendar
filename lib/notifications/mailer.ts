import type { AvailabilitySlot } from "@/lib/availability";
import nodemailer from "nodemailer";

export interface MailerRecipient {
  name: string;
  email: string;
}

export interface MailerAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface BookingConfirmationMessage {
  to: MailerRecipient;
  subject: string;
  textBody: string;
  htmlBody: string;
  fromName?: string;
  replyTo?: string;
  attachments?: MailerAttachment[];
  metadata?: Record<string, unknown>;
}

export interface MailerAdapter {
  sendBookingConfirmation(message: BookingConfirmationMessage): Promise<void>;
}

class ConsoleMailer implements MailerAdapter {
  async sendBookingConfirmation(message: BookingConfirmationMessage): Promise<void> {
    // eslint-disable-next-line no-console
    console.info("[mailer] booking confirmation", {
      to: message.to,
      subject: message.subject,
      attachments: message.attachments?.map((attachment) => attachment.filename),
    });
  }
}

class PostmarkMailer implements MailerAdapter {
  constructor(private client: { sendEmail: (payload: any) => Promise<any> }, private fromEmail: string) {}

  async sendBookingConfirmation(message: BookingConfirmationMessage): Promise<void> {
    const fromAddress = formatFromAddress(this.fromEmail, message.fromName);
    const payload: Record<string, unknown> = {
      From: fromAddress,
      To: formatAddress(message.to),
      Subject: message.subject,
      TextBody: message.textBody,
      HtmlBody: message.htmlBody,
    };

    if (message.attachments?.length) {
      payload.Attachments = message.attachments.map((attachment) => ({
        Name: attachment.filename,
        Content: Buffer.from(attachment.content, "utf8").toString("base64"),
        ContentType: attachment.contentType,
      }));
    }

    if (message.metadata) {
      payload.Metadata = message.metadata;
    }

    if (message.replyTo) {
      payload.ReplyTo = message.replyTo;
    }

  await this.client.sendEmail(payload);
  }
}

type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
};

class SmtpMailer implements MailerAdapter {
  constructor(private config: SmtpConfig) {}

  async sendBookingConfirmation(message: BookingConfirmationMessage): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.port === 465,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
    });

    await transporter.sendMail({
      from: formatFromAddress(this.config.from, message.fromName),
      to: formatAddress(message.to),
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.textBody,
      html: message.htmlBody,
      attachments: message.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
      })),
    });
  }
}

function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;
  if (!host || !user || !pass || !from) {
    return null;
  }
  return { host, port, user, pass, from };
}

export async function createMailer(): Promise<MailerAdapter> {
  const token = process.env.POSTMARK_API_TOKEN;
  const fromEmail = process.env.POSTMARK_FROM_EMAIL;

  if (!token || !fromEmail) {
    const smtpConfig = getSmtpConfig();
    if (smtpConfig) {
      return new SmtpMailer(smtpConfig);
    }
    return new ConsoleMailer();
  }

  try {
    const postmarkImport = await import("postmark");
    const client = new postmarkImport.ServerClient(token);
    return new PostmarkMailer(client, fromEmail);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("Postmark client unavailable, using console mailer.", error);
    return new ConsoleMailer();
  }
}

function formatAddress(recipient: MailerRecipient): string {
  return recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email;
}

function formatFromAddress(from: string, fromName?: string): string {
  if (!fromName || !fromName.trim()) {
    return from;
  }
  const match = from.match(/<([^>]+)>/);
  const email = match?.[1]?.trim() || from.trim();
  return `${fromName.trim()} <${email}>`;
}
