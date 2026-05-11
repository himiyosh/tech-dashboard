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
import type { NormalizedEntry } from "../types.ts";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  groupArchiveEntries,
  mergeArchiveEntries,
  type ArchiveBuildStats,
  type ArchiveIndexFile,
  type ArchiveMonthFile,
} from "./archive-core.ts";

async function readMonthFile(path: string): Promise<ArchiveMonthFile | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ArchiveMonthFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeArchive(
  entries: NormalizedEntry[],
  dataDir: string,
): Promise<ArchiveBuildStats> {
  const archiveDir = join(dataDir, "archive");
  await mkdir(archiveDir, { recursive: true });

  const { byMonth, stats } = groupArchiveEntries(entries);

  const generatedAt = new Date().toISOString();

  for (const [month, incoming] of byMonth) {
    const path = join(archiveDir, `${month}.json`);
    const existing = await readMonthFile(path);
    const merged = mergeArchiveEntries(existing?.entries ?? [], incoming);
    const payload = buildArchiveMonthFile(month, merged, generatedAt);
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
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
  const idx: ArchiveIndexFile = buildArchiveIndexFile(
    months.map((month) => ({ generatedAt, month, count: perMonth[month] ?? 0, entries: [] })),
    generatedAt,
  );
  idx.totalEntries = total;
  await writeFile(
    join(archiveDir, "_index.json"),
    JSON.stringify(idx, null, 2) + "\n",
    "utf8",
  );
}
