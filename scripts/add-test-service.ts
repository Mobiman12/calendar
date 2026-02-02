import { PrismaClient, ServiceStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const locationSlug = process.argv[2] ?? "city-center-salon";
  const location = await prisma.location.findUnique({
    where: { slug: locationSlug },
    select: { id: true, name: true },
  });

  if (!location) {
    throw new Error(`Standort mit Slug "${locationSlug}" wurde nicht gefunden.`);
  }

  const name = "Test Service";
  const slug = "test-service";

  const service = await prisma.service.upsert({
    where: {
      locationId_slug: {
        locationId: location.id,
        slug,
      },
    },
    update: {
      name,
      description: "Manueller Testservice",
      duration: 45,
      basePrice: 49.9,
      status: ServiceStatus.ACTIVE,
      steps: {
        deleteMany: {},
        create: [
          {
            name: "Behandlung",
            order: 0,
            duration: 45,
          },
        ],
      },
    },
    create: {
      locationId: location.id,
      name,
      slug,
      description: "Manueller Testservice",
      duration: 45,
      basePrice: 49.9,
      status: ServiceStatus.ACTIVE,
      steps: {
        create: [
          {
            name: "Behandlung",
            order: 0,
            duration: 45,
          },
        ],
      },
    },
  });

  console.log(`✅ Service "${service.name}" ist bereit für Tests.`);
}

main()
  .catch((error) => {
    console.error("❌ Fehler beim Anlegen des Test-Services", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
