import { ARCHIVE_MONTHS, ARCHIVE_TOTAL_ENTRIES } from "./archive.ts";
import {
  ALL_ENTRIES,
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
  const statsToday = STATS.byDay.find((bucket) => bucket.date === todayKey)?.count;
  const liveToday = ALL_ENTRIES.filter((entry) => jstDateKey(entry.publishedAt) === todayKey).length;
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
    liveEntries: ALL_ENTRIES.length,
    allTimeEntries: STATS.totals.allTime,
    todayEntries: statsToday ?? liveToday,
    majorEntries: ALL_ENTRIES.filter((entry) => entry.importance === 3).length,
    activeSourceCount,
    totalSourceCount,
    sourceCoverageLabel,
    totalCategories: CATEGORY_META.length,
    archiveEntries: ARCHIVE_TOTAL_ENTRIES,
    archiveMonths: ARCHIVE_MONTHS.length,
    last24hEntries: STATS.totals.last24h,
    last7dEntries: STATS.totals.last7d,
    last30dEntries: STATS.totals.last30d,
    workerLastRunAt: WORKER_HEALTH?.lastRunAt ?? null,
    workerBatchLabel: WORKER_HEALTH ? `${WORKER_HEALTH.batchIndex}/${WORKER_HEALTH.batchTotal}` : "no data",
    workerSourceOkLabel: WORKER_HEALTH ? `${WORKER_HEALTH.sourcesOk}/${WORKER_HEALTH.sourcesAttempted}` : "no data",
    fallbackEntries: WORKER_HEALTH?.fallbackTotal ?? fallback.fallbackEntries,
    realSummaryEntries: fallback.realSummaryEntries,
    fallbackPercent: WORKER_HEALTH?.fallbackPercent ?? fallback.fallbackPercent,
    summaryQueueMode: WORKER_HEALTH?.queueMode ?? "unknown",
    summaryQueueCandidates: WORKER_HEALTH?.enqueueCandidates ?? 0,
  };
}

export const DASHBOARD_METRICS = buildDashboardMetrics();
