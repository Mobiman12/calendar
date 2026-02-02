import { PolicyType } from "@prisma/client";

import type {
  CancellationPolicy,
  DepositPolicy,
  NoShowPolicy,
  ParsedPolicy,
  PolicyRecord,
} from "@/lib/policies/types";

export function parsePolicy(record: PolicyRecord): ParsedPolicy | null {
  const config = record.configuration;
  if (record.type === PolicyType.CANCELLATION) {
    return parseCancellationPolicy(config);
  }
  if (record.type === PolicyType.NO_SHOW) {
    return parseNoShowPolicy(config);
  }
  if (record.type === PolicyType.DEPOSIT) {
    return parseDepositPolicy(config);
  }
  return null;
}

function parseCancellationPolicy(configuration: unknown): CancellationPolicy | null {
  if (!configuration || typeof configuration !== "object") {
    return null;
  }
  const cfg = configuration as Record<string, unknown>;
  const windowHours = toNumber(cfg.windowHours, 24);
  const penalty = cfg.penalty as Record<string, unknown> | undefined;
  const kind = typeof penalty?.kind === "string" ? (penalty.kind as "percentage" | "flat") : "percentage";
  const value = toNumber(penalty?.value, 50);

  return {
    type: "CANCELLATION",
    windowHours,
    penalty: {
      kind,
      value,
    },
  };
}

function parseNoShowPolicy(configuration: unknown): NoShowPolicy | null {
  if (!configuration || typeof configuration !== "object") {
    return null;
  }
  const cfg = configuration as Record<string, unknown>;
  const charge = cfg.charge as Record<string, unknown> | undefined;
  const kind = typeof charge?.kind === "string" ? (charge.kind as "percentage" | "flat") : "flat";
  const value = toNumber(charge?.value, 20);
  const graceMinutes = toNumber(cfg.graceMinutes, 10);

  return {
    type: "NO_SHOW",
    charge: {
      kind,
      value,
    },
    graceMinutes,
  };
}

function parseDepositPolicy(configuration: unknown): DepositPolicy | null {
  if (!configuration || typeof configuration !== "object") {
    return null;
  }
  const cfg = configuration as Record<string, unknown>;
  const thresholdAmount = cfg.thresholdAmount !== undefined ? toNumber(cfg.thresholdAmount, undefined) : undefined;
  const percentage = cfg.percentage !== undefined ? toNumber(cfg.percentage, undefined) : undefined;
  const flatAmount = cfg.flatAmount !== undefined ? toNumber(cfg.flatAmount, undefined) : undefined;
  const applies = Array.isArray(cfg.appliesToServiceIds)
    ? cfg.appliesToServiceIds.filter((id): id is string => typeof id === "string")
    : undefined;

  if (percentage === undefined && flatAmount === undefined) {
    return null;
  }

  return {
    type: "DEPOSIT",
    thresholdAmount,
    percentage,
    flatAmount,
    appliesToServiceIds: applies?.length ? applies : undefined,
  };
}

function toNumber(value: unknown, fallback: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  if (fallback === undefined) {
    throw new Error("Invalid numeric value in policy configuration");
  }
  return fallback;
}
