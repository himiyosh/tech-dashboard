import statsJson from "../../../data/stats.json";
import type { Category } from "./data.ts";

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

export function categoryMonthlyTrend(category: Category, months = 12): CategoryMonthlyTrendBucket[] {
  const buckets = [...STATS.byMonth]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-months)
    .map((bucket) => ({
      month: bucket.month,
      count: bucket.byCategory[category] ?? 0,
    }));
  const maxMonth = Math.max(1, ...buckets.map((bucket) => bucket.count));
  return buckets.map((bucket) => ({
    ...bucket,
    height: bucket.count === 0 ? 2 : Math.max(12, Math.round((bucket.count / maxMonth) * 100)),
  }));
}