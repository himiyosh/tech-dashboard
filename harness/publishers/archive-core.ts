import type { ArchiveTier, NormalizedEntry } from "../types.ts";

export const ARCHIVE_TIERS: ReadonlySet<ArchiveTier> = new Set(["warm", "cold"]);

/**
 * Tiers retained for stats/byDay continuity. Includes `hot` so live entries
 * remain countable even after they are evicted from data/index.json by
 * PER_SOURCE_CAP or by aging into `dropped` (LL: 案 1 — current-month archive).
 */
export const RETAINED_TIERS: ReadonlySet<ArchiveTier> = new Set(["hot", "warm", "cold"]);

export interface ArchiveMonthFile {
  generatedAt: string;
  month: string;
  count: number;
  entries: NormalizedEntry[];
}

export interface ArchiveIndexFile {
  generatedAt: string;
  months: string[];
  totalEntries: number;
  perMonth: Record<string, number>;
}

export interface ArchiveBuildStats {
  monthsTouched: number;
  entriesArchived: number;
  entriesDropped: number;
  entriesSkippedHot: number;
}

export function archiveBucketOf(entry: NormalizedEntry): string {
  const iso = entry.publishedAt ?? entry.collectedAt;
  return iso.slice(0, 7);
}

export function groupArchiveEntries(
  entries: readonly NormalizedEntry[],
  options: { includeHot?: boolean } = {},
): {
  byMonth: Map<string, NormalizedEntry[]>;
  stats: ArchiveBuildStats;
} {
  const includeHot = options.includeHot ?? false;
  const accept: ReadonlySet<ArchiveTier> = includeHot ? RETAINED_TIERS : ARCHIVE_TIERS;
  const stats: ArchiveBuildStats = {
    monthsTouched: 0,
    entriesArchived: 0,
    entriesDropped: 0,
    entriesSkippedHot: 0,
  };
  const byMonth = new Map<string, NormalizedEntry[]>();

  for (const entry of entries) {
    const tier = entry.archiveTier;
    if (tier === "dropped") {
      stats.entriesDropped++;
      continue;
    }
    if (!tier || !accept.has(tier)) {
      stats.entriesSkippedHot++;
      continue;
    }
    const month = archiveBucketOf(entry);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(entry);
    byMonth.set(month, bucket);
    stats.entriesArchived++;
  }

  stats.monthsTouched = byMonth.size;
  return { byMonth, stats };
}

export function mergeArchiveEntries(
  existing: readonly NormalizedEntry[],
  incoming: readonly NormalizedEntry[],
): NormalizedEntry[] {
  const byId = new Map<string, NormalizedEntry>();
  for (const entry of existing) byId.set(entry.id, entry);
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bTime - aTime;
  });
}

export function buildArchiveMonthFile(
  month: string,
  entries: readonly NormalizedEntry[],
  generatedAt: string,
): ArchiveMonthFile {
  return {
    generatedAt,
    month,
    count: entries.length,
    entries: [...entries],
  };
}

export function buildArchiveIndexFile(
  months: readonly ArchiveMonthFile[],
  generatedAt: string,
): ArchiveIndexFile {
  const sortedMonths = [...months]
    .filter((month) => /^\d{4}-\d{2}$/.test(month.month))
    .sort((a, b) => b.month.localeCompare(a.month));
  const perMonth: Record<string, number> = {};
  let totalEntries = 0;
  for (const month of sortedMonths) {
    perMonth[month.month] = month.count;
    totalEntries += month.count;
  }
  return {
    generatedAt,
    months: sortedMonths.map((month) => month.month),
    totalEntries,
    perMonth,
  };
}