import type { DepositPolicy } from "@/lib/policies/types";

export function calculateDepositAmount(policy: DepositPolicy | undefined, totalAmount: number, serviceIds: string[]): number {
  if (!policy) return 0;
  if (policy.thresholdAmount !== undefined && totalAmount < policy.thresholdAmount) {
    return 0;
  }

  if (policy.appliesToServiceIds?.length) {
    const intersects = serviceIds.some((id) => policy.appliesToServiceIds?.includes(id));
    if (!intersects) {
      return 0;
    }
  }

  const percentagePortion =
    policy.percentage !== undefined ? Math.round((totalAmount * policy.percentage) / 100) : 0;
  const flatPortion = policy.flatAmount !== undefined ? policy.flatAmount : 0;
  return Math.max(percentagePortion, flatPortion);
}

export function getCancellationDeadlineMinutes(windowHours: number): number {
  return windowHours * 60;
}
