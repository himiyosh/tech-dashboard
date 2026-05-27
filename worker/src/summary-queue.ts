import type { NormalizedEntry } from "../../harness/types.ts";
import type { CacheEntry } from "./kv-cache.ts";

export interface SummaryJob {
  url: string;
  entry: Pick<
    NormalizedEntry,
    "id" | "url" | "title" | "category" | "source" | "sourceType"
  > &
    Partial<
      Pick<
        NormalizedEntry,
        | "titleJa"
        | "titleEn"
        | "summaryJa"
        | "summaryEn"
        | "lang"
        | "publishedAt"
        | "tags"
        | "importance"
      >
    >;
}

export interface SummaryJobBatch {
  jobs: SummaryJob[];
  eligibleCount: number;
  startIndex: number;
  drainEstimateHours: number;
}

const FALLBACK_SUMMARY_JA_PREFIX = "このエントリは ";
const FALLBACK_SUMMARY_EN_NEEDLE = "AI summary not yet available";
const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";

export function needsGeneratedContent(
  entry: Pick<NormalizedEntry, "summaryJa" | "summaryEn" | "bodyJa" | "bodyEn">,
): boolean {
  const summaryJa = entry.summaryJa ?? "";
  const summaryEn = entry.summaryEn ?? "";
  return (
    !summaryJa.trim() ||
    !summaryEn.trim() ||
    !String(entry.bodyJa ?? "").trim() ||
    !String(entry.bodyEn ?? "").trim() ||
    summaryJa.startsWith(FALLBACK_SUMMARY_JA_PREFIX) ||
    summaryEn.includes(FALLBACK_SUMMARY_EN_NEEDLE) ||
    String(entry.bodyEn ?? "").includes(FALLBACK_BODY_EN_NEEDLE)
  );
}

function hasRealCacheEntry(hit: CacheEntry | undefined): boolean {
  return Boolean(
    hit &&
      hit.summaryJa &&
      hit.summaryEn &&
      hit.bodyJa &&
      hit.bodyEn &&
      hit.model !== "deterministic-fallback",
  );
}

function toSummaryJob(entry: NormalizedEntry): SummaryJob {
  return {
    url: entry.url,
    entry: {
      id: entry.id,
      url: entry.url,
      title: entry.title,
      titleJa: entry.titleJa,
      titleEn: entry.titleEn,
      summaryJa: entry.summaryJa,
      summaryEn: entry.summaryEn,
      lang: entry.lang,
      publishedAt: entry.publishedAt ?? undefined,
      tags: entry.tags,
      category: entry.category,
      source: entry.source,
      sourceType: entry.sourceType,
      importance: entry.importance,
    },
  };
}

function isEligibleSummaryJob(
  entry: NormalizedEntry,
  hitsByUrl: Map<string, CacheEntry>,
  lookedUpUrls: ReadonlySet<string>,
  uncheckedFallbackUrls: ReadonlySet<string>,
): boolean {
  const isLookedUp = lookedUpUrls.has(entry.url);
  const isUncheckedFallback = uncheckedFallbackUrls.has(entry.url);
  if (!isLookedUp && !isUncheckedFallback) {
    return false;
  }
  if (isLookedUp && hasRealCacheEntry(hitsByUrl.get(entry.url))) {
    return false;
  }
  return true;
}

export function selectSummaryJobBatch(
  entries: readonly NormalizedEntry[],
  hitsByUrl: Map<string, CacheEntry>,
  lookedUpUrls: ReadonlySet<string>,
  cap: number,
  uncheckedFallbackUrls: ReadonlySet<string> = new Set(),
  opts: { nowMs?: number } = {},
): SummaryJobBatch {
  const safeCap = Math.max(1, Math.floor(cap));
  const eligible = entries.filter((entry) =>
    isEligibleSummaryJob(entry, hitsByUrl, lookedUpUrls, uncheckedFallbackUrls),
  );
  if (eligible.length === 0) {
    return { jobs: [], eligibleCount: 0, startIndex: 0, drainEstimateHours: 0 };
  }

  // Advance by one full cap-sized window per hour. Advancing by one entry per
  // hour makes a 400+ item backlog take weeks to cycle when failures persist.
  const hour = Math.floor((opts.nowMs ?? Date.now()) / 3_600_000);
  const startIndex = eligible.length > safeCap ? (hour * safeCap) % eligible.length : 0;
  const jobs: SummaryJob[] = [];
  for (let i = 0; i < Math.min(safeCap, eligible.length); i++) {
    jobs.push(toSummaryJob(eligible[(startIndex + i) % eligible.length]!));
  }

  return {
    jobs,
    eligibleCount: eligible.length,
    startIndex,
    drainEstimateHours: Math.ceil(eligible.length / safeCap),
  };
}

export function selectSummaryJobs(
  entries: readonly NormalizedEntry[],
  hitsByUrl: Map<string, CacheEntry>,
  lookedUpUrls: ReadonlySet<string>,
  cap: number,
  uncheckedFallbackUrls: ReadonlySet<string> = new Set(),
  opts: { nowMs?: number } = {},
): SummaryJob[] {
  return selectSummaryJobBatch(entries, hitsByUrl, lookedUpUrls, cap, uncheckedFallbackUrls, opts).jobs;
}
