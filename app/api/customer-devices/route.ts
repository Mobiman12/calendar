import { NextResponse, type NextRequest } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { formatDateTimeLocalInput, formatInTimeZone } from "@/lib/timezone";

type DeviceCustomer = {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
};

type BookingSuggestion = {
  serviceId: string;
  serviceName: string;
  addOnServiceIds?: string[];
  addOnServiceNames?: string[];
  weekdayIndex: number;
  weekdayLabel: string;
  timeHHmm: string;
  startsAtLocalISO?: string | null;
  staffId: string | null;
};

type CustomerDeviceResponse = {
  customer: DeviceCustomer | null;
  suggestion: BookingSuggestion | null;
};

const prisma = getPrismaClient();
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function GET(request: NextRequest) {
  const locationId = request.nextUrl.searchParams.get("locationId");
  const deviceId = request.nextUrl.searchParams.get("deviceId");

  if (!locationId || !deviceId || !isUuid(deviceId)) {
    return NextResponse.json({ error: "Missing locationId or invalid deviceId" }, { status: 400, headers: NO_STORE_HEADERS });
  }

  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { id: true, timezone: true },
  });
  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404, headers: NO_STORE_HEADERS });
  }

  const device = await prisma.customerDevice.findFirst({
    where: {
      deviceId,
      revokedAt: null,
      customer: {
        locationId,
      },
    },
    orderBy: { lastSeenAt: "desc" },
    select: {
      customer: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
        },
      },
    },
  });

  const customerId = device?.customer?.id ?? null;
  const customer = customerId
    ? {
        firstName: device.customer.firstName,
        lastName: device.customer.lastName,
        email: device.customer.email ?? null,
        phone: device.customer.phone ?? null,
      }
    : null;

  const suggestion = customerId
    ? await buildBookingSuggestion({
        customerId,
        locationId: location.id,
        timeZone: location.timezone,
      })
    : null;

  const payload: CustomerDeviceResponse = {
    customer,
    suggestion,
  };

  return NextResponse.json(payload, { headers: NO_STORE_HEADERS });
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const WEEKDAY_LABELS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

async function buildBookingSuggestion(params: { customerId: string; locationId: string; timeZone: string }) {
  const appointment = await prisma.appointment.findFirst({
    where: {
      customerId: params.customerId,
      locationId: params.locationId,
      status: {
        notIn: ["CANCELLED", "NO_SHOW"],
      },
    },
    orderBy: { startsAt: "desc" },
    include: {
      items: {
        include: {
          service: {
            select: {
              id: true,
              name: true,
              duration: true,
            },
          },
        },
      },
    },
  });

  if (!appointment || !appointment.items.length) {
    return null;
  }

  const serviceMap = new Map<string, { serviceId: string; serviceName: string; durationMin: number; staffId: string | null }>();
  for (const item of appointment.items) {
    if (!item.service) continue;
    if (!serviceMap.has(item.service.id)) {
      serviceMap.set(item.service.id, {
        serviceId: item.service.id,
        serviceName: item.service.name,
        durationMin: item.service.duration ?? 0,
        staffId: item.staffId ?? null,
      });
    }
  }

  const services = Array.from(serviceMap.values());
  if (!services.length) return null;
  services.sort((a, b) => {
    if (b.durationMin !== a.durationMin) return b.durationMin - a.durationMin;
    const nameCompare = a.serviceName.localeCompare(b.serviceName, "de-DE");
    if (nameCompare !== 0) return nameCompare;
    return a.serviceId.localeCompare(b.serviceId);
  });

  const primary = services[0];
  const addOnServices = services
    .filter((service) => service.serviceId !== primary.serviceId)
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName, "de-DE"));
  const startDate = new Date(appointment.startsAt);
  const timeHHmm = formatInTimeZone(startDate, params.timeZone, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: params.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(startDate);
  const year = Number.parseInt(dateParts.find((part) => part.type === "year")?.value ?? "1970", 10);
  const month = Number.parseInt(dateParts.find((part) => part.type === "month")?.value ?? "1", 10);
  const day = Number.parseInt(dateParts.find((part) => part.type === "day")?.value ?? "1", 10);
  const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

  return {
    serviceId: primary.serviceId,
    serviceName: primary.serviceName,
    addOnServiceIds: addOnServices.map((service) => service.serviceId),
    addOnServiceNames: addOnServices.map((service) => service.serviceName),
    weekdayIndex,
    weekdayLabel: WEEKDAY_LABELS[weekdayIndex] ?? "",
    timeHHmm,
    startsAtLocalISO: formatDateTimeLocalInput(startDate, params.timeZone),
    staffId: primary.staffId,
  };
}
