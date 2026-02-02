import { confirmResetAction } from "../actions";

export default async function ConfirmResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md space-y-6 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200">
        <header className="space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Passwort zurücksetzen</p>
          <h1 className="text-2xl font-semibold text-zinc-900">Neues Passwort vergeben</h1>
          <p className="text-sm text-zinc-600">Gib dein neues Passwort ein.</p>
        </header>
        <form action={confirmResetAction} className="space-y-4">
          <input type="hidden" name="token" value={token} />
          <label className="flex flex-col gap-1 text-sm text-zinc-700">
            Neues Passwort
            <input
              name="password"
              type="password"
              required
              minLength={8}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              placeholder="Mind. 8 Zeichen, Buchstaben, Zahlen, Sonderzeichen"
            />
          </label>
          <p className="text-xs text-zinc-500">
            Passwort muss mindestens 8 Zeichen lang sein und Buchstaben, Zahlen sowie ein Sonderzeichen enthalten.
          </p>
          <button
            type="submit"
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
          >
            Passwort setzen
          </button>
        </form>
      </div>
    </main>
  );
}
