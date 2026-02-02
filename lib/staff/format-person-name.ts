export function formatPersonName(firstName?: string | null, lastName?: string | null) {
  const first = firstName?.trim() ?? "";
  const last = lastName?.trim() ?? "";
  const combined = `${first} ${last}`.replace(/\s+/g, " ").trim();
  return combined.length ? combined : null;
}
