import { ARCHIVE_MONTHS, ARCHIVE_TOTAL_ENTRIES } from "./archive.ts";
import { dailyDisplayCount, dailyEntryCount } from "./daily-summary.ts";
import {
  ALL_ENTRIES,
  MAIN_TIMELINE_ENTRIES,
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
  timelineEntries: number;
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
  workerBatchTotal: number | null;
  workerSourceOkLabel: string;
  fallbackEntries: number;
  realSummaryEntries: number;
  fallbackPercent: number;
  summaryQueueMode: string;
  summaryQueueCandidates: number;
  summaryQueueBacklog: number;
  summaryQueueEnqueued: number | null;
  summaryQueueDrainEstimateHours: number;
  bodyQueueMode: string | null;
  bodyQueueBacklog: number | null;
  bodyQueueDrainEstimateHours: number | null;
  bodyQueueEnqueued: number | null;
  bodyQueueMerged: number | null;
  bodyQueueCandidates: number | null;
  bodyQueueEnqueueCap: number | null;
  bodyQueueLookupCount: number | null;
  enrichmentEnqueueCap: number | null;
  enrichmentEnqueued: number | null;
  enrichmentRemaining: number | null;
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
  // The partial current JST day uses the same all-lane live count as DailySummary.
  // Archive-backed stats remain authoritative only for completed days.
  const statsToday = STATS.byDay.find((bucket) => bucket.date === todayKey);
  const liveToday = dailyEntryCount(
    ALL_ENTRIES,
    todayKey,
    (entry) => jstDateKey(entry.publishedAt),
  );
  const todayCount = dailyDisplayCount(todayKey, todayKey, liveToday, statsToday?.count);
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
  const optionalMetric = (value: unknown): number | null => {
    const numeric = Number(value);
    return value === undefined || value === null || !Number.isFinite(numeric)
      ? null
      : Math.max(0, numeric);
  };

  return {
    generatedAt: latestIso([GENERATED_AT, STATS.generatedAt, WORKER_HEALTH?.lastRunAt ?? null]),
    indexGeneratedAt: GENERATED_AT,
    statsGeneratedAt: STATS.generatedAt,
    // liveEntries = entries with a real AI summary (quality/health count). Kept
    // distinct from the listed Timeline set (ALL_ENTRIES, which also includes
    // pending-summary entries) so allTimeEntries >= liveEntries stays true.
    liveEntries: PUBLISHABLE_ENTRIES.length,
    // Canonical news-Timeline size: matches the category sidebar total and the
    // sum of per-category counts. Use this for any bare "Live entries" headline
    // so taxonomy surfaces never contradict the categories they list.
    timelineEntries: MAIN_TIMELINE_ENTRIES.length,
    // All-time must be >= the live index size (LL-110 invariant). Summary-first
    // (LL-112) made nearly every entry publishable, so the live index can now
    // exceed the archive-derived total (the archive undercounts un-aged recent
    // entries). Clamp to max so the invariant holds.
    allTimeEntries: Math.max(ARCHIVE_TOTAL_ENTRIES, ALL_ENTRIES.length),
    todayEntries: todayCount,
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
    workerBatchTotal: WORKER_HEALTH?.batchTotal ?? null,
    workerSourceOkLabel: WORKER_HEALTH ? `${WORKER_HEALTH.sourcesOk}/${WORKER_HEALTH.sourcesAttempted}` : "no data",
    fallbackEntries: WORKER_HEALTH?.fallbackTotal ?? fallback.fallbackEntries,
    realSummaryEntries: fallback.realSummaryEntries,
    fallbackPercent: WORKER_HEALTH?.fallbackPercent ?? fallback.fallbackPercent,
    summaryQueueMode: WORKER_HEALTH?.queueMode ?? "unknown",
    summaryQueueCandidates: WORKER_HEALTH?.enqueueCandidates ?? 0,
    summaryQueueBacklog: WORKER_HEALTH?.summaryQueueBacklog ?? WORKER_HEALTH?.fallbackTotal ?? fallback.fallbackEntries,
    summaryQueueEnqueued: optionalMetric(WORKER_HEALTH?.summaryQueueEnqueued),
    summaryQueueDrainEstimateHours: WORKER_HEALTH?.summaryQueueDrainEstimateHours ?? 0,
    bodyQueueMode: typeof WORKER_HEALTH?.bodyQueueMode === "string"
      ? WORKER_HEALTH.bodyQueueMode
      : null,
    bodyQueueBacklog: optionalMetric(WORKER_HEALTH?.bodyBacklog),
    bodyQueueDrainEstimateHours: optionalMetric(
      WORKER_HEALTH?.bodyQueueDrainEstimateHours
      ?? WORKER_HEALTH?.bodyDrainEstimateHours,
    ),
    bodyQueueEnqueued: optionalMetric(WORKER_HEALTH?.bodyEnqueued),
    bodyQueueMerged: optionalMetric(WORKER_HEALTH?.bodyMerged),
    bodyQueueCandidates: optionalMetric(WORKER_HEALTH?.bodyEnqueueCandidates),
    bodyQueueEnqueueCap: optionalMetric(WORKER_HEALTH?.bodyEnqueueCap),
    bodyQueueLookupCount: optionalMetric(WORKER_HEALTH?.bodyLookupCount),
    enrichmentEnqueueCap: optionalMetric(WORKER_HEALTH?.enrichmentEnqueueCap),
    enrichmentEnqueued: optionalMetric(WORKER_HEALTH?.enrichmentEnqueued),
    enrichmentRemaining: optionalMetric(WORKER_HEALTH?.enrichmentRemaining),
  };
}

export const DASHBOARD_METRICS = buildDashboardMetrics();
