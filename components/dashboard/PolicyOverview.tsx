interface PolicyOverviewProps {
  cancellation?: {
    windowHours: number;
    penalty: {
      kind: "percentage" | "flat";
      value: number;
    };
  } | null;
  deposit?: {
    thresholdAmount?: number;
    percentage?: number;
    flatAmount?: number;
  } | null;
  noShow?: {
    charge: {
      kind: "percentage" | "flat";
      value: number;
    };
    graceMinutes: number;
  } | null;
}

export function PolicyOverview({ cancellation, deposit, noShow }: PolicyOverviewProps) {
  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-zinc-200">
      <h3 className="text-lg font-semibold text-white">Richtlinien</h3>
      <div className="mt-4 space-y-4">
        <PolicyCard
          title="Stornierung"
          description={cancellation ? formatCancellation(cancellation) : "Keine Stornierungsrichtlinie hinterlegt."}
        />
        <PolicyCard
          title="Nicht erschienen"
          description={noShow ? formatNoShow(noShow) : "Keine Gebühr für nicht erschienene Kund:innen definiert."}
        />
        <PolicyCard
          title="Anzahlung"
          description={deposit ? formatDeposit(deposit) : "Keine Anzahlung erforderlich."}
        />
      </div>
    </section>
  );
}

function PolicyCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-4">
      <p className="text-xs uppercase tracking-widest text-zinc-400">{title}</p>
      <p className="mt-1 text-sm text-zinc-200">{description}</p>
    </div>
  );
}

function formatCancellation(policy: NonNullable<PolicyOverviewProps["cancellation"]>) {
  const penalty =
    policy.penalty.kind === "percentage"
      ? `${policy.penalty.value}% des Servicepreises`
      : formatCurrency(policy.penalty.value);
  return `Kostenfrei bis ${policy.windowHours}h vorher, danach ${penalty}.`;
}

function formatNoShow(policy: NonNullable<PolicyOverviewProps["noShow"]>) {
  const charge =
    policy.charge.kind === "percentage"
      ? `${policy.charge.value}% des Servicepreises`
      : formatCurrency(policy.charge.value);
  return `${policy.graceMinutes} Minuten Kulanz, danach ${charge}.`;
}

function formatDeposit(policy: NonNullable<PolicyOverviewProps["deposit"]>) {
  if (policy.percentage !== undefined) {
    return `Anzahlung ${policy.percentage}% (ab ${formatThreshold(policy.thresholdAmount)}).`;
  }
  if (policy.flatAmount !== undefined) {
    return `Anzahlung ${formatCurrency(policy.flatAmount)} (ab ${formatThreshold(policy.thresholdAmount)}).`;
  }
  return "Anzahlung aktiviert.";
}

function formatThreshold(amount?: number) {
  return amount !== undefined ? formatCurrency(amount) : "alle Services";
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(amount);
}
