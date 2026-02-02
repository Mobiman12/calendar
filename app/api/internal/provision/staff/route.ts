import { NextResponse } from "next/server";
import { getPrismaClient } from "@/lib/prisma";

const prisma = getPrismaClient();

function assertSecret(headers: Headers) {
  const secret = process.env.PROVISION_SECRET;
  const incoming = headers.get("x-provision-secret");
  return Boolean(secret && incoming && incoming === secret);
}

type IncomingStaff = {
  id: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
  metadata?: Record<string, unknown> | null;
};

export async function POST(req: Request) {
  if (!assertSecret(req.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const tenantId = body?.tenantId;
  const staff = Array.isArray(body?.staff) ? (body.staff as IncomingStaff[]) : [];

  if (!tenantId || !staff.length) {
    return NextResponse.json({ error: "tenantId and staff required" }, { status: 400 });
  }

  const tenant = await prisma.tenant.upsert({
    where: { id: tenantId },
    update: {},
    create: { id: tenantId, name: tenantId },
  });

  // Wähle erste Location des Tenants oder lege eine Default-Location an.
  let location = await prisma.location.findFirst({ where: { tenantId: tenant.id } });
  if (!location) {
    location = await prisma.location.create({
      data: {
        tenantId: tenant.id,
        slug: `loc-${tenant.id.slice(0, 6)}`,
        name: "Default",
        timezone: "Europe/Berlin",
        country: "DE",
        metadata: { provisionedBy: "staff-sync" },
      },
    });
  }

  await prisma.$transaction(async (tx) => {
    for (const person of staff) {
      if (!person?.id) continue;
      const code = person.id;

      const nameCandidate = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
      const displayName = person.displayName ?? (nameCandidate || "Unbenannt");

      const payload = {
        locationId: location!.id,
        firstName: person.firstName ?? null,
        lastName: person.lastName ?? null,
        displayName,
        email: person.email ?? null,
        phone: person.phone ?? null,
        status: "ACTIVE" as const,
        metadata: {
          ...(person.metadata ?? {}),
          role: person.role ?? undefined,
          source: "control-plane",
        },
      };

      const existing = await tx.staff.findFirst({
        where: { code, location: { tenantId: tenant.id } },
        select: { id: true },
      });

      if (existing) {
        await tx.staff.update({
          where: { id: existing.id },
          data: payload,
        });
      } else {
        await tx.staff.create({
          data: { ...payload, code },
        });
      }
    }
  });

  return NextResponse.json({ ok: true, count: staff.length });
}
