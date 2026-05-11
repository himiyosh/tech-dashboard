import type { Category, NormalizedEntry } from "../types.ts";

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

const DAY_MS = 86_400_000;

function dayKey(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}

function monthKey(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 7);
}

export function buildStatsPayload(
  entries: readonly NormalizedEntry[],
  generatedAt = new Date().toISOString(),
): StatsPayload {
  const now = new Date(generatedAt).getTime();
  const totals = { allTime: entries.length, last30d: 0, last7d: 0, last24h: 0 };
  const byDay = new Map<string, DayBucket>();
  const byMonth = new Map<string, MonthBucket>();
  const bySource = new Map<string, SourceBucket>();
  const byImportance: Record<"1" | "2" | "3", number> = { "1": 0, "2": 0, "3": 0 };

  for (const entry of entries) {
    const iso = entry.publishedAt ?? entry.collectedAt;
    const time = iso ? new Date(iso).getTime() : NaN;
    const ageDays = Number.isFinite(time) ? (now - time) / DAY_MS : Infinity;

    if (ageDays <= 30) totals.last30d++;
    if (ageDays <= 7) totals.last7d++;
    if (ageDays <= 1) totals.last24h++;

    const date = dayKey(iso);
    if (date && ageDays <= 90) {
      const bucket = byDay.get(date) ?? { date, count: 0, byCategory: {} };
      bucket.count++;
      bucket.byCategory[entry.category] = (bucket.byCategory[entry.category] ?? 0) + 1;
      byDay.set(date, bucket);
    }

    const month = monthKey(iso);
    if (month) {
      const bucket = byMonth.get(month) ?? { month, count: 0, byCategory: {} };
      bucket.count++;
      bucket.byCategory[entry.category] = (bucket.byCategory[entry.category] ?? 0) + 1;
      byMonth.set(month, bucket);
    }

    const source = bySource.get(entry.source) ?? { source: entry.source, total: 0, last30d: 0 };
    source.total++;
    if (ageDays <= 30) source.last30d++;
    bySource.set(entry.source, source);

    const importance = String(entry.importance ?? 1) as "1" | "2" | "3";
    byImportance[importance] = (byImportance[importance] ?? 0) + 1;
  }

  return {
    generatedAt,
    totals,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    bySource: [...bySource.values()].sort((a, b) => b.total - a.total),
    byImportance,
  };
}