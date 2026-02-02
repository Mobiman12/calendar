import { addDays, parseISO, startOfWeek, subDays } from "date-fns";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { AppointmentItemStatus, AppointmentStatus, ConsentType, NotificationStatus, Prisma, Weekday } from "@prisma/client";

import { autoCompletePastAppointments } from "@/lib/appointments/auto-complete";
import { getPrismaClient } from "@/lib/prisma";
import { loadPoliciesForLocation } from "@/lib/policies";
import { getInternalNoteFromMetadata } from "@/lib/appointments/internal-notes";
import { CalendarWorkspace } from "@/components/dashboard/CalendarWorkspace";
import { PolicyOverview } from "@/components/dashboard/PolicyOverview";
import { syncStundenlisteStaff, getHiddenStaffByLocation } from "@/lib/stundenliste-sync";
import { ensureCalendarOrdering, supportsCalendarOrder } from "@/lib/staff-ordering";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { readTenantContext } from "@/lib/tenant";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { extractColorMetadata } from "@/lib/color-consultation";

export const revalidate = 0;
export const dynamic = "force-dynamic";

function metadataHidesStaff(metadata: Prisma.JsonValue | null, locationId: string): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  const isHiddenFlag = (value: unknown) => {
    if (typeof value === "boolean") return value === false;
    if (typeof value === "number") return value === 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      return normalized === "false" || normalized === "0" || normalized === "nein";
    }
    return false;
  };
  const calendarVisible = record.calendarVisible;
  if (isHiddenFlag(calendarVisible)) {
    return true;
  }
  const bookingDisplay = record.bookingDisplay;
  if (bookingDisplay && typeof bookingDisplay === "object" && !Array.isArray(bookingDisplay)) {
    const showInCalendar = (bookingDisplay as Record<string, unknown>).showInCalendar;
    if (isHiddenFlag(showInCalendar)) {
      return true;
    }
  }
  const stundenlisteEntry = record.stundenliste;
  if (!stundenlisteEntry || typeof stundenlisteEntry !== "object" || Array.isArray(stundenlisteEntry)) {
    return false;
  }
  const visibility = (stundenlisteEntry as Record<string, unknown>).visibility;
  if (!visibility || typeof visibility !== "object" || Array.isArray(visibility)) {
    return false;
  }
  const value = (visibility as Record<string, unknown>)[locationId];
  return value === false;
}

function readOnlineBookable(metadata: Prisma.JsonValue | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return true;
  }
  const value = (metadata as Record<string, unknown>).onlineBookingEnabled;
  return typeof value === "boolean" ? value : true;
}

function readIsColorRequest(metadata: Prisma.JsonValue | null): boolean {
  return Boolean(extractColorMetadata(metadata).request);
}

interface CalendarPageProps {
  params: Promise<{ location: string }>;
  searchParams: Promise<{ week?: string; staff?: string }>;
}

export default async function CalendarPage({ params, searchParams }: CalendarPageProps) {
  const { location } = await params;
  const { week, staff: staffQuery } = await searchParams;

  const prisma = getPrismaClient();
  const hdrs = await headers();
  const tenantContext = readTenantContext(hdrs);
  // Tenant-Id tolerant: Session/Headers, danach Fallback DEFAULT_TENANT_ID
  let tenantId = tenantContext?.id ?? process.env.DEFAULT_TENANT_ID ?? undefined;

  const selectLocation = {
    select: {
      id: true,
      slug: true,
      name: true,
      timezone: true,
      tenantId: true,
      addressLine1: true,
      city: true,
      metadata: true,
      schedules: {
        where: { ownerType: "LOCATION", isDefault: true },
        take: 1,
        select: {
          timezone: true,
          rules: {
            select: {
              weekday: true,
              startsAt: true,
              endsAt: true,
              isActive: true,
            },
          },
        },
      },
    },
  } as const;

  let locationRecord = await prisma.location.findFirst(
    tenantId ? { where: { tenantId, slug: location }, ...selectLocation } : { where: { slug: location }, ...selectLocation },
  );
  if (!locationRecord && tenantId) {
    // Fallback ohne Tenant-Filter
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, ...selectLocation });
  }

  if (!locationRecord) {
    notFound();
  }

  const effectiveTenantId = locationRecord.tenantId ?? tenantId;

  const [staffMembershipSupported, customerMembershipSupported] = await Promise.all([
    supportsStaffMemberships(prisma),
    supportsCustomerMemberships(prisma),
  ]);

  const staffScope: Prisma.StaffWhereInput = staffMembershipSupported
    ? {
        memberships: {
          some: { locationId: locationRecord.id },
        },
      }
    : {
        locationId: locationRecord.id,
      };

  const customerScope: Prisma.CustomerWhereInput = customerMembershipSupported
    ? {
        OR: [
          { locationId: locationRecord.id },
          { memberships: { some: { locationId: locationRecord.id } } },
        ],
      }
    : {
        locationId: locationRecord.id,
      };

  const [staffCodesByLocation, calendarOrderSupported] = await Promise.all([
    effectiveTenantId ? syncStundenlisteStaff(effectiveTenantId) : Promise.resolve(null),
    supportsCalendarOrder(prisma),
  ]);
  const syncedCodes = staffCodesByLocation?.[locationRecord.id] ?? null;
  const hiddenStaffIds = Array.from(getHiddenStaffByLocation().get(locationRecord.id) ?? new Set<string>());
  const staffCodeScope: Prisma.StaffWhereInput =
    syncedCodes?.length
      ? {
          OR: [
            { code: { in: syncedCodes } },
            { code: null },
            { code: "" },
            { metadata: { path: ["calendarVisible"], equals: true } },
            { metadata: { path: ["calendarVisible"], equals: "true" } },
            { metadata: { path: ["calendarVisible"], equals: 1 } },
            { metadata: { path: ["bookingDisplay", "showInCalendar"], equals: true } },
            { metadata: { path: ["bookingDisplay", "showInCalendar"], equals: "true" } },
            { metadata: { path: ["bookingDisplay", "showInCalendar"], equals: 1 } },
          ],
        }
      : {};

  if (calendarOrderSupported) {
    await ensureCalendarOrdering(prisma, locationRecord.id);
  }


  let staffRecords: Array<{
    id: string;
    firstName: string;
    lastName: string;
    displayName: string | null;
    color: string | null;
    calendarOrder: number | null;
    metadata: Prisma.JsonValue | null;
  }>;

  if (calendarOrderSupported) {
    const staffWithOrder = await prisma.staff.findMany({
      where: {
        ...staffScope,
        status: "ACTIVE",
        ...staffCodeScope,
      },
      orderBy: [{ calendarOrder: "asc" }, { displayName: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        color: true,
        calendarOrder: true,
        metadata: true,
      },
    });
    staffRecords = staffWithOrder.map((member) => ({
      ...member,
      calendarOrder: member.calendarOrder ?? null,
    }));
  } else {
    const staffWithoutOrder = await prisma.staff.findMany({
      where: {
        ...staffScope,
        status: "ACTIVE",
        ...staffCodeScope,
      },
      orderBy: [{ displayName: "asc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        displayName: true,
        color: true,
        metadata: true,
      },
    });
    staffRecords = staffWithoutOrder.map((member) => ({
      ...member,
      calendarOrder: null,
    }));
  }

  const referenceDate = week ? parseISO(week) : new Date();
  const weekStart = startOfWeek(referenceDate, { weekStartsOn: 1 });
  const weekEnd = addDays(weekStart, 7);

  const hiddenStaffSet = new Set(hiddenStaffIds);
  for (const staff of staffRecords) {
    if (metadataHidesStaff(staff.metadata, locationRecord.id)) {
      hiddenStaffSet.add(staff.id);
    }
  }

  const [services, resources, customerDirectory, timeBlockers] = await Promise.all([
    prisma.service.findMany({
      where: { locationId: locationRecord.id, status: "ACTIVE" },
      orderBy: { name: "asc" },
      include: {
        steps: {
          orderBy: { order: "asc" },
          include: {
            resources: {
              include: { resource: true },
            },
          },
        },
      },
    }),
    prisma.resource.findMany({
      where: { locationId: locationRecord.id, isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        type: true,
        color: true,
      },
    }),
    prisma.customer.findMany({
      where: customerScope,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        consents: {
          where: { type: ConsentType.COMMUNICATION },
          select: {
            scope: true,
            granted: true,
          },
        },
        _count: {
          select: { appointments: true },
        },
        appointments: {
          where: { locationId: locationRecord.id },
          orderBy: { startsAt: "desc" },
          take: 1,
          select: { startsAt: true, status: true },
        },
      },
    }),
    prisma.timeOff.findMany({
      where: {
        locationId: locationRecord.id,
        startsAt: { lt: weekEnd },
        endsAt: { gt: weekStart },
      },
      select: {
        id: true,
        staffId: true,
        startsAt: true,
        endsAt: true,
        reason: true,
        metadata: true,
      },
      orderBy: { startsAt: "asc" },
    }),
  ]);

  const locationMetadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const popularWindowDays = bookingPreferences.popularServicesWindowDays ?? 90;
  const popularityCounts = await prisma.appointmentItem.groupBy({
    by: ["serviceId"],
    where: {
      serviceId: { in: services.map((service) => service.id) },
      status: { not: AppointmentItemStatus.CANCELLED },
      appointment: {
        locationId: locationRecord.id,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        startsAt: { gte: subDays(new Date(), popularWindowDays) },
      },
    },
    _count: { serviceId: true },
  });
  const popularityById = new Map(
    popularityCounts.map((entry) => [entry.serviceId, entry._count.serviceId ?? 0]),
  );

  if (!locationRecord) {
    notFound();
  }

  const autoCompletePromise = autoCompletePastAppointments(prisma, locationRecord.id);
  const policiesPromise = loadPoliciesForLocation(locationRecord.id);

  const WEEK_ORDER: Weekday[] = [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ];

  const locationSchedule = (() => {
    const schedule = locationRecord.schedules?.[0];
    if (!schedule) return null;
    return WEEK_ORDER.map((weekday) => {
      const rule = schedule.rules.find((entry) => entry.weekday === weekday && entry.isActive);
      return {
        weekday,
        startsAt: rule?.startsAt ?? null,
        endsAt: rule?.endsAt ?? null,
      };
    });
  })();
  const assignmentRecordsPromise = (async () => {
    await autoCompletePromise;
    return prisma.appointmentItem.findMany({
      where: {
        appointment: {
          locationId: locationRecord.id,
        },
        startsAt: { gte: weekStart, lt: weekEnd },
      },
      select: {
        id: true,
        startsAt: true,
        endsAt: true,
        staffId: true,
        serviceId: true,
        service: { select: { id: true, name: true } },
        appointment: {
          select: {
            id: true,
            confirmationCode: true,
            status: true,
            source: true,
            startsAt: true,
            endsAt: true,
            note: true,
            metadata: true,
            customer: { select: { firstName: true, lastName: true, phone: true } },
          },
        },
      },
      orderBy: { startsAt: "asc" },
    });
  })();

  const [
    policies,
    assignmentRecords,
    unassignedAppointments,
    customerStats,
    newCustomers,
    upcomingCampaigns,
    recentCustomers,
    recentCampaigns,
  ] = await Promise.all([
    policiesPromise,
    assignmentRecordsPromise,
    prisma.appointment.findMany({
      where: {
        locationId: locationRecord.id,
        startsAt: { gte: weekStart, lt: weekEnd },
        items: { none: {} },
      },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        source: true,
        startsAt: true,
        endsAt: true,
        note: true,
        metadata: true,
        customer: { select: { firstName: true, lastName: true, phone: true } },
      },
      orderBy: { startsAt: "asc" },
    }),
    prisma.customer.count({ where: customerScope }),
    prisma.customer.count({
      where: {
        ...customerScope,
        createdAt: { gte: addDays(weekStart, -30) },
      },
    }),
    prisma.notification.findMany({
      where: { locationId: locationRecord.id, status: "SCHEDULED" },
      orderBy: { scheduledAt: "asc" },
      take: 3,
      select: {
        id: true,
        trigger: true,
        scheduledAt: true,
        channel: true,
        status: true,
      },
    }),
    prisma.customer.findMany({
      where: customerScope,
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        createdAt: true,
        consents: {
          select: { type: true, scope: true, granted: true, grantedAt: true },
        },
      },
    }),
    prisma.notification.findMany({
      where: { locationId: locationRecord.id, status: { in: ["SENT", "FAILED"] } },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take: 6,
      select: {
        id: true,
        trigger: true,
        channel: true,
        status: true,
        sentAt: true,
        createdAt: true,
        metadata: true,
      },
    }),
  ]);

  const policiesForClient = {
    cancellation: policies.cancellation ?? null,
    deposit: policies.deposit ?? null,
    noShow: policies.noShow ?? null,
  };

  const visibleStaffIds = new Set(staffRecords.filter((staff) => !hiddenStaffSet.has(staff.id)).map((staff) => staff.id));
  const visibleAssignments = assignmentRecords.filter((record) => {
    if (!record.staffId) {
      return true;
    }
    if (hiddenStaffSet.has(record.staffId)) {
      return false;
    }
    return visibleStaffIds.has(record.staffId);
  });
  const hiddenAssignments = assignmentRecords.filter((record) => {
    if (!record.staffId) {
      return false;
    }
    if (hiddenStaffSet.has(record.staffId)) {
      return true;
    }
    return !visibleStaffIds.has(record.staffId);
  });

  const staffOptions = staffRecords
    .slice()
    .sort((a, b) => {
      const orderA = a.calendarOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.calendarOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      const nameA = (a.displayName ?? `${a.firstName} ${a.lastName}`).toLowerCase();
      const nameB = (b.displayName ?? `${b.firstName} ${b.lastName}`).toLowerCase();
      return nameA.localeCompare(nameB);
    })
    .map((staff) => ({
      id: staff.id,
      name: staff.displayName ?? `${staff.firstName} ${staff.lastName}`,
      color: staff.color ?? "#1f2937",
      hidden: hiddenStaffSet.has(staff.id),
      onlineBookable: readOnlineBookable(staff.metadata),
    }));
  const filteredStaffIds = staffQuery ? staffQuery.split(",").filter(Boolean) : [];

  const weekStartIso = weekStart.toISOString();

  const calendarAppointments = visibleAssignments.map((item) => {
    const customerName = item.appointment?.customer
      ? `${item.appointment.customer.firstName ?? ""} ${item.appointment.customer.lastName ?? ""}`
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const serviceName = item.service?.name?.trim() ?? "";
    const internalNote = getInternalNoteFromMetadata(item.appointment?.metadata ?? null);
    const isOnline = item.appointment?.source === "WEB";
    const customerPhone = item.appointment?.customer?.phone ?? null;
    const isColorRequest = readIsColorRequest(item.appointment?.metadata ?? null);
    return {
      id: item.id,
      appointmentId: item.appointment!.id,
      staffId: item.staffId ?? undefined,
      serviceId: item.serviceId ?? item.service?.id ?? undefined,
      startsAt: item.startsAt.toISOString(),
      endsAt: item.endsAt.toISOString(),
      serviceName,
      confirmationCode: item.appointment?.confirmationCode ?? "",
      customerName,
      customerPhone,
      status: item.appointment?.status ?? "PENDING",
      note: item.appointment?.note ?? null,
      internalNote,
      internalNoteIsTitle: false,
      isOnline,
      isColorRequest,
    };
  });

  const freedAssignments = hiddenAssignments.map((item) => {
    const customerName = item.appointment?.customer
      ? `${item.appointment.customer.firstName ?? ""} ${item.appointment.customer.lastName ?? ""}`
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const serviceName = item.service?.name?.trim() ?? "";
    const internalNote = getInternalNoteFromMetadata(item.appointment?.metadata ?? null);
    const isOnline = item.appointment?.source === "WEB";
    const customerPhone = item.appointment?.customer?.phone ?? null;
    const isColorRequest = readIsColorRequest(item.appointment?.metadata ?? null);
    return {
      id: item.id,
      appointmentId: item.appointment!.id,
      staffId: undefined,
      serviceId: item.serviceId ?? item.service?.id ?? undefined,
      startsAt: item.startsAt.toISOString(),
      endsAt: item.endsAt.toISOString(),
      serviceName,
      confirmationCode: item.appointment?.confirmationCode ?? "",
      customerName,
      customerPhone,
      status: item.appointment?.status ?? "PENDING",
      note: item.appointment?.note ?? null,
      internalNote,
      internalNoteIsTitle: false,
      isOnline,
      isColorRequest,
    };
  });

  const combinedAppointments = [...calendarAppointments, ...freedAssignments].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const fallbackAppointments = unassignedAppointments.map((appointment) => {
    const customerName = appointment.customer
      ? `${appointment.customer.firstName ?? ""} ${appointment.customer.lastName ?? ""}`
          .replace(/\s+/g, " ")
          .trim()
      : "";
    const metadata = appointment.metadata;
    const metadataRecord =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : null;
    const internalNote = getInternalNoteFromMetadata(metadataRecord);
    const isOnline = appointment.source === "WEB";
    const customerPhone = appointment.customer?.phone ?? null;
    const isColorRequest = readIsColorRequest(metadataRecord);
    const assignedStaffFromMetadata = Array.isArray(metadataRecord?.assignedStaffIds)
      ? (metadataRecord?.assignedStaffIds as unknown[])
          .map((value) => (typeof value === "string" && value.trim().length ? value.trim() : null))
          .filter((value): value is string => Boolean(value && value.length))
      : [];
    const candidateStaffId = assignedStaffFromMetadata[0] ?? null;
    const staffId = candidateStaffId && hiddenStaffSet.has(candidateStaffId) ? undefined : candidateStaffId ?? undefined;
    return {
      id: `fallback:${appointment.id}`,
      appointmentId: appointment.id,
      staffId,
      serviceId: undefined,
      startsAt: appointment.startsAt.toISOString(),
      endsAt: appointment.endsAt.toISOString(),
      serviceName: "",
      confirmationCode: appointment.confirmationCode ?? "",
      customerName,
      customerPhone,
      status: appointment.status ?? "PENDING",
      note: appointment.note ?? null,
      internalNote,
      internalNoteIsTitle: false,
      isOnline,
      isColorRequest,
    };
  });

  const totalAppointments = [...combinedAppointments, ...fallbackAppointments].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  const calendarServices = services.map((service) => {
    const metadata =
      service.metadata && typeof service.metadata === "object" && !Array.isArray(service.metadata)
        ? (service.metadata as Record<string, unknown>)
        : null;
    const tags = Array.isArray(metadata?.tags)
      ? metadata!.tags
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value): value is string => value.length > 0)
      : [];
    return {
      id: service.id,
      name: service.name,
      duration: service.duration,
      basePrice: Number(service.basePrice ?? 0),
      currency: service.priceCurrency ?? "EUR",
      tags,
      popularityScore: popularityById.get(service.id) ?? 0,
      steps: service.steps.map((step) => ({
        id: step.id,
        name: step.name,
        duration: step.duration,
        requiresExclusiveResource: step.requiresExclusiveResource,
        resources: step.resources.map((resource) => ({
          id: resource.id,
          resourceId: resource.resourceId,
          name: resource.resource.name,
        })),
      })),
    };
  });

  const calendarResources = resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    type: resource.type,
    color: resource.color,
  }));

  const calendarCustomers = customerDirectory.map((customer) => {
    const lastAppointment = customer.appointments[0] ?? null;
    const consentSummary = {
      email: false,
      sms: false,
      whatsapp: false,
    };
    for (const consent of customer.consents ?? []) {
      if (!consent.granted) continue;
      switch (consent.scope) {
        case "EMAIL":
          consentSummary.email = true;
          break;
        case "SMS":
          consentSummary.sms = true;
          break;
        case "WHATSAPP":
          consentSummary.whatsapp = true;
          break;
        default:
          break;
      }
    }
    return {
      id: customer.id,
      firstName: customer.firstName ?? "",
      lastName: customer.lastName ?? "",
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      appointmentCount: customer._count.appointments ?? 0,
      lastAppointment: lastAppointment?.startsAt?.toISOString() ?? null,
      lastAppointmentStatus: lastAppointment?.status ?? null,
      consents: consentSummary,
    };
  });

  const calendarBlockers = timeBlockers.map((blocker) => ({
    id: blocker.id,
    staffId: blocker.staffId ?? null,
    reason: blocker.reason ?? null,
    startsAt: blocker.startsAt.toISOString(),
    endsAt: blocker.endsAt.toISOString(),
    metadata: blocker.metadata as Record<string, unknown> | null,
  }));

  const todayIso = new Date().toISOString();
  const slotIntervalOverride = Number.parseInt(bookingPreferences.interval ?? "", 10);

  return (
    <section className="-mt-4 flex flex-col gap-6 lg:-mt-6">
      <CalendarWorkspace
        location={{
          id: locationRecord.id,
          name: locationRecord.name ?? locationRecord.slug,
          timezone: locationRecord.timezone ?? "Europe/Berlin",
          slug: locationRecord.slug,
        }}
        locationSchedule={locationSchedule}
        initialWeekStart={weekStartIso}
        staffOptions={staffOptions}
        appointments={totalAppointments}
        services={calendarServices}
        resources={calendarResources}
        customers={calendarCustomers}
        timeBlockers={calendarBlockers}
        initialDayIso={todayIso}
        initialActiveStaffIds={filteredStaffIds}
        manualConfirmationMode={bookingPreferences.manualConfirmationMode}
        slotIntervalOverride={
          Number.isFinite(slotIntervalOverride) && slotIntervalOverride > 0 ? slotIntervalOverride : undefined
        }
      />
    </section>
  );
}

type NotificationSlice = {
  channel: string;
  status: NotificationStatus;
  metadata: unknown;
};

type ChannelAnalytics = {
  channel: string;
  scheduled: number;
  sent: number;
  failed: number;
  openRate: number | null;
  clickRate: number | null;
  responseRate: number | null;
  failureRatio: number | null;
};

function summariseNotificationAnalytics(notifications: NotificationSlice[]) {
  const channelMap = new Map<
    string,
    {
      scheduled: number;
      sent: number;
      failed: number;
      openRates: number[];
      clickRates: number[];
      responseRates: number[];
    }
  >();
  const allOpenRates: number[] = [];
  const allClickRates: number[] = [];
  const allResponseRates: number[] = [];

  for (const notification of notifications) {
    const entry =
      channelMap.get(notification.channel) ??
      {
        scheduled: 0,
        sent: 0,
        failed: 0,
        openRates: [],
        clickRates: [],
        responseRates: [],
      };

    switch (notification.status) {
      case "PENDING":
      case "SCHEDULED":
        entry.scheduled += 1;
        break;
      case "SENT":
        entry.sent += 1;
        break;
      case "FAILED":
        entry.failed += 1;
        break;
      default:
        break;
    }

    const openRate = extractRate(notification.metadata, "openRate");
    if (openRate !== null) {
      entry.openRates.push(openRate);
      allOpenRates.push(openRate);
    }

    const clickRate = extractRate(notification.metadata, "clickRate");
    if (clickRate !== null) {
      entry.clickRates.push(clickRate);
      allClickRates.push(clickRate);
    }

    const responseRate = extractRate(notification.metadata, "responseRate");
    if (responseRate !== null) {
      entry.responseRates.push(responseRate);
      allResponseRates.push(responseRate);
    }

    channelMap.set(notification.channel, entry);
  }

  const channels: ChannelAnalytics[] = Array.from(channelMap.entries())
    .map(([channel, data]) => ({
      channel,
      scheduled: data.scheduled,
      sent: data.sent,
      failed: data.failed,
      openRate: data.openRates.length ? average(data.openRates) : null,
      clickRate: data.clickRates.length ? average(data.clickRates) : null,
      responseRate: data.responseRates.length ? average(data.responseRates) : null,
      failureRatio: computeRatio(data.failed, data.sent + data.scheduled + data.failed),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel));

  return {
    channels,
    averageOpenRate: allOpenRates.length ? average(allOpenRates) : null,
    averageClickRate: allClickRates.length ? average(allClickRates) : null,
    averageResponseRate: allResponseRates.length ? average(allResponseRates) : null,
  };
}

function extractRate(metadata: unknown, key: "openRate" | "clickRate" | "responseRate") {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const directValue = normalizeRate(record[key]);
  if (directValue !== null) {
    return directValue;
  }

  const metrics = record.metrics;
  if (metrics && typeof metrics === "object") {
    const nestedValue = normalizeRate((metrics as Record<string, unknown>)[key]);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function normalizeRate(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  if (value < 0) {
    return null;
  }
  if (value > 1) {
    return Math.min(value / 100, 1);
  }
  return value;
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function computeRatio(part: number, total: number) {
  if (total <= 0) {
    return null;
  }
  return part / total;
}
