/**
 * stats-builder.ts — writes data/stats.json aggregating article counts
 * across the live index and the persisted month-archive.
 *
 * This decouples "trend graph data" from `data/index.json` (which is capped
 * for performance). Stats are computed from:
 *   - data/index.json (current 2000-entry window)
 *   - data/archive/{YYYY-MM}.json (all warm/cold history)
 *
 * Output schema (data/stats.json):
 *   {
 *     generatedAt,
 *     totals: { allTime, last30d, last7d, last24h },
 *     byDay:        [{ date: "YYYY-MM-DD", count, byCategory: {...} }, ...]    // last 90 days
 *     byMonth:      [{ month: "YYYY-MM", count, byCategory: {...} }, ...]       // all
 *     bySource:     [{ source, total, last30d }, ...] sorted by total desc
 *     byImportance: { "1": n, "2": n, "3": n }
 *   }
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalUrlKey } from "../pipeline/url.ts";
import type { NormalizedEntry } from "../types.ts";
import { buildStatsPayload, type StatsPayload } from "./stats-core.ts";

interface ArchiveMonthShape {
  entries: NormalizedEntry[];
}

interface StatsInput {
  entries: NormalizedEntry[];
  generatedAt?: string;
}

function statsEntryKey(entry: NormalizedEntry): string {
  return canonicalUrlKey(entry.url) ?? entry.url ?? entry.id;
}

async function loadAllEntries(dataDir: string): Promise<StatsInput> {
  const all = new Map<string, NormalizedEntry>();
  let generatedAt: string | undefined;

  // Live index
  try {
    const raw = await readFile(join(dataDir, "index.json"), "utf8");
    const parsed = JSON.parse(raw) as { generatedAt?: unknown; entries: NormalizedEntry[] };
    if (
      typeof parsed.generatedAt === "string" &&
      Number.isFinite(Date.parse(parsed.generatedAt))
    ) {
      generatedAt = parsed.generatedAt;
    }
    for (const e of parsed.entries) all.set(statsEntryKey(e), e);
  } catch {
    /* missing on first run */
  }

  // Archive months
  const archiveDir = join(dataDir, "archive");
  try {
    const files = (await readdir(archiveDir)).filter((f) =>
      /^\d{4}-\d{2}\.json$/.test(f),
    );
    for (const f of files) {
      try {
        const raw = await readFile(join(archiveDir, f), "utf8");
        const parsed = JSON.parse(raw) as ArchiveMonthShape;
        for (const e of parsed.entries ?? []) {
          // Live entries are authoritative (newer summary etc.)
          const key = statsEntryKey(e);
          if (!all.has(key)) all.set(key, e);
        }
      } catch {
        /* skip corrupt month */
      }
    }
  } catch {
    /* no archive dir yet */
  }

  return { entries: [...all.values()], generatedAt };
}

export async function writeStats(dataDir: string): Promise<string> {
  const { entries, generatedAt } = await loadAllEntries(dataDir);
  const payload: StatsPayload = buildStatsPayload(entries, generatedAt);

  const outPath = join(dataDir, "stats.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return outPath;
}
