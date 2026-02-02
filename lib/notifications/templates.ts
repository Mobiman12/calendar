interface ServiceDisplay {
  name: string;
  price?: number;
  currency?: string;
}

export interface BookingConfirmationTemplateInput {
  customerName: string;
  locationName?: string;
  start: Date;
  end: Date;
  timeZone?: string;
  services: ServiceDisplay[];
  confirmationCode: string;
  manageUrl?: string;
  personalMessage?: string;
}

export interface BookingConfirmationTemplateOutput {
  subject: string;
  text: string;
  html: string;
}

export interface BookingRequestTemplateInput {
  customerName: string;
  locationName?: string;
  start: Date;
  end: Date;
  timeZone?: string;
  services: ServiceDisplay[];
  confirmationCode: string;
  manageUrl?: string;
  personalMessage?: string;
}

export interface BookingRequestTemplateOutput {
  subject: string;
  text: string;
  html: string;
}

export function renderBookingConfirmation(input: BookingConfirmationTemplateInput): BookingConfirmationTemplateOutput {
  const dateFormatter = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: input.timeZone ?? "UTC",
  });
  const timeFormatter = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: input.timeZone ?? "UTC",
  });

  const dateLabel = dateFormatter.format(input.start);
  const startTime = timeFormatter.format(input.start);
  const endTime = timeFormatter.format(input.end);
  const timeRange = `${dateLabel} um ${startTime} bis ${endTime} Uhr`;

  const serviceLines = input.services
    .map((service) => {
      const price = service.price != null ? formatPrice(service.price, service.currency) : "";
      return `• ${service.name}${price ? ` (${price})` : ""}`;
    })
    .join("\n");

  const subject = `Terminbestätigung ${input.locationName ?? ""}`.trim();
  const manageLine = input.manageUrl ? `Ändern oder absagen: ${input.manageUrl}` : "";

  const text = [
    `Hallo ${input.customerName},`,
    "",
    `wir bestätigen deinen Termin am ${timeRange}.`,
    "",
    "Gebuchte Leistungen:",
    serviceLines,
    "",
    ...(input.personalMessage ? [input.personalMessage, ""] : []),
    `Bestätigungscode: ${input.confirmationCode}`,
    manageLine,
    "",
    `Liebe Grüße${input.locationName ? `\n${input.locationName}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlServices = input.services
    .map((service) => {
      const price = service.price != null ? formatPrice(service.price, service.currency) : "";
      return `<li>${escapeHtml(service.name)}${price ? ` <strong>${escapeHtml(price)}</strong>` : ""}</li>`;
    })
    .join("");

  const htmlPersonalMessage = input.personalMessage
    ? `<p>${escapeHtml(input.personalMessage)}</p>`
    : "";

  const html = `
    <p>Hallo ${escapeHtml(input.customerName)},</p>
    <p>wir bestätigen deinen Termin am <strong>${escapeHtml(timeRange)}</strong>.</p>
    <p>Gebuchte Leistungen:</p>
    <ul>${htmlServices}</ul>
    ${htmlPersonalMessage}
    <p>Bestätigungscode: <strong>${escapeHtml(input.confirmationCode)}</strong></p>
    ${input.manageUrl ? `<p><a href="${escapeHtml(input.manageUrl)}">Termin verwalten</a></p>` : ""}
    <p>Liebe Grüße${input.locationName ? `<br/>${escapeHtml(input.locationName)}` : ""}</p>
  `
    .replace(/\s+\n/g, "\n")
    .trim();

  return {
    subject,
    text,
    html,
  };
}

export function renderBookingRequest(input: BookingRequestTemplateInput): BookingRequestTemplateOutput {
  const dateFormatter = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: input.timeZone ?? "UTC",
  });
  const timeFormatter = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: input.timeZone ?? "UTC",
  });

  const dateLabel = dateFormatter.format(input.start);
  const startTime = timeFormatter.format(input.start);
  const endTime = timeFormatter.format(input.end);
  const timeRange = `${dateLabel} um ${startTime} bis ${endTime} Uhr`;

  const serviceLines = input.services
    .map((service) => {
      const price = service.price != null ? formatPrice(service.price, service.currency) : "";
      return `• ${service.name}${price ? ` (${price})` : ""}`;
    })
    .join("\n");

  const subject = `Terminanfrage ${input.locationName ?? ""}`.trim();
  const manageLine = input.manageUrl ? `Ändern oder absagen: ${input.manageUrl}` : "";

  const text = [
    `Hallo ${input.customerName},`,
    "",
    "wir haben deine Terminanfrage erhalten und melden uns so schnell wie möglich mit einer Bestätigung.",
    "",
    `Angefragter Termin: ${timeRange}`,
    "",
    "Angefragte Leistungen:",
    serviceLines,
    "",
    ...(input.personalMessage ? [input.personalMessage, ""] : []),
    `Bestätigungscode: ${input.confirmationCode}`,
    manageLine,
    "",
    `Liebe Grüße${input.locationName ? `\n${input.locationName}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");

  const htmlServices = input.services
    .map((service) => {
      const price = service.price != null ? formatPrice(service.price, service.currency) : "";
      return `<li>${escapeHtml(service.name)}${price ? ` <strong>${escapeHtml(price)}</strong>` : ""}</li>`;
    })
    .join("");

  const htmlPersonalMessage = input.personalMessage ? `<p>${escapeHtml(input.personalMessage)}</p>` : "";

  const html = `
    <p>Hallo ${escapeHtml(input.customerName)},</p>
    <p>wir haben deine Terminanfrage erhalten und melden uns so schnell wie möglich mit einer Bestätigung.</p>
    <p>Angefragter Termin: <strong>${escapeHtml(timeRange)}</strong></p>
    <p>Angefragte Leistungen:</p>
    <ul>${htmlServices}</ul>
    ${htmlPersonalMessage}
    <p>Bestätigungscode: <strong>${escapeHtml(input.confirmationCode)}</strong></p>
    ${input.manageUrl ? `<p><a href="${escapeHtml(input.manageUrl)}">Termin verwalten</a></p>` : ""}
    <p>Liebe Grüße${input.locationName ? `<br/>${escapeHtml(input.locationName)}` : ""}</p>
  `
    .replace(/\s+\n/g, "\n")
    .trim();

  return {
    subject,
    text,
    html,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function formatPrice(value: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}
