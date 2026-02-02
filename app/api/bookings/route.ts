import { NextResponse, type NextRequest } from "next/server";
import { ConsentScope, ConsentType } from "@prisma/client";
import { z } from "zod";

import { getPrismaClient } from "@/lib/prisma";
import { decodeHoldId, releaseSlotHold, verifySlotHold } from "@/lib/booking-holds";
import { resolvePermittedStaffIdsForDevice } from "@/lib/customer-booking-permissions";
import { supportsStaffMemberships } from "@/lib/staff-memberships";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { publishAppointmentSync } from "@/lib/appointment-sync";

const optionalTrimmedString = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z.string().email().optional(),
);

const MAX_ATTACHMENTS = 1;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);

const consentSchema = z.object({
  type: z.nativeEnum(ConsentType),
  scope: z.nativeEnum(ConsentScope),
  granted: z.boolean(),
});

const payloadSchema = z
  .object({
    slotId: z.string().min(1),
    holdId: z.string().min(1).optional(),
    serviceId: z.string().min(1).optional(),
    serviceIds: z.array(z.string().min(1)).optional(),
    staffId: z.string().optional(),
    deviceId: z.string().uuid().optional(),
    customer: z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      phone: optionalTrimmedString,
      email: optionalEmail,
    }),
    consents: z.array(consentSchema).optional().default([]),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((payload, ctx) => {
    if (!payload.serviceId && (!payload.serviceIds || payload.serviceIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bitte wähle mindestens eine Leistung aus.",
        path: ["serviceId"],
      });
    }
    if (!payload.customer.email || !payload.customer.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Bitte gib eine Telefonnummer und eine E-Mail-Adresse an.",
        path: ["customer", "email"],
      });
    }
  });

type SlotPayload = {
  slotKey: string;
  locationId: string;
  staffId: string;
  start: string;
  end: string;
  reservedFrom?: string;
  reservedTo?: string;
  service?: {
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  };
  services?: Array<{
    serviceId: string;
    steps: Array<{
      stepId: string;
      start: string;
      end: string;
      requiresStaff: boolean;
      resourceIds: string[];
    }>;
  }>;
};

type ServiceMetadata = {
  onlineBookable?: boolean;
  assignedStaffIds?: unknown;
};

const prisma = getPrismaClient();

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  let rawPayload: unknown = null;
  let attachments: File[] = [];

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData().catch(() => null);
    if (formData) {
      const payloadField = formData.get("payload");
      try {
        if (typeof payloadField === "string") {
          rawPayload = JSON.parse(payloadField);
        } else if (payloadField instanceof File) {
          rawPayload = JSON.parse(await payloadField.text());
        }
      } catch {
        rawPayload = null;
      }
      attachments = formData
        .getAll("attachments")
        .filter((attachment): attachment is File => attachment instanceof File)
        .slice(0, MAX_ATTACHMENTS);
    }
  } else {
    rawPayload = await request.json().catch(() => null);
  }

  for (const file of attachments) {
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json({ error: `Ungültiger Dateityp: ${file.name}` }, { status: 400 });
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: `Datei zu groß: ${file.name}` }, { status: 400 });
    }
  }

  const parseResult = payloadSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: "Invalid payload",
        details: parseResult.error.issues.map((issue) => issue.message),
      },
      { status: 400 },
    );
  }

  const headerDeviceId = request.headers.get("x-device-id") ?? undefined;
  const rawHeaderDeviceId = typeof headerDeviceId === "string" ? headerDeviceId.trim() : undefined;
  const isValidHeaderDeviceId = rawHeaderDeviceId ? isUuid(rawHeaderDeviceId) : false;
  const deviceId = parseResult.data.deviceId ?? (isValidHeaderDeviceId ? rawHeaderDeviceId : undefined);
  const { slotId, holdId, serviceId, serviceIds, staffId, customer, consents, metadata } = parseResult.data;
  const requestedServices = (serviceIds && serviceIds.length > 0 ? serviceIds : serviceId ? [serviceId] : []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const uniqueServices: string[] = [];
  for (const id of requestedServices) {
    if (!uniqueServices.includes(id)) uniqueServices.push(id);
  }
  if (!uniqueServices.length) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }
  const hasTermsConsent = consents.some((consent) => consent.type === "TERMS" && consent.granted);
  const hasPrivacyConsent = consents.some((consent) => consent.type === "PRIVACY" && consent.granted);
  if (!hasTermsConsent || !hasPrivacyConsent) {
    return NextResponse.json({ error: "AGB und Datenschutzrichtlinien müssen akzeptiert werden." }, { status: 400 });
  }
  const decoded = decodeSlotId(slotId);
  if (!decoded) {
    return NextResponse.json({ error: "Invalid slot" }, { status: 400 });
  }
  const holdIdentity = holdId ? decodeHoldId(holdId) : null;
  if (holdId && !holdIdentity) {
    return NextResponse.json({ error: "Invalid hold" }, { status: 400 });
  }
  if (holdIdentity && holdIdentity.slotKey !== decoded.slotKey) {
    return NextResponse.json({ error: "Hold does not match slot" }, { status: 400 });
  }
  if (holdIdentity) {
    const valid = await verifySlotHold(holdIdentity.slotKey, holdIdentity.token);
    if (!valid) {
      return NextResponse.json({ error: "Reservierung abgelaufen. Bitte neu wählen." }, { status: 409 });
    }
  }
  if (staffId && decoded.staffId !== staffId) {
    return NextResponse.json({ error: "Slot does not match staff" }, { status: 400 });
  }

  const locationRecord = await prisma.location.findUnique({
    where: { id: decoded.locationId },
    select: {
      id: true,
      slug: true,
      tenantId: true,
      metadata: true,
    },
  });
  if (!locationRecord) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const locationMetadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const maxServicesPerBooking = Math.max(1, Math.min(bookingPreferences.servicesPerBooking ?? 1, 10));
  if (uniqueServices.length > maxServicesPerBooking) {
    return NextResponse.json({ error: "Zu viele Leistungen ausgewählt." }, { status: 400 });
  }

  const serviceRecords = await prisma.service.findMany({
    where: {
      id: { in: uniqueServices },
      locationId: locationRecord.id,
      status: "ACTIVE",
    },
    select: {
      id: true,
      basePrice: true,
      priceCurrency: true,
      metadata: true,
    },
  });
  if (serviceRecords.length !== uniqueServices.length) {
    return NextResponse.json({ error: "Service not found" }, { status: 404 });
  }

  const assignedStaffLists = serviceRecords.map((record) => {
    const metadata = record.metadata as ServiceMetadata | null;
    return {
      onlineBookable: resolveOnlineBookable(metadata),
      assignedStaffIds: resolveAssignedStaffIds(metadata),
    };
  });
  if (assignedStaffLists.some((entry) => !entry.onlineBookable || entry.assignedStaffIds.length === 0)) {
    return NextResponse.json({ error: "Service not available for online booking" }, { status: 400 });
  }

  let allowedStaffIds = new Set(assignedStaffLists[0]?.assignedStaffIds ?? []);
  for (const entry of assignedStaffLists.slice(1)) {
    allowedStaffIds = new Set([...allowedStaffIds].filter((id) => entry.assignedStaffIds.includes(id)));
  }
  if (!allowedStaffIds.has(decoded.staffId)) {
    return NextResponse.json({ error: "Slot does not match service staff" }, { status: 400 });
  }
  if (staffId && !allowedStaffIds.has(staffId)) {
    return NextResponse.json({ error: "Staff not available for this service" }, { status: 400 });
  }

  const staffMembershipSupported = await supportsStaffMemberships(prisma);
  const staffRecord = await prisma.staff.findFirst({
    where: staffMembershipSupported
      ? {
          id: decoded.staffId,
          status: "ACTIVE",
          memberships: { some: { locationId: locationRecord.id } },
        }
      : {
          id: decoded.staffId,
          status: "ACTIVE",
          locationId: locationRecord.id,
        },
    select: {
      id: true,
      metadata: true,
    },
  });
  if (!staffRecord) {
    return NextResponse.json({ error: "Staff not found for this location" }, { status: 400 });
  }
  const staffMetadata = staffRecord.metadata;
  if (staffMetadata && typeof staffMetadata === "object" && !Array.isArray(staffMetadata)) {
    const onlineBookingEnabled = (staffMetadata as Record<string, unknown>).onlineBookingEnabled;
    if (typeof onlineBookingEnabled === "boolean" && !onlineBookingEnabled) {
      const { staffIds: permittedStaffIds } = await resolvePermittedStaffIdsForDevice({
        deviceId,
        locationId: locationRecord.id,
        prisma,
      });
      if (!permittedStaffIds.includes(decoded.staffId)) {
        return NextResponse.json({ error: "Staff not available for online booking" }, { status: 403 });
      }
    }
  }

  const slotServices = decoded.services && decoded.services.length > 0 ? decoded.services : decoded.service ? [decoded.service] : [];
  const slotServiceIds = new Set(slotServices.map((service) => service.serviceId));
  for (const serviceId of uniqueServices) {
    if (!slotServiceIds.has(serviceId)) {
      return NextResponse.json({ error: "Slot does not match service" }, { status: 400 });
    }
  }

  const serviceById = new Map(serviceRecords.map((record) => [record.id, record]));
  const assignmentById = new Map(slotServices.map((service) => [service.serviceId, service]));
  const requestedServicesPayload = uniqueServices
    .map((serviceId) => {
      const record = serviceById.get(serviceId);
      const assignment = assignmentById.get(serviceId);
      if (!record || !assignment) return null;
      return {
        serviceId: record.id,
        price: record.basePrice ? Number(record.basePrice) : 0,
        currency: record.priceCurrency ?? "EUR",
        steps: assignment.steps ?? [],
      };
    })
    .filter((service): service is NonNullable<typeof service> => Boolean(service));
  if (requestedServicesPayload.length !== uniqueServices.length) {
    return NextResponse.json({ error: "Slot does not match service" }, { status: 400 });
  }

  const checkoutPayload = {
    slotKey: decoded.slotKey,
    window: {
      from: decoded.reservedFrom ?? decoded.start,
      to: decoded.reservedTo ?? decoded.end,
    },
    staffId: decoded.staffId,
    deviceId,
    services: requestedServicesPayload,
    customer: {
      firstName: customer.firstName.trim(),
      lastName: customer.lastName.trim(),
      email: customer.email ?? undefined,
      phone: customer.phone ?? undefined,
    },
    consents,
    metadata: metadata ?? undefined,
  };

  const basePath = `/book/${locationRecord.tenantId}/${locationRecord.slug}`;
  const url = new URL(`${basePath}/checkout`, request.url);

  const headers = new Headers({ "Content-Type": "application/json" });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    headers.set("idempotency-key", idempotencyKey);
  }
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    headers.set("x-forwarded-for", forwardedFor);
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    headers.set("x-real-ip", realIp);
  }
  const userAgent = request.headers.get("user-agent");
  if (userAgent) {
    headers.set("user-agent", userAgent);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(checkoutPayload),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));

  if (response.ok && holdIdentity) {
    await releaseSlotHold(holdIdentity.slotKey, holdIdentity.token);
  }

  if (response.ok && attachments.length > 0) {
    const appointmentId = payload?.data?.appointmentId;
    if (typeof appointmentId === "string" && appointmentId.length > 0) {
      try {
        for (const file of attachments) {
          const arrayBuffer = await file.arrayBuffer();
          await prisma.appointmentAttachment.create({
            data: {
              appointmentId,
              locationId: locationRecord.id,
              fileName: file.name,
              mimeType: file.type,
              size: file.size,
              data: Buffer.from(arrayBuffer),
            },
          });
        }
      } catch (error) {
        console.warn("[bookings] attachment upload failed", error);
      }
    }
  }

  if (response.ok) {
    const appointmentId = payload?.data?.appointmentId;
    const appointmentIds = Array.isArray(payload?.data?.appointmentIds) ? payload.data.appointmentIds : undefined;
    try {
      await publishAppointmentSync({
        locationId: locationRecord.id,
        action: "created",
        appointmentId: typeof appointmentId === "string" ? appointmentId : undefined,
        appointmentIds,
        timestamp: Date.now(),
      });
    } catch (error) {
      console.warn("[bookings] appointment sync failed", error);
    }
  }

  return NextResponse.json(payload, { status: response.status });
}

function decodeSlotId(value: string): SlotPayload | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    return JSON.parse(json) as SlotPayload;
  } catch {
    return null;
  }
}

function resolveOnlineBookable(metadata: ServiceMetadata | null): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  const value = metadata.onlineBookable;
  return typeof value === "boolean" ? value : true;
}

function resolveAssignedStaffIds(metadata: ServiceMetadata | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = metadata.assignedStaffIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
