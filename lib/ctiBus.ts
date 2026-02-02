import { EventEmitter } from "events";

export type CtiIncomingEvent = {
  tenant_id: string;
  caller_number: string | null;
  caller_number_raw: string | null;
  called_number: string | null;
  extension: string | null;
  line: string | null;
  ts: string;
};

declare global {
  // eslint-disable-next-line no-var
  var __calendarCtiEmitter: EventEmitter | undefined;
}

function getEmitter() {
  if (!global.__calendarCtiEmitter) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    global.__calendarCtiEmitter = emitter;
  }
  return global.__calendarCtiEmitter;
}

export function subscribeCti(handler: (event: CtiIncomingEvent) => void): () => void {
  const emitter = getEmitter();
  emitter.on("incoming_call", handler);
  return () => {
    emitter.off("incoming_call", handler);
  };
}

export function publishCti(event: CtiIncomingEvent) {
  // In-memory only; replace with shared bus when multiple nodes are introduced.
  getEmitter().emit("incoming_call", event);
}
