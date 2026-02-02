export const dynamic = "force-dynamic";
export const revalidate = 0;

import { CompanySettingsTabs } from "@/components/dashboard/CompanySettingsTabs";
import { getPrismaClient } from "@/lib/prisma";
import { deriveBookingPreferences } from "@/lib/booking-preferences";
import { Prisma } from "@prisma/client";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { readTenantContext } from "@/lib/tenant";
import { getSessionOrNull } from "@/lib/session";
import { isAdminRole } from "@/lib/access-control";

interface CompanySettingsPageProps {
  params: Promise<{ location: string }>;
}

export default async function CompanySettingsPage({ params }: CompanySettingsPageProps) {
  const { location } = await params;
  const prisma = getPrismaClient();
  const hdrs = await headers();
  const session = await getSessionOrNull();
  if (!isAdminRole(session?.role)) {
    redirect(`/backoffice/${location}/calendar`);
  }
  const tenantContext = readTenantContext(hdrs);
  const tenantId = tenantContext?.id ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  const selectLocation = {
    select: {
      slug: true,
      name: true,
      timezone: true,
      email: true,
      phone: true,
      addressLine1: true,
      addressLine2: true,
      postalCode: true,
      city: true,
      country: true,
      metadata: true,
      schedules: {
        where: { ownerType: "LOCATION", isDefault: true },
        include: { rules: true },
        take: 1,
      },
      staff: {
        where: { status: "ACTIVE" },
        select: {
          id: true,
          displayName: true,
          firstName: true,
          lastName: true,
        },
        orderBy: [{ displayName: "asc" }, { firstName: "asc" }],
      },
    },
  } as const;

  let locationRecord = await prisma.location.findFirst(
    tenantId ? { where: { tenantId: tenantId, slug: location }, ...selectLocation } : { where: { slug: location }, ...selectLocation },
  );
  if (!locationRecord && tenantId) {
    // Fallback ohne Tenant-Filter (dev/debug), falls Header/Session nicht passt
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, ...selectLocation });
  }

  if (!locationRecord) {
    notFound();
  }

  const metadataRecord = parseMetadataRecord(locationRecord.metadata);
  const bookingPreferences = deriveBookingPreferences(metadataRecord?.bookingPreferences ?? null);
  const labelMap: Record<string, string> = {
    MONDAY: "Montag",
    TUESDAY: "Dienstag",
    WEDNESDAY: "Mittwoch",
    THURSDAY: "Donnerstag",
    FRIDAY: "Freitag",
    SATURDAY: "Samstag",
    SUNDAY: "Sonntag",
  };
  type ScheduleEntry = { weekday: string; label: string; isOpen: boolean; start: string; end: string };
type ClosureEntry = { id: string; startDate: string; startTime: string; endDate: string; endTime: string; reason: string };
type AbsenceEntry = { id: string; staffId: string; startDate: string; startTime: string; endDate: string; endTime: string; reason: string };
type CompanyProfile = {
  description: string;
  website: string;
  facebook: string;
  instagram: string;
  xProfile: string;
  newsletterText: string;
  imprint: string;
  customLegalText: boolean;
  terms: string;
  privacy: string;
  customName?: boolean;
  displayName?: string;
};

  const bookingScheduleFromMetadata: ScheduleEntry[] | undefined = Array.isArray(metadataRecord?.companyBookingSchedule)
    ? (metadataRecord?.companyBookingSchedule as unknown[])
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;
          const weekdayValue = typeof record.weekday === "string" ? record.weekday : null;
          if (!weekdayValue) return null;
          const weekday = weekdayValue as string;
          const label = labelMap[weekday] ?? weekday;
          return {
            weekday,
            label,
            isOpen: Boolean(record.isOpen),
            start: typeof record.start === "string" ? record.start : "09:00",
            end: typeof record.end === "string" ? record.end : "18:00",
          };
        })
        .filter((entry): entry is ScheduleEntry => Boolean(entry))
    : undefined;

  const scheduleRules = locationRecord.schedules?.[0]?.rules ?? [];
  const bookingScheduleFromRules: ScheduleEntry[] | undefined =
    scheduleRules.length > 0
      ? scheduleRules.map((rule) => {
          const weekday = String(rule.weekday);
          return {
            weekday,
            label: labelMap[weekday] ?? weekday,
            isOpen: rule.isActive ?? false,
            start: minutesToTime(rule.startsAt ?? 540),
            end: minutesToTime(rule.endsAt ?? 1080),
          };
        })
      : undefined;

  const closuresFromMetadata: ClosureEntry[] | undefined = Array.isArray(metadataRecord?.companyClosures)
    ? (metadataRecord?.companyClosures as unknown[])
        .map((entry, index) => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;
          const idValue = typeof record.id === "string" && record.id.length ? record.id : `closure-${index}`;
          return {
            id: idValue,
            startDate: typeof record.startDate === "string" ? record.startDate : new Date().toISOString().slice(0, 10),
            startTime: typeof record.startTime === "string" ? record.startTime : "09:00",
            endDate: typeof record.endDate === "string" ? record.endDate : new Date().toISOString().slice(0, 10),
            endTime: typeof record.endTime === "string" ? record.endTime : "18:00",
            reason: typeof record.reason === "string" ? record.reason : "Schließtag",
          };
        })
        .filter((entry): entry is ClosureEntry => Boolean(entry))
    : undefined;

  const absencesFromMetadata: AbsenceEntry[] | undefined = Array.isArray(metadataRecord?.companyAbsences)
    ? (metadataRecord?.companyAbsences as unknown[])
        .map((entry, index) => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;
          const idValue = typeof record.id === "string" && record.id.length ? record.id : `absence-${index}`;
          const staffIdValue = typeof record.staffId === "string" ? record.staffId : "";
          return {
            id: idValue,
            staffId: staffIdValue,
            startDate: typeof record.startDate === "string" ? record.startDate : new Date().toISOString().slice(0, 10),
            startTime: typeof record.startTime === "string" ? record.startTime : "09:00",
            endDate: typeof record.endDate === "string" ? record.endDate : new Date().toISOString().slice(0, 10),
            endTime: typeof record.endTime === "string" ? record.endTime : "18:00",
            reason: typeof record.reason === "string" ? record.reason : "Abwesenheit",
          };
        })
        .filter((entry): entry is AbsenceEntry => Boolean(entry))
    : undefined;

  const profileFromMetadata: CompanyProfile | undefined = (() => {
    const record = metadataRecord;
    if (!record) return undefined;
    const profile = record.companyProfile;
    if (!profile || typeof profile !== "object") return undefined;
    const profileRecord = profile as Record<string, unknown>;
    return {
      description: typeof profileRecord.description === "string" ? profileRecord.description : "",
      website: typeof profileRecord.website === "string" ? profileRecord.website : "",
      facebook: typeof profileRecord.facebook === "string" ? profileRecord.facebook : "",
      instagram: typeof profileRecord.instagram === "string" ? profileRecord.instagram : "",
      xProfile: typeof profileRecord.xProfile === "string" ? profileRecord.xProfile : "",
      newsletterText: typeof profileRecord.newsletterText === "string" ? profileRecord.newsletterText : "",
      imprint: typeof profileRecord.imprint === "string" ? profileRecord.imprint : "",
      customLegalText: Boolean(profileRecord.customLegalText),
      terms: typeof profileRecord.terms === "string" ? profileRecord.terms : "",
      privacy: typeof profileRecord.privacy === "string" ? profileRecord.privacy : "",
      customName: Boolean(profileRecord.customName),
      displayName: typeof profileRecord.displayName === "string" ? profileRecord.displayName : "",
    };
  })();
  const preferredName =
    profileFromMetadata?.customName && profileFromMetadata.displayName?.trim().length
      ? profileFromMetadata.displayName.trim()
      : null;

  const companyLocation = {
    name: preferredName ?? locationRecord.name ?? locationRecord.slug,
    slug: locationRecord.slug,
    email: locationRecord.email,
    phone: locationRecord.phone,
    addressLine1: locationRecord.addressLine1,
    addressLine2: locationRecord.addressLine2,
    postalCode: locationRecord.postalCode,
    city: locationRecord.city,
    country: locationRecord.country,
    timezone: locationRecord.timezone ?? "Europe/Berlin",
    bookingSchedule: bookingScheduleFromMetadata ?? bookingScheduleFromRules,
    closures: closuresFromMetadata,
    absences: absencesFromMetadata,
    staffOptions: locationRecord.staff.map((staff) => {
      const fallbackName = `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim();
      return {
        id: staff.id,
        name: staff.displayName ?? (fallbackName.length ? fallbackName : "Mitarbeiter"),
      };
    }),
    shiftPlanEnabled: bookingPreferences.shiftPlan,
    profile: profileFromMetadata,
  };

  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Organisation</p>
        <h1 className="text-3xl font-semibold text-zinc-900">Unternehmenseinstellungen</h1>
        <p className="text-sm text-zinc-600">
          Verwalte zentrale Informationen für {companyLocation.name}. Änderungen wirken sich auf alle Standorte und Teams aus.
        </p>
      </header>

      <CompanySettingsTabs location={companyLocation} />
    </section>
  );
}

function parseMetadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (value === Prisma.JsonNull || value === Prisma.DbNull) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function minutesToTime(value: number) {
  const hours = Math.floor(value / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
