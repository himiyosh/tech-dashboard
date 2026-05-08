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
import type { Category, NormalizedEntry } from "../types.ts";

interface ArchiveMonthShape {
  entries: NormalizedEntry[];
}

interface DayBucket {
  date: string;
  count: number;
  byCategory: Partial<Record<Category, number>>;
}
interface MonthBucket {
  month: string;
  count: number;
  byCategory: Partial<Record<Category, number>>;
}
interface SourceBucket {
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

async function loadAllEntries(dataDir: string): Promise<NormalizedEntry[]> {
  const all = new Map<string, NormalizedEntry>();

  // Live index
  try {
    const raw = await readFile(join(dataDir, "index.json"), "utf8");
    const parsed = JSON.parse(raw) as { entries: NormalizedEntry[] };
    for (const e of parsed.entries) all.set(e.id, e);
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
          if (!all.has(e.id)) all.set(e.id, e);
        }
      } catch {
        /* skip corrupt month */
      }
    }
  } catch {
    /* no archive dir yet */
  }

  return [...all.values()];
}

export async function writeStats(dataDir: string): Promise<string> {
  const entries = await loadAllEntries(dataDir);
  const now = Date.now();

  const totals = { allTime: entries.length, last30d: 0, last7d: 0, last24h: 0 };
  const byDay = new Map<string, DayBucket>();
  const byMonth = new Map<string, MonthBucket>();
  const bySource = new Map<string, SourceBucket>();
  const byImportance: Record<"1" | "2" | "3", number> = { "1": 0, "2": 0, "3": 0 };

  for (const e of entries) {
    const iso = e.publishedAt ?? e.collectedAt;
    const t = iso ? new Date(iso).getTime() : NaN;
    const ageDays = Number.isFinite(t) ? (now - t) / DAY_MS : Infinity;

    if (ageDays <= 30) totals.last30d++;
    if (ageDays <= 7) totals.last7d++;
    if (ageDays <= 1) totals.last24h++;

    const dk = dayKey(iso);
    if (dk && ageDays <= 90) {
      const b =
        byDay.get(dk) ?? { date: dk, count: 0, byCategory: {} };
      b.count++;
      b.byCategory[e.category] = (b.byCategory[e.category] ?? 0) + 1;
      byDay.set(dk, b);
    }

    const mk = monthKey(iso);
    if (mk) {
      const b =
        byMonth.get(mk) ?? { month: mk, count: 0, byCategory: {} };
      b.count++;
      b.byCategory[e.category] = (b.byCategory[e.category] ?? 0) + 1;
      byMonth.set(mk, b);
    }

    const s =
      bySource.get(e.source) ?? { source: e.source, total: 0, last30d: 0 };
    s.total++;
    if (ageDays <= 30) s.last30d++;
    bySource.set(e.source, s);

    const imp = String(e.importance ?? 1) as "1" | "2" | "3";
    byImportance[imp] = (byImportance[imp] ?? 0) + 1;
  }

  const payload: StatsPayload = {
    generatedAt: new Date().toISOString(),
    totals,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    bySource: [...bySource.values()].sort((a, b) => b.total - a.total),
    byImportance,
  };

  const outPath = join(dataDir, "stats.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return outPath;
}
