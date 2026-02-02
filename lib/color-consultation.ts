export const COLOR_CONSULTATION_REGEX = /farbberatung|color consultation|farbplanung/i;

export type HairLength = "short" | "medium" | "long";
export type HairDensity = "fine" | "normal" | "thick";
export type HairState = "natural" | "colored" | "blonded";
export type DesiredResult = "refresh" | "change";
export type YesNo = "yes" | "no";

export type ColorPrecheckAnswers = {
  hairLength?: HairLength;
  hairDensity?: HairDensity;
  hairState?: HairState;
  desiredResult?: DesiredResult;
  allergies?: YesNo;
  returning?: YesNo;
};

export type ColorDurationConfig = {
  hairLength: Record<HairLength, number>;
  hairDensity: Record<HairDensity, number>;
  hairState: Record<HairState, number>;
  desiredResult: Record<DesiredResult, number>;
  allergies: Record<YesNo, number>;
  returning: Record<YesNo, number>;
};

const COLOR_PRECHECK_FIELDS: Array<keyof ColorPrecheckAnswers> = [
  "hairLength",
  "hairDensity",
  "hairState",
  "desiredResult",
];

const COLOR_PRECHECK_OPTIONS = {
  hairLength: ["short", "medium", "long"] as const,
  hairDensity: ["fine", "normal", "thick"] as const,
  hairState: ["natural", "colored", "blonded"] as const,
  desiredResult: ["refresh", "change"] as const,
  allergies: ["yes", "no"] as const,
  returning: ["yes", "no"] as const,
};

export function isColorConsultationName(name: string): boolean {
  return COLOR_CONSULTATION_REGEX.test(name);
}

export function createDefaultColorDurationConfig(): ColorDurationConfig {
  return {
    hairLength: { short: 0, medium: 0, long: 0 },
    hairDensity: { fine: 0, normal: 0, thick: 0 },
    hairState: { natural: 0, colored: 0, blonded: 0 },
    desiredResult: { refresh: 0, change: 0 },
    allergies: { yes: 0, no: 0 },
    returning: { yes: 0, no: 0 },
  };
}

export function hasColorDurationConfig(config: ColorDurationConfig | null): boolean {
  if (!config) return false;
  const groups = [config.hairLength, config.hairDensity, config.hairState, config.desiredResult];
  return groups.some((group) => Object.values(group).some((value) => value > 0));
}

export function normalizeColorDurationConfig(raw: unknown): ColorDurationConfig | null {
  if (!isRecord(raw)) return null;
  const record = raw as Record<string, unknown>;
  return {
    hairLength: readGroup(record.hairLength, COLOR_PRECHECK_OPTIONS.hairLength),
    hairDensity: readGroup(record.hairDensity, COLOR_PRECHECK_OPTIONS.hairDensity),
    hairState: readGroup(record.hairState, COLOR_PRECHECK_OPTIONS.hairState),
    desiredResult: readGroup(record.desiredResult, COLOR_PRECHECK_OPTIONS.desiredResult),
    allergies: readGroup(record.allergies, COLOR_PRECHECK_OPTIONS.allergies),
    returning: readGroup(record.returning, COLOR_PRECHECK_OPTIONS.returning),
  };
}

export function normalizeColorPrecheckAnswers(raw: unknown): ColorPrecheckAnswers | null {
  if (!isRecord(raw)) return null;
  const record = raw as Record<string, unknown>;
  const answers: ColorPrecheckAnswers = {};
  const hairLength = readOption(record.hairLength, COLOR_PRECHECK_OPTIONS.hairLength);
  const hairDensity = readOption(record.hairDensity, COLOR_PRECHECK_OPTIONS.hairDensity);
  const hairState = readOption(record.hairState, COLOR_PRECHECK_OPTIONS.hairState);
  const desiredResult = readOption(record.desiredResult, COLOR_PRECHECK_OPTIONS.desiredResult);
  const allergies = readOption(record.allergies, COLOR_PRECHECK_OPTIONS.allergies);
  const returning = readOption(record.returning, COLOR_PRECHECK_OPTIONS.returning);

  if (hairLength) answers.hairLength = hairLength;
  if (hairDensity) answers.hairDensity = hairDensity;
  if (hairState) answers.hairState = hairState;
  if (desiredResult) answers.desiredResult = desiredResult;
  if (allergies) answers.allergies = allergies;
  if (returning) answers.returning = returning;

  return Object.keys(answers).length ? answers : null;
}

export function isColorPrecheckComplete(answers: ColorPrecheckAnswers | null): boolean {
  if (!answers) return false;
  return COLOR_PRECHECK_FIELDS.every((field) => Boolean(answers[field]));
}

export function calculateColorDurationAdjustment(
  config: ColorDurationConfig | null,
  answers: ColorPrecheckAnswers | null,
): { extraMinutes: number; complete: boolean } {
  const complete = isColorPrecheckComplete(answers);
  if (!complete || !config || !answers) {
    return { extraMinutes: 0, complete };
  }
  const extraMinutes =
    config.hairLength[answers.hairLength!] +
    config.hairDensity[answers.hairDensity!] +
    config.hairState[answers.hairState!] +
    config.desiredResult[answers.desiredResult!];
  return { extraMinutes: Math.max(0, Math.round(extraMinutes)), complete };
}

export function extractColorMetadata(metadata: unknown): {
  request: Record<string, unknown> | null;
  precheck: ColorPrecheckAnswers | null;
} {
  if (!isRecord(metadata)) {
    return { request: null, precheck: null };
  }
  const record = metadata as Record<string, unknown>;
  const requestRecord = isRecord(record.request) ? (record.request as Record<string, unknown>) : record;
  const request = isRecord(requestRecord.colorRequest) ? (requestRecord.colorRequest as Record<string, unknown>) : null;
  const precheck = normalizeColorPrecheckAnswers(requestRecord.colorPrecheck);
  return { request, precheck };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readMinutes(value: unknown): number {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.round(raw));
}

function readGroup<T extends string>(raw: unknown, keys: readonly T[]): Record<T, number> {
  const group = isRecord(raw) ? (raw as Record<string, unknown>) : {};
  return keys.reduce((acc, key) => {
    acc[key] = readMinutes(group[key]);
    return acc;
  }, {} as Record<T, number>);
}

function readOption<T extends string>(raw: unknown, options: readonly T[]): T | undefined {
  if (typeof raw !== "string") return undefined;
  return options.includes(raw as T) ? (raw as T) : undefined;
}
