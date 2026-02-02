import { getPrismaClient } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";
import { isAdminRole } from "@/lib/access-control";
import type { Session } from "@/lib/session";

export type PermissionSnapshot = {
  keys: string[];
  isAdmin: boolean;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const permissionCache = new Map<string, { keys: string[]; expiresAt: number }>();

const LEGACY_ROLE_MAP: Record<string, string> = {
  "1": "employee",
  "2": "admin",
};

function normalizeRoleKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const legacy = LEGACY_ROLE_MAP[trimmed];
  if (legacy) return legacy;
  const slug = slugify(trimmed).slice(0, 64);
  return slug.length ? slug : null;
}

export function normalizeStaffRoleKey(value: string | null | undefined): string | null {
  return normalizeRoleKey(value);
}

function readStaffId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const staffId = record.staffId;
  return typeof staffId === "string" && staffId.trim().length ? staffId.trim() : null;
}

function readRoleKey(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  const roleKey = record.staffRoleKey ?? record.roleKey;
  return typeof roleKey === "string" && roleKey.trim().length ? normalizeRoleKey(roleKey) : null;
}

async function fetchRoleKeyFromControlPlane(tenantId: string, staffId: string): Promise<string | null> {
  const prisma = getPrismaClient();
  const rows = await prisma.$queryRaw<{ role: string | null }[]>`
    SELECT role
    FROM "control_plane"."StaffMember"
    WHERE id = ${staffId} AND "tenantId" = ${tenantId}
    LIMIT 1
  `;
  return normalizeRoleKey(rows[0]?.role ?? null);
}

async function fetchRolePermissions(tenantId: string, roleKey: string): Promise<string[]> {
  const cacheKey = `${tenantId}:${roleKey}`;
  const cached = permissionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const prisma = getPrismaClient();
  const rows = await prisma.$queryRaw<{ permissionKey: string }[]>`
    WITH RECURSIVE role_tree AS (
      SELECT id
      FROM "control_plane"."TenantRole"
      WHERE "tenantId" = ${tenantId} AND key = ${roleKey}
      UNION
      SELECT "parentRoleId"
      FROM "control_plane"."TenantRoleInheritance"
      INNER JOIN role_tree ON "TenantRoleInheritance"."roleId" = role_tree.id
    )
    SELECT DISTINCT "permissionKey"
    FROM "control_plane"."TenantRolePermission"
    WHERE "roleId" IN (SELECT id FROM role_tree)
  `;

  const keys = rows.map((row) => row.permissionKey).filter((key) => typeof key === "string");
  permissionCache.set(cacheKey, { keys, expiresAt: Date.now() + CACHE_TTL_MS });
  return keys;
}

export async function resolvePermissionSnapshot({
  session,
  tenantId,
  userMetadata,
}: {
  session: Session | null;
  tenantId?: string | null;
  userMetadata?: unknown;
}): Promise<PermissionSnapshot> {
  if (!session) {
    return { keys: [], isAdmin: false };
  }
  const isAdmin = isAdminRole(session.role);
  if (isAdmin) {
    return { keys: [], isAdmin: true };
  }
  if (!tenantId) {
    return { keys: [], isAdmin: false };
  }

  const staffId = readStaffId(userMetadata ?? null);
  let roleKey = readRoleKey(userMetadata ?? null);
  if (!roleKey && staffId) {
    roleKey = await fetchRoleKeyFromControlPlane(tenantId, staffId);
  }
  if (!roleKey) {
    return { keys: [], isAdmin: false };
  }

  const keys = await fetchRolePermissions(tenantId, roleKey);
  return { keys, isAdmin: false };
}

export function hasPermission(snapshot: PermissionSnapshot, key: string): boolean {
  if (snapshot.isAdmin) return true;
  return snapshot.keys.includes(key);
}
