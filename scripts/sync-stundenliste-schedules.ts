import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();
if (!process.env.STUNDENLISTE_BASE_URL) {
  process.env.STUNDENLISTE_BASE_URL = "http://localhost:3001";
}
import { startOfMonth, addMonths, format, parseISO } from "date-fns";

import { getPrismaClient } from "@/lib/prisma";
import { supportsStaffMemberships } from "@/lib/staff-memberships";

const prisma = getPrismaClient();

type ScheduleRuleInput = {
  id: string;
  scheduleId: string;
  ruleType: "DATE";
  weekday: null;
  startsAt: number;
  endsAt: number;
  serviceId: null;
  staffId: string;
  priority: number;
  effectiveFrom: Date;
  effectiveTo: Date;
  isActive: boolean;
  metadata: Record<string, unknown> | null;
};

function collectMonthKeys(base: Date, count: number): string[] {
  const keys: string[] = [];
  let cursor = startOfMonth(base);
  for (let i = 0; i < count; i++) {
    keys.push(format(cursor, "yyyy-MM"));
    cursor = addMonths(cursor, 1);
  }
  return keys;
}

async function main() {
  const { getStundenlisteClient } = await import("@/lib/stundenliste-client");
  const monthKeys = collectMonthKeys(new Date(), 2); // aktueller und nächster Monat

  const membershipSupported = await supportsStaffMemberships(prisma);
  const locations = await prisma.location.findMany({
    select: {
      id: true,
      slug: true,
      timezone: true,
      metadata: true,
      tenantId: true,
    },
  });

  const clientCache = new Map<string, ReturnType<typeof getStundenlisteClient>>();

  for (const location of locations) {
    const tenantId = location.tenantId ?? process.env.DEFAULT_TENANT_ID ?? "";
    if (!tenantId) {
      console.warn("[stundenliste-sync] Kein tenantId für Location", location.slug);
      continue;
    }
    const cachedClient = clientCache.get(tenantId);
    const client = cachedClient ?? getStundenlisteClient(tenantId);
    if (!cachedClient) {
      clientCache.set(tenantId, client);
    }

    const timezone = location.timezone ?? "Europe/Berlin";
    const staffWhere = membershipSupported
      ? { memberships: { some: { locationId: location.id } }, status: "ACTIVE" as const }
      : { locationId: location.id, status: "ACTIVE" as const };

    const staffList = await prisma.staff.findMany({
      where: staffWhere,
      select: { id: true, code: true, metadata: true },
    });

    const staffExternalMap = staffList
      .map((staff) => {
        const code = (staff.code ?? "").trim();
        let externalId: number | null = null;
        if (code && Number.isFinite(Number.parseInt(code, 10))) {
          externalId = Number.parseInt(code, 10);
        } else if (
          staff.metadata &&
          typeof staff.metadata === "object" &&
          "stundenliste" in (staff.metadata as Record<string, unknown>)
        ) {
          const meta = (staff.metadata as Record<string, any>).stundenliste;
          const id = meta?.employeeId ?? meta?.id;
          const parsed = Number.parseInt(String(id ?? ""), 10);
          if (Number.isFinite(parsed)) {
            externalId = parsed;
          }
        }
        return externalId ? { staffId: staff.id, externalId } : null;
      })
      .filter(Boolean) as Array<{ staffId: string; externalId: number }>;

    // Alte Sync-Schedules entfernen
    await prisma.schedule.deleteMany({
      where: {
        locationId: location.id,
        staffId: { in: staffExternalMap.map((s) => s.staffId) },
        metadata: {
          path: ["source"],
          equals: "stundenliste-sync",
        },
      },
    });

    for (const entry of staffExternalMap) {
      const rules: ScheduleRuleInput[] = [];
      for (const monthKey of monthKeys) {
        try {
          const plan = await client.getShiftPlan(entry.externalId, monthKey);
          for (const day of plan.days) {
            const startParts = (day.start ?? "").split(":");
            const endParts = (day.end ?? "").split(":");
            const startMinutes = startParts.length === 2 ? Number.parseInt(startParts[0], 10) * 60 + Number.parseInt(startParts[1], 10) : NaN;
            const endMinutes = endParts.length === 2 ? Number.parseInt(endParts[0], 10) * 60 + Number.parseInt(endParts[1], 10) : NaN;
            if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || endMinutes <= startMinutes) {
              continue;
            }
            const isoDate = parseISO(day.isoDate);
            const scheduleId = `stundenliste-${entry.staffId}-${monthKey}`;
            rules.push({
              id: `${scheduleId}-${rules.length}`,
              scheduleId,
              ruleType: "DATE",
              weekday: null,
              startsAt: startMinutes,
              endsAt: endMinutes,
              serviceId: null,
              staffId: entry.staffId,
              priority: 0,
              effectiveFrom: isoDate,
              effectiveTo: isoDate,
              isActive: true,
              metadata: null,
            });
          }
        } catch (error) {
          console.warn("[sync-schedules] plan fetch failed", { staffId: entry.staffId, monthKey, error });
        }
      }

      if (!rules.length) {
        continue;
      }

      const scheduleId = `stundenliste-${entry.staffId}`;
      await prisma.schedule.create({
        data: {
          id: scheduleId,
          locationId: location.id,
          ownerType: "STAFF",
          staffId: entry.staffId,
          name: "Stundenliste",
          timezone,
          isDefault: false,
          metadata: { source: "stundenliste-sync" },
          rules: {
            createMany: {
              data: rules.map((rule) => ({
                id: rule.id,
                ruleType: "DATE",
                weekday: null,
                startsAt: rule.startsAt,
                endsAt: rule.endsAt,
                serviceId: null,
                staffId: entry.staffId,
                priority: 0,
                effectiveFrom: rule.effectiveFrom,
                effectiveTo: rule.effectiveTo,
                isActive: true,
                metadata: null,
              })),
            },
          },
        },
      });
    }

    console.info(`[sync-schedules] ${location.slug} done (${staffExternalMap.length} staff)`);
  }
}

main()
  .then(() => {
    console.info("Sync complete.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Sync failed", error);
    process.exit(1);
  });
