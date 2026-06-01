import statsJson from "../../../data/stats.json";
import { ALL_ENTRIES, type Category } from "./data.ts";

export interface DayBucket {
  date: string;
  count: number;
  byCategory: Partial<Record<Category, number>>;
}

export interface MonthBucket {
  month: string;
  count: number;
  byCategory: Partial<Record<Category, number>>;
}

export interface SourceBucket {
  source: string;
  total: number;
  last30d: number;
}

export interface CategoryMonthlyTrendBucket {
  month: string;
  count: number;
  height: number;
}

export interface CategoryDailyTrendBucket {
  key: string;
  count: number;
}

export interface CategoryDailySparkBucket {
  key: string;
  count: number;
  height: number;
}

export interface CategoryWeekOverWeek {
  thisWeek: number;
  prevWeek: number;
  deltaPct: number;
  avgPerDay: number;
  peak: { key: string; count: number } | null;
}

export interface StatsPayload {
  generatedAt: string;
  totals: {
    allTime: number;
    last30d: number;
    last7d: number;
    last24h: number;
  };
  byDay: DayBucket[];
  byMonth: MonthBucket[];
  bySource: SourceBucket[];
  byImportance: Record<"1" | "2" | "3", number>;
}

export const STATS = statsJson as StatsPayload;

const publicEntriesForCategory = (category: Category) =>
  ALL_ENTRIES.filter((entry) => entry.category === category);

export function categoryMonthlyTrend(category: Category, months = 12): CategoryMonthlyTrendBucket[] {
  const entries = publicEntriesForCategory(category);
  const buckets = [...STATS.byMonth]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-months)
    .map((bucket) => {
      const count = entries.filter((entry) => entry.publishedAt.startsWith(bucket.month)).length;
      return { month: bucket.month, count };
    });
  const maxMonth = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return buckets.map((bucket) => ({
    ...bucket,
    height: bucket.count === 0 ? 2 : Math.max(12, Math.round((bucket.count / maxMonth) * 100)),
  }));
}

function jstDateKey(time: number): string {
  // 9 hour offset to JST, then take YYYY-MM-DD.
  const jst = new Date(time + 9 * 3600_000);
  return jst.toISOString().slice(0, 10);
}

/**
 * Trailing-`days` daily totals for a category, derived from `data/stats.json`.
 * This keeps the category detail Trend chart aligned with the sidebar /
 * categories-index sparkline (single source of truth: stats.json).
 */
export function categoryDailyTrend(
  category: Category,
  days = 30,
  now = new Date(),
): CategoryDailyTrendBucket[] {
  const buckets: CategoryDailyTrendBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    buckets.push({ key: jstDateKey(now.getTime() - i * 86_400_000), count: 0 });
  }
  const idxByKey = new Map(buckets.map((bucket, i) => [bucket.key, i] as const));
  for (const entry of publicEntriesForCategory(category)) {
    const publishedAt = Date.parse(entry.publishedAt);
    if (!Number.isFinite(publishedAt)) continue;
    const i = idxByKey.get(jstDateKey(publishedAt));
    if (i === undefined) continue;
    buckets[i]!.count += 1;
  }
  return buckets;
}

/**
 * Trailing-`days` daily spark with normalized bar heights. Shared between the
 * sidebar sparkline, categories-index card chart, and category detail Trend
 * panel so all three show the same period and shape.
 */
export function categoryDailySpark(
  category: Category,
  days = 30,
  now = new Date(),
): CategoryDailySparkBucket[] {
  const buckets = categoryDailyTrend(category, days, now);
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return buckets.map((b) => ({
    ...b,
    height: b.count === 0 ? 2 : Math.max(8, Math.round((b.count / max) * 100)),
  }));
}

/** Week-over-week KPIs derived from stats.byDay (matches the daily trend chart). */
export function categoryWeekOverWeek(
  category: Category,
  now = new Date(),
): CategoryWeekOverWeek {
  const last14 = categoryDailyTrend(category, 14, now);
  const prevWeek = last14.slice(0, 7).reduce((s, b) => s + b.count, 0);
  const thisWeek = last14.slice(7, 14).reduce((s, b) => s + b.count, 0);
  const deltaPct =
    prevWeek === 0
      ? thisWeek > 0
        ? 100
        : 0
      : Math.round(((thisWeek - prevWeek) / prevWeek) * 100);
  const avgPerDay = Math.round((thisWeek / 7) * 10) / 10;
  const all = categoryDailyTrend(category, 30, now);
  const peak = all.reduce<{ key: string; count: number } | null>(
    (acc, b) => (b.count > (acc?.count ?? -1) ? { key: b.key, count: b.count } : acc),
    null,
  );
  return { thisWeek, prevWeek, deltaPct, avgPerDay, peak };
}
