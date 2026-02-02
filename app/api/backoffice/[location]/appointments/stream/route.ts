import { getPrismaClient } from "@/lib/prisma";
import { getTenantIdOrThrow } from "@/lib/tenant";
import { subscribeAppointmentSync, type AppointmentSyncMessage } from "@/lib/appointment-sync";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const prisma = getPrismaClient();

export async function GET(
  request: Request,
  context: { params: Promise<{ location: string }> },
) {
  const { location } = await context.params;
  let tenantId: string;
  try {
    tenantId = await getTenantIdOrThrow(new Headers(request.headers), { locationSlug: location });
  } catch {
    return new Response("Nicht autorisiert.", { status: 401 });
  }

  const locationRecord = await prisma.location.findFirst({
    where: { slug: location, tenantId },
    select: { id: true },
  });

  if (!locationRecord) {
    return new Response("Standort nicht gefunden.", { status: 404 });
  }

  let cleanup: (() => void) | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (message: AppointmentSyncMessage) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
      };

      const unsubscribe = subscribeAppointmentSync(locationRecord.id, send);
      const keepAlive = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15_000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // ignore double close
        }
      };

      cleanup = close;
      request.signal.addEventListener("abort", close);
      controller.enqueue(encoder.encode(`event: ready\ndata: ${Date.now()}\n\n`));
    },
    cancel() {
      if (cleanup) {
        cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
