import Link from "next/link";
import { loginAction } from "./actions";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md space-y-6 rounded-2xl bg-white p-8 shadow-sm ring-1 ring-zinc-200">
        <header className="space-y-2 text-center">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Calendar Backoffice</p>
          <h1 className="text-2xl font-semibold text-zinc-900">Anmelden</h1>
          <p className="text-sm text-zinc-600">Mit deinen Zugangsdaten fortfahren.</p>
        </header>
        <form action={loginAction} className="space-y-4">
          <label className="flex flex-col gap-1 text-sm text-zinc-700">
            E-Mail
            <input
              name="email"
              type="email"
              required
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              placeholder="you@example.com"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-zinc-700">
            Passwort
            <input
              name="password"
              type="password"
              required
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              placeholder="••••••••"
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800"
          >
            Einloggen
          </button>
          <div className="flex justify-center text-xs">
            <Link href="/auth/reset" className="text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline">
              Passwort vergessen?
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
