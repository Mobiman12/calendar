import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { publishCti } from "@/lib/ctiBus";
import { getTenantIdOrThrow } from "@/lib/tenant";

const SECRET = process.env.CTI_SHARED_SECRET || "TEST_SECRET_123456789";

function hmac(body: string) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-cti-signature") ?? "";
  const body = await req.text();

  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  if (payload.eventType !== "incoming_call") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  let tenantId: string;
  try {
    tenantId = await getTenantIdOrThrow(req.headers);
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const readString = (value: unknown) => (typeof value === "string" ? value.trim() || null : null);
  const callerNumber = readString(payload.caller_number ?? payload.caller ?? payload.callerNumber);
  const callerRaw = readString(payload.caller_number_raw ?? payload.callerRaw ?? payload.caller);
  const calledNumber = readString(payload.called_number ?? payload.called ?? payload.calledNumber);
  const extension = readString(payload.extension ?? payload.ext);
  const line = readString(payload.line);
  const ts = new Date().toISOString();

  publishCti({
    tenant_id: tenantId,
    caller_number: callerNumber,
    caller_number_raw: callerRaw,
    called_number: calledNumber,
    extension,
    line,
    ts,
  });

  console.log("CTI incoming:", payload);
  return NextResponse.json({ ok: true });
}
