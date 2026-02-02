import { AppointmentItemStatus, AppointmentStatus, type PrismaClient } from "@prisma/client";

type TillhubConfigResponse = {
  tillhub?: {
    enabled?: boolean;
  };
};

async function isTillhubEnabledForLocation(prisma: PrismaClient, locationId: string): Promise<boolean> {
  const baseUrl = process.env.CONTROL_PLANE_URL?.trim();
  if (!baseUrl) return false;
  try {
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: { tenantId: true },
    });
    if (!location?.tenantId) return false;
    const url = new URL("/api/internal/tillhub/config", baseUrl);
    url.searchParams.set("tenantId", location.tenantId);
    const secret = process.env.PROVISION_SECRET?.trim();
    const response = await fetch(url.toString(), {
      headers: secret ? { "x-provision-secret": secret } : undefined,
      cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as TillhubConfigResponse;
    return Boolean(payload?.tillhub?.enabled);
  } catch {
    return false;
  }
}

/**
 * Marks past appointments as completed once their end time has passed.
 * Updates both the appointment status itself and any pending appointment items.
 */
export async function autoCompletePastAppointments(prisma: PrismaClient, locationId: string) {
  if (await isTillhubEnabledForLocation(prisma, locationId)) {
    return;
  }
  const now = new Date();
  const staleAppointments = await prisma.appointment.findMany({
    where: {
      locationId,
      endsAt: { lt: now },
      status: { in: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
    },
    select: { id: true },
  });

  if (!staleAppointments.length) {
    return;
  }

  const appointmentIds = staleAppointments.map((entry) => entry.id);

  await prisma.$transaction([
    prisma.appointment.updateMany({
      where: { id: { in: appointmentIds } },
      data: {
        status: AppointmentStatus.COMPLETED,
        updatedAt: now,
      },
    }),
    prisma.appointmentItem.updateMany({
      where: {
        appointmentId: { in: appointmentIds },
        status: { in: [AppointmentItemStatus.PENDING, AppointmentItemStatus.SCHEDULED] },
      },
      data: {
        status: AppointmentItemStatus.COMPLETED,
      },
    }),
  ]);
}
