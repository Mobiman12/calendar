export type RepeatSeriesMetadata = {
  seriesId: string;
  frequency: "DAILY" | "WEEKLY";
  interval: number;
  index: number;
  until: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function extractRepeatSeries(metadata: unknown): RepeatSeriesMetadata | null {
  if (!isRecord(metadata)) return null;
  const repeat = metadata.repeat;
  if (!isRecord(repeat)) return null;
  const seriesId = repeat.seriesId;
  const frequency = repeat.frequency;
  const interval = repeat.interval;
  const index = repeat.index;
  const until = repeat.until;
  if (typeof seriesId !== "string" || !seriesId.trim()) return null;
  if (frequency !== "DAILY" && frequency !== "WEEKLY") return null;
  if (typeof interval !== "number" || !Number.isFinite(interval) || interval < 1) return null;
  const normalizedIndex = typeof index === "number" && Number.isFinite(index) ? index : 0;
  const normalizedUntil = typeof until === "string" ? until : null;
  return {
    seriesId,
    frequency,
    interval,
    index: normalizedIndex,
    until: normalizedUntil,
  };
}
