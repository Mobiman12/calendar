"use client";

import { addDays, formatISO, subDays } from "date-fns";
import { useRouter } from "next/navigation";

interface WeekNavigatorProps {
  slug: string;
  weekStart: Date;
  staffQuery?: string;
}

export function WeekNavigator({ slug, weekStart, staffQuery }: WeekNavigatorProps) {
  const router = useRouter();

  const goToWeek = (date: Date) => {
    const params = new URLSearchParams();
    params.set("week", formatISO(date, { representation: "date" }));
    if (staffQuery) {
      params.set("staff", staffQuery);
    }
    const search = params.toString();
    const href = `/backoffice/${slug}/calendar${search ? `?${search}` : ""}`;
    router.push(href);
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <button
        type="button"
        onClick={() => goToWeek(subDays(weekStart, 7))}
        className="rounded-md border border-zinc-300 px-3 py-1 text-zinc-700 hover:bg-zinc-100"
      >
        ← Vorherige Woche
      </button>
      <button
        type="button"
        onClick={() => goToWeek(new Date())}
        className="rounded-md border border-zinc-300 px-3 py-1 text-zinc-700 hover:bg-zinc-100"
      >
        Heute
      </button>
      <button
        type="button"
        onClick={() => goToWeek(addDays(weekStart, 7))}
        className="rounded-md border border-zinc-300 px-3 py-1 text-zinc-700 hover:bg-zinc-100"
      >
        Nächste Woche →
      </button>
    </div>
  );
}
