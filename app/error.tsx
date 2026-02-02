"use client";

import { useEffect } from "react";

function isMaintenanceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /PrismaClient|P1001|P1002|P1003|P1008|P1009|P1011|P1012|ECONNREFUSED|ECONNRESET|ENOTFOUND|connection refused|could not connect|database|Database/i.test(
    message,
  );
}

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const maintenance = isMaintenanceError(error);
  const title = maintenance ? "Wartungsarbeiten" : "Technischer Fehler";
  const description = maintenance
    ? "Unser System ist gerade nicht verfuegbar. Bitte spaeter erneut versuchen."
    : "Ein unerwarteter Fehler ist aufgetreten. Bitte spaeter erneut versuchen.";

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-16">
        <div className="w-full rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-xl">
            !
          </div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-3 text-sm text-slate-600">{description}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => reset()}
              className="rounded-full bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Erneut versuchen
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-slate-200 px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Seite neu laden
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
