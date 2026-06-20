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
  cooldownCount: number;
}

export interface SummaryJobSelectionOpts {
  nowMs?: number;
  skipUrls?: ReadonlySet<string>;
}

const FALLBACK_SUMMARY_JA_PREFIX = "このエントリは ";
const FALLBACK_SUMMARY_EN_NEEDLE = "AI summary not yet available";
const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";

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
  opts: SummaryJobSelectionOpts = {},
): SummaryJobBatch {
  const safeCap = Math.max(1, Math.floor(cap));
  const maybeEligible = entries.filter((entry) =>
    isEligibleSummaryJob(entry, hitsByUrl, lookedUpUrls, uncheckedFallbackUrls),
  );
  const skipUrls = opts.skipUrls ?? new Set<string>();
  const cooldownCount = skipUrls.size
    ? maybeEligible.filter((entry) => skipUrls.has(entry.url)).length
    : 0;
  const eligible = skipUrls.size
    ? maybeEligible.filter((entry) => !skipUrls.has(entry.url))
    : maybeEligible;
  if (eligible.length === 0) {
    return { jobs: [], eligibleCount: 0, startIndex: 0, drainEstimateHours: 0, cooldownCount };
  }

  // Prioritize evergreen (Knowledge lane) entries: they belong to a small,
  // curated set of best-practice sources, but the Knowledge page only shows
  // entries with a real bilingual summary (isPublishableEntry). Without
  // priority they compete with the whole news backlog (500+) and can take many
  // hours to surface, making newly added Knowledge sources look "missing"
  // (LL-098). Summarize evergreen first, then fill the rest of the cap with the
  // fair round-robin window so the news backlog still drains predictably.
  const evergreenEligible = eligible.filter((entry) => entry.evergreen === true);
  const restEligible = eligible.filter((entry) => entry.evergreen !== true);

  const jobs: SummaryJob[] = [];
  const seen = new Set<string>();
  const pushJob = (entry: NormalizedEntry) => {
    if (seen.has(entry.url) || jobs.length >= safeCap) return;
    seen.add(entry.url);
    jobs.push(toSummaryJob(entry));
  };

  for (const entry of evergreenEligible) pushJob(entry);

  // Reserve part of the remaining cap for the NEWEST un-summarized entries so
  // freshly collected articles get a real bilingual summary within an hour or
  // two, instead of waiting for the fair round-robin to reach them
  // (LL-074 / LL-087: recent articles are what readers notice first). Once an
  // entry gets a real summary it leaves the eligible pool, so this front-loads
  // fresh articles WITHOUT permanently starving the older backlog.
  const remainingAfterEvergreen = safeCap - jobs.length;
  const recentSlots = Math.floor(remainingAfterEvergreen / 2);
  if (recentSlots > 0) {
    const byNewest = [...restEligible].sort(
      (a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt),
    );
    let recentTaken = 0;
    for (const entry of byNewest) {
      if (recentTaken >= recentSlots || jobs.length >= safeCap) break;
      const before = jobs.length;
      pushJob(entry);
      if (jobs.length > before) recentTaken += 1;
    }
  }

  // Fill the rest with a fair cap-sized round-robin window over the older
  // backlog so nothing starves (LL-076). Advancing by a full cap per hour keeps
  // a 400+ item backlog cycling predictably (shared roundRobinStart helper).
  const startIndex = roundRobinStart(opts.nowMs ?? Date.now(), restEligible.length, safeCap);
  for (let i = 0; i < restEligible.length && jobs.length < safeCap; i++) {
    pushJob(restEligible[(startIndex + i) % restEligible.length]!);
  }

  return {
    jobs,
    eligibleCount: eligible.length,
    startIndex,
    drainEstimateHours: Math.ceil(eligible.length / safeCap),
    cooldownCount,
  };
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
