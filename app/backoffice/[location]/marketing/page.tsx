import { addDays, subDays } from "date-fns";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";

import { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { loadPoliciesForLocation } from "@/lib/policies";
import { MarketingOverview } from "@/components/dashboard/MarketingOverview";
import { PolicyOverview } from "@/components/dashboard/PolicyOverview";
import { supportsCustomerMemberships } from "@/lib/customer-memberships";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

export default async function MarketingPage({
  params,
}: {
  params: Promise<{ location: string }>;
}) {
  const { location } = await params;
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect(`/backoffice/${location}/calendar`);
  }
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  let locationRecord = await prisma.location.findFirst(
    tenantId
      ? { where: { tenantId: tenantId, slug: location }, select: { id: true, name: true, slug: true } }
      : { where: { slug: location }, select: { id: true, name: true, slug: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, select: { id: true, name: true, slug: true } });
  }

  if (!locationRecord) {
    notFound();
  }

  const marketingWindowStart = subDays(new Date(), 90);
  const membershipSupported = await supportsCustomerMemberships(prisma);
  const customerScope: Prisma.CustomerWhereInput = membershipSupported
    ? {
        OR: [
          { locationId: locationRecord.id },
          { memberships: { some: { locationId: locationRecord.id } } },
        ],
      }
    : {
        locationId: locationRecord.id,
      };

  const [
    customerStats,
    newCustomers,
    upcomingCampaigns,
    recentCustomers,
    recentCampaigns,
    notificationsForAnalytics,
    policies,
  ] = await Promise.all([
    prisma.customer.count({ where: customerScope }),
    prisma.customer.count({
      where: {
        ...customerScope,
        createdAt: { gte: subDays(new Date(), 30) },
      },
    }),
    prisma.notification.findMany({
      where: { locationId: locationRecord.id, status: "SCHEDULED" },
      orderBy: { scheduledAt: "asc" },
      take: 3,
      select: {
        id: true,
        trigger: true,
        channel: true,
        status: true,
        scheduledAt: true,
      },
    }),
    prisma.customer.findMany({
      where: customerScope,
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        createdAt: true,
        consents: {
          select: { type: true, scope: true, granted: true, grantedAt: true },
        },
      },
    }),
    prisma.notification.findMany({
      where: { locationId: locationRecord.id, status: { in: ["SENT", "FAILED"] } },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
      take: 6,
      select: {
        id: true,
        trigger: true,
        channel: true,
        status: true,
        sentAt: true,
        createdAt: true,
        metadata: true,
      },
    }),
    prisma.notification.findMany({
      where: {
        locationId: locationRecord.id,
        createdAt: { gte: marketingWindowStart },
      },
      select: {
        channel: true,
        status: true,
        metadata: true,
      },
    }),
    loadPoliciesForLocation(locationRecord.id),
  ]);

  const marketingAnalytics = summariseNotificationAnalytics(notificationsForAnalytics);

  const policiesForClient = {
    cancellation: policies.cancellation ?? null,
    deposit: policies.deposit ?? null,
    noShow: policies.noShow ?? null,
  };

  return (
    <section className="-mt-4 space-y-6 lg:-mt-6">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Marketing</p>
        <h1 className="text-3xl font-semibold text-zinc-900">
          {locationRecord.name ?? locationRecord.slug}
        </h1>
        <p className="text-sm text-zinc-600">
          CRM-Kennzahlen, Mailing-Performance und Kampagnenstatus im Blick behalten.
        </p>
      </header>

      <MarketingOverview
        stats={{
          totalCustomers: customerStats,
          newCustomers,
          activeCampaigns: upcomingCampaigns.length,
        }}
        metrics={{
          averageOpenRate: marketingAnalytics.averageOpenRate,
          averageClickRate: marketingAnalytics.averageClickRate,
          averageResponseRate: marketingAnalytics.averageResponseRate,
        }}
        channels={marketingAnalytics.channels}
        campaigns={upcomingCampaigns.map((campaign) => ({
          id: campaign.id,
          trigger: campaign.trigger,
          channel: campaign.channel,
          scheduledAt: campaign.scheduledAt,
          status: campaign.status,
        }))}
        recentCustomers={recentCustomers.map((customer) => ({
          id: customer.id,
          name: `${customer.firstName} ${customer.lastName}`.trim(),
          email: customer.email ?? undefined,
          phone: customer.phone ?? undefined,
          createdAt: customer.createdAt,
          consents: customer.consents.map((consent) => ({
            type: consent.type,
            scope: consent.scope,
            granted: consent.granted,
            grantedAt: consent.grantedAt,
          })),
        }))}
        recentCampaigns={recentCampaigns.map((notification) => ({
          id: notification.id,
          trigger: notification.trigger,
          channel: notification.channel,
          status: notification.status,
          deliveredAt: notification.sentAt ?? notification.createdAt,
          metrics: {
            openRate: extractRate(notification.metadata, "openRate"),
            clickRate: extractRate(notification.metadata, "clickRate"),
            responseRate: extractRate(notification.metadata, "responseRate"),
          },
        }))}
      />

      <PolicyOverview
        cancellation={policiesForClient.cancellation}
        deposit={policiesForClient.deposit}
        noShow={policiesForClient.noShow}
      />
    </section>
  );
}

type NotificationSlice = {
  channel: string;
  status: string;
  metadata: unknown;
};

type ChannelAnalytics = {
  channel: string;
  scheduled: number;
  sent: number;
  failed: number;
  openRate: number | null;
  clickRate: number | null;
  responseRate: number | null;
  failureRatio: number | null;
};

function summariseNotificationAnalytics(notifications: NotificationSlice[]) {
  const channelMap = new Map<
    string,
    {
      scheduled: number;
      sent: number;
      failed: number;
      openRates: number[];
      clickRates: number[];
      responseRates: number[];
    }
  >();

  const allOpenRates: number[] = [];
  const allClickRates: number[] = [];
  const allResponseRates: number[] = [];

  for (const notification of notifications) {
    const entry =
      channelMap.get(notification.channel) ?? {
        scheduled: 0,
        sent: 0,
        failed: 0,
        openRates: [],
        clickRates: [],
        responseRates: [],
      };

    switch (notification.status) {
      case "SCHEDULED":
        entry.scheduled += 1;
        break;
      case "SENT":
        entry.sent += 1;
        break;
      case "FAILED":
        entry.failed += 1;
        break;
      default:
        break;
    }

    const openRate = extractRate(notification.metadata, "openRate");
    if (openRate !== null) {
      entry.openRates.push(openRate);
      allOpenRates.push(openRate);
    }

    const clickRate = extractRate(notification.metadata, "clickRate");
    if (clickRate !== null) {
      entry.clickRates.push(clickRate);
      allClickRates.push(clickRate);
    }

    const responseRate = extractRate(notification.metadata, "responseRate");
    if (responseRate !== null) {
      entry.responseRates.push(responseRate);
      allResponseRates.push(responseRate);
    }

    channelMap.set(notification.channel, entry);
  }

  const channels: ChannelAnalytics[] = Array.from(channelMap.entries())
    .map(([channel, data]) => ({
      channel,
      scheduled: data.scheduled,
      sent: data.sent,
      failed: data.failed,
      openRate: data.openRates.length ? average(data.openRates) : null,
      clickRate: data.clickRates.length ? average(data.clickRates) : null,
      responseRate: data.responseRates.length ? average(data.responseRates) : null,
      failureRatio: computeRatio(data.failed, data.sent + data.scheduled + data.failed),
    }))
    .sort((a, b) => a.channel.localeCompare(b.channel));

  return {
    channels,
    averageOpenRate: allOpenRates.length ? average(allOpenRates) : null,
    averageClickRate: allClickRates.length ? average(allClickRates) : null,
    averageResponseRate: allResponseRates.length ? average(allResponseRates) : null,
  };
}

function extractRate(metadata: unknown, key: "openRate" | "clickRate" | "responseRate") {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const record = metadata as Record<string, unknown>;
  const directValue = normalizeRate(record[key]);
  if (directValue !== null) {
    return directValue;
  }

  const metrics = record.metrics;
  if (metrics && typeof metrics === "object") {
    const nestedValue = normalizeRate((metrics as Record<string, unknown>)[key]);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function normalizeRate(value: unknown) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  if (value < 0) {
    return null;
  }
  if (value > 1) {
    return Math.min(value / 100, 1);
  }
  return value;
}

function average(values: number[]) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function computeRatio(part: number, total: number) {
  if (total <= 0) {
    return null;
  }
  return part / total;
}
