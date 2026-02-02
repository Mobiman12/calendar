export type BookingActor = {
  staffId: string;
  staffName: string;
  token: string;
  expiresAt: number;
  role: string | null;
};

export const PIN_SESSION_TIMEOUT_MS = 30_000;
export const PIN_SESSION_IDLE_GRACE_MS = 30_000;
