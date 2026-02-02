export default function TrialExpiredPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md space-y-5 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200">
        <header className="space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Calendar Backoffice</p>
          <h1 className="text-2xl font-semibold text-zinc-900">Testzeitraum abgelaufen</h1>
          <p className="text-sm text-zinc-600">
            Der Zugang zu diesem Tenant ist nicht mehr aktiv.
          </p>
        </header>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Bitte wende dich an den Administrator, um den Zugang zu verlaengern.
        </div>
      </div>
    </main>
  );
}
