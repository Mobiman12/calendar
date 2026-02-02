"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { createPortal } from "react-dom";

import { useToast } from "@/components/ui/ToastProvider";
import { useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";

type UseBookingPinAuthParams = {
  locationSlug: string;
};

type PendingPromise = {
  resolve: (actor: BookingActor) => void;
  reject: (reason?: unknown) => void;
};

type DialogState = {
  open: boolean;
  pending?: PendingPromise;
  contextLabel?: string;
};

type DialogPortalProps = {
  open: boolean;
  pin: string;
  submitting: boolean;
  error: string | null;
  failedAttempts: number;
  handlePinChange: (value: string) => void;
  handleCancel: () => void;
  remainingAttempts: number;
  shake: boolean;
  pinInputRef: React.RefObject<HTMLInputElement | null>;
  contextLabel?: string;
};

const PIN_LENGTH = 4;
const MAX_ATTEMPTS = 3;
const SHAKE_DURATION_MS = 400;

export function useBookingPinAuth({ locationSlug }: UseBookingPinAuthParams) {
  const { pushToast } = useToast();
  const {
    actor,
    setSession,
    registerActivity,
    endSession: contextEndSession,
    consumeManualClearFlag,
    secondsRemaining,
  } = useBookingPinSession();
  const [dialogState, setDialogState] = useState<DialogState>({ open: false });
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [shake, setShake] = useState(false);
  const previousActorRef = useRef<BookingActor | null>(actor);
  const reloadPendingRef = useRef(false);
  const pinInputRef = useRef<HTMLInputElement | null>(null);
  const shakeTimerRef = useRef<number | null>(null);

  const focusPinInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const input = pinInputRef.current;
        if (input) {
          input.focus();
          try {
            const length = input.value.length;
            input.setSelectionRange?.(length, length);
          } catch {
            // ignore selection errors (e.g. unsupported input type)
          }
        }
      });
    });
  }, []);

  const closeDialog = useCallback(() => {
    setDialogState((state) => {
      if (state.pending) {
        state.pending.reject(new Error("Booking PIN dialog aborted"));
      }
      return { open: false };
    });
    setSubmitting(false);
    setError(null);
    setPin("");
    setFailedAttempts(0);
    setShake(false);
    if (shakeTimerRef.current) {
      window.clearTimeout(shakeTimerRef.current);
      shakeTimerRef.current = null;
    }
  }, []);

  const ensureBookingActor = useCallback(
    (contextLabel?: string) => {
      console.log("[booking-pin] ensureBookingActor", { hasActor: Boolean(actor), locationSlug, contextLabel });
      if (actor) {
        const updated = registerActivity();
        if (updated) {
          return Promise.resolve(updated);
        }
        return Promise.resolve(actor);
      }
      return new Promise<BookingActor>((resolve, reject) => {
        setDialogState({ open: true, pending: { resolve, reject }, contextLabel });
        console.log("[booking-pin] opening dialog", { locationSlug, contextLabel });
      });
    },
    [actor, locationSlug, registerActivity],
  );

  useEffect(() => {
    if (!dialogState.open) {
      setPin("");
      setSubmitting(false);
      setError(null);
      setFailedAttempts(0);
      setShake(false);
      return;
    }
    setPin("");
    setSubmitting(false);
    setError(null);
    setFailedAttempts(0);
    setShake(false);
    focusPinInput();
  }, [dialogState, focusPinInput]);

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) {
        window.clearTimeout(shakeTimerRef.current);
      }
    };
  }, []);

  const handleSubmit = useCallback(
    async (explicitPin?: string) => {
      if (!dialogState.open || !dialogState.pending || submitting) {
        return;
      }
      const value = (explicitPin ?? pin).trim();
      if (!value.length) {
        setError("Bitte die Buchungs-PIN eingeben.");
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        const response = await fetch(`/api/backoffice/${locationSlug}/staff/verify-pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: value }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.data) {
          throw new Error(payload?.error ?? "PIN konnte nicht verifiziert werden.");
        }
        const nextActor = setSession({
          staffId: payload.data.staffId,
          staffName: payload.data.staffName,
          token: payload.data.token,
          expiresAt: payload.data.expiresAt,
          role: typeof payload.data.role === "string" ? payload.data.role : payload.data.role ? String(payload.data.role) : null,
        });
        const refreshed = registerActivity() ?? nextActor;
        dialogState.pending.resolve(refreshed);
        setDialogState({ open: false });
        setSubmitting(false);
        setPin("");
        setError(null);
        setFailedAttempts(0);
        setShake(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "PIN konnte nicht verifiziert werden.";
        const nextFailedAttempts = failedAttempts + 1;
        setFailedAttempts(nextFailedAttempts);
        setError(message);
        setSubmitting(false);
        setPin("");
        setShake(true);
        if (shakeTimerRef.current) {
          window.clearTimeout(shakeTimerRef.current);
        }
        shakeTimerRef.current = window.setTimeout(() => {
          setShake(false);
          shakeTimerRef.current = null;
        }, SHAKE_DURATION_MS);
        focusPinInput();
        if (nextFailedAttempts >= MAX_ATTEMPTS) {
          pushToast({ variant: "error", message: "Zu viele Fehlversuche. Dialog wird geschlossen." });
          closeDialog();
        } else {
          pushToast({ variant: "error", message });
        }
      }
    },
    [closeDialog, dialogState, failedAttempts, locationSlug, pin, pushToast, registerActivity, setSession, submitting, focusPinInput],
  );

  const handlePinChange = useCallback(
    (rawValue: string) => {
      if (submitting) return;
      const numeric = rawValue.replace(/\D/g, "").slice(0, PIN_LENGTH);
      setPin(numeric);
      if (error) {
        setError(null);
      }
      if (numeric.length === PIN_LENGTH) {
        void handleSubmit(numeric);
      }
    },
    [error, handleSubmit, submitting],
  );

  const handleCancel = useCallback(() => {
    closeDialog();
  }, [closeDialog]);

  const dialogElement = useDialogPortal({
    open: dialogState.open,
    pin,
    submitting,
    error,
    failedAttempts,
    handlePinChange,
    handleCancel,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - failedAttempts),
    shake,
    pinInputRef,
    contextLabel: dialogState.contextLabel,
  });

  const previousLocationSlugRef = useRef(locationSlug);
  useEffect(() => {
    previousLocationSlugRef.current = locationSlug;
  }, [locationSlug]);

  useEffect(() => {
    if (!dialogState.open) {
      return;
    }
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      if (previousLocationSlugRef.current !== locationSlug) {
        setDialogState({ open: false });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [dialogState.open, locationSlug]);

  useEffect(() => {
    const previous = previousActorRef.current;
    if (previous && !actor) {
      const wasManual = consumeManualClearFlag();
      if (!wasManual) {
        pushToast({ variant: "info", message: "Buchungsfreigabe abgelaufen." });
        if (!reloadPendingRef.current) {
          reloadPendingRef.current = true;
          window.setTimeout(() => {
            window.location.reload();
          }, 100);
        }
      }
    }
    previousActorRef.current = actor;
  }, [actor, consumeManualClearFlag, pushToast]);

  useEffect(() => {
    if (dialogState.open) {
      console.log("[booking-pin] dialog open");
    }
  }, [dialogState.open]);

  const endSession = useCallback(() => {
    if (actor) {
      contextEndSession();
      pushToast({ variant: "info", message: "Buchungsfreigabe beendet." });
    }
  }, [actor, contextEndSession, pushToast]);

  return {
    actor,
    ensureBookingActor,
    dialogElement,
    sessionSecondsRemaining: secondsRemaining,
    endSession,
  };
}

function useDialogPortal(props: DialogPortalProps) {
  const { open } = props;
  const portalTarget = typeof document !== "undefined" ? document.body : null;

  return useMemo(() => {
    if (!open || !portalTarget) {
      return null;
    }
    return createPortal(<BookingPinDialog {...props} />, portalTarget);
  }, [open, portalTarget, props]);
}

function BookingPinDialog({
  pin,
  submitting,
  error,
  failedAttempts,
  handlePinChange,
  handleCancel,
  remainingAttempts,
  shake,
  pinInputRef,
  contextLabel,
}: DialogPortalProps) {
  return (
    <div className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/40 p-4">
      <div className="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white shadow-2xl">
        <header className="border-b border-zinc-200 px-6 py-4">
          {contextLabel && <p className="mb-1 text-sm font-semibold text-zinc-900">{contextLabel}</p>}
          <h2 className="text-lg font-semibold text-zinc-900">Buchungs-PIN erforderlich</h2>
          <p className="mt-1 text-sm text-zinc-500">Die Eingabe wird automatisch geprüft, sobald die letzte Ziffer erfasst ist.</p>
        </header>
        <div className="space-y-4 px-6 py-4">
          <div className="space-y-1">
            <label htmlFor="booking-pin" className="text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Buchungs-PIN
            </label>
            <input
              id="booking-pin"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={pin}
              onChange={(event) => handlePinChange(event.target.value)}
              ref={pinInputRef}
              aria-invalid={Boolean(error)}
              className={`w-full rounded-lg border px-3 py-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 ${
                error
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
                  : "border-zinc-300 focus:border-zinc-900 focus:ring-zinc-900/10"
              } ${shake ? "pin-input-shake" : ""}`}
              placeholder={`PIN (${PIN_LENGTH} Ziffern)`}
              disabled={submitting}
            />
          </div>
          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
          <p className="text-xs text-zinc-400">
            Verbleibende Versuche: {remainingAttempts} / {MAX_ATTEMPTS}
          </p>
        </div>
        <footer className="flex items-center justify-end border-t border-zinc-200 px-6 py-4">
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
            disabled={submitting}
          >
            Abbrechen
          </button>
        </footer>
        {submitting && (
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70 backdrop-blur-[1px]">
            <Loader2 className="h-7 w-7 animate-spin text-zinc-700" />
          </div>
        )}
      </div>
      <style jsx>{`
        @keyframes pin-input-shake {
          0%,
          100% {
            transform: translateX(0);
          }
          20%,
          60% {
            transform: translateX(-6px);
          }
          40%,
          80% {
            transform: translateX(6px);
          }
        }

        .pin-input-shake {
          animation: pin-input-shake ${SHAKE_DURATION_MS}ms ease;
        }
      `}</style>
    </div>
  );
}
