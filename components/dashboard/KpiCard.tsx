interface KpiCardProps {
  label: string;
  value: string;
  helper?: string;
  trendLabel?: string;
  trendValue?: string;
}

export function KpiCard({ label, value, helper, trendLabel, trendValue }: KpiCardProps) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-6 shadow-sm">
      <p className="text-xs uppercase tracking-widest text-zinc-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-zinc-900">{value}</p>
      {helper && <p className="mt-1 text-xs text-zinc-500">{helper}</p>}
      {trendLabel && trendValue && (
        <p className="mt-3 text-xs font-medium text-emerald-600">
          {trendLabel}: {trendValue}
        </p>
      )}
    </div>
  );
}
