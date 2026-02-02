import { createHmac, timingSafeEqual } from "crypto";

export interface TenantSsoPayload {
  tenantId: string;
  tenantSlug: string;
  tenantName?: string | null;
  email?: string | null;
  app: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  iat: number;
  exp: number;
  returnTo?: string | null;
  staffCode?: string | null;
  role?: string | null;
}

function getSsoSecret() {
  const secret = process.env.TENANT_SSO_SECRET || process.env.TENANT_AUTH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("TENANT_SSO_SECRET ist nicht gesetzt.");
    }
    return "dev-sso-secret";
  }
  return secret;
}

export function verifyTenantSsoToken(token: string | null, expectedApp: string): TenantSsoPayload | null {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot === -1) return null;
    const payloadJson = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    if (!payloadJson || !sig) return null;
    const expectedSig = createHmac("sha256", getSsoSecret()).update(payloadJson).digest("hex");
    const sigBuf = Buffer.from(sig, "utf8");
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    const payload = JSON.parse(payloadJson) as TenantSsoPayload;
    if (!payload?.tenantId || !payload?.tenantSlug || !payload?.exp || !payload?.iat) {
      return null;
    }
    if (payload.app !== expectedApp) {
      return null;
    }
    if (Date.now() > Number(payload.exp)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
