"use client";

import Link from "next/link";
import { X } from "lucide-react";

type KnownCustomer = {
  id: string;
  name: string;
  detailUrl: string;
  lastBookedService: string | null;
};

type IncomingCallPopupProps = {
  open: boolean;
  callerNumber: string | null;
  callerNumberRaw: string | null;
  knownCustomer: KnownCustomer | null;
  showApply: boolean;
  onApply: () => void;
  onClose: () => void;
};

export function IncomingCallPopup({
  open,
  callerNumber,
  callerNumberRaw,
  knownCustomer,
  showApply,
  onApply,
  onClose,
}: IncomingCallPopupProps) {
  if (!open) return null;

  const displayNumber = callerNumberRaw || callerNumber;
  const hasNumber = Boolean(displayNumber);
  const isKnown = Boolean(knownCustomer);

  return (
    <div
      className="fixed bottom-4 right-4 z-[2000] w-[340px] rounded-2xl border border-zinc-200 bg-white shadow-2xl"
      role="dialog"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-zinc-900">Eingehender Anruf</p>
          <p className="text-xs text-zinc-500">Live aus der Telefonanlage</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 text-zinc-500 transition hover:text-zinc-700"
          aria-label="Popup schließen"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 px-4 py-4 text-sm text-zinc-700">
        {!hasNumber && <p>Anrufer ohne Rufnummer</p>}

        {hasNumber && !isKnown && (
          <div className="space-y-1">
            <p className="font-semibold text-zinc-900">Unbekannter Anrufer</p>
            <p className="text-xs text-zinc-500">{displayNumber}</p>
          </div>
        )}

        {isKnown && knownCustomer && (
          <div className="space-y-1">
            <Link href={knownCustomer.detailUrl} className="font-semibold text-zinc-900 hover:underline">
              {knownCustomer.name}
            </Link>
            {knownCustomer.lastBookedService ? (
              <p className="text-xs text-zinc-500">Letzte Leistung: {knownCustomer.lastBookedService}</p>
            ) : null}
            {displayNumber ? <p className="text-xs text-zinc-500">{displayNumber}</p> : null}
          </div>
        )}
      </div>

      {showApply ? (
        <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-4 py-3">
          <button
            type="button"
            onClick={onApply}
            className="rounded-full bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800"
          >
            Übernehmen
          </button>
        </div>
      ) : null}
    </div>
  );
}
