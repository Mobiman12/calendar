"use client";

import { useState } from "react";

export function BookingCustomerNotice({ text }: { text: string }) {
  const [dismissed, setDismissed] = useState(false);
  const content = text.trim();

  if (!content || dismissed) {
    return null;
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
          <span className="text-lg">💬</span>
        </div>
        <p className="flex-1 whitespace-pre-line text-sm italic leading-5 text-slate-700">{content}</p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          aria-label="Hinweis schließen"
        >
          ×
        </button>
      </div>
    </div>
  );
}
