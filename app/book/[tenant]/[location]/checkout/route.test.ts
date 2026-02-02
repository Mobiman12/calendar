import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const availabilitySlotsRef: { current: any[] } = { current: [] };

type BookingSlotClaimRecord = {
  locationId: string;
  slotKey: string;
  idempotencyKey: string | null;
  status: string;
  expiresAt: Date;
};

type AppointmentRecord = {
  id: string;
  locationId: string;
  idempotencyKey: string | null;
  confirmationCode: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  metadata: Prisma.JsonValue | null;
  customerId: string | null;
};

function createMockPrisma() {
  let appointmentSeq = 1;
  const claims = new Map<string, BookingSlotClaimRecord>();
  const appointments = new Map<string, AppointmentRecord>();
  let appointmentFindFirstQueue: Array<AppointmentRecord | null> | null = null;
  let appointmentItemFindFirstArgs: any = null;

  const locationRecord = {
    id: "loc-1",
    slug: "meissen",
    name: "Murmel",
    tenantId: "tenant-1",
    timezone: "Europe/Berlin",
    metadata: {},
    addressLine1: "Street 1",
    city: "Meissen",
    tenant: { name: "Tenant" },
  };

  const services = [
    {
      id: "svc-1",
      name: "Service A",
      steps: [],
    },
  ];

  const staff = [
    {
      id: "staff-1",
      locationId: "loc-1",
      firstName: "Staff",
      lastName: "One",
      displayName: "Staff One",
      email: "staff@example.com",
      code: "S1",
      metadata: null,
    },
  ];

  function reset() {
    appointmentSeq = 1;
    claims.clear();
    appointments.clear();
    appointmentFindFirstQueue = null;
    appointmentItemFindFirstArgs = null;
  }

  function uniqueError(target: string[]) {
    return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.18.0",
      meta: { target },
    });
  }

  const prisma = {
    __reset: reset,
    __seedAppointment: (record: AppointmentRecord) => {
      appointments.set(record.id, record);
    },
    __setAppointmentFindFirstQueue: (queue: Array<AppointmentRecord | null>) => {
      appointmentFindFirstQueue = [...queue];
    },
    __getAppointmentItemFindFirstArgs: () => appointmentItemFindFirstArgs,
    $transaction: async (fn: any) => fn(prisma),
    location: {
      findFirst: async () => locationRecord,
    },
    service: {
      findMany: async () => services,
    },
    staff: {
      findMany: async () => staff,
    },
    timeOff: {
      findMany: async () => [],
    },
    resource: {
      findMany: async () => [],
    },
    availabilityException: {
      findMany: async () => [],
    },
    schedule: {
      findMany: async () => [],
    },
    appointmentItem: {
      findMany: async () => [],
      findFirst: async (args: any) => {
        appointmentItemFindFirstArgs = args;
        return null;
      },
    },
    bookingSlotClaim: {
      deleteMany: async ({ where }: any) => {
        const cutoff = where?.expiresAt?.lt as Date | undefined;
        if (!cutoff) return { count: 0 };
        let removed = 0;
        for (const [key, claim] of claims.entries()) {
          if (claim.locationId === where.locationId && claim.expiresAt < cutoff) {
            claims.delete(key);
            removed += 1;
          }
        }
        return { count: removed };
      },
      create: async ({ data }: any) => {
        const key = `${data.locationId}:${data.slotKey}`;
        if (claims.has(key)) {
          throw uniqueError(["locationId", "slotKey"]);
        }
        claims.set(key, {
          locationId: data.locationId,
          slotKey: data.slotKey,
          idempotencyKey: data.idempotencyKey ?? null,
          status: data.status,
          expiresAt: data.expiresAt,
        });
        return claims.get(key);
      },
      update: async ({ where, data }: any) => {
        const key = `${where.locationId_slotKey.locationId}:${where.locationId_slotKey.slotKey}`;
        const existing = claims.get(key);
        if (!existing) return null;
        const updated = { ...existing, ...data };
        claims.set(key, updated);
        return updated;
      },
    },
    customer: {
      findFirst: async () => null,
      update: async () => null,
    },
    appointment: {
      create: async ({ data }: any) => {
        if (data.idempotencyKey) {
          const duplicate = Array.from(appointments.values()).find(
            (appt) =>
              appt.locationId === data.location.connect.id && appt.idempotencyKey === data.idempotencyKey,
          );
          if (duplicate) {
            throw uniqueError(["locationId", "idempotencyKey"]);
          }
        }
        const id = `appt-${appointmentSeq++}`;
        let customerId = data.customer?.connect?.id ?? null;
        if (!customerId && data.customer?.create) {
          customerId = `cust-${appointmentSeq}`;
        }
        const record: AppointmentRecord = {
          id,
          locationId: data.location.connect.id,
          idempotencyKey: data.idempotencyKey ?? null,
          confirmationCode: data.confirmationCode,
          startsAt: data.startsAt,
          endsAt: data.endsAt,
          status: data.status,
          metadata: data.metadata ?? null,
          customerId,
        };
        appointments.set(id, record);
        return record;
      },
      findFirst: async ({ where }: any) => {
        if (appointmentFindFirstQueue && appointmentFindFirstQueue.length) {
          return appointmentFindFirstQueue.shift() ?? null;
        }
        if (!where?.idempotencyKey) return null;
        return (
          Array.from(appointments.values()).find(
            (appt) =>
              appt.locationId === where.locationId && appt.idempotencyKey === where.idempotencyKey,
          ) ?? null
        );
      },
      update: async ({ where, data }: any) => {
        const existing = appointments.get(where.id);
        if (!existing) return null;
        const updated = { ...existing, ...data };
        appointments.set(where.id, updated);
        return updated;
      },
    },
    customerDevice: {
      upsert: async () => null,
    },
    consent: {
      findMany: async () => [],
      update: async () => null,
      create: async () => null,
    },
  };

  return prisma;
}

const prismaRef = createMockPrisma();

vi.mock("@/lib/prisma", () => ({
  getPrismaClient: () => prismaRef,
}));

vi.mock("@/lib/availability", () => ({
  findAvailability: vi.fn(async () => availabilitySlotsRef.current),
}));

vi.mock("@/lib/availability/request-builder", () => ({
  buildAvailabilityRequest: (params: any) => params,
}));

vi.mock("@/lib/availability/cache", () => ({
  makeAvailabilityCacheKey: () => "availability-cache-key",
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => null,
}));

vi.mock("@/lib/notifications/ics", () => ({
  createIcsEvent: () => "ics",
}));

vi.mock("@/lib/notifications/templates", () => ({
  renderBookingConfirmation: () => ({ subject: "subject", text: "text", html: "<p>ok</p>" }),
  renderBookingRequest: () => ({ subject: "subject", text: "text", html: "<p>ok</p>" }),
}));

vi.mock("@/lib/notifications/mailer", () => ({
  createMailer: async () => ({
    sendBookingConfirmation: vi.fn(),
  }),
}));

vi.mock("@/lib/policies", () => ({
  loadPoliciesForLocation: async () => ({ deposit: null, cancellation: null, noShow: null }),
  calculateDepositAmount: () => null,
}));

vi.mock("@/lib/notifications/reminders", () => ({
  scheduleAppointmentReminders: async () => null,
}));

vi.mock("@/lib/notifications/sms", () => ({
  isSmsConfigured: () => false,
  isWhatsappConfigured: () => false,
  sendSms: async () => ({ ok: false }),
}));

vi.mock("@/lib/notifications/whatsapp", () => ({
  sendWhatsAppNotification: async () => ({ ok: false }),
}));

vi.mock("@/lib/audit/logger", () => ({
  logAuditEvent: async () => null,
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: async () => ({ allowed: true }),
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock("@/lib/circuit-breaker", () => ({
  executeWithCircuitBreaker: async (_key: string, fn: any) => fn(),
}));

vi.mock("@/lib/staff-memberships", () => ({
  supportsStaffMemberships: async () => false,
}));

vi.mock("@/lib/shift-plan-client", () => ({
  getShiftPlanClient: () => null,
  resolveShiftPlanStaffIdWithLookup: async () => null,
}));

vi.mock("@/lib/booking-preferences", () => ({
  bookingLimitToMinutes: () => 0,
  deriveBookingPreferences: () => ({
    onlineBookingEnabled: true,
    autoConfirm: false,
    shiftPlan: false,
    interval: "15",
    smartSlotsEnabled: false,
    stepEngineMin: 5,
    bufferMin: 0,
    minGapMin: 10,
    maxSmartSlotsPerHour: 1,
    minWasteReductionMin: 10,
    maxOffGridOffsetMin: 10,
    minAdvance: "0",
    maxAdvance: "0",
    emailSenderName: "",
    emailReplyToEnabled: false,
    emailReplyTo: "",
    smsBrandName: "",
    smsSenderName: "",
  }),
}));

vi.mock("@/lib/booking-tenant", () => ({
  resolveBookingTenant: async () => ({ tenantId: "tenant-1" }),
}));

vi.mock("@/lib/appointments/access-tokens", () => ({
  buildAppointmentManageUrl: () => "http://localhost/manage",
  buildAppointmentSmsUrl: () => "http://localhost/sms",
  createAppointmentAccessToken: async () => ({ token: "token", tokenHash: "hash", shortCode: "short" }),
}));

vi.mock("@/lib/appointments/cancellation", () => ({
  resolveCancellationDeadline: () => null,
}));

vi.mock("@/lib/tenant", () => ({
  resolveTenantName: async () => "Tenant",
}));

vi.mock("@/lib/consent-method", () => ({
  CONSENT_METHOD_ONLINE: "online",
  normalizeConsentMethod: (value: any) => value,
}));

vi.mock("@/lib/availability/intervals", () => ({
  buildScheduleIntervals: () => [],
}));

vi.mock("@/lib/customer-booking-permissions", () => ({
  resolvePermittedStaffIdsForDevice: async () => ({ staffIds: [] }),
}));

vi.mock("@/lib/customer-metadata", () => ({
  applyCustomerProfile: (metadata: any) => metadata,
}));

vi.mock("@/lib/color-consultation", () => ({
  extractColorMetadata: () => ({ request: null, precheck: null }),
}));

vi.mock("@/lib/notifications/phone", () => ({
  normalizePhoneNumber: (value: string) => value,
}));

vi.mock("@/lib/notifications/notification-preferences", () => ({
  resolveNotificationPreferences: () => ({
    emailSenderName: "Sender",
    emailReplyTo: null,
    smsBrandName: null,
    smsSenderName: null,
  }),
}));

let postHandler: ((request: Request, context: { params: Promise<{ tenant: string; location: string }> }) => Promise<Response>) | null =
  null;

async function getPostHandler() {
  if (!postHandler) {
    const mod = await import("./route");
    postHandler = mod.POST;
  }
  return postHandler;
}

function buildPayload(
  slotKey: string,
  options?: { slotStaffId?: string; payloadStaffId?: string; includeAvailability?: boolean },
) {
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const slotStaffId = options?.slotStaffId ?? "staff-1";
  if (options?.includeAvailability === false) {
    availabilitySlotsRef.current = [];
  } else {
    availabilitySlotsRef.current = [
      {
        slotKey,
        staffId: slotStaffId,
        start,
        end,
        reservedFrom: start,
        reservedTo: end,
        services: [
          {
            serviceId: "svc-1",
            steps: [
              {
                stepId: "step-1",
                start,
                end,
                requiresStaff: true,
                resourceIds: [],
                staffId: slotStaffId,
              },
            ],
          },
        ],
      },
    ];
  }

  return {
    slotKey,
    window: { from: start.toISOString(), to: end.toISOString() },
    staffId: options?.payloadStaffId ?? "staff-1",
    services: [
      {
        serviceId: "svc-1",
        price: 10,
        currency: "EUR",
        steps: [
          {
            stepId: "step-1",
            start: start.toISOString(),
            end: end.toISOString(),
            requiresStaff: true,
            resourceIds: [],
          },
        ],
      },
    ],
    customer: {
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
      phone: "+49123456789",
    },
    consents: [
      {
        type: "TERMS",
        scope: "EMAIL",
        granted: true,
      },
    ],
  };
}

async function callCheckout(payload: any, idempotencyKey?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey) {
    headers.set("idempotency-key", idempotencyKey);
  }
  const request = new Request("http://localhost/book/tenant/meissen/checkout", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const handler = await getPostHandler();
  return handler(request as any, { params: Promise.resolve({ tenant: "tenant", location: "meissen" }) });
}

describe("checkout route (db claim + idempotency)", () => {
  beforeEach(() => {
    prismaRef.__reset();
  });

  it("allows only one booking per slot under concurrent attempts", async () => {
    const payload = buildPayload("slot-1");
    const [resA, resB] = await Promise.all([callCheckout(payload), callCheckout(payload)]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("rejects booking when slotKey is not found (no synthetic slot)", async () => {
    const payload = buildPayload("slot-missing", { includeAvailability: false });
    const res = await callCheckout(payload);
    expect(res.status).toBe(409);
  });

  it("returns idempotent success when claim conflicts and appointment exists", async () => {
    const payload = buildPayload("slot-claim-conflict");
    const existingAppointment = {
      id: "appt-existing",
      locationId: "loc-1",
      idempotencyKey: "idem-conflict",
      confirmationCode: "ABC123",
      startsAt: new Date(payload.window.from),
      endsAt: new Date(payload.window.to),
      status: "CONFIRMED",
      metadata: null,
      customerId: null,
    };
    prismaRef.__seedAppointment(existingAppointment);
    prismaRef.__setAppointmentFindFirstQueue([null, existingAppointment]);
    await prismaRef.bookingSlotClaim.create({
      data: {
        locationId: "loc-1",
        slotKey: payload.slotKey,
        idempotencyKey: "idem-conflict",
        status: "HELD",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await callCheckout(payload, "idem-conflict");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.appointmentId).toBe(existingAppointment.id);
  });

  it("replays the same booking for the same idempotency key", async () => {
    const payload = buildPayload("slot-2");
    const first = await callCheckout(payload, "idem-1");
    const firstBody = await first.json();
    const second = await callCheckout(payload, "idem-1");
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody.data.appointmentId).toBe(firstBody.data.appointmentId);
    expect(secondBody.data.confirmationCode).toBe(firstBody.data.confirmationCode);
  });

  it("ignores payload.staffId and uses slot staffId for overlap checks", async () => {
    const payload = buildPayload("slot-staff", { slotStaffId: "staff-2", payloadStaffId: "staff-1" });
    const res = await callCheckout(payload);
    expect(res.status).toBe(200);
    const args = prismaRef.__getAppointmentItemFindFirstArgs();
    expect(args?.where?.staffId).toBe("staff-2");
  });
});
