import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  AuditAction,
  AuditActorType,
  PolicyType,
  ScheduleOwnerType,
  ScheduleRuleType,
  Weekday,
  Prisma,
} from "@prisma/client";

import { getPrismaClient } from "@/lib/prisma";
import { logAuditEvent } from "@/lib/audit/logger";
import { loadPoliciesForLocation } from "@/lib/policies";
import { verifySessionToken } from "@/lib/session";

const requestSchema = z.object({
  location: z.object({
    name: z.string().min(1).max(120),
    addressLine1: z.string().max(200).optional().default(""),
    city: z.string().max(120).optional().default(""),
    timezone: z.string().min(1).max(100),
  }),
  policies: z.object({
    cancellation: z
      .object({
        windowHours: z.number().min(1).max(168),
        penaltyKind: z.enum(["percentage", "flat"]),
        penaltyValue: z.number().min(0).max(1000),
      })
      .nullable(),
    noShow: z
      .object({
        chargeKind: z.enum(["percentage", "flat"]),
        chargeValue: z.number().min(0).max(1000),
        graceMinutes: z.number().min(0).max(240),
      })
      .nullable(),
    deposit: z
      .object({
        type: z.enum(["percentage", "flat"]),
        value: z.number().min(0).max(1000),
        thresholdAmount: z.number().min(0).max(10000).nullable().optional(),
      })
      .nullable(),
  }),
  schedule: z
    .array(
      z.object({
        weekday: z.string(),
        startsAt: z.number().min(0).max(24 * 60).nullable(),
        endsAt: z.number().min(0).max(24 * 60).nullable(),
      }),
    )
    .min(1),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ location: string }> }) {
  const prisma = getPrismaClient();
  const { location } = await context.params;
  let payload: z.infer<typeof requestSchema>;

  try {
    const json = await request.json();
    payload = requestSchema.parse(json);
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((item) => item.message).join(", ") : "Invalid payload";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const sessionToken = request.cookies.get("calendar_session")?.value;
  const session = verifySessionToken(sessionToken);
  const tenantId = request.headers.get("x-tenant-id") ?? session?.tenantId ?? process.env.DEFAULT_TENANT_ID;

  let locationRecord = await prisma.location.findFirst(
    tenantId
      ? { where: { tenantId, slug: location }, select: { id: true, timezone: true } }
      : { where: { slug: location }, select: { id: true, timezone: true } },
  );
  if (!locationRecord && tenantId) {
    locationRecord = await prisma.location.findFirst({ where: { slug: location }, select: { id: true, timezone: true } });
  }

  if (!locationRecord) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  const validWeekdays = new Set<string>(Object.values(Weekday));
  for (const rule of payload.schedule) {
    if (!validWeekdays.has(rule.weekday)) {
      return NextResponse.json({ error: `Unbekannter Wochentag: ${rule.weekday}` }, { status: 400 });
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.location.update({
        where: { id: locationRecord.id },
        data: {
          name: payload.location.name.trim(),
          addressLine1: payload.location.addressLine1?.trim() || null,
          city: payload.location.city?.trim() || null,
          timezone: payload.location.timezone,
        },
      });

      await savePolicy(tx, locationRecord.id, PolicyType.CANCELLATION, payload.policies.cancellation);
      await savePolicy(tx, locationRecord.id, PolicyType.NO_SHOW, payload.policies.noShow);
      await savePolicy(tx, locationRecord.id, PolicyType.DEPOSIT, payload.policies.deposit);

      let schedule = await tx.schedule.findFirst({
        where: {
          locationId: locationRecord.id,
          ownerType: ScheduleOwnerType.LOCATION,
          isDefault: true,
        },
      });

      if (!schedule) {
        schedule = await tx.schedule.create({
          data: {
            locationId: locationRecord.id,
            ownerType: ScheduleOwnerType.LOCATION,
            name: "Standard",
            timezone: payload.location.timezone,
            isDefault: true,
          },
        });
      }

      for (const rule of payload.schedule) {
        const weekday = rule.weekday as Weekday;
        if (rule.startsAt === null || rule.endsAt === null) {
          await tx.scheduleRule.updateMany({
            where: { scheduleId: schedule.id, weekday },
            data: { isActive: false },
          });
          continue;
        }

        if (rule.startsAt >= rule.endsAt) {
          throw new Error(`Ungültige Zeitspanne für ${weekday}`);
        }

        const existingRule = await tx.scheduleRule.findFirst({
          where: { scheduleId: schedule.id, weekday },
        });

        if (existingRule) {
          await tx.scheduleRule.update({
            where: { id: existingRule.id },
            data: {
              startsAt: rule.startsAt,
              endsAt: rule.endsAt,
              isActive: true,
            },
          });
        } else {
          await tx.scheduleRule.create({
            data: {
              scheduleId: schedule.id,
              ruleType: ScheduleRuleType.WEEKLY,
              weekday,
              startsAt: rule.startsAt,
              endsAt: rule.endsAt,
              isActive: true,
            },
          });
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Einstellungen konnten nicht gespeichert werden";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const updatedPolicies = await loadPoliciesForLocation(locationRecord.id);

  await logAuditEvent({
    locationId: locationRecord.id,
    actorType: AuditActorType.USER,
    actorId: null,
    action: AuditAction.UPDATE,
    entityType: "location_settings",
    entityId: locationRecord.id,
    diff: {
      location: payload.location,
      policies: payload.policies,
      schedule: payload.schedule,
    },
    context: { source: "backoffice_settings" },
    ipAddress: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  });

  return NextResponse.json({ success: true, policies: updatedPolicies });
}

type PrismaTransactionClient = Prisma.TransactionClient;

type CancellationInput = z.infer<typeof requestSchema>["policies"]["cancellation"];
type NoShowInput = z.infer<typeof requestSchema>["policies"]["noShow"];
type DepositInput = z.infer<typeof requestSchema>["policies"]["deposit"];
type CancellationConfig = NonNullable<CancellationInput>;
type NoShowConfig = NonNullable<NoShowInput>;
type DepositConfig = NonNullable<DepositInput>;
type PolicyPayload = CancellationConfig | NoShowConfig | DepositConfig;

async function savePolicy(
  tx: PrismaTransactionClient,
  locationId: string,
  type: PolicyType,
  payload: CancellationInput | NoShowInput | DepositInput,
) {
  if (!payload) {
    await tx.policy.updateMany({
      where: { locationId, type },
      data: { isActive: false },
    });
    return;
  }

  const activePayload = payload as PolicyPayload;
  const configuration = buildPolicyConfiguration(type, activePayload);
  const defaults = policyDefaults[type];

  await tx.policy.upsert({
    where: {
      locationId_type: {
        locationId,
        type,
      },
    },
    update: {
      name: defaults.name,
      description: defaults.description,
      isActive: true,
      configuration,
    },
    create: {
      locationId,
      type,
      name: defaults.name,
      description: defaults.description,
      configuration,
    },
  });
}

function buildPolicyConfiguration(type: PolicyType, payload: PolicyPayload): Prisma.InputJsonValue {
  switch (type) {
    case PolicyType.CANCELLATION: {
      const cancellation = payload as CancellationConfig;
      const config = {
        windowHours: cancellation.windowHours,
        penalty: {
          kind: cancellation.penaltyKind,
          value: cancellation.penaltyValue,
        },
      };
      return config as Prisma.InputJsonValue;
    }
    case PolicyType.NO_SHOW: {
      const noShow = payload as NoShowConfig;
      const config = {
        charge: {
          kind: noShow.chargeKind,
          value: noShow.chargeValue,
        },
        graceMinutes: noShow.graceMinutes,
      };
      return config as Prisma.InputJsonValue;
    }
    case PolicyType.DEPOSIT: {
      const deposit = payload as DepositConfig;
      const config: Record<string, unknown> = {
        thresholdAmount: deposit.thresholdAmount ?? null,
      };
      if (deposit.type === "percentage") {
        config.percentage = deposit.value;
      }
      if (deposit.type === "flat") {
        config.flatAmount = deposit.value;
      }
      return config as Prisma.InputJsonValue;
    }
    default:
      return payload as Prisma.InputJsonValue;
  }
}

const policyDefaults: Record<PolicyType, { name: string; description: string | null }> = {
  [PolicyType.CANCELLATION]: {
    name: "Stornierung",
    description: "Konfiguration via Backoffice",
  },
  [PolicyType.NO_SHOW]: {
    name: "No-Show",
    description: "Konfiguration via Backoffice",
  },
  [PolicyType.DEPOSIT]: {
    name: "Anzahlung",
    description: "Konfiguration via Backoffice",
  },
};
