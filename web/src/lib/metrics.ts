import { ARCHIVE_MONTHS, ARCHIVE_TOTAL_ENTRIES } from "./archive.ts";
import {
  ALL_ENTRIES,
  PUBLISHABLE_ENTRIES,
  CATEGORY_META,
  GENERATED_AT,
  WORKER_HEALTH,
  fallbackMetrics,
  jstDateKey,
} from "./data.ts";
import { SOURCE_META } from "./source-meta.ts";
import { STATS } from "./stats.ts";

export interface DashboardMetrics {
  generatedAt: string;
  indexGeneratedAt: string;
  statsGeneratedAt: string;
  liveEntries: number;
  allTimeEntries: number;
  todayEntries: number;
  majorEntries: number;
  activeSourceCount: number;
  totalSourceCount: number;
  sourceCoverageLabel: string;
  totalCategories: number;
  archiveEntries: number;
  archiveMonths: number;
  last24hEntries: number;
  last7dEntries: number;
  last30dEntries: number;
  workerLastRunAt: string | null;
  workerBatchLabel: string;
  workerSourceOkLabel: string;
  fallbackEntries: number;
  realSummaryEntries: number;
  fallbackPercent: number;
  summaryQueueMode: string;
  summaryQueueCandidates: number;
  summaryQueueBacklog: number;
  summaryQueueDrainEstimateHours: number;
}

function latestIso(values: Array<string | null | undefined>): string {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return new Date(0).toISOString();
  return new Date(Math.max(...timestamps)).toISOString();
}

export function buildDashboardMetrics(now = new Date()): DashboardMetrics {
  const todayKey = jstDateKey(now.toISOString());
  const liveToday = ALL_ENTRIES.filter((entry) => jstDateKey(entry.publishedAt) === todayKey).length;
  const countSince = (ms: number): number => {
    const cutoff = now.getTime() - ms;
    return ALL_ENTRIES.filter((entry) => Date.parse(entry.publishedAt) >= cutoff).length;
  };
  const activeSourceCount = new Set(ALL_ENTRIES.map((entry) => entry.source)).size;
  const totalSourceCount = SOURCE_META.length;
  const sourceCoverageLabel = activeSourceCount === totalSourceCount
    ? String(activeSourceCount)
    : `${activeSourceCount}/${totalSourceCount}`;
  const fallback = fallbackMetrics(ALL_ENTRIES);

  return {
    generatedAt: latestIso([GENERATED_AT, STATS.generatedAt, WORKER_HEALTH?.lastRunAt ?? null]),
    indexGeneratedAt: GENERATED_AT,
    statsGeneratedAt: STATS.generatedAt,
    // liveEntries = entries with a real AI summary (quality/health count). Kept
    // distinct from the listed Timeline set (ALL_ENTRIES, which also includes
    // pending-summary entries) so allTimeEntries >= liveEntries stays true.
    liveEntries: PUBLISHABLE_ENTRIES.length,
    allTimeEntries: ARCHIVE_TOTAL_ENTRIES || ALL_ENTRIES.length,
    todayEntries: liveToday,
    majorEntries: PUBLISHABLE_ENTRIES.filter((entry) => entry.importance === 3).length,
    activeSourceCount,
    totalSourceCount,
    sourceCoverageLabel,
    totalCategories: CATEGORY_META.length,
    archiveEntries: ARCHIVE_TOTAL_ENTRIES,
    archiveMonths: ARCHIVE_MONTHS.length,
    last24hEntries: countSince(24 * 3600_000),
    last7dEntries: countSince(7 * 86_400_000),
    last30dEntries: countSince(30 * 86_400_000),
    workerLastRunAt: WORKER_HEALTH?.lastRunAt ?? null,
    workerBatchLabel: WORKER_HEALTH ? `${WORKER_HEALTH.batchIndex}/${WORKER_HEALTH.batchTotal}` : "no data",
    workerSourceOkLabel: WORKER_HEALTH ? `${WORKER_HEALTH.sourcesOk}/${WORKER_HEALTH.sourcesAttempted}` : "no data",
    fallbackEntries: WORKER_HEALTH?.fallbackTotal ?? fallback.fallbackEntries,
    realSummaryEntries: fallback.realSummaryEntries,
    fallbackPercent: WORKER_HEALTH?.fallbackPercent ?? fallback.fallbackPercent,
    summaryQueueMode: WORKER_HEALTH?.queueMode ?? "unknown",
    summaryQueueCandidates: WORKER_HEALTH?.enqueueCandidates ?? 0,
    summaryQueueBacklog: WORKER_HEALTH?.summaryQueueBacklog ?? WORKER_HEALTH?.fallbackTotal ?? fallback.fallbackEntries,
    summaryQueueDrainEstimateHours: WORKER_HEALTH?.summaryQueueDrainEstimateHours ?? 0,
  };
}

export const DASHBOARD_METRICS = buildDashboardMetrics();
