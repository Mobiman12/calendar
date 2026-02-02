import "server-only";

import { readString } from "@/lib/actions-center/mapper";

type ExtractedBooking = {
  appointmentId: string | null;
  confirmationCode: string | null;
  startsAt: string | null;
  endsAt: string | null;
  status: string | null;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractCheckoutBooking(payload: unknown): ExtractedBooking {
  const root = readRecord(payload);
  const data = readRecord(root?.data) ?? readRecord(root?.appointment) ?? root ?? {};
  const nestedAppointment = readRecord(data.appointment) ?? null;
  const source = nestedAppointment ?? data;

  return {
    appointmentId: readString(source.appointmentId ?? source.id ?? root?.appointmentId ?? root?.id),
    confirmationCode: readString(source.confirmationCode ?? root?.confirmationCode),
    startsAt: readString(source.startsAt),
    endsAt: readString(source.endsAt),
    status: readString(source.status),
  };
}

export function buildBookingResponse(params: {
  appointmentId: string;
  confirmationCode?: string | null;
  status?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  slotKey?: string | null;
  merchantId?: string | null;
}) {
  return {
    booking: {
      appointmentId: params.appointmentId,
      confirmationCode: params.confirmationCode ?? null,
      status: params.status ?? null,
      startsAt: params.startsAt ?? null,
      endsAt: params.endsAt ?? null,
      slotKey: params.slotKey ?? null,
      merchantId: params.merchantId ?? null,
    },
  };
}
