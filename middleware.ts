import { NextRequest, NextResponse } from "next/server";

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "http://localhost:3000";
const ENABLE_TENANT_GUARD = process.env.ENABLE_TENANT_GUARD?.trim() !== "false";

// SSO placeholder: validate a simple bearer token with tenantId
function decodeBase64Url(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob === "function") {
    return atob(padded);
  }
  // Fallback for non-edge environments (e.g. tests)
  const nodeBuffer = (globalThis as any).Buffer;
  if (nodeBuffer) {
    return nodeBuffer.from(padded, "base64").toString("utf-8");
  }
  throw new Error("No base64 decoder available");
}

function getBearerSecret() {
  const secret = process.env.TENANT_AUTH_SECRET?.trim();
  if (!secret) return null;
  return secret;
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSha256Hex(secret: string, value: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function parseAuth(headers: Headers) {
  const auth = headers.get("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  try {
    const token = auth.slice(7).trim();
    const [encoded, signature] = token.split(".");
    const allowLegacy = process.env.NODE_ENV !== "production";
    let payloadRaw = token;
    if (signature) {
      const secret = getBearerSecret();
      if (!secret) return null;
      const expected = await hmacSha256Hex(secret, encoded);
      if (!constantTimeEqual(signature, expected)) {
        return null;
      }
      payloadRaw = encoded;
    } else if (!allowLegacy) {
      return null;
    }
    const decoded = JSON.parse(decodeBase64Url(payloadRaw));
    if (decoded?.tenantId && decoded?.sub) {
      return { tenantId: String(decoded.tenantId), userId: String(decoded.sub) };
    }
  } catch (error) {
    return null;
  }
  return null;
}

function parseHost(host: string | null) {
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length < 3) return null;
  const [tenantSlug, appKey] = parts;
  return { tenantSlug, appKey };
}

async function resolveTenant(tenantSlug: string, appKey: string, authTenantId?: string) {
  const url = `${CONTROL_PLANE_URL}/api/internal/tenant/resolve?tenant=${encodeURIComponent(tenantSlug)}&app=${encodeURIComponent(appKey)}`;
  try {
    const headers = authTenantId ? { "x-tenant-id": authTenantId } : undefined;
    const res = await fetch(url, { cache: "no-store", headers });
    if (res.status === 403) {
      const data = (await res.json().catch(() => ({}))) as { reason?: string; message?: string };
      if (data?.reason === "trial_expired" || data?.message === "Trial abgelaufen") {
        return { ok: false, reason: "trial_expired" } as const;
      }
      return null;
    }
    if (!res.ok) return null;
    return {
      ok: true as const,
      ...(await res.json()),
    } as {
      ok: true;
      tenantId: string;
      app: string;
      tenantStatus: string;
      provisionMode?: string;
      trialEndsAt?: string | null;
      theme?: { preset?: string; mode?: string };
    };
  } catch (error) {
    console.error("tenant resolve failed", error);
    return null;
  }
}

export async function middleware(req: NextRequest) {
  if (!ENABLE_TENANT_GUARD) return NextResponse.next();

  // Staff-Central soll auch funktionieren, wenn z.B. nur STAFF_CORE aktiv ist.
  if (req.nextUrl.pathname.startsWith("/backoffice/staff-central")) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith("/trial-expired")) {
    return NextResponse.next();
  }

  const parsed = parseHost(req.headers.get("host"));
  if (!parsed) return NextResponse.next();

  const auth = await parseAuth(req.headers);
  const match = await resolveTenant(parsed.tenantSlug, parsed.appKey, auth?.tenantId);
  if (!match) {
    return NextResponse.json({ message: "Tenant/App nicht freigeschaltet" }, { status: 403 });
  }
  if (!match.ok && match.reason === "trial_expired") {
    const acceptsHtml = req.headers.get("accept")?.includes("text/html");
    if (acceptsHtml) {
      const redirectUrl = req.nextUrl.clone();
      redirectUrl.pathname = "/trial-expired";
      redirectUrl.search = "";
      return NextResponse.redirect(redirectUrl);
    }
    return NextResponse.json({ message: "Trial abgelaufen", reason: "trial_expired" }, { status: 403 });
  }

  const requestHeaders = new Headers(req.headers);
  if (auth?.tenantId) requestHeaders.set("x-auth-tenant-id", auth.tenantId);
  if (auth?.userId) requestHeaders.set("x-auth-user-id", auth.userId);
  requestHeaders.set("x-tenant-id", match.tenantId);
  requestHeaders.set("x-app-type", match.app);
  requestHeaders.set("x-tenant-status", match.tenantStatus);
  if (match.provisionMode) requestHeaders.set("x-tenant-provision-mode", match.provisionMode);
  if (match.trialEndsAt) requestHeaders.set("x-tenant-trial-ends", match.trialEndsAt);
  if (match.theme?.preset) requestHeaders.set("x-tenant-theme", match.theme.preset);
  if (match.theme?.mode) requestHeaders.set("x-tenant-theme-mode", match.theme.mode);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
