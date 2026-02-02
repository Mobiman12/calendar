import { NextResponse, type NextRequest } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { createIcsEvent } from "@/lib/notifications/ics";

export async function GET(request: NextRequest) {
  const appointmentId = request.nextUrl.searchParams.get("appointmentId");
  const confirmationCode = request.nextUrl.searchParams.get("code");

  if (!appointmentId || !confirmationCode) {
    return NextResponse.json({ error: "Missing appointmentId or code" }, { status: 400 });
  }

  const prisma = getPrismaClient();
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      confirmationCode: true,
      startsAt: true,
      endsAt: true,
      customer: {
        select: {
          firstName: true,
          lastName: true,
          email: true,
        },
      },
      location: {
        select: {
          name: true,
          addressLine1: true,
          city: true,
          timezone: true,
          email: true,
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

  if (!appointment || appointment.confirmationCode !== confirmationCode) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const customerName = `${appointment.customer?.firstName ?? ""} ${appointment.customer?.lastName ?? ""}`.trim() || "Kunde";
  const locationLabel = [appointment.location?.name, appointment.location?.addressLine1, appointment.location?.city]
    .filter(Boolean)
    .join(" · ") || undefined;
  const services = appointment.items
    .map((item) => item.service?.name)
    .filter((name): name is string => Boolean(name && name.trim().length));
  const description = services.length ? `Leistung: ${services.join(", ")}` : "Wir freuen uns auf dich!";

  const ics = createIcsEvent({
    summary: `Termin im ${appointment.location?.name ?? "Salon"}`,
    description,
    location: locationLabel,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    organizer: {
      name: appointment.location?.name ?? "Timevex Calendar",
      email: appointment.location?.email ?? "noreply@example.com",
    },
    attendees: appointment.customer?.email
      ? [
          {
            name: customerName,
            email: appointment.customer.email,
          },
        ]
      : [],
    remindersMinutesBefore: [60],
  });

  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename=termin-${appointment.confirmationCode}.ics`,
    },
  });
}
