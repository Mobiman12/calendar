import { subscribeCti, type CtiIncomingEvent } from "@/lib/ctiBus";
import { getTenantIdOrThrow } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: Request) {
  let tenantId: string;
  try {
    tenantId = await getTenantIdOrThrow(new Headers(request.headers));
  } catch {
    return new Response("Nicht autorisiert.", { status: 401 });
  }

  let cleanup: (() => void) | null = null;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (payload: unknown, eventName?: string) => {
        if (closed) return;
        if (eventName) {
          controller.enqueue(encoder.encode(`event: ${eventName}\n`));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const handler = (evt: CtiIncomingEvent) => {
        if (evt.tenant_id !== tenantId) return;
        send({ type: "incoming_call", evt }, "incoming_call");
      };
      const unsubscribe = subscribeCti(handler);

      const keepAlive = setInterval(() => {
        send({ ts: Date.now() }, "ping");
      }, 25_000);

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
      send({ ts: Date.now() }, "hello");
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
