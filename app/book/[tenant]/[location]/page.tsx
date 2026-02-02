import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getPrismaClient } from "@/lib/prisma";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { resolveBookingTenant } from "@/lib/booking-tenant";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { normalizeColorDurationConfig } from "@/lib/color-consultation";

interface PageProps {
  params: Promise<{ tenant: string; location: string }>;
}

type ServiceMetadata = {
  onlineBookable?: boolean;
  assignedStaffIds?: unknown;
  isComplex?: boolean;
  addOnServiceIds?: unknown;
  colorConsultationDurations?: unknown;
};

export default async function BookingPage({ params }: PageProps) {
  const { tenant, location } = await params;
  const prisma = getPrismaClient();
  const resolution = await resolveBookingTenant(tenant);
  if (!resolution) {
    notFound();
  }

  const locationRecord = await prisma.location.findFirst({
    where: { tenantId: resolution.tenantId, slug: location },
    select: {
      id: true,
      slug: true,
      name: true,
      timezone: true,
      metadata: true,
      services: {
        where: { status: "ACTIVE" },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          basePrice: true,
          priceCurrency: true,
          duration: true,
          metadata: true,
          categoryId: true,
          category: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (!locationRecord) {
    notFound();
  }

  const locationMetadata =
    locationRecord.metadata && typeof locationRecord.metadata === "object" && !Array.isArray(locationRecord.metadata)
      ? (locationRecord.metadata as Record<string, unknown>)
      : null;
  const locationLogo =
    typeof locationMetadata?.logoUrl === "string" && locationMetadata.logoUrl.trim().length
      ? locationMetadata.logoUrl.trim()
      : null;
  const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.trim() || "http://localhost:3003";
  const locationLogoUrl =
    locationLogo && locationLogo.startsWith("/") ? `${controlPlaneUrl}${locationLogo}` : locationLogo;
  const bookingPreferences = deriveBookingPreferences(locationMetadata?.bookingPreferences ?? null);
  const companyProfile =
    locationMetadata?.companyProfile && typeof locationMetadata.companyProfile === "object" && !Array.isArray(locationMetadata.companyProfile)
      ? (locationMetadata.companyProfile as Record<string, unknown>)
      : null;
  const companyProfileLinks = {
    terms: typeof companyProfile?.terms === "string" ? companyProfile.terms.trim() : "",
    privacy: typeof companyProfile?.privacy === "string" ? companyProfile.privacy.trim() : "",
    imprint: typeof companyProfile?.imprint === "string" ? companyProfile.imprint.trim() : "",
  };
  if (!bookingPreferences.onlineBookingEnabled) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center px-6 py-12 text-center text-zinc-900">
        <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Online-Buchung</p>
        <h1 className="mt-3 text-3xl font-semibold text-zinc-900">Online-Buchung deaktiviert</h1>
        <p className="mt-3 text-sm text-zinc-600">
          Dieser Standort nimmt aktuell keine Online-Buchungen an. Bitte kontaktiere das Team direkt.
        </p>
      </main>
    );
  }

  const bannerHeight = bookingPreferences.bookingBannerHeight;
  const bannerFit = bookingPreferences.bookingBannerFit;
  const hasBanner = Boolean(bookingPreferences.bookingBannerImageUrl);
  const bannerImageClass =
    bannerFit === "contain" ? "h-full w-full object-contain" : "h-full w-full object-cover";
  const customerNotice =
    bookingPreferences.customerNoticeEnabled && bookingPreferences.customerNoticeText.trim().length
      ? bookingPreferences.customerNoticeText.trim()
      : null;

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-12 px-6 py-12">
      <div className="absolute inset-x-0 top-0 hidden h-56 bg-gradient-to-br from-zinc-100 via-white to-transparent lg:block" aria-hidden="true" />
      <div className="relative">
        <section className="space-y-6">
          {hasBanner ? (
            <div
              className="relative hidden overflow-hidden rounded-3xl border border-zinc-200 bg-white shadow-sm sm:block"
              style={
                {
                  "--banner-height": `${bannerHeight}px`,
                } as React.CSSProperties
              }
            >
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-transparent sm:hidden" />
              <img
                src={bookingPreferences.bookingBannerImageUrl}
                alt={`Buchungsbanner ${locationRecord.name ?? locationRecord.slug}`}
                className={`${bannerImageClass} h-16 sm:h-[var(--banner-height)]`}
              />
              <div className="absolute left-4 top-4 flex items-center gap-3 text-white sm:hidden">
                {locationLogoUrl ? (
                  <img
                    src={locationLogoUrl}
                    alt={`Logo ${locationRecord.name ?? locationRecord.slug}`}
                    className="h-9 w-9 rounded-lg border border-white/20 bg-white/10 object-contain"
                  />
                ) : null}
                <span className="text-base font-semibold">{locationRecord.name ?? locationRecord.slug}</span>
              </div>
            </div>
          ) : null}
          <div className="max-w-3xl space-y-2">
            <div className="flex items-center gap-3">
              {locationLogoUrl ? (
                <img
                  src={locationLogoUrl}
                  alt={`Logo ${locationRecord.name ?? locationRecord.slug}`}
                  className="h-16 w-16 rounded-2xl border border-zinc-200 bg-white object-contain sm:h-32 sm:w-32 sm:rounded-3xl"
                />
              ) : null}
              <h1 className="text-[20px] font-semibold text-zinc-900 sm:text-4xl">
                {locationRecord.name ?? locationRecord.slug}
              </h1>
            </div>
          </div>
          <Suspense fallback={<p className="text-zinc-500">Lade Buchungswidget …</p>}>
            <BookingFlow
              tenantSlug={resolution.tenantSlug}
              location={{
                id: locationRecord.id,
                slug: locationRecord.slug,
                name: locationRecord.name ?? locationRecord.slug,
                timezone: locationRecord.timezone ?? "Europe/Berlin",
              }}
              theme={{
                accentColor: bookingPreferences.bookingButtonColor,
                accentTextColor: bookingPreferences.bookingButtonTextColor,
              }}
              bookingPreferences={{
                showAnyStaffOption: bookingPreferences.showAnyStaffOption,
                hideLastNames: bookingPreferences.hideLastNames,
                servicesPerBooking: bookingPreferences.servicesPerBooking,
                serviceListLimit: bookingPreferences.serviceListLimit,
              }}
              initialServices={locationRecord.services
                .filter((service) => {
                  const metadata = service.metadata as ServiceMetadata | null;
                  const onlineBookable =
                    typeof metadata?.onlineBookable === "boolean" ? metadata.onlineBookable : true;
                  const assignedStaffIds = resolveAssignedStaffIds(metadata);
                  return onlineBookable && assignedStaffIds.length > 0;
                })
                .map((service) => ({
                  id: service.id,
                  name: service.name,
                  description: service.description ?? undefined,
                  durationMin: service.duration,
                  priceCents: service.basePrice ? Math.round(Number(service.basePrice) * 100) : undefined,
                  isComplex: typeof (service.metadata as ServiceMetadata | null)?.isComplex === "boolean"
                    ? (service.metadata as ServiceMetadata).isComplex
                    : undefined,
                  categoryId: service.category?.id ?? service.categoryId ?? undefined,
                  categoryName: service.category?.name ?? undefined,
                  assignedStaffIds: resolveAssignedStaffIds(service.metadata as ServiceMetadata | null),
                  addOnServiceIds: resolveAddOnServiceIds(service.metadata as ServiceMetadata | null),
                  colorConsultationDurations: normalizeColorDurationConfig(
                    (service.metadata as ServiceMetadata | null)?.colorConsultationDurations,
                  ),
                }))}
              companyProfile={companyProfileLinks}
              customerNotice={customerNotice ?? undefined}
            />
          </Suspense>
        </section>
      </div>
    </main>
  );
}

function resolveAssignedStaffIds(metadata: ServiceMetadata | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = metadata.assignedStaffIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function resolveAddOnServiceIds(metadata: ServiceMetadata | null): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = metadata.addOnServiceIds;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}
