import type { PolicyType } from "@prisma/client";

export type Money = {
  amount: number;
  currency: string;
};

export interface CancellationPolicy {
  type: "CANCELLATION";
  windowHours: number;
  penalty: {
    kind: "percentage" | "flat";
    value: number;
  };
}

export interface NoShowPolicy {
  type: "NO_SHOW";
  charge: {
    kind: "percentage" | "flat";
    value: number;
  };
  graceMinutes: number;
}

export interface DepositPolicy {
  type: "DEPOSIT";
  thresholdAmount?: number;
  percentage?: number;
  flatAmount?: number;
  appliesToServiceIds?: string[];
}

export type ParsedPolicy = CancellationPolicy | NoShowPolicy | DepositPolicy;

export type LocationPolicies = {
  cancellation?: CancellationPolicy;
  noShow?: NoShowPolicy;
  deposit?: DepositPolicy;
};

export interface PolicyRecord {
  id: string;
  type: PolicyType;
  configuration: unknown;
}
