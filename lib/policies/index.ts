import { PolicyType } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import type { LocationPolicies, PolicyRecord } from "@/lib/policies/types";
import { parsePolicy } from "@/lib/policies/parse";

export { calculateDepositAmount, getCancellationDeadlineMinutes } from "@/lib/policies/evaluate";

export async function loadPoliciesForLocation(locationId: string): Promise<LocationPolicies> {
  const prisma = getPrismaClient();
  const records = await prisma.policy.findMany({
    where: {
      locationId,
      isActive: true,
      type: { in: [PolicyType.CANCELLATION, PolicyType.NO_SHOW, PolicyType.DEPOSIT] },
    },
  });

  const result: LocationPolicies = {};

  for (const record of records) {
    const parsed = parsePolicy(toPolicyRecord(record));
    if (!parsed) continue;
    if (parsed.type === "CANCELLATION") {
      result.cancellation = parsed;
    } else if (parsed.type === "NO_SHOW") {
      result.noShow = parsed;
    } else if (parsed.type === "DEPOSIT") {
      result.deposit = parsed;
    }
  }

  return result;
}

function toPolicyRecord(record: { id: string; type: PolicyType; configuration: unknown }): PolicyRecord {
  return {
    id: record.id,
    type: record.type,
    configuration: record.configuration,
  };
}
