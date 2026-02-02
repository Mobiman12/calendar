/**
 * Quick sync: zieht Branches/Mitarbeitende aus der Stundenliste-API (Port 3001)
 * und legt in der Calendar-DB Staff-Einträge und Branch-Zuordnungen an.
 *
 * Voraussetzung:
 * - STUNDENLISTE_BASE_URL und STUNDENLISTE_API_KEY sind gesetzt (.env.local)
 * - Kalender-DB ist erreichbar (DATABASE_URL).
 *
 * Nutzung:
 *   pnpm tsx scripts/sync-stundenliste-staff.ts
 */

import { PrismaClient, StaffStatus } from "@prisma/client";

const prisma = new PrismaClient();
const baseUrl = process.env.STUNDENLISTE_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:3001";
const apiKey = process.env.STUNDENLISTE_API_KEY ?? "codex-dev-key";

type Branch = {
  id: number;
  slug?: string | null;
  name: string;
};

type Employee = {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  bookingPin: string | null;
  isActive: boolean;
  showInCalendar?: boolean | null;
  branches?: Array<Branch>;
};

const palette = ["#22c55e", "#0ea5e9", "#a855f7", "#f97316", "#ec4899", "#eab308", "#06b6d4", "#8b5cf6", "#f43f5e"];

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (payload as any)?.error ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (payload as any).data ?? payload;
}

async function main() {
  const branches = await fetchJson<Branch[]>("/api/branches");
  const employees = await fetchJson<Employee[]>("/api/employees");

  const branchById = new Map<number, Branch>();
  branches.forEach((b) => branchById.set(b.id, b));

  // Map Location by slug -> id
  const locations = await prisma.location.findMany({ select: { id: true, slug: true } });
  const locBySlug = new Map(locations.map((l) => [l.slug, l.id]));

  // Set stundenlisteBranchId on matching locations (by slug)
  for (const branch of branches) {
    if (!branch.slug) continue;
    const locId = locBySlug.get(branch.slug);
    if (locId) {
      await prisma.location.update({
        where: { id: locId },
        data: { stundenlisteBranchId: branch.id },
      });
    }
  }

  // Clear existing staff (optional: remove only ones without appointments)
  await prisma.staffLocationMembership.deleteMany({});
  await prisma.staff.deleteMany({});

  let colorIdx = 0;
  for (const emp of employees) {
    const staffColor = palette[colorIdx % palette.length];
    colorIdx += 1;
    const branchLocations = (emp.branches ?? [])
      .map((branch) => branchById.get(branch.id) ?? branch)
      .map((branchMeta) => {
        const slug =
          branchMeta.slug ??
          branchMeta.name
            ?.trim()
            .toLowerCase()
            .replace(/ä/g, "ae")
            .replace(/ö/g, "oe")
            .replace(/ü/g, "ue")
            .replace(/ß/g, "ss")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") ??
          null;
        const locId = slug ? locBySlug.get(slug) : null;
        return locId ? { locId, branchMeta } : null;
      })
      .filter((entry): entry is { locId: string; branchMeta: Branch } => Boolean(entry));

    if (!branchLocations.length) continue;

    const primaryLocId = branchLocations[0].locId;

    const staff = await prisma.staff.create({
      data: {
        code: String(emp.id),
        firstName: emp.firstName,
        lastName: emp.lastName,
        displayName: `${emp.firstName} ${emp.lastName}`,
        email: emp.email ?? undefined,
        phone: emp.phone ?? undefined,
        status: emp.isActive ? StaffStatus.ACTIVE : StaffStatus.INACTIVE,
        locationId: primaryLocId,
        bookingPin: emp.bookingPin ?? null,
        calendarOrder: colorIdx, // simple order
        color: staffColor,
        metadata: {
          stundenliste: {
            employeeId: emp.id,
          },
        },
      },
    });

    // Create memberships for all linked branches
    for (const { locId } of branchLocations) {
      await prisma.staffLocationMembership.create({
        data: {
          staffId: staff.id,
          locationId: locId,
          role: "member",
        },
      });
    }
  }

  console.log("Sync complete:", {
    staffCount: await prisma.staff.count(),
    locationMappings: await prisma.location.findMany({ select: { slug: true, stundenlisteBranchId: true } }),
  });
}

main()
  .catch((error) => {
    console.error("Sync failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
