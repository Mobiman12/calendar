const ADMIN_ROLES = new Set(["ADMIN", "OWNER"]);

export function isAdminRole(role: string | null | undefined): boolean {
  const normalized = (role ?? "").toString().trim().toUpperCase();
  return ADMIN_ROLES.has(normalized);
}
