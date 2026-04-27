/**
 * archive-builder.ts — month-bucketed accumulating archive writer.
 *
 * Strategy (per docs/archive policy, 2026-04-28)
 * ----------------------------------------------
 * - Main `data/index.json` keeps only the most recent slice (hot + warm),
 *   capped by INDEX_LIMIT. Older entries would normally be lost.
 * - This builder snapshots WARM and COLD entries into per-month aggregate
 *   JSON files at `data/archive/{YYYY-MM}.json`, so they survive across runs
 *   even after they age out of index.json.
 * - DROPPED entries are excluded from both index and archive (per the
 *   "archive over retention" decision: no paid DB, accept long-tail loss).
 * - Re-running the orchestrator merges by entry.id (newer record wins),
 *   so summary improvements / tier transitions propagate.
 *
 * File layout
 * -----------
 *   data/archive/2026-04.json   { generatedAt, month, count, entries: [...] }
 *   data/archive/2026-05.json
 *   data/archive/_index.json    { months: ["2026-04", "2026-05", ...], totalEntries }
 *
 * Bucket key = entry.publishedAt's YYYY-MM (UTC). Entries with no
 * publishedAt are bucketed by collectedAt as a fallback.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveTier, NormalizedEntry } from "../types.ts";

/** Tiers eligible for the persistent archive. "hot" stays only in index.json. */
const ARCHIVE_TIERS: ReadonlySet<ArchiveTier> = new Set(["warm", "cold"]);

export interface ArchiveMonthFile {
  generatedAt: string;
  month: string; // "YYYY-MM"
  count: number;
  entries: NormalizedEntry[];
}

export interface ArchiveIndexFile {
  generatedAt: string;
  months: string[];
  totalEntries: number;
  /** Per-month counts for quick UI rendering. */
  perMonth: Record<string, number>;
}

export interface ArchiveBuildStats {
  monthsTouched: number;
  entriesArchived: number;
  entriesDropped: number;
  entriesSkippedHot: number;
}

function bucketOf(entry: NormalizedEntry): string {
  const iso = entry.publishedAt ?? entry.collectedAt;
  // Defensive slice — both fields are ISO 8601.
  return iso.slice(0, 7);
}

async function readMonthFile(path: string): Promise<ArchiveMonthFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ArchiveMonthFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Merge-by-id: new entries overwrite same-id existing entries. Order is
 * preserved by publishedAt desc within the file.
 */
function mergeEntries(
  existing: NormalizedEntry[],
  incoming: NormalizedEntry[],
): NormalizedEntry[] {
  const byId = new Map<string, NormalizedEntry>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e); // newer wins
  return [...byId.values()].sort((a, b) => {
    const aTime = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const bTime = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return bTime - aTime;
  });
}

export async function writeArchive(
  entries: NormalizedEntry[],
  dataDir: string,
): Promise<ArchiveBuildStats> {
  const archiveDir = join(dataDir, "archive");
  await mkdir(archiveDir, { recursive: true });

  const stats: ArchiveBuildStats = {
    monthsTouched: 0,
    entriesArchived: 0,
    entriesDropped: 0,
    entriesSkippedHot: 0,
  };

  // Bucket archivable entries by month.
  const byMonth = new Map<string, NormalizedEntry[]>();
  for (const e of entries) {
    const tier = e.archiveTier;
    if (tier === "dropped") {
      stats.entriesDropped++;
      continue;
    }
    if (!tier || tier === "hot") {
      stats.entriesSkippedHot++;
      continue;
    }
    // tier is "warm" | "cold"
    const key = bucketOf(e);
    const arr = byMonth.get(key) ?? [];
    arr.push(e);
    byMonth.set(key, arr);
  }

  const generatedAt = new Date().toISOString();

  for (const [month, incoming] of byMonth) {
    const path = join(archiveDir, `${month}.json`);
    const existing = await readMonthFile(path);
    const merged = mergeEntries(existing?.entries ?? [], incoming);
    const payload: ArchiveMonthFile = {
      generatedAt,
      month,
      count: merged.length,
      entries: merged,
    };
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
    stats.monthsTouched++;
    stats.entriesArchived += incoming.length;
  }

  // Refresh top-level archive index.
  await writeArchiveIndex(archiveDir, generatedAt);

  return stats;
}

async function writeArchiveIndex(archiveDir: string, generatedAt: string): Promise<void> {
  const files = (await readdir(archiveDir)).filter(
    (f) => /^\d{4}-\d{2}\.json$/.test(f),
  );
  const months = files.map((f) => f.replace(/\.json$/, "")).sort().reverse();
  const perMonth: Record<string, number> = {};
  let total = 0;
  for (const m of months) {
    const f = await readMonthFile(join(archiveDir, `${m}.json`));
    perMonth[m] = f?.count ?? 0;
    total += f?.count ?? 0;
  }
  const idx: ArchiveIndexFile = {
    generatedAt,
    months,
    totalEntries: total,
    perMonth,
  };
  await writeFile(
    join(archiveDir, "_index.json"),
    JSON.stringify(idx, null, 2) + "\n",
    "utf8",
  );
}
