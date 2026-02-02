import Link from "next/link";

interface ActivityItem {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  href?: string;
  badge?: string;
}

interface ActivityListProps {
  title: string;
  items: ActivityItem[];
  emptyLabel?: string;
}

export function ActivityList({ title, items, emptyLabel = "Keine Einträge" }: ActivityListProps) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white px-4 py-5 shadow-sm">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
      </header>
      <ul className="space-y-3">
        {items.length === 0 && <li className="text-xs text-zinc-500">{emptyLabel}</li>}
        {items.map((item) => {
          const content = (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-zinc-900">{item.title}</p>
                {item.subtitle && <p className="text-xs text-zinc-500">{item.subtitle}</p>}
              </div>
              <div className="text-right">
                {item.badge && (
                  <span className="inline-flex rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                    {item.badge}
                  </span>
                )}
                {item.meta && <p className="text-[11px] text-zinc-500">{item.meta}</p>}
              </div>
            </div>
          );

          return (
            <li key={item.id}>
              {item.href ? (
                <Link href={item.href} className="block rounded-md px-2 py-2 transition hover:bg-zinc-100">
                  {content}
                </Link>
              ) : (
                <div className="rounded-md px-2 py-2">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
