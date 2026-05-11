export type FreshnessSourceType = "blog" | "release" | "changelog" | "paper" | "community";

export interface FreshnessProfile {
  category: string;
  sourceType: FreshnessSourceType;
}

export interface FreshnessThreshold {
  staleHrs: number;
  errorHrs: number;
}

export type FreshnessStatus = "ok" | "stale" | "error" | "no-data";

export interface SourceFreshness {
  ageHrs: number;
  status: FreshnessStatus;
  threshold: FreshnessThreshold;
}

export function freshnessThresholdFor(source: FreshnessProfile): FreshnessThreshold {
  if (source.sourceType === "release" || source.sourceType === "changelog") {
    return { staleHrs: 24 * 30, errorHrs: 24 * 120 };
  }
  if (source.sourceType === "community") {
    return { staleHrs: 24 * 7, errorHrs: 24 * 30 };
  }
  if (source.sourceType === "paper" || source.category === "research") {
    return { staleHrs: 24 * 14, errorHrs: 24 * 60 };
  }
  return { staleHrs: 42, errorHrs: 168 };
}

export function hoursSince(iso: string | undefined | null, nowMs = Date.now()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((nowMs - timestamp) / 3600_000));
}

export function sourceFreshnessStatus(
  source: FreshnessProfile,
  latestCollected: string | undefined | null,
  nowMs = Date.now(),
): SourceFreshness {
  const threshold = freshnessThresholdFor(source);
  if (!latestCollected) {
    return { ageHrs: -1, status: "no-data", threshold };
  }

  const ageHrs = hoursSince(latestCollected, nowMs);
  if (!Number.isFinite(ageHrs) || ageHrs > threshold.errorHrs) {
    return { ageHrs, status: "error", threshold };
  }
  if (ageHrs > threshold.staleHrs) {
    return { ageHrs, status: "stale", threshold };
  }
  return { ageHrs, status: "ok", threshold };
}