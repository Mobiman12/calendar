export const SERVICE_ASSIGNMENT_NONE_KEY = "__none";

function normalizeStaffIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const collected = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length) {
      collected.add(trimmed);
    }
  }
  return Array.from(collected);
}

export function buildServiceStaffAssignmentsFromPayload(
  services: Array<{ id?: string | null; staffIds?: unknown }>,
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const service of services) {
    const key = service.id ?? SERVICE_ASSIGNMENT_NONE_KEY;
    const staffIds = normalizeStaffIds(service.staffIds);
    if (!staffIds.length) continue;
    map[key] = staffIds;
  }
  return map;
}

export function buildServiceStaffAssignmentsFromItems(
  items: Array<{ serviceId?: string | null; staffId?: string | null }>,
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const item of items) {
    const staffId = typeof item.staffId === "string" ? item.staffId.trim() : "";
    if (!staffId.length) continue;
    const key = item.serviceId ?? SERVICE_ASSIGNMENT_NONE_KEY;
    if (!map[key]) {
      map[key] = [];
    }
    if (!map[key].includes(staffId)) {
      map[key].push(staffId);
    }
  }
  return map;
}
