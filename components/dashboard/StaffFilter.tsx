"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";

interface StaffFilterProps {
  slug: string;
  weekStart: Date;
  staffOptions: Array<{ id: string; name: string; color: string }>;
  activeStaffIds: string[];
}

export function StaffFilter({ staffOptions, activeStaffIds, slug, weekStart }: StaffFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const weekParam = searchParams.get("week");

  const toggleStaff = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    const current = new Set(activeStaffIds);
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    if (current.size) {
      params.set("staff", Array.from(current).join(","));
    } else {
      params.delete("staff");
    }
    if (!weekParam) {
      params.set("week", weekStart.toISOString().split("T")[0]);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-zinc-600">Mitarbeiter:</span>
      {staffOptions.map((staff) => {
        const selected = activeStaffIds.includes(staff.id);
        return (
          <button
            type="button"
            key={staff.id}
            onClick={() => toggleStaff(staff.id)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 transition ${
              selected ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-700 hover:bg-zinc-100"
            }`}
          >
            <span className="inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: staff.color }} />
            {staff.name}
          </button>
        );
      })}
      {activeStaffIds.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.delete("staff");
            router.push(`${pathname}?${params.toString()}`);
          }}
          className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:bg-zinc-100"
        >
          Alle anzeigen
        </button>
      )}
    </div>
  );
}
