import { NextResponse } from "next/server";
import { ProvisionMode } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";

const prisma = getPrismaClient();

function assertSecret(headers: Headers) {
  const secret = process.env.PROVISION_SECRET;
  const incoming = headers.get("x-provision-secret");
  if (!secret || !incoming || incoming !== secret) {
    return false;
  }
  return true;
}

export async function POST(request: Request) {
  if (!assertSecret(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const tenantId = typeof body.tenantId === "string" && body.tenantId.trim().length ? body.tenantId.trim() : null;
  const modeValue = typeof body.mode === "string" ? body.mode : null;
  const subdomain = typeof body.subdomain === "string" && body.subdomain.trim().length ? body.subdomain.trim() : null;

  if (!tenantId || !modeValue) {
    return NextResponse.json({ error: "tenantId and mode required" }, { status: 400 });
  }

  const mode = modeValue as ProvisionMode;
  const normalizeMetadata = (value: unknown): Record<string, unknown> => {
    if (!value) return {};
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return {};
      }
    }
    if (typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  };

  // ensure tenant exists
  await prisma.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: tenantId },
  });

  let location = await prisma.location.findFirst({ where: { tenantId } });
  if (!location) {
    const slug = subdomain ?? `loc-${tenantId.slice(0, 6)}`;
    location = await prisma.location.create({
      data: {
        tenantId,
        slug,
        name: "Demo Location",
        timezone: "Europe/Berlin",
        country: "DE",
        city: "Berlin",
        metadata: { provisioned: mode, bookingPreferences: { onlineBookingEnabled: true } },
      },
    });
  } else if (subdomain && location.slug !== subdomain) {
    // Wenn bereits ein Location-Eintrag existiert, aber ein abweichender Slug gewünscht ist,
    // versuche den Slug anzupassen (überspringe still, falls Konflikt)
    try {
      location = await prisma.location.update({
        where: { id: location.id },
        data: { slug: subdomain },
      });
    } catch (error) {
      // z.B. Unique-Constraint – dann behalten wir den bestehenden Slug bei
    }
  }

  const locationMetadata = normalizeMetadata(location.metadata);
  const bookingPreferences = normalizeMetadata(locationMetadata.bookingPreferences);
  if (typeof bookingPreferences.onlineBookingEnabled !== "boolean") {
    bookingPreferences.onlineBookingEnabled = true;
    locationMetadata.bookingPreferences = bookingPreferences;
    location = await prisma.location.update({
      where: { id: location.id },
      data: { metadata: locationMetadata },
    });
  }

  const existingStaffCount = await prisma.staff.count({ where: { locationId: location.id } });
  const staff =
    existingStaffCount === 0
      ? await (async () => {
          const demoCode = `demo-${location.slug}`;
          const existing = await prisma.staff.findFirst({
            where: { code: demoCode, location: { tenantId } },
          });
          if (existing) {
            return prisma.staff.update({
              where: { id: existing.id },
              data: { bookingPin: "0000" },
            });
          }
          return prisma.staff.create({
            data: {
              locationId: location.id,
              code: demoCode,
              firstName: "Demo",
              lastName: "Staff",
              displayName: "Demo Staff",
              color: "#10b981",
              bookingPin: "0000",
              status: "ACTIVE",
            },
          });
        })()
      : null;

  let staffSchedule: { id: string } | null = null;
  if (staff) {
    // Mitgliedschaft anlegen, falls Memberships unterstützt werden
    try {
      await prisma.staffLocationMembership.upsert({
        where: { staffId_locationId: { staffId: staff.id, locationId: location.id } },
        update: {},
        create: { staffId: staff.id, locationId: location.id, role: "STAFF" },
      });
    } catch (error) {
      console.warn("[provision] staff membership upsert skipped", error instanceof Error ? error.message : error);
    }
  }

  const service = await prisma.service.upsert({
    where: { locationId_slug: { locationId: location.id, slug: `demo-${location.slug}` } },
    update: {},
    create: {
      locationId: location.id,
      name: "Demo Service",
      slug: `demo-${location.slug}`,
      duration: 45,
      basePrice: 0,
      priceCurrency: "EUR",
      status: "ACTIVE",
    },
  });

  // Services benötigen mindestens einen Step, sonst können keine Slots berechnet werden.
  const existingServiceSteps = await prisma.serviceStep.count({ where: { serviceId: service.id } });
  if (existingServiceSteps === 0) {
    await prisma.serviceStep.create({
      data: {
        serviceId: service.id,
        name: service.name,
        order: 1,
        duration: service.duration,
        minStaff: 1,
        maxStaff: 1,
        requiresExclusiveResource: false,
        metadata: { demo: true },
      },
    });
  }

  // Default Location-Schedule (Mo-Fr 08:00-16:00)
  const locationSchedule = await prisma.schedule.upsert({
    where: { id: `${location.id}-default-schedule` },
    update: {
      timezone: location.timezone ?? "Europe/Berlin",
      metadata: { demo: true },
    },
    create: {
      id: `${location.id}-default-schedule`,
      locationId: location.id,
      ownerType: "LOCATION",
      name: "Demo Öffnungszeiten",
      timezone: location.timezone ?? "Europe/Berlin",
      isDefault: true,
      metadata: { demo: true },
    },
  });
  await prisma.scheduleRule.deleteMany({ where: { scheduleId: locationSchedule.id } });
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] as const;
  await prisma.scheduleRule.createMany({
    data: weekdays.map((w) => ({
      scheduleId: locationSchedule.id,
      ruleType: "WEEKLY",
      weekday: w,
      startsAt: 8 * 60,
      endsAt: 16 * 60,
      isActive: true,
      priority: 0,
    })),
  });

  if (staff) {
    // Staff-Schedule (nur für Demo-Seed)
    const existingStaffSchedule = await prisma.schedule.findFirst({
      where: { staffId: staff.id },
    });
    const staffScheduleRecord =
      existingStaffSchedule ??
      (await prisma.schedule.create({
        data: {
          locationId: location.id,
          ownerType: "STAFF",
          staffId: staff.id,
          name: "Demo Schicht",
          timezone: location.timezone ?? "Europe/Berlin",
          isDefault: true,
          metadata: { demo: true },
        },
      }));
    staffSchedule = staffScheduleRecord;
    if (existingStaffSchedule) {
      await prisma.schedule.update({
        where: { id: staffScheduleRecord.id },
        data: { timezone: location.timezone ?? "Europe/Berlin", metadata: { demo: true } },
      });
    }
    await prisma.scheduleRule.deleteMany({ where: { scheduleId: staffScheduleRecord.id } });
    await prisma.scheduleRule.createMany({
      data: weekdays.map((w) => ({
        scheduleId: staffScheduleRecord.id,
        ruleType: "WEEKLY",
        weekday: w,
        startsAt: 8 * 60,
        endsAt: 16 * 60,
        isActive: true,
        priority: 0,
      })),
    });
  }

  // Demo-Kunde
  const existingCustomer = await prisma.customer.findFirst({
    where: { locationId: location.id, email: "demo@example.com" },
  });
  const customer =
    existingCustomer ??
    (await prisma.customer.create({
      data: {
        locationId: location.id,
        firstName: "Max",
        lastName: "Mustermann",
        email: "demo@example.com",
        phone: "+49123456789",
        metadata: { demo: true },
      },
    }));

  // Aufräumen unzugewiesene Termine/Blocker bei DEMO
  if (mode === "DEMO") {
    await prisma.appointment.deleteMany({ where: { locationId: location.id, items: { none: {} } } }).catch(() => null);
    await prisma.appointmentItem.deleteMany({ where: { appointment: { locationId: location.id }, staffId: null } }).catch(() => null);
    await prisma.timeOff.deleteMany({ where: { locationId: location.id, staffId: null } }).catch(() => null);
  }

  if (mode === "DEMO" && staff && staffSchedule) {
    const now = new Date();
    // Termin morgen 10:00-10:45
    const start = new Date(now);
    start.setDate(now.getDate() + 1);
    start.setHours(10, 0, 0, 0);
    const end = new Date(start.getTime() + 45 * 60 * 1000);

    const appointment = await prisma.appointment.create({
      data: {
        locationId: location.id,
        scheduleId: staffSchedule.id,
        customerId: customer.id,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        source: "ADMIN",
        startsAt: start,
        endsAt: end,
        totalAmount: 0,
        currency: "EUR",
        confirmationCode: `DEMO-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        metadata: { demo: true },
        items: {
          create: {
            serviceId: service.id,
            staffId: staff.id,
            startsAt: start,
            endsAt: end,
            status: "CONFIRMED",
          },
        },
      },
    }).catch(() => null);

    // Demo-Zeitblocker (morgen 13:00-14:00)
    const blockStart = new Date(now);
    blockStart.setDate(now.getDate() + 1);
    blockStart.setHours(13, 0, 0, 0);
    const blockEnd = new Date(blockStart.getTime() + 60 * 60 * 1000);
    await prisma.timeOff
      .create({
        data: {
          locationId: location.id,
          scheduleId: staffSchedule.id,
          staffId: staff.id,
          reason: "Demo Zeitblocker",
          startsAt: blockStart,
          endsAt: blockEnd,
          metadata: { demo: true },
        },
      })
      .catch(() => null);
  }

  return NextResponse.json({ success: true, locationId: location.id });
}
