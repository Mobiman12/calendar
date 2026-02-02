"use client";

import { PlusCircle } from "lucide-react";

type NewCustomerButtonProps = {
  href: string;
};

export function NewCustomerButton({ href }: NewCustomerButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window === "undefined") return;
        window.open(href, "_blank", "noopener,noreferrer,width=720,height=760");
      }}
      className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
    >
      <PlusCircle className="h-4 w-4" />
      Kunde anlegen
    </button>
  );
}
