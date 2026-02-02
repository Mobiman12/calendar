import { NextResponse, type NextRequest } from "next/server";
import { AuditAction, AuditActorType } from "@prisma/client";
import JSZip from "jszip";

import { getPrismaClient } from "@/lib/prisma";
import { requireTenantContext } from "@/lib/tenant";
import { createIcsCalendar } from "@/lib/notifications/ics";
import { logAuditEvent } from "@/lib/audit/logger";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const tenant = requireTenantContext(request.headers);
  const prisma = getPrismaClient();

  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      location: {
        select: {
          id: true,
          name: true,
          slug: true,
          tenantId: true,
          addressLine1: true,
          city: true,
        },
      },
      appointments: {
        orderBy: { startsAt: "asc" },
        include: {
          items: {
            include: {
              service: true,
            },
          },
        },
      },
    },
  });

  if (!customer || customer.location?.tenantId !== tenant.id) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const zip = new JSZip();

  const customerJson = {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    location: {
      id: customer.location?.id,
      name: customer.location?.name,
      slug: customer.location?.slug,
    },
  };

  zip.file("customer.json", JSON.stringify(customerJson, null, 2));

  const appointmentsCsv = buildAppointmentsCsv(customer.appointments);
  zip.file("appointments.csv", appointmentsCsv);

  if (customer.appointments.length) {
    const calendar = createIcsCalendar(
      customer.appointments.map((appointment) => ({
        summary: `Salon Termin - ${appointment.items.map((item) => item.service?.name ?? "Service").join(", ")}`,
        description: `Termin im ${customer.location?.name ?? "Salon"} (${customer.location?.addressLine1 ?? ""})`,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        createdAt: appointment.createdAt,
        updatedAt: appointment.updatedAt,
        location: `${customer.location?.addressLine1 ?? ""} ${customer.location?.city ?? ""}`.trim(),
        status: appointment.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED",
      })),
    );
    zip.file("appointments.ics", calendar);
  }

  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const body = new Uint8Array(archive);
  const fileName = `customer-export-${customer.id}.zip`;

  await logAuditEvent({
    locationId: customer.locationId,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.ACCESS,
    entityType: "customer",
    entityId: customer.id,
    appointmentId: null,
    diff: null,
    context: { source: "gdpr_export" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}

function buildAppointmentsCsv(
  appointments: Array<{
    id: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
    totalAmount: any;
    currency: string;
    items: Array<{
      service: {
        name: string | null;
      } | null;
    }>;
  }>,
) {
  const header = ["appointment_id", "starts_at", "ends_at", "status", "services", "total_amount", "currency"];
  const rows = appointments.map((appointment) => {
    const services = appointment.items.map((item) => item.service?.name ?? "Service").join("|");
    return [
      appointment.id,
      appointment.startsAt.toISOString(),
      appointment.endsAt.toISOString(),
      appointment.status,
      services,
      appointment.totalAmount?.toString() ?? "",
      appointment.currency,
    ];
  });

  return [header, ...rows].map((columns) => columns.map(escapeCsvField).join(",")).join("\n");
}

function escapeCsvField(value: string) {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}
