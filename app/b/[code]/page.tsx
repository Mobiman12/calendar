import { notFound } from "next/navigation";

import { getPrismaClient } from "@/lib/prisma";
import { hashAppointmentAccessToken } from "@/lib/appointments/access-tokens";

interface PageProps {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type ServiceLine = {
  name: string;
  price: number | null;
  currency: string;
};

export default async function BookingShortManagePage({ params, searchParams }: PageProps) {
  const [{ code }, query] = await Promise.all([params, searchParams]);

  const prisma = getPrismaClient();
  const codeHash = hashAppointmentAccessToken(code);
  const accessToken = await prisma.appointmentAccessToken.findFirst({
    where: {
      OR: [{ shortCodeHash: codeHash }, { tokenHash: codeHash }],
    },
    include: {
      appointment: {
        select: {
          id: true,
          status: true,
          startsAt: true,
          endsAt: true,
          totalAmount: true,
          currency: true,
          confirmationCode: true,
          cancelReason: true,
          cancelledAt: true,
          customer: {
            select: { firstName: true, lastName: true, email: true, phone: true },
          },
          location: {
            select: {
              id: true,
              slug: true,
              name: true,
              timezone: true,
              phone: true,
              addressLine1: true,
              city: true,
              tenantId: true,
            },
          },
          items: {
            select: {
              id: true,
              price: true,
              currency: true,
              service: { select: { name: true } },
              staff: {
                select: {
                  displayName: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!accessToken?.appointment) {
    notFound();
  }

  const now = new Date();
  const appointment = accessToken.appointment;
  const timezone = appointment.location.timezone ?? "Europe/Berlin";
  const isExpired = accessToken.expiresAt <= now;
  const isRevoked = Boolean(accessToken.revokedAt);
  const isCancelled = appointment.status === "CANCELLED";
  const canCancel = !isExpired && !isRevoked && !isCancelled;

  const statusParam = typeof query.status === "string" ? query.status : null;
  const errorParam = typeof query.error === "string" ? query.error : null;

  const appointmentDate = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "full",
    timeZone: timezone,
  }).format(appointment.startsAt);
  const appointmentTime = `${new Intl.DateTimeFormat("de-DE", {
    timeStyle: "short",
    timeZone: timezone,
  }).format(appointment.startsAt)} – ${new Intl.DateTimeFormat("de-DE", {
    timeStyle: "short",
    timeZone: timezone,
  }).format(appointment.endsAt)}`;

  const cancellationDeadline = accessToken.expiresAt;
  const cancellationLabel = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(cancellationDeadline);

  const serviceLines: ServiceLine[] = appointment.items.map((item) => ({
    name: item.service?.name ?? "Leistung",
    price: item.price ? Number(item.price) : null,
    currency: item.currency ?? appointment.currency ?? "EUR",
  }));

  const staffNames = Array.from(
    new Set(
      appointment.items
        .map((item) => formatStaffName(item.staff))
        .filter((name): name is string => Boolean(name)),
    ),
  );

  const customerName = `${appointment.customer?.firstName ?? ""} ${appointment.customer?.lastName ?? ""}`.trim();
  const locationLabel = appointment.location.name ?? appointment.location.slug;
  const locationAddress = [appointment.location.addressLine1, appointment.location.city].filter(Boolean).join(", ");
  const locationPhone = appointment.location.phone?.trim() ?? "";
  const locationMapUrl = locationAddress
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(locationAddress)}`
    : null;

  const totalAmount = Number(appointment.totalAmount);
  const totalLabel = Number.isFinite(totalAmount)
    ? formatPrice(totalAmount, appointment.currency ?? "EUR")
    : null;

  return (
    <main className="relative mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Termin</p>
          <h1 className="mt-2 text-4xl font-semibold text-zinc-900">Termin gebucht</h1>
          <p className="mt-2 text-sm text-zinc-600">Wir freuen uns auf Ihren Besuch.</p>
        </div>
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-2xl text-blue-600">
          ✓
        </div>
      </header>

      {statusParam === "cancelled" || isCancelled ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          Der Termin wurde storniert.
        </div>
      ) : null}

      {errorParam ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorParam}
        </div>
      ) : null}

      {!canCancel && !isCancelled ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          Stornierung ist nicht mehr möglich. Der Link ist abgelaufen. Bitte kontaktiere uns telefonisch.
        </div>
      ) : null}

      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-6">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Leistung</h2>
              <ul className="mt-3 space-y-2 text-base text-zinc-900">
                {serviceLines.map((service, index) => (
                  <li key={`${service.name}-${index}`} className="flex items-center justify-between gap-6">
                    <span>{service.name}</span>
                    <span className="text-sm text-zinc-600">
                      {service.price != null ? formatPrice(service.price, service.currency) : ""}
                    </span>
                  </li>
                ))}
              </ul>
              {totalLabel ? (
                <p className="mt-3 text-sm text-zinc-600">Gesamtbetrag: {totalLabel}</p>
              ) : null}
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Mitarbeiter</h2>
              <p className="mt-2 text-base text-zinc-900">{staffNames.length ? staffNames.join(", ") : "—"}</p>
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Datum</h2>
              <p className="mt-2 text-base text-zinc-900">{appointmentDate}</p>
              <p className="text-base text-zinc-900">{appointmentTime}</p>
            </div>
          </div>

          <div className="w-full max-w-sm space-y-6">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Termin verwalten</h2>
              <p className="mt-2 text-sm text-zinc-600">
                Stornierung möglich bis {cancellationLabel}.
              </p>
              {canCancel ? (
                <form action={`/b/${encodeURIComponent(code)}/cancel`} method="post" className="mt-4 space-y-4">
                  <div>
                    <label className="text-sm font-medium text-zinc-700" htmlFor="reason">
                      Grund der Stornierung (optional)
                    </label>
                    <textarea
                      id="reason"
                      name="reason"
                      rows={3}
                      className="mt-2 w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm text-zinc-900 shadow-sm focus:border-zinc-400 focus:outline-none"
                      placeholder="z. B. kurzfristig verhindert"
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex w-full items-center justify-center rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-500"
                  >
                    Termin stornieren
                  </button>
                </form>
              ) : null}
            </div>

            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Standort</h2>
              <p className="mt-2 text-base text-zinc-900">{locationLabel}</p>
              {locationPhone ? (
                <p className="text-sm text-zinc-600">
                  <a href={`tel:${locationPhone}`} className="underline underline-offset-2">
                    {locationPhone}
                  </a>
                </p>
              ) : null}
              {locationAddress ? (
                <p className="text-sm text-zinc-600">
                  {locationMapUrl ? (
                    <a href={locationMapUrl} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                      {locationAddress}
                    </a>
                  ) : (
                    locationAddress
                  )}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-8 rounded-2xl border border-zinc-100 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
          Bestätigungscode: <span className="font-medium text-zinc-900">{appointment.confirmationCode}</span>
          {customerName ? <span className="ml-2 text-zinc-500">· {customerName}</span> : null}
        </div>
      </section>
    </main>
  );
}

function formatStaffName(staff: { displayName: string | null; firstName: string | null; lastName: string | null } | null) {
  if (!staff) return null;
  const direct = staff.displayName?.trim();
  if (direct) return direct;
  const fallback = `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim();
  return fallback || null;
}

function formatPrice(amount: number, currency: string) {
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}
