"use client";

import { useMemo } from "react";

interface ServiceFilterProps {
  services: Array<{ id: string; name: string; duration: number; price: number; currency: string }>;
  selectedServiceId: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (id: string) => void;
}

export function ServiceFilter({ services, selectedServiceId, filter, onFilterChange, onSelect }: ServiceFilterProps) {
  const quickPicks = useMemo(() => services.slice(0, 3), [services]);

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex flex-1 min-w-[220px] max-w-sm items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-600 focus-within:border-zinc-900 focus-within:ring-2 focus-within:ring-zinc-900">
        <span>Suche</span>
        <input
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder="z. B. Balayage"
          className="w-full border-none bg-transparent text-sm text-zinc-900 focus:outline-none"
        />
      </label>
      {quickPicks.map((service) => (
        <button
          key={service.id}
          type="button"
          onClick={() => onSelect(service.id)}
          className={`flex items-center gap-2 rounded-full border px-3 py-1 transition ${
            selectedServiceId === service.id
              ? "border-zinc-900 bg-zinc-900 text-white"
              : "border-zinc-300 text-zinc-700 hover:bg-zinc-100"
          }`}
        >
          <span>{service.name}</span>
          <span className="text-xs text-zinc-500">{service.duration} Min</span>
        </button>
      ))}
      {filter && (
        <button
          type="button"
          onClick={() => onFilterChange("")}
          className="rounded-full border border-zinc-300 px-3 py-1 text-zinc-600 hover:bg-zinc-100"
        >
          Filter zurücksetzen
        </button>
      )}
    </div>
  );
}
