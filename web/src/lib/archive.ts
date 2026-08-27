/**
 * Archive loader — reads data/archive/{YYYY-MM}.json bundles produced by
 * harness/publishers/archive-builder.ts.
 *
 * Astro builds statically, so we use import.meta.glob with eager:true to
 * inline every month file at build time. This keeps the runtime free of
 * fetches (consistent with how lib/data.ts inlines index.json).
 */
import {
  applyPublicationGate,
  isPublishableEntry,
  type NormalizedEntry,
  type RawIndexEntry,
} from "./data.ts";
import { SITE_PUBLICATION_GATE } from "./publication-gate-data.ts";

export const ARCHIVE_TIER_SUMMARY = {
  ja: "hot = live収録時点の統計用snapshot · warm = 個別記事URLを保持 · cold = 月次Archive内のみ",
  en: "hot = statistical snapshot from its live period · warm = individual URL retained · cold = monthly archive only",
} as const;

export const ARCHIVE_TIER_DETAIL = {
  ja: "hot はlive収録時点の統計用snapshotで、月別記事一覧には表示しません。保持期間後はlive indexから外れる場合があります。warm は個別記事URLを保持し、cold は月次Archive内だけで保持します。evergreen知見はwarmを維持します。",
  en: "Hot rows are statistical snapshots from their live period and are not shown in monthly article lists. They may leave the live index after retention expires. Warm entries retain an individual URL. Cold entries remain only in their monthly archive. Evergreen knowledge stays warm.",
} as const;

/** A month bundle exactly as data/archive/YYYY-MM.json stores it. */
interface ArchiveMonthPayload {
  generatedAt: string;
  month: string;
  count: number;
  storedCount: number;
  hot: number;
  warm: number;
  cold: number;
  entries: RawIndexEntry[];
}

/** The same bundle after the publication gate has annotated its entries. */
interface ArchiveMonthFile extends Omit<ArchiveMonthPayload, "entries"> {
  entries: NormalizedEntry[];
}

interface ArchiveIndexFile {
  generatedAt: string;
  months: string[];
  totalEntries: number;
  perMonth: Record<string, number>;
}

// path: web/src/lib/archive.ts → data/archive/*.json (3 levels up)
const monthModules = import.meta.glob<ArchiveMonthPayload>(
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
    const storedCount = payload.entries.length;
    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (const entry of payload.entries) {
      if (entry.archiveTier === "hot") hot++;
      else if (entry.archiveTier === "warm") warm++;
      else if (entry.archiveTier === "cold") cold++;
    }
    const entries = applyPublicationGate(payload.entries, SITE_PUBLICATION_GATE)
      .filter(isPublishableEntry);
    out[m] = {
      ...payload,
      count: entries.length,
      storedCount,
      hot,
      warm,
      cold,
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

/** Summary-ready archive entries that are rendered on monthly pages. */
export const ARCHIVE_BROWSABLE_ENTRIES = Object.values(ARCHIVE_BY_MONTH)
  .reduce((sum, month) => sum + month.count, 0);

/** All stored archive rows, including hot rows mirrored from the live index. */
export const ARCHIVE_STORED_ENTRIES = Object.values(ARCHIVE_BY_MONTH)
  .reduce((sum, month) => sum + month.storedCount, 0);

/** Warm archive entries retain individual in-site detail routes (R-022). */
export const ARCHIVE_WARM_ENTRIES: ReadonlyArray<NormalizedEntry> = (() => {
  const byId = new Map<string, NormalizedEntry>();
  for (const month of Object.values(ARCHIVE_BY_MONTH)) {
    for (const entry of month.entries) {
      if (entry.archiveTier === "warm" && !byId.has(entry.id)) {
        byId.set(entry.id, entry);
      }
    }
  }
  return [...byId.values()];
})();

export const ARCHIVE_GENERATED_AT = indexFile?.generatedAt
  ?? Object.values(ARCHIVE_BY_MONTH)[0]?.generatedAt
  ?? new Date(0).toISOString();

export interface MonthSummary {
  month: string;       // "YYYY-MM"
  label: string;       // "2026 April"
  count: number;
  storedCount: number;
  hot: number;
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
    return {
      month,
      label: labelFor(month),
      count: f.count,
      storedCount: f.storedCount,
      hot: f.hot,
      warm: f.warm,
      cold: f.cold,
    };
  });
}

export function getMonth(month: string): ArchiveMonthFile | null {
  return ARCHIVE_BY_MONTH[month] ?? null;
}

export function getMonthLabel(month: string): string {
  return labelFor(month);
}
