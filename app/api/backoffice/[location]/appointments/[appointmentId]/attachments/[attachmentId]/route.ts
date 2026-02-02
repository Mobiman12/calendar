import { NextResponse } from "next/server";

import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";

const prisma = getPrismaClient();

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string; appointmentId: string; attachmentId: string }> },
) {
  const { location, appointmentId, attachmentId } = await context.params;
  const tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
  const { searchParams } = new URL(request.url);

  const attachment = await prisma.appointmentAttachment.findFirst({
    where: {
      id: attachmentId,
      appointmentId,
      appointment: {
        location: { slug: location, tenantId },
      },
    },
    select: {
      fileName: true,
      mimeType: true,
      size: true,
      data: true,
    },
  });

  if (!attachment || !attachment.data) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const buffer = Buffer.from(attachment.data);
  const wantsInline = interpretBoolean(searchParams.get("inline"));
  const mimeType = attachment.mimeType || "application/octet-stream";
  const allowInline = INLINE_MIME_TYPES.has(mimeType);
  const disposition = wantsInline && allowInline ? "inline" : "attachment";

  const response = new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(buffer.length ?? attachment.size ?? buffer.byteLength),
      "Content-Disposition": `${disposition}; filename="${encodeURIComponent(attachment.fileName)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });

  return response;
}

const INLINE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

function interpretBoolean(value: string | null) {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}
