import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  PIN_SESSION_IDLE_GRACE_MS,
  PIN_SESSION_TIMEOUT_MS,
  type BookingActor,
} from "@/components/dashboard/booking-pin-types";

type BookingPinSessionContextValue = {
  actor: BookingActor | null;
  setSession: (actor: BookingActor) => BookingActor;
  registerActivity: () => BookingActor | null;
  clearSession: () => void;
  endSession: () => void;
  consumeManualClearFlag: () => boolean;
  secondsRemaining: number;
};

const BookingPinSessionContext = createContext<BookingPinSessionContextValue | null>(null);

export function BookingPinSessionProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<BookingActor | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const actorRef = useRef<BookingActor | null>(null);
  const manualClearRef = useRef(false);
  const lastActivityRef = useRef<number>(0);
  const countdownEndsAtRef = useRef<number | null>(null);

  const setSession = useCallback((nextActor: BookingActor) => {
    const now = Date.now();
    const normalized = {
      ...nextActor,
      role: nextActor.role ?? null,
      expiresAt: now + PIN_SESSION_IDLE_GRACE_MS + PIN_SESSION_TIMEOUT_MS,
    };
    manualClearRef.current = false;
    actorRef.current = normalized;
    lastActivityRef.current = now;
    countdownEndsAtRef.current = null;
    setSecondsRemaining(PIN_SESSION_TIMEOUT_MS / 1000);
    setActor(normalized);
    return normalized;
  }, []);

  const registerActivity = useCallback(() => {
    if (!actorRef.current) {
      return null;
    }
    const now = Date.now();
    lastActivityRef.current = now;
    countdownEndsAtRef.current = null;
    manualClearRef.current = false;
    const updatedExpiresAt = now + PIN_SESSION_IDLE_GRACE_MS + PIN_SESSION_TIMEOUT_MS;
    const currentActor = actorRef.current;
    let updatedActor = currentActor;
    if (currentActor.expiresAt !== updatedExpiresAt) {
      updatedActor = { ...currentActor, expiresAt: updatedExpiresAt };
      actorRef.current = updatedActor;
      window.setTimeout(() => {
        setActor((state) => {
          if (!state) {
            return null;
          }
          if (state.staffId !== updatedActor!.staffId) {
            return state;
          }
          if (state.expiresAt === updatedActor!.expiresAt) {
            return state;
          }
          return updatedActor!;
        });
      }, 0);
    }
    setSecondsRemaining((current) => {
      const next = PIN_SESSION_TIMEOUT_MS / 1000;
      return current === next ? current : next;
    });
    return updatedActor;
  }, []);

  const clearSession = useCallback(() => {
    setActor(null);
    setSecondsRemaining(0);
    actorRef.current = null;
    countdownEndsAtRef.current = null;
    lastActivityRef.current = 0;
  }, []);

  const endSession = useCallback(() => {
    manualClearRef.current = true;
    clearSession();
  }, [clearSession]);

  const consumeManualClearFlag = useCallback(() => {
    const wasManual = manualClearRef.current;
    manualClearRef.current = false;
    return wasManual;
  }, []);

  const previousActorRef = useRef<BookingActor | null>(null);

  useEffect(() => {
    previousActorRef.current = actor;
    actorRef.current = actor;
  }, [actor]);

  useEffect(() => {
    if (!actor) {
      setSecondsRemaining(0);
      countdownEndsAtRef.current = null;
      return;
    }

    const updateRemaining = () => {
      const now = Date.now();
      const idleDuration = now - lastActivityRef.current;

      if (idleDuration < PIN_SESSION_IDLE_GRACE_MS) {
        countdownEndsAtRef.current = null;
        setSecondsRemaining((current) => {
          const next = PIN_SESSION_TIMEOUT_MS / 1000;
          return current === next ? current : next;
        });
        return;
      }

      if (!countdownEndsAtRef.current) {
        countdownEndsAtRef.current = now + PIN_SESSION_TIMEOUT_MS;
      }

      const remaining = (countdownEndsAtRef.current ?? 0) - now;
      if (remaining <= 0) {
        actorRef.current = null;
        setActor(null);
        setSecondsRemaining(0);
        return;
      }

      setSecondsRemaining((current) => {
        const next = Math.max(0, Math.ceil(remaining / 1000));
        return current === next ? current : next;
      });
    };

    updateRemaining();
    const interval = window.setInterval(updateRemaining, 500);
    return () => window.clearInterval(interval);
  }, [actor]);

  useEffect(() => {
    if (!actor) return;
    const handleActivity = () => {
      registerActivity();
    };
    const events: Array<keyof DocumentEventMap> = ["mousedown", "keydown", "pointerdown", "touchstart"];
    events.forEach((event) => document.addEventListener(event, handleActivity, { passive: true }));
    return () => {
      events.forEach((event) => document.removeEventListener(event, handleActivity));
    };
  }, [actor, registerActivity]);

  const value = useMemo(
    () => ({
      actor,
      setSession,
      registerActivity,
      clearSession,
      endSession,
      consumeManualClearFlag,
      secondsRemaining,
    }),
    [actor, setSession, registerActivity, clearSession, endSession, consumeManualClearFlag, secondsRemaining],
  );

  return <BookingPinSessionContext.Provider value={value}>{children}</BookingPinSessionContext.Provider>;
}

export function useBookingPinSession() {
  const context = useContext(BookingPinSessionContext);
  if (!context) {
    throw new Error("useBookingPinSession must be used within a BookingPinSessionProvider");
  }
  return context;
}
