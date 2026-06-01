/**
 * Archive loader — reads data/archive/{YYYY-MM}.json bundles produced by
 * harness/publishers/archive-builder.ts.
 *
 * Astro builds statically, so we use import.meta.glob with eager:true to
 * inline every month file at build time. This keeps the runtime free of
 * fetches (consistent with how lib/data.ts inlines index.json).
 */
import { isPublishableEntry, type NormalizedEntry } from "./data.ts";

interface ArchiveMonthFile {
  generatedAt: string;
  month: string;
  count: number;
  entries: NormalizedEntry[];
}

interface ArchiveIndexFile {
  generatedAt: string;
  months: string[];
  totalEntries: number;
  perMonth: Record<string, number>;
}

// path: web/src/lib/archive.ts → data/archive/*.json (3 levels up)
const monthModules = import.meta.glob<ArchiveMonthFile>(
  "../../../data/archive/[0-9]*.json",
  { eager: true, import: "default" },
);

let indexFile: ArchiveIndexFile | null = null;
try {
  // Optional — if backfill hasn't been run, _index.json may not exist yet.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  indexFile = (await import("../../../data/archive/_index.json")).default as ArchiveIndexFile;
} catch {
  indexFile = null;
}

/** Map of "YYYY-MM" → full month payload. */
export const ARCHIVE_BY_MONTH: Readonly<Record<string, ArchiveMonthFile>> = (() => {
  const out: Record<string, ArchiveMonthFile> = {};
  for (const [path, payload] of Object.entries(monthModules)) {
    const m = path.match(/(\d{4}-\d{2})\.json$/)?.[1];
    if (!m || !payload) continue;
    const entries = payload.entries.filter(isPublishableEntry);
    out[m] = {
      ...payload,
      count: entries.length,
      entries,
    };
  }
  return out;
})();

/** All available months, newest first. */
export const ARCHIVE_MONTHS: ReadonlyArray<string> = Object.keys(ARCHIVE_BY_MONTH)
  .filter((month) => (ARCHIVE_BY_MONTH[month]?.count ?? 0) > 0)
  .sort()
  .reverse();

export const ARCHIVE_TOTAL_ENTRIES = Object.values(ARCHIVE_BY_MONTH).reduce((sum, m) => sum + m.count, 0);

export const ARCHIVE_GENERATED_AT = indexFile?.generatedAt
  ?? Object.values(ARCHIVE_BY_MONTH)[0]?.generatedAt
  ?? new Date(0).toISOString();

export interface MonthSummary {
  month: string;       // "YYYY-MM"
  label: string;       // "2026 April"
  count: number;
  warm: number;
  cold: number;
}

const MONTH_LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  timeZone: "UTC",
});

function labelFor(month: string): string {
  // Use UTC midnight so the formatter doesn't shift the month.
  return MONTH_LABEL_FMT.format(new Date(`${month}-01T00:00:00Z`));
}

export function getMonthSummaries(): MonthSummary[] {
  return ARCHIVE_MONTHS.map((month) => {
    const f = ARCHIVE_BY_MONTH[month]!;
    let warm = 0;
    let cold = 0;
    for (const e of f.entries) {
      if (e.archiveTier === "warm") warm++;
      else if (e.archiveTier === "cold") cold++;
    }
    return { month, label: labelFor(month), count: f.count, warm, cold };
  });
}

export function getMonth(month: string): ArchiveMonthFile | null {
  return ARCHIVE_BY_MONTH[month] ?? null;
}

export function getMonthLabel(month: string): string {
  return labelFor(month);
}
