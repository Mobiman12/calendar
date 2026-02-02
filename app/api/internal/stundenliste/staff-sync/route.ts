import { NextResponse } from "next/server";

import { PrismaClient, StaffStatus } from "@prisma/client";

import { getStundenlisteClient } from "@/lib/stundenliste-client";

const prisma = new PrismaClient();

type Payload = {
  employeeId: number;
  tenantId?: string;
};

function slugify(value: string | null | undefined): string | null {
  if (!value) return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

const palette = ["#22c55e", "#0ea5e9", "#a855f7", "#f97316", "#ec4899", "#eab308", "#06b6d4", "#8b5cf6", "#f43f5e"];

export async function POST(request: Request) {
  const secret = process.env.STUNDENLISTE_WEBHOOK_SECRET ?? process.env.PROVISION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook-Secret fehlt (setze STUNDENLISTE_WEBHOOK_SECRET)." }, { status: 500 });
  }
  const provided = request.headers.get("x-stundenliste-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "Ungültiger Payload" }, { status: 400 });
  }

  const employeeId = Number(body.employeeId);
  if (!Number.isFinite(employeeId)) {
    return NextResponse.json({ error: "employeeId fehlt oder ist ungültig." }, { status: 400 });
  }

  const tenantId =
    request.headers.get("x-tenant-id") ??
    body.tenantId ??
    process.env.DEFAULT_TENANT_ID ??
    null;
  if (!tenantId) {
    return NextResponse.json({ error: "tenantId fehlt." }, { status: 400 });
  }

  try {
    const client = getStundenlisteClient(tenantId);

    // Die Stundenliste-API bietet kein Einzel-Endpoint -> komplettes Listing filtern.
    const employees = await client.listEmployees();
    const emp = employees.find((e) => Number(e.id) === employeeId);
    if (!emp) {
      return NextResponse.json({ error: "Mitarbeiter nicht gefunden." }, { status: 404 });
    }

    const employeeVisible = emp.showInCalendar !== false;

    const branches = await client.listBranches();
    const branchById = new Map(branches.map((b) => [b.id, b]));
    const locs = await prisma.location.findMany({
      where: { tenantId },
      select: { id: true, slug: true, stundenlisteBranchId: true },
    });
    const locBySlug = new Map(locs.map((l) => [l.slug, l.id]));
    const locByBranchId = new Map<number, string>();
    for (const loc of locs) {
      if (loc.stundenlisteBranchId) {
        locByBranchId.set(loc.stundenlisteBranchId, loc.id);
      }
    }

    const branchEntries = (emp.branches ?? [])
      .map((b) => branchById.get(b.id) ?? b)
      .map((b) => {
        const branchVisible = (b as any).showInCalendar !== false && (b as any).visibleInCalendar !== false;
        if (!branchVisible) return null;
        const locId =
          locByBranchId.get(b.id) ??
          (() => {
            const slug = slugify(b.slug ?? b.name ?? "");
            return slug ? locBySlug.get(slug) ?? null : null;
          })();
        return locId ? { locId, branch: b } : null;
      })
      .filter((x): x is { locId: string; branch: { id: number } } => Boolean(x));

    if (!branchEntries.length) {
      return NextResponse.json(
        { error: "Keine passende (sichtbare) Filiale für diesen Mitarbeiter gefunden." },
        { status: 400 },
      );
    }

    // Fallback Farbe/Sortierung
    const existingCount = await prisma.staff.count({ where: { location: { tenantId } } });
    const color = palette[existingCount % palette.length];

    // Primary location = erste gefundene
    const primaryLocId = branchEntries[0].locId;
    const code = String(emp.id);

    const existingStaff = await prisma.staff.findFirst({
      where: { code, location: { tenantId } },
      select: { id: true },
    });

    const staffPayload = {
      firstName: emp.firstName,
      lastName: emp.lastName,
      displayName: `${emp.firstName} ${emp.lastName}`,
      email: emp.email ?? undefined,
      phone: emp.phone ?? undefined,
      status: employeeVisible && emp.isActive ? StaffStatus.ACTIVE : StaffStatus.INACTIVE,
      bookingPin: emp.bookingPin ?? null,
      locationId: primaryLocId,
      metadata: {
        stundenliste: {
          employeeId: emp.id,
          showInCalendar: emp.showInCalendar ?? null,
        },
      },
    };

    const staff = existingStaff
      ? await prisma.staff.update({
          where: { id: existingStaff.id },
          data: staffPayload,
          select: { id: true },
        })
      : await prisma.staff.create({
          data: {
            ...staffPayload,
            code,
            calendarOrder: existingCount + 1,
            color,
          },
          select: { id: true },
        });

    // Memberships neu setzen
    await prisma.staffLocationMembership.deleteMany({ where: { staffId: staff.id } });
    await prisma.staffLocationMembership.createMany({
      data: branchEntries.map(({ locId }) => ({
        staffId: staff.id,
        locationId: locId,
        role: "member",
      })),
      skipDuplicates: true,
    });

    return NextResponse.json({
      ok: true,
      staffId: staff.id,
      locations: branchEntries.map((b) => b.locId),
    });
  } catch (error: any) {
    console.error("[stundenliste-webhook] failed", error);
    return NextResponse.json({ error: error?.message ?? "Internal error" }, { status: 500 });
  }
}
