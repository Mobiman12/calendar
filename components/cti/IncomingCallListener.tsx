"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IncomingCallPopup } from "@/components/cti/IncomingCallPopup";

type IncomingCallEvent = {
  tenant_id: string;
  caller_number: string | null;
  caller_number_raw: string | null;
  called_number: string | null;
  extension: string | null;
  line: string | null;
  ts: string;
};

type KnownCustomer = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  name: string;
  detailUrl: string;
  lastBookedService: string | null;
};

type ApplyPayload = {
  customerId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  phone?: string;
};

type IncomingMessage = {
  type?: string;
  evt?: IncomingCallEvent;
};

const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export function IncomingCallListener({ locationSlug }: { locationSlug: string }) {
  const [currentCall, setCurrentCall] = useState<IncomingCallEvent | null>(null);
  const [knownCustomer, setKnownCustomer] = useState<KnownCustomer | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const matchAbortRef = useRef<AbortController | null>(null);

  const closePopup = useCallback(() => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    matchAbortRef.current?.abort();
    matchAbortRef.current = null;
    setPopupOpen(false);
    setCurrentCall(null);
    setKnownCustomer(null);
  }, []);

  const matchCustomer = useCallback(
    async (evt: IncomingCallEvent) => {
      const hasPhone = Boolean(evt.caller_number || evt.caller_number_raw);
      if (!hasPhone || !locationSlug) return;
      matchAbortRef.current?.abort();
      const controller = new AbortController();
      matchAbortRef.current = controller;

      const params = new URLSearchParams();
      if (evt.caller_number) params.set("phone", evt.caller_number);
      if (evt.caller_number_raw) params.set("raw", evt.caller_number_raw);

      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/customers/match?${params.toString()}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) return;
        const payload = (await response.json()) as { customer?: KnownCustomer | null };
        if (controller.signal.aborted) return;
        setKnownCustomer(payload.customer ?? null);
      } catch (error) {
        if (!controller.signal.aborted) {
          setKnownCustomer(null);
        }
      }
    },
    [locationSlug],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleCreateState = (event: Event) => {
      const detail = (event as CustomEvent<{ open?: boolean }>).detail;
      setCreateOpen(Boolean(detail?.open));
    };
    window.addEventListener("cti.appointment.create", handleCreateState);
    return () => window.removeEventListener("cti.appointment.create", handleCreateState);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const source = new EventSource("/api/cti/stream");
    const handleIncoming = (event: MessageEvent<string>) => {
      let payload: IncomingMessage | null = null;
      try {
        payload = JSON.parse(event.data) as IncomingMessage;
      } catch {
        return;
      }
      if (!payload || payload.type !== "incoming_call" || !payload.evt) return;
      setCurrentCall(payload.evt);
      setKnownCustomer(null);
      setPopupOpen(true);
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      timeoutRef.current = window.setTimeout(() => {
        closePopup();
      }, MAX_TIMEOUT_MS);
      void matchCustomer(payload.evt);
    };

    source.addEventListener("incoming_call", handleIncoming);
    return () => {
      source.removeEventListener("incoming_call", handleIncoming);
      source.close();
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      matchAbortRef.current?.abort();
      matchAbortRef.current = null;
    };
  }, [closePopup, matchCustomer]);

  const showApply = Boolean(
    popupOpen &&
      createOpen &&
      (knownCustomer || currentCall?.caller_number || currentCall?.caller_number_raw),
  );

  const handleApply = useCallback(() => {
    if (typeof window === "undefined") return;
    const displayPhone = currentCall?.caller_number_raw || currentCall?.caller_number || undefined;
    const detail: ApplyPayload = knownCustomer
      ? {
          customerId: knownCustomer.id,
          firstName: knownCustomer.firstName,
          lastName: knownCustomer.lastName,
          name: knownCustomer.name,
          phone: knownCustomer.phone ?? displayPhone,
        }
      : displayPhone
        ? { phone: displayPhone }
        : {};
    if (Object.keys(detail).length) {
      window.dispatchEvent(new CustomEvent("cti.apply", { detail }));
    }
    closePopup();
  }, [closePopup, currentCall, knownCustomer]);

  return (
    <IncomingCallPopup
      open={popupOpen}
      callerNumber={currentCall?.caller_number ?? null}
      callerNumberRaw={currentCall?.caller_number_raw ?? null}
      knownCustomer={knownCustomer}
      showApply={showApply}
      onApply={handleApply}
      onClose={closePopup}
    />
  );
}
