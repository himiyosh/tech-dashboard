import type { NormalizedEntry } from "../../harness/types.ts";
import {
  hasUsableBilingualSummary,
  needsSummaryGeneration,
  type SummaryQualityInput,
} from "../../harness/pipeline/summary-quality.ts";
import {
  cacheEntryMatchesPublisherContract,
  type CacheEntry,
} from "./kv-cache.ts";

export interface SummaryJob {
  url: string;
  publisherContractFingerprint?: string;
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
  cooldownCount: number;
}

export interface SummaryJobSelectionOpts {
  nowMs?: number;
  skipUrls?: ReadonlySet<string>;
  publisherContractFingerprint?: string;
}

export interface SummaryEntrySelection {
  entries: NormalizedEntry[];
  eligibleCount: number;
  startIndex: number;
  drainEstimateHours: number;
  cooldownCount: number;
}

function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Start index for an hourly round-robin window over `total` items, advancing by
 * a FULL `cap`-sized window each hour (NOT one item per hour).
 *
 * This is the single source of truth for BOTH the summary enqueue window and the
 * collector's KV-lookup / merge-back window. Keeping them symmetric is the whole
 * point: LL-076 fixed the enqueue side to advance by `cap`, but the merge-back
 * window in the collector was left advancing by 1/hour. The result was that
 * summaries were generated quickly (enqueue cycled in hours) yet merged into the
 * index at a crawl (the lookup window took `total` hours — weeks — to cycle), so
 * summaries piled up in KV unmerged and the visible backlog never drained
 * (LL-102). Both sides now call this helper so the bug cannot reappear on one
 * side only.
 */
export function roundRobinStart(nowMs: number, total: number, cap: number): number {
  const safeCap = Math.max(1, Math.floor(cap));
  if (total <= safeCap) return 0;
  const hour = Math.floor(nowMs / 3_600_000);
  return ((hour * safeCap) % total + total) % total;
}

/**
 * Order summary work with one shared priority contract:
 * evergreen first, then reserved recent slots, then a cap-sized round-robin
 * window over the remaining backlog.
 */
export function orderSummaryCandidates(
  entries: readonly NormalizedEntry[],
  cap: number,
  opts: SummaryJobSelectionOpts = {},
): SummaryEntrySelection {
  const safeCap = Math.max(1, Math.floor(cap));
  const unique: NormalizedEntry[] = [];
  const candidateUrls = new Set<string>();
  for (const entry of entries) {
    if (candidateUrls.has(entry.url)) continue;
    candidateUrls.add(entry.url);
    unique.push(entry);
  }

  const skipUrls = opts.skipUrls ?? new Set<string>();
  const cooldownCount = skipUrls.size
    ? unique.filter((entry) => skipUrls.has(entry.url)).length
    : 0;
  const eligible = skipUrls.size
    ? unique.filter((entry) => !skipUrls.has(entry.url))
    : unique;
  if (eligible.length === 0) {
    return { entries: [], eligibleCount: 0, startIndex: 0, drainEstimateHours: 0, cooldownCount };
  }

  const evergreenEligible = eligible.filter((entry) => entry.evergreen === true);
  const restEligible = eligible.filter((entry) => entry.evergreen !== true);
  const selected: NormalizedEntry[] = [];
  const selectedUrls = new Set<string>();
  const pushEntry = (entry: NormalizedEntry) => {
    if (selectedUrls.has(entry.url) || selected.length >= safeCap) return;
    selectedUrls.add(entry.url);
    selected.push(entry);
  };

  for (const entry of evergreenEligible) pushEntry(entry);

  const remainingAfterEvergreen = safeCap - selected.length;
  const recentSlots = Math.floor(remainingAfterEvergreen / 2);
  if (recentSlots > 0) {
    const byNewest = [...restEligible].sort(
      (a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt),
    );
    let recentTaken = 0;
    for (const entry of byNewest) {
      if (recentTaken >= recentSlots || selected.length >= safeCap) break;
      const before = selected.length;
      pushEntry(entry);
      if (selected.length > before) recentTaken += 1;
    }
  }

  const startIndex = roundRobinStart(opts.nowMs ?? Date.now(), restEligible.length, safeCap);
  for (let i = 0; i < restEligible.length && selected.length < safeCap; i++) {
    pushEntry(restEligible[(startIndex + i) % restEligible.length]!);
  }

  return {
    entries: selected,
    eligibleCount: eligible.length,
    startIndex,
    drainEstimateHours: Math.ceil(eligible.length / safeCap),
    cooldownCount,
  };
}

/**
 * Whether an entry still needs an AI-generated summary.
 *
 * Post LL-104/LL-106 the queue summarizer produces SUMMARIES ONLY
 * (titleJa + summaryJa + summaryEn). Long-form body generation is a separate
 * body-file pipeline (R-012/R-013). So "needs generation" must mean
 * "lacks a real bilingual summary",
 * NOT "lacks a real body". The old body checks here made every summary-only
 * entry look unfinished forever: summary-complete entries were perpetually
 * re-enqueued (wasting queue capacity) and the visible backlog never drained
 * even though generation was working (LL-107).
 */
export function needsGeneratedContent(
  entry: SummaryQualityInput,
): boolean {
  return needsSummaryGeneration(entry);
}

/**
 * Whether a KV cache hit is a real AI summary, so the entry should NOT be
 * re-enqueued. Matches the summarizer's own completeness contract
 * (isSummaryComplete): titleJa + summaryJa + summaryEn. The body is NOT
 * required — the summary-only summarizer (LL-106) writes empty bodies on
 * purpose, and requiring a body here re-enqueued every already-summarized
 * entry forever (LL-107).
 */
function hasRealCacheEntry(
  hit: CacheEntry | undefined,
  entry: NormalizedEntry,
  publisherContractFingerprint?: string,
): boolean {
  return Boolean(
    hit &&
      cacheEntryMatchesPublisherContract(hit, publisherContractFingerprint) &&
      hit.titleJa &&
      hasUsableBilingualSummary({
        ...hit,
        title: entry.title,
        titleJa: hit.titleJa || entry.titleJa,
        titleEn: entry.titleEn,
      }) &&
      hit.model !== "deterministic-fallback",
  );
}

function toSummaryJob(
  entry: NormalizedEntry,
  publisherContractFingerprint?: string,
): SummaryJob {
  return {
    url: entry.url,
    publisherContractFingerprint,
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
  publisherContractFingerprint?: string,
): boolean {
  const isLookedUp = lookedUpUrls.has(entry.url);
  const isUncheckedFallback = uncheckedFallbackUrls.has(entry.url);
  if (!isLookedUp && !isUncheckedFallback) {
    return false;
  }
  if (
    isLookedUp &&
    hasRealCacheEntry(
      hitsByUrl.get(entry.url),
      entry,
      publisherContractFingerprint,
    )
  ) {
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
  opts: SummaryJobSelectionOpts = {},
): SummaryJobBatch {
  const maybeEligible = entries.filter((entry) =>
    isEligibleSummaryJob(
      entry,
      hitsByUrl,
      lookedUpUrls,
      uncheckedFallbackUrls,
      opts.publisherContractFingerprint,
    ),
  );
  const selection = orderSummaryCandidates(maybeEligible, cap, opts);

  return {
    jobs: selection.entries.map((entry) =>
      toSummaryJob(entry, opts.publisherContractFingerprint),
    ),
    eligibleCount: selection.eligibleCount,
    startIndex: selection.startIndex,
    drainEstimateHours: selection.drainEstimateHours,
    cooldownCount: selection.cooldownCount,
  };
}

export function selectSummaryLookupEntries(
  entries: readonly NormalizedEntry[],
  cap: number,
  opts: SummaryJobSelectionOpts = {},
): SummaryEntrySelection {
  return orderSummaryCandidates(entries.filter(needsGeneratedContent), cap, opts);
}

export function selectSummaryJobs(
  entries: readonly NormalizedEntry[],
  hitsByUrl: Map<string, CacheEntry>,
  lookedUpUrls: ReadonlySet<string>,
  cap: number,
  uncheckedFallbackUrls: ReadonlySet<string> = new Set(),
  opts: SummaryJobSelectionOpts = {},
): SummaryJob[] {
  return selectSummaryJobBatch(entries, hitsByUrl, lookedUpUrls, cap, uncheckedFallbackUrls, opts).jobs;
}
