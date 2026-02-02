"use client";

import { useMemo } from "react";
import { addMonths, format, isSameDay, isSameMonth, startOfMonth } from "date-fns";

export interface DatePickerProps {
  value: Date;
  onChange: (date: Date) => void;
  onMonthChange?: (date: Date) => void;
  minDate?: Date;
  maxDate?: Date;
  highlightedDates?: string[];
}

const weekdayLabels = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

export function DatePicker({
  value,
  onChange,
  onMonthChange,
  minDate,
  maxDate,
  highlightedDates,
}: DatePickerProps) {
  const weeks = useMemo(
    () => buildCalendar(value, minDate, maxDate, highlightedDates),
    [value, minDate, maxDate, highlightedDates],
  );

  return (
    <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700 shadow-sm">
      <header className="mb-3 flex items-center justify-between text-xs uppercase tracking-widest text-zinc-500">
        <span>{format(value, "MMMM yyyy", { locale: undefined })}</span>
        <div className="flex gap-2 text-zinc-500">
          <button
            type="button"
            onClick={() => {
              const next = addMonths(value, -1);
              if (onMonthChange) {
                onMonthChange(next);
              } else {
                onChange(next);
              }
            }}
            className="rounded border border-zinc-200 px-2 py-1 transition hover:bg-zinc-100"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => {
              const next = addMonths(value, 1);
              if (onMonthChange) {
                onMonthChange(next);
              } else {
                onChange(next);
              }
            }}
            className="rounded border border-zinc-200 px-2 py-1 transition hover:bg-zinc-100"
          >
            →
          </button>
        </div>
      </header>

      <div className="grid grid-cols-7 gap-1 text-center text-xs font-semibold text-zinc-400">
        {weekdayLabels.map((label) => (
          <div key={label} className="py-1">
            {label}
          </div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1 text-sm">
        {weeks.flat().map((day) => {
          const disabled = day.isDisabled;
          const isSelected = isSameDay(day.date, value);
          const isCurrentMonth = isSameMonth(day.date, value);
          return (
            <button
              key={day.date.toISOString()}
              type="button"
              disabled={disabled}
              onClick={() => onChange(day.date)}
              className={`relative rounded-md px-2 py-1 transition ${
                isSelected
                  ? "bg-zinc-900 text-white shadow"
                  : disabled
                    ? "cursor-not-allowed text-zinc-300"
                    : day.isHighlighted
                      ? "border border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                      : isCurrentMonth
                        ? "hover:bg-zinc-100"
                        : "text-zinc-400 hover:bg-zinc-50"
              }`}
            >
              {day.date.getDate()}
              {day.isHighlighted && !isSelected && !disabled && (
                <span className="absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-emerald-500" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function buildCalendar(selectedDate: Date, minDate?: Date, maxDate?: Date, highlightedDates?: string[]) {
  const start = startOfMonth(selectedDate);
  const startDay = ((start.getDay() + 6) % 7) + 1; // Monday as first day
  const days: Array<{ date: Date; isDisabled: boolean; isHighlighted: boolean }> = [];
  const highlightSet = new Set(highlightedDates ?? []);

  for (let i = 1 - startDay; i < 42 - startDay; i++) {
    const date = new Date(start);
    date.setDate(start.getDate() + i);
    const isDisabled = (minDate && date < minDate) || (maxDate && date > maxDate);
    const key = format(date, "yyyy-MM-dd");
    days.push({ date, isDisabled: Boolean(isDisabled), isHighlighted: highlightSet.has(key) });
  }

  return chunk(days, 7);
}

function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
