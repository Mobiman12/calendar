import { Prisma, PrismaClient, ResourceType, ScheduleOwnerType, ScheduleRuleType, StaffStatus, Weekday, NotificationChannel, NotificationTrigger, NotificationStatus, PolicyType } from "@prisma/client";
import { addDays, subDays } from "date-fns";

const prisma = new PrismaClient();

const locationSlug = "mei-en";
const legacyTenantId = process.env.DEFAULT_TENANT_ID ?? "legacy";

async function ensureTenant() {
  return prisma.tenant.upsert({
    where: { id: legacyTenantId },
    update: { name: "Legacy Tenant" },
    create: {
      id: legacyTenantId,
      name: "Legacy Tenant",
    },
  });
}

async function upsertLocation() {
  return prisma.location.upsert({
    where: { tenantId_slug: { tenantId: legacyTenantId, slug: locationSlug } },
    update: {
      name: "murmel creation meissen",
      phone: "+49 3521 413433",
      email: "office@murmel-creation.de",
      addressLine1: "Neugasse 13",
      city: "Meißen",
      country: "DE",
      timezone: "Europe/Berlin",
      tenantId: legacyTenantId,
    },
    create: {
      slug: locationSlug,
      name: "murmel creation meissen",
      phone: "+49 3521 413433",
      email: "office@murmel-creation.de",
      addressLine1: "Neugasse 13",
      city: "Meißen",
      country: "DE",
      timezone: "Europe/Berlin",
      tenantId: legacyTenantId,
    },
  });
}

async function seedResources(locationId: string) {
  const resources = [
    { code: "CHAIR-1", name: "Styling Chair 1", type: ResourceType.CHAIR, capacity: 1, color: "#F87171" },
    { code: "CHAIR-2", name: "Styling Chair 2", type: ResourceType.CHAIR, capacity: 1, color: "#60A5FA" },
    { code: "WASH-1", name: "Wash Basin", type: ResourceType.BASIN, capacity: 1, color: "#34D399" },
  ];

  await Promise.all(
    resources.map((resource) =>
      prisma.resource.upsert({
        where: { locationId_code: { locationId, code: resource.code } },
        update: {
          name: resource.name,
          type: resource.type,
          capacity: resource.capacity,
          color: resource.color,
          isActive: true,
        },
        create: { ...resource, locationId },
      })
    )
  );
}

async function seedStaff(locationId: string) {
  // Wenn bereits Staff existiert, nichts anlegen (schützt echte Daten).
  const existingCount = await prisma.staff.count({ where: { locationId } });
  if (existingCount > 0) {
    return;
  }

  const staffMembers = [
    {
      code: "EMP-01",
      firstName: "Lina",
      lastName: "Schmidt",
      displayName: "Lina",
      email: "lina@citycentersalon.example",
      color: "#F59E0B",
      status: StaffStatus.ACTIVE,
    },
    {
      code: "EMP-02",
      firstName: "Marco",
      lastName: "Becker",
      displayName: "Marco",
      email: "marco@citycentersalon.example",
      color: "#10B981",
      status: StaffStatus.ACTIVE,
    },
    {
      code: "EMP-03",
      firstName: "Sara",
      lastName: "Nguyen",
      displayName: "Sara",
      email: "sara@citycentersalon.example",
      color: "#6366F1",
      status: StaffStatus.ACTIVE,
    },
  ];

  await Promise.all(
    staffMembers.map(async (staff, index) => {
      const record = await prisma.staff.upsert({
        where: { code: staff.code },
        update: {
          ...staff,
          calendarOrder: index,
          locationId,
        },
        create: {
          ...staff,
          calendarOrder: index,
          locationId,
        },
      });

      await prisma.staffLocationMembership.upsert({
        where: {
          staffId_locationId: {
            staffId: record.id,
            locationId,
          },
        },
        update: {
          role: null,
        },
        create: {
          staffId: record.id,
          locationId,
        },
      });
    })
  );
}

type ServiceSeed = {
  name: string;
  slug: string;
  description: string;
  duration: number;
  basePrice: Prisma.Decimal;
  bufferBefore?: number;
  bufferAfter?: number;
  steps: Array<{
    name: string;
    description?: string;
    duration: number;
    requiresExclusiveResource?: boolean;
  }>;
  categorySlug: string;
};

async function seedServiceCategories(locationId: string) {
  const categories = [
    { name: "Herren", slug: "herren", description: "Leistungen für Herren" },
    { name: "Damen", slug: "damen", description: "Leistungen für Damen" },
    { name: "Coloration", slug: "coloration", description: "Farb- und Tönungsservices" },
    { name: "Styling", slug: "styling", description: "Styling und Events" },
    { name: "Pflege", slug: "pflege", description: "Pflege- und Treatment-Angebote" },
  ];

  const records = await Promise.all(
    categories.map((category) =>
      prisma.serviceCategory.upsert({
        where: {
          locationId_slug: {
            locationId,
            slug: category.slug,
          },
        },
        update: {
          name: category.name,
          description: category.description,
        },
        create: {
          locationId,
          name: category.name,
          slug: category.slug,
          description: category.description,
        },
      }),
    ),
  );

  const map = new Map<string, string>();
  for (const entry of records) {
    map.set(entry.slug, entry.id);
  }
  return map;
}

async function seedServices(locationId: string) {
  const categoryMap = await seedServiceCategories(locationId);
  const services: ServiceSeed[] = [
    {
      name: "Classic Haircut",
      slug: "classic-haircut",
      description: "Waschen, Schneiden, Föhnen für Kurzhaarschnitte.",
      duration: 45,
      basePrice: new Prisma.Decimal("38.00"),
      bufferAfter: 5,
      steps: [
        { name: "Consultation", duration: 10 },
        { name: "Cut & Style", duration: 30, requiresExclusiveResource: true },
        { name: "Finish", duration: 10 },
      ],
      categorySlug: "damen",
    },
    {
      name: "Deluxe Color",
      slug: "deluxe-color",
      description: "Intensivtönung inkl. Pflege und Styling.",
      duration: 120,
      basePrice: new Prisma.Decimal("120.00"),
      bufferAfter: 10,
      steps: [
        { name: "Color Consultation", duration: 15 },
        { name: "Color Application", duration: 45, requiresExclusiveResource: true },
        { name: "Processing", duration: 30 },
        { name: "Wash & Style", duration: 30, requiresExclusiveResource: true },
      ],
      categorySlug: "coloration",
    },
    {
      name: "Balayage Package",
      slug: "balayage-package",
      description: "Balayage Technik inkl. Glossing und Styling.",
      duration: 180,
      basePrice: new Prisma.Decimal("240.00"),
      bufferBefore: 10,
      bufferAfter: 15,
      steps: [
        { name: "Consultation", duration: 15 },
        { name: "Lightening", duration: 60, requiresExclusiveResource: true },
        { name: "Processing", duration: 45 },
        { name: "Toner & Wash", duration: 30, requiresExclusiveResource: true },
        { name: "Cut & Style", duration: 45, requiresExclusiveResource: true },
      ],
      categorySlug: "coloration",
    },
    {
      name: "Gentlemen Cut",
      slug: "gentlemen-cut",
      description: "Haarschnitt und Styling für Herren, inkl. Kopfmassage.",
      duration: 40,
      basePrice: new Prisma.Decimal("32.00"),
      bufferAfter: 5,
      steps: [
        { name: "Wash & Massage", duration: 10 },
        { name: "Cut & Style", duration: 25, requiresExclusiveResource: true },
        { name: "Finish", duration: 5 },
      ],
      categorySlug: "herren",
    },
    {
      name: "Express Styling",
      slug: "express-styling",
      description: "Styling für Zwischendurch, z. B. für Events.",
      duration: 30,
      basePrice: new Prisma.Decimal("28.00"),
      steps: [
        { name: "Style Prep", duration: 10 },
        { name: "Heat Styling", duration: 15, requiresExclusiveResource: true },
        { name: "Finishing Touch", duration: 5 },
      ],
      categorySlug: "styling",
    },
    {
      name: "Keratin Treatment",
      slug: "keratin-treatment",
      description: "Glättung mit Keratin inkl. Nachbehandlung.",
      duration: 150,
      basePrice: new Prisma.Decimal("199.00"),
      bufferAfter: 15,
      steps: [
        { name: "Wash & Prep", duration: 20, requiresExclusiveResource: true },
        { name: "Keratin Application", duration: 45, requiresExclusiveResource: true },
        { name: "Processing", duration: 45 },
        { name: "Sealing & Finish", duration: 40, requiresExclusiveResource: true },
      ],
      categorySlug: "pflege",
    },
  ];

  for (const service of services) {
    const upserted = await prisma.service.upsert({
      where: {
        locationId_slug: {
          locationId,
          slug: service.slug,
        },
      },
      update: {
        name: service.name,
        description: service.description,
        duration: service.duration,
        basePrice: service.basePrice,
        bufferBefore: service.bufferBefore ?? 0,
        bufferAfter: service.bufferAfter ?? 0,
        categoryId: categoryMap.get(service.categorySlug) ?? null,
      },
      create: {
        locationId,
        name: service.name,
        slug: service.slug,
        description: service.description,
        duration: service.duration,
        basePrice: service.basePrice,
        bufferBefore: service.bufferBefore ?? 0,
        bufferAfter: service.bufferAfter ?? 0,
        categoryId: categoryMap.get(service.categorySlug) ?? null,
      },
    });

    await prisma.serviceStep.deleteMany({ where: { serviceId: upserted.id } });
    await prisma.serviceStep.createMany({
      data: service.steps.map((step, index) => ({
        serviceId: upserted.id,
        name: step.name,
        description: step.description ?? null,
        order: index + 1,
        duration: step.duration,
        requiresExclusiveResource: step.requiresExclusiveResource ?? false,
      })),
    });
  }
}

async function seedPolicies(locationId: string) {
  const policies = [
    {
      type: "CANCELLATION",
      name: "Stornierung",
      description: "Kostenlose Stornierung bis 12 Stunden vor Termin, danach 50 % des Preises.",
      configuration: {
        windowHours: 12,
        penalty: {
          kind: "percentage",
          value: 50,
        },
      },
    },
    {
      type: "NO_SHOW",
      name: "No-Show Fee",
      description: "Bei Nichterscheinen wird eine Pauschale von 25 € fällig.",
      configuration: {
        charge: {
          kind: "flat",
          value: 25,
        },
        graceMinutes: 10,
      },
    },
    {
      type: "DEPOSIT",
      name: "Anzahlung",
      description: "Für Behandlungen ab 80 € wird eine Anzahlung von 30 % fällig.",
      configuration: {
        thresholdAmount: 80,
        percentage: 30,
      },
    },
  ];

  for (const policy of policies) {
    await prisma.policy.upsert({
      where: {
        locationId_type: {
          locationId,
          type: policy.type as PolicyType,
        },
      },
      update: {
        name: policy.name,
        description: policy.description,
        isActive: true,
        configuration: policy.configuration as Prisma.InputJsonValue,
      },
      create: {
        locationId,
        type: policy.type as PolicyType,
        name: policy.name,
        description: policy.description,
        configuration: policy.configuration as Prisma.InputJsonValue,
      },
    });
  }
}

async function seedSchedules(locationId: string) {
  const scheduleName = "Salon Main Hours";
  let schedule = await prisma.schedule.findFirst({
    where: {
      locationId,
      ownerType: ScheduleOwnerType.LOCATION,
      name: scheduleName,
    },
  });

  if (!schedule) {
    schedule = await prisma.schedule.create({
      data: {
        locationId,
        ownerType: ScheduleOwnerType.LOCATION,
        name: scheduleName,
        timezone: "Europe/Berlin",
        isDefault: true,
      },
    });
  }

  await prisma.scheduleRule.deleteMany({ where: { scheduleId: schedule.id } });
  await prisma.scheduleRule.createMany({
    data: [Weekday.MONDAY, Weekday.TUESDAY, Weekday.WEDNESDAY, Weekday.THURSDAY, Weekday.FRIDAY, Weekday.SATURDAY].map(
      (weekday) => ({
        scheduleId: schedule!.id,
        ruleType: ScheduleRuleType.WEEKLY,
        weekday,
        startsAt: 9 * 60,
        endsAt: 18 * 60,
      })
    ),
  });
}

type CustomerSeed = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  createdAt: Date;
  categorySlug: string;
};

async function seedCustomerCategories(locationId: string) {
  const categories = [
    { name: "Stammkunden", slug: "stammkunden", description: "Regelmäßige Kund:innen mit hoher Loyalität." },
    { name: "Neu", slug: "neu", description: "Neu gewonnene Kund:innen ohne umfangreiche Historie." },
    { name: "VIP", slug: "vip", description: "Besonders umsatzstarke oder wichtige Kund:innen." },
  ];

  const records = await Promise.all(
    categories.map((category) =>
      prisma.customerCategory.upsert({
        where: {
          locationId_slug: {
            locationId,
            slug: category.slug,
          },
        },
        update: {
          name: category.name,
          description: category.description,
        },
        create: {
          locationId,
          name: category.name,
          slug: category.slug,
          description: category.description,
        },
      }),
    ),
  );

  const map = new Map<string, string>();
  for (const entry of records) {
    map.set(entry.slug, entry.id);
  }
  return map;
}

async function seedCustomers(locationId: string, categoryMap: Map<string, string>) {
  const now = new Date();
  const customers: CustomerSeed[] = [
    {
      id: "cust-anna-weber",
      firstName: "Anna",
      lastName: "Weber",
      email: "anna.weber@example.com",
      phone: "+49 170 1234567",
      createdAt: subDays(now, 2),
      categorySlug: "stammkunden",
    },
    {
      id: "cust-felix-wagner",
      firstName: "Felix",
      lastName: "Wagner",
      email: "felix.wagner@example.com",
      phone: "+49 151 9988776",
      createdAt: subDays(now, 14),
      categorySlug: "stammkunden",
    },
    {
      id: "cust-leonie-bauer",
      firstName: "Leonie",
      lastName: "Bauer",
      email: "leonie.bauer@example.com",
      phone: "+49 152 3344556",
      createdAt: subDays(now, 35),
      categorySlug: "neu",
    },
    {
      id: "cust-moritz-keller",
      firstName: "Moritz",
      lastName: "Keller",
      email: "moritz.keller@example.com",
      phone: "+49 160 4455667",
      createdAt: subDays(now, 65),
      categorySlug: "vip",
    },
    {
      id: "cust-selina-voigt",
      firstName: "Selina",
      lastName: "Voigt",
      email: "selina.voigt@example.com",
      phone: "+49 151 2233445",
      createdAt: subDays(now, 5),
      categorySlug: "neu",
    },
  ];

  const records = [];
  for (const customer of customers) {
    const record = await prisma.customer.upsert({
      where: { id: customer.id },
      update: {
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        locationId,
        categoryId: categoryMap.get(customer.categorySlug) ?? null,
      },
      create: {
        id: customer.id,
        locationId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        createdAt: customer.createdAt,
        categoryId: categoryMap.get(customer.categorySlug) ?? null,
      },
    });

    await prisma.customerLocationMembership.upsert({
      where: {
        customerId_locationId: {
          customerId: record.id,
          locationId,
        },
      },
      update: {},
      create: {
        customerId: record.id,
        locationId,
      },
    });

    records.push(record);
  }

  return records;
}

async function seedNotifications(locationId: string, customerIds: string[]) {
  const now = new Date();
  const [firstCustomer] = customerIds;

  const notifications: Array<Prisma.NotificationCreateInput & { id: string }> = [
    {
      id: "notif-reminder-email-upcoming",
      location: { connect: { id: locationId } },
      customer: firstCustomer ? { connect: { id: firstCustomer } } : undefined,
      channel: NotificationChannel.EMAIL,
      trigger: NotificationTrigger.APPOINTMENT_REMINDER,
      status: NotificationStatus.SCHEDULED,
      scheduledAt: addDays(now, 1),
      metadata: {
        audienceSize: 42,
        template: "reminder_v2",
      },
    },
    {
      id: "notif-weekly-newsletter",
      location: { connect: { id: locationId } },
      channel: NotificationChannel.EMAIL,
      trigger: NotificationTrigger.CUSTOM,
      status: NotificationStatus.SENT,
      sentAt: subDays(now, 3),
      metadata: {
        sentCount: 180,
        openRate: 0.62,
        clickRate: 0.19,
        responseRate: 0.12,
      },
    },
    {
      id: "notif-no-show-sms",
      location: { connect: { id: locationId } },
      channel: NotificationChannel.SMS,
      trigger: NotificationTrigger.NO_SHOW_FOLLOW_UP,
      status: NotificationStatus.SENT,
      sentAt: subDays(now, 1),
      metadata: {
        sentCount: 28,
        responseRate: 0.35,
        openRate: 0.82,
      },
    },
    {
      id: "notif-loyalty-push",
      location: { connect: { id: locationId } },
      channel: NotificationChannel.PUSH,
      trigger: NotificationTrigger.CUSTOM,
      status: NotificationStatus.SENT,
      sentAt: subDays(now, 5),
      metadata: {
        openRate: 0.54,
        clickRate: 0.21,
      },
    },
    {
      id: "notif-campaign-failed",
      location: { connect: { id: locationId } },
      channel: NotificationChannel.EMAIL,
      trigger: NotificationTrigger.CUSTOM,
      status: NotificationStatus.FAILED,
      metadata: {
        attemptedAt: subDays(now, 7).toISOString(),
        metrics: {
          openRate: 0,
          clickRate: 0,
          responseRate: 0,
        },
        error: "SMTP authentication failed",
      },
    },
  ];

  for (const notification of notifications) {
    await prisma.notification.upsert({
      where: { id: notification.id },
      update: {
        channel: notification.channel,
        trigger: notification.trigger,
        status: notification.status,
        scheduledAt: notification.scheduledAt ?? null,
        sentAt: notification.sentAt ?? null,
        metadata: notification.metadata ?? Prisma.JsonNull,
      },
      create: notification,
    });
  }
}

async function main() {
  await ensureTenant();
  const location = await upsertLocation();

  await seedResources(location.id);
  await seedStaff(location.id);
  await seedServices(location.id);
  await seedSchedules(location.id);
  await seedPolicies(location.id);
  const customerCategories = await seedCustomerCategories(location.id);
  const customers = await seedCustomers(location.id, customerCategories);
  await seedNotifications(location.id, customers.map((customer) => customer.id));

  console.log("✅ Seed data created for", location.name);
}

main()
  .catch((error) => {
    console.error("❌ Seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
