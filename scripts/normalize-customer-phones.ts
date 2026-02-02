/**
 * Normalisiert Kunden-Telefonnummern in der Kalender-DB auf E.164.
 * Standard: Dry-Run (kein Schreiben). Mit --apply werden Änderungen gespeichert.
 *
 * Nutzung:
 *   pnpm tsx scripts/normalize-customer-phones.ts
 *   pnpm tsx scripts/normalize-customer-phones.ts --apply
 *   pnpm tsx scripts/normalize-customer-phones.ts --apply --location meissen
 *   pnpm tsx scripts/normalize-customer-phones.ts --limit 1000
 */

import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

import { getPrismaClient } from "@/lib/prisma";
import { normalizePhoneNumber } from "@/lib/notifications/phone";

const prisma = getPrismaClient();

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return null;
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const locationSlug = readArg("--location");
  const limitRaw = readArg("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : null;

  let locationId: string | null = null;
  if (locationSlug) {
    const location = await prisma.location.findFirst({
      where: { slug: locationSlug },
      select: { id: true },
    });
    if (!location) {
      throw new Error(`Standort nicht gefunden: ${locationSlug}`);
    }
    locationId = location.id;
  }

  const customers = await prisma.customer.findMany({
    where: {
      phone: { not: null },
      ...(locationId ? { locationId } : {}),
    },
    select: { id: true, phone: true },
    take: Number.isFinite(limit) ? limit ?? undefined : undefined,
  });

  let unchanged = 0;
  let invalid = 0;
  let willUpdate = 0;
  let updated = 0;
  const normalizedIndex = new Map<string, string[]>();
  const updates: Array<{ id: string; phone: string }> = [];

  for (const customer of customers) {
    const raw = customer.phone?.trim() ?? "";
    if (!raw) {
      invalid += 1;
      continue;
    }
    const normalized = normalizePhoneNumber(raw);
    if (!normalized) {
      invalid += 1;
      continue;
    }
    const list = normalizedIndex.get(normalized) ?? [];
    list.push(customer.id);
    normalizedIndex.set(normalized, list);

    if (normalized === raw) {
      unchanged += 1;
      continue;
    }
    updates.push({ id: customer.id, phone: normalized });
    willUpdate += 1;
  }

  if (apply) {
    for (const update of updates) {
      await prisma.customer.update({
        where: { id: update.id },
        data: { phone: update.phone },
      });
      updated += 1;
    }
  }

  const duplicateGroups = Array.from(normalizedIndex.values()).filter((group) => group.length > 1);
  const duplicateCustomers = duplicateGroups.reduce((sum, group) => sum + group.length, 0);

  console.log({
    mode: apply ? "apply" : "dry-run",
    scope: locationSlug ?? "all",
    total: customers.length,
    unchanged,
    invalid,
    willUpdate,
    updated,
    duplicateNumbers: duplicateGroups.length,
    duplicateCustomers,
  });
}

main()
  .catch((error) => {
    console.error("Normalize failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
