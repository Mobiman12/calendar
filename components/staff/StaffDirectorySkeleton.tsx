"use client";

export function StaffDirectorySkeleton() {
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-zinc-200" />
        <div className="h-8 w-64 animate-pulse rounded bg-zinc-200" />
        <div className="h-4 w-72 animate-pulse rounded bg-zinc-200" />
      </header>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-8 w-20 animate-pulse rounded-full bg-zinc-200" />
        ))}
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-100 px-4 py-3">
          <div className="h-5 w-48 animate-pulse rounded bg-zinc-200" />
        </div>
        <ul className="divide-y divide-zinc-100">
          {Array.from({ length: 6 }).map((_, index) => (
            <li key={index} className="flex items-center justify-between px-4 py-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 animate-pulse rounded-full border border-zinc-200 bg-zinc-100" />
                <div className="space-y-2">
                  <div className="h-4 w-40 animate-pulse rounded bg-zinc-200" />
                  <div className="h-3 w-24 animate-pulse rounded bg-zinc-100" />
                </div>
              </div>
              <div className="h-6 w-20 animate-pulse rounded-full bg-zinc-100" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
