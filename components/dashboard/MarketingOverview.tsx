"use client";

import type { ReactNode } from "react";
import { format } from "date-fns";

interface CampaignSummary {
  id: string;
  trigger: string;
  scheduledAt: Date | null;
  channel: string;
  status: string;
}

interface CustomerSummary {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  createdAt: Date;
  consents: Array<{ type: string; scope: string; granted: boolean; grantedAt: Date }>;
}

interface CampaignActivity {
  id: string;
  trigger: string;
  channel: string;
  status: string;
  deliveredAt: Date | null;
  metrics: {
    openRate: number | null;
    clickRate: number | null;
    responseRate: number | null;
  };
}

interface ChannelAnalytics {
  channel: string;
  scheduled: number;
  sent: number;
  failed: number;
  openRate: number | null;
  clickRate: number | null;
  responseRate: number | null;
  failureRatio: number | null;
}

interface MarketingOverviewProps {
  stats: {
    totalCustomers: number;
    newCustomers: number;
    activeCampaigns: number;
  };
  metrics: {
    averageOpenRate: number | null;
    averageClickRate: number | null;
    averageResponseRate: number | null;
  };
  channels: ChannelAnalytics[];
  campaigns: CampaignSummary[];
  recentCustomers: CustomerSummary[];
  recentCampaigns: CampaignActivity[];
}

export function MarketingOverview({ stats, metrics, channels, campaigns, recentCustomers, recentCampaigns }: MarketingOverviewProps) {
  const nextSteps = buildNextSteps({ channels, metrics, campaigns });

  return (
    <section className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
      <div className="col-span-full space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6">
        <h2 className="text-xl font-semibold text-white">CRM &amp; Marketing Überblick</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Aktive Kunden" value={formatNumber(stats.totalCustomers)} />
          <StatCard label="Neue Kunden (30 Tage)" value={formatNumber(stats.newCustomers)} />
          <StatCard label="Ø Öffnungsrate" value={formatPercent(metrics.averageOpenRate)} description="Basierend auf Kampagnen der letzten 90 Tage" />
          <StatCard label="Ø Klickrate" value={formatPercent(metrics.averageClickRate)} description="Letzte 90 Tage" />
          <StatCard label="Ø Response-Rate" value={formatPercent(metrics.averageResponseRate)} description="Antworten auf Follow-ups (90 Tage)" />
        </div>
      </div>

      <div className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Kanal-Performance</h3>
          <span className="text-xs uppercase tracking-widest text-zinc-500">Letzte 90 Tage</span>
        </div>
        <div className="space-y-3 text-sm text-zinc-200">
          {channels.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-zinc-400">
              Noch keine Versand- oder Öffnungsdaten vorhanden.
            </p>
          )}
          {channels.map((channel) => (
            <div key={channel.channel} className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="font-semibold text-white">{labelForChannel(channel.channel)}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="emerald">{formatPercent(channel.openRate)}</Badge>
                  <Badge tone="blue">{formatPercent(channel.clickRate)}</Badge>
                  {channel.responseRate !== null && <Badge tone="amber">{formatPercent(channel.responseRate)}</Badge>}
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
                <span className="text-zinc-400">Geplant: {channel.scheduled}</span>
                <span className="text-zinc-400">Versendet: {channel.sent}</span>
                <span className="text-red-300">Fehlgeschlagen: {channel.failed}</span>
                <span className={channel.failureRatio && channel.failureRatio > 0.05 ? "text-red-200 font-medium" : "text-zinc-400"}>
                  Fehlerquote: {formatPercent(channel.failureRatio)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lg:col-span-2 xl:col-span-2 space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Kampagnen in Arbeit</h3>
          <button
            type="button"
            className="rounded-md border border-white/20 px-3 py-1 text-xs text-emerald-200 transition hover:bg-emerald-500/10"
          >
            Kampagne planen
          </button>
        </div>
        <div className="space-y-3 text-sm text-zinc-200">
          {campaigns.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-zinc-400">
              Keine geplanten Kampagnen. <span className="text-emerald-200">Starte eine Geburtstags- oder No-Show-Aktion</span>.
            </p>
          )}
          {campaigns.map((campaign) => (
            <div key={campaign.id} className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <p className="font-semibold text-white">{labelForTrigger(campaign.trigger)}</p>
                  <StatusBadge status={campaign.status} />
                </div>
                <span className="rounded-full border border-emerald-200/30 px-2 py-0.5 text-[11px] uppercase tracking-wide text-emerald-200">
                  {campaign.channel}
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Versand am {campaign.scheduledAt ? format(new Date(campaign.scheduledAt), "dd.MM.yyyy HH:mm") : "—"}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="lg:col-span-2 xl:col-span-2 space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">Zuletzt gesendete Kampagnen</h3>
          <span className="text-xs uppercase tracking-widest text-zinc-500">Letzte 6</span>
        </div>
        <div className="space-y-3 text-sm text-zinc-200">
          {recentCampaigns.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-zinc-400">Noch keine gesendeten Kampagnen.</p>
          )}
          {recentCampaigns.map((campaign) => (
            <div key={campaign.id} className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-white">{labelForTrigger(campaign.trigger)}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    <StatusBadge status={campaign.status} />
                    <span className="rounded-full border border-zinc-400/40 px-2 py-0.5 text-[11px] uppercase tracking-wide text-zinc-200">
                      {labelForChannel(campaign.channel)}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-zinc-400">
                  {campaign.deliveredAt ? format(campaign.deliveredAt, "dd.MM.yyyy HH:mm") : "Zeitpunkt unbekannt"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
                <MetricPill label="Open" value={formatPercent(campaign.metrics.openRate)} tone="emerald" />
                <MetricPill label="Click" value={formatPercent(campaign.metrics.clickRate)} tone="blue" />
                <MetricPill label="Response" value={formatPercent(campaign.metrics.responseRate)} tone="amber" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6">
        <h3 className="text-lg font-semibold text-white">Letzte Kundenaktivität</h3>
        <div className="space-y-3 text-sm text-zinc-200">
          {recentCustomers.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-zinc-400">
              Noch keine Kunden erfasst.
            </p>
          )}
          {recentCustomers.map((customer) => (
            <div key={customer.id} className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="font-medium text-white">{customer.name || "Unbekannt"}</p>
                <span className="text-xs text-zinc-400">{format(customer.createdAt, "dd.MM.yyyy")}</span>
              </div>
              <p className="text-xs text-zinc-400">{customer.email ?? "Keine E-Mail"}</p>
              {customer.phone && <p className="text-xs text-zinc-400">{customer.phone}</p>}
              {customer.consents.length ? (
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-300">
                  {customer.consents.map((consent) => (
                    <span
                      key={`${consent.type}-${consent.scope}`}
                      className={`rounded-full border px-2 py-0.5 uppercase tracking-wide ${consent.granted ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200" : "border-zinc-500/40 bg-zinc-700/30 text-zinc-300"}`}
                    >
                      {labelForConsent(consent.type)}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-[11px] uppercase tracking-wide text-zinc-500">Keine erfassten Einwilligungen</p>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-full border border-white/20 px-3 py-1 text-xs text-emerald-200 transition hover:bg-emerald-500/10">
            Segment erstellen
          </button>
          <button className="rounded-full border border-white/20 px-3 py-1 text-xs text-zinc-300 transition hover:bg-white/10">
            Kunden exportieren
          </button>
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6">
        <h3 className="text-lg font-semibold text-white">Nächste Schritte</h3>
        <div className="space-y-3 text-sm text-zinc-200">
          {nextSteps.length === 0 && (
            <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-emerald-200">
              Alles im grünen Bereich – Kampagnen performen stabil.
            </p>
          )}
          {nextSteps.map((step) => (
            <div key={step.title} className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
              <p className="font-semibold text-white">{step.title}</p>
              <p className="mt-1 text-xs text-zinc-400">{step.description}</p>
              {step.action && (
                <button
                  type="button"
                  className="mt-3 inline-flex items-center gap-2 rounded-full border border-emerald-200/40 px-3 py-1 text-[12px] uppercase tracking-wide text-emerald-200 transition hover:bg-emerald-500/10"
                >
                  {step.action}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function StatCard({ label, value, description }: { label: string; value: string; description?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/40 p-4">
      <p className="text-2xl font-semibold text-white">{value}</p>
      <p className="text-xs uppercase tracking-widest text-zinc-300">{label}</p>
      {description && <p className="mt-1 text-[11px] text-zinc-500">{description}</p>}
    </div>
  );
}

function Badge({ tone, children }: { tone: "emerald" | "blue" | "amber"; children: ReactNode }) {
  const styles = tone === "emerald"
    ? "border-emerald-300/40 bg-emerald-400/10 text-emerald-200"
    : tone === "blue"
      ? "border-blue-300/40 bg-blue-400/10 text-blue-200"
      : "border-amber-300/40 bg-amber-400/10 text-amber-200";
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wide ${styles}`}>{children}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const { label, tone } = (() => {
    switch (normalized) {
      case "SCHEDULED":
        return { label: "Geplant", tone: "emerald" as const };
      case "SENT":
        return { label: "Gesendet", tone: "blue" as const };
      case "FAILED":
        return { label: "Fehlgeschlagen", tone: "amber" as const };
      case "CANCELLED":
        return { label: "Abgebrochen", tone: "amber" as const };
      default:
        return { label: normalized, tone: "blue" as const };
    }
  })();

  return <Badge tone={tone}>{label}</Badge>;
}

function MetricPill({ label, value, tone }: { label: string; value: string; tone: "emerald" | "blue" | "amber" }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-[11px] uppercase tracking-wide text-zinc-300">
      <Badge tone={tone}>{label}</Badge>
      <span>{value}</span>
    </span>
  );
}

function buildNextSteps({
  channels,
  metrics,
  campaigns,
}: {
  channels: ChannelAnalytics[];
  metrics: MarketingOverviewProps["metrics"];
  campaigns: CampaignSummary[];
}) {
  const steps: Array<{ title: string; description: string; action?: string }> = [];

  const failingChannels = channels.filter((channel) => (channel.failureRatio ?? 0) > 0.1);
  if (failingChannels.length) {
    const channelNames = failingChannels.map((channel) => labelForChannel(channel.channel)).join(", ");
    steps.push({
      title: "Zustellprobleme prüfen",
      description: `Hohe Fehlerquote bei ${channelNames}. Überprüfe Kampagneneinstellungen oder Versanddienstleister.`,
      action: "Fehlerberichte ansehen",
    });
  }

  if (metrics.averageResponseRate !== null && metrics.averageResponseRate < 0.15) {
    steps.push({
      title: "Follow-up verbessern",
      description: "Die Response-Rate liegt unter 15 %. Teste personalisierte SMS oder Incentives für schnelleres Feedback.",
      action: "Follow-up Vorlage bearbeiten",
    });
  }

  if (!campaigns.length) {
    steps.push({
      title: "Neue Kampagne planen",
      description: "Keine geplanten Kampagnen. Starte eine saisonale Aktion, um die Pipeline zu füllen.",
      action: "Kampagne erstellen",
    });
  }

  return steps.slice(0, 3);
}

function labelForTrigger(trigger: string) {
  switch (trigger) {
    case "BOOKING_CONFIRMATION":
      return "Buchungsbestätigungen";
    case "APPOINTMENT_REMINDER":
      return "Termin-Erinnerungen";
    case "NO_SHOW_FOLLOW_UP":
      return "No-Show Rückgewinnung";
    default:
      return trigger.replace(/_/g, " ");
  }
}

function labelForChannel(channel: string) {
  switch (channel) {
    case "EMAIL":
      return "E-Mail";
    case "SMS":
      return "SMS";
    case "WHATSAPP":
      return "WhatsApp";
    case "PUSH":
      return "Push";
    default:
      return channel;
  }
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "—";
  }
  return `${(value * 100).toFixed(1).replace(".", ",")} %`;
}

function formatNumber(value: number) {
  return value ? value.toLocaleString("de-DE") : "0";
}

function labelForConsent(type: string) {
  switch (type) {
    case "TERMS":
      return "Terms";
    case "MARKETING":
      return "Marketing";
    case "PRIVACY":
      return "Privacy";
    default:
      return type;
  }
}
