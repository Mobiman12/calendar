import Link from "next/link";

const highlights = [
  {
    title: "Online Buchung",
    description:
      "24/7 Terminbuchung mit Live-Verfügbarkeiten, Wartelisten und automatischen Bestätigungen.",
    cta: "Terminseite öffnen",
    href: "/book/city-center-salon",
  },
  {
    title: "Marketing & CRM",
    description:
      "E-Mail-Kampagnen, Geburtstagsgrüße und halbautomatische Reaktivierungen auf Basis deiner Kundendaten.",
    cta: "Kampagnen planen",
    href: "/backoffice/city-center-salon",
  },
  {
    title: "Team & Ressourcen",
    description:
      "Wochenplanung mit Drag-&-Drop, Konfliktwarnungen und Ressourcenverwaltung in Echtzeit.",
    cta: "Dashboard öffnen",
    href: "/backoffice/city-center-salon",
  },
];

const pillars = [
  {
    label: "1",
    title: "Alle Kanäle – eine Buchungsstrecke",
    text: "Website, Google, Instagram oder QR-Code: Ein Funnel, der deine Kund:innen direkt zum passenden Slot führt.",
  },
  {
    label: "2",
    title: "Automationen, die Umsatz bringen",
    text: "Reminder, Upselling und Loyalty-Flows reduzieren No-Shows und füllen freie Zeiten – ganz ohne Mehraufwand.",
  },
  {
    label: "3",
    title: "Ein Backoffice für das ganze Team",
    text: "Live-Kalender, Auslastung und Analysen – so behältst du Kapazitäten, Mitarbeitende und Marketing-KPIs im Blick.",
  },
];

const stats = [
  { value: "60%", label: "höhere Buchungsquote nach 3 Monaten" },
  { value: "1.000+", label: "Termine/Monat pro Standort" },
  { value: "24/7", label: "Service & automatische Erinnerungen" },
];

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-950 via-black to-zinc-950 text-white">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 pb-16 pt-20 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl space-y-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-700 px-4 py-1 text-xs uppercase tracking-[0.2em] text-zinc-300">
            Timevex - Termine einfach planen - Team im Blick
          </span>
          <h1 className="text-4xl font-semibold leading-tight md:text-5xl">
            Der smarte Kalender für Salons &amp; Studios – Buchung, Marketing, Backoffice in einem Tool.
          </h1>
          <p className="text-lg text-zinc-300">
            Lass Kund:innen online buchen, versende personalisierte Kampagnen und steuere dein Team in einer modernen Oberfläche – optimiert für Conversion und Auslastung.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Link
              href="/book/city-center-salon"
              className="flex items-center justify-center rounded-md bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200"
            >
              Demo buchen
            </Link>
            <Link
              href="/backoffice/city-center-salon"
              className="flex items-center justify-center rounded-md border border-zinc-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Live-Kalender ansehen
            </Link>
          </div>
          <div className="grid gap-6 sm:grid-cols-3">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                <p className="text-2xl font-semibold">{stat.value}</p>
                <p className="text-xs text-zinc-300">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="w-full max-w-md space-y-6 rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur">
          <h2 className="text-lg font-semibold">Produkt-Tour</h2>
          <p className="text-sm text-zinc-300">
            Drei Use-Cases zeigen dir, wie Booking, Marketing und Backoffice zusammenspielen. Spring direkt zum Modul oder starte im Demo-Kalender.
          </p>
          <div className="space-y-3">
            {highlights.map((highlight) => (
              <Link
                key={highlight.title}
                href={highlight.href}
                className="block rounded-xl border border-white/10 bg-black/40 px-4 py-3 transition hover:border-white/40 hover:bg-black/20"
              >
                <p className="text-sm font-medium text-white">{highlight.title}</p>
                <p className="text-xs text-zinc-300">{highlight.description}</p>
                <span className="mt-2 inline-flex items-center gap-2 text-xs font-semibold text-emerald-300">
                  {highlight.cta}
                  <span aria-hidden>→</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <div className="grid gap-6 md:grid-cols-3">
          {pillars.map((pillar) => (
            <div key={pillar.label} className="space-y-3 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/30 text-xs font-semibold text-emerald-300">
                {pillar.label}
              </span>
              <h3 className="text-lg font-semibold text-white">{pillar.title}</h3>
              <p className="text-sm text-zinc-300">{pillar.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 pb-20">
        <div className="grid gap-8 rounded-3xl border border-white/10 bg-white/5 p-8 backdrop-blur md:grid-cols-2">
          <div className="space-y-4">
            <h2 className="text-2xl font-semibold text-white">All-in-one für dein Wachstum</h2>
            <ul className="space-y-3 text-sm text-zinc-200">
              <li>
                <span className="font-semibold text-white">CRM &amp; Zahlungsstatus</span> – alle Kund:innen mit Terminhistorie, Einwilligungen und offenen Zahlungen.
              </li>
              <li>
                <span className="font-semibold text-white">Marketing Automation</span> – Segmentierung, Trigger-Kampagnen, Reports und ROI-Messung.
              </li>
              <li>
                <span className="font-semibold text-white">Reporting</span> – Umsatz, Auslastung, Team-Performance und Marketing-KPIs in einem Dashboard.
              </li>
            </ul>
            <Link
              href="/backoffice/city-center-salon"
              className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200"
            >
              Backoffice öffnen <span aria-hidden>→</span>
            </Link>
          </div>
          <div className="grid gap-4 rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-zinc-200">
            <h3 className="text-base font-semibold text-white">Demo Agenda</h3>
            <p>Erlebe den Flow live:</p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>Termin online buchen und ICS erhalten</li>
              <li>Reminder &amp; Marketing-Kampagne planen</li>
              <li>Team im Backoffice verwalten und Termin verschieben</li>
            </ol>
            <p className="text-xs text-zinc-400">Noch Fragen? Wir begleiten dich gerne beim Setup.</p>
          </div>
        </div>
      </section>
    </main>
  );
}
