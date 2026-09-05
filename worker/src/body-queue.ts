/**
 * worker/src/body-queue.ts
 *
 * Body job selection for the body-file architecture (LL-115). Mirrors
 * summary-queue.ts but simpler: a live entry is eligible for body generation
 * when it (a) already has a real bilingual SUMMARY (the body uses the summary as
 * context, and only publishable entries surface anywhere worth a long body) and
 * (b) does NOT yet have a real body in data/bodies.json.
 *
 * Selection mirrors the summary queue's fairness model (LL-076/LL-101):
 *   - reserve part of the cap for the NEWEST eligible entries (fresh articles
 *     get a body within an hour or two), then
 *   - fill the rest with a cap-sized round-robin window over the backlog so
 *     nothing starves.
 *
 * Cloudflare-type-free so it can be unit-tested directly.
 */
import type { NormalizedEntry } from "../../harness/types.ts";
import { hasUsableBilingualSummary, hasUsableGroundedBilingualSummary } from "../../harness/pipeline/summary-quality.ts";
import { hasSufficientBodySourceGrounding } from "../../harness/pipeline/source-grounding.ts";
import { type BodyJob } from "./body-generate.ts";
import { roundRobinStart } from "./summary-queue.ts";

export interface BodyJobBatch {
  jobs: BodyJob[];
  eligibleCount: number;
  startIndex: number;
  drainEstimateHours: number;
}

export interface BodyJobSelectionOpts {
  nowMs?: number;
  publisherContractFingerprint?: string;
  excludeEntryIds?: ReadonlySet<string>;
}

export interface BodyPipelineSelection {
  pendingJobs: BodyJob[];
  candidateJobs: BodyJob[];
  lookupJobs: BodyJob[];
  eligibleCount: number;
  drainEstimateHours: number;
}

export const DEFAULT_BODY_RETENTION_DAYS = 30;

/** Parse an ISO timestamp to epoch ms, or 0 when missing/invalid. Exported so
 * bodies-budget.ts can rank entries by the same recency semantics used here
 * (publishedAt falling back to collectedAt). */
export function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function bodyJobForEntry(
  entry: NormalizedEntry,
  publisherContractFingerprint?: string,
): BodyJob {
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
      contentSnippet: entry.contentSnippet,
      lang: entry.lang,
      category: entry.category,
      source: entry.source,
      sourceType: entry.sourceType,
      tags: entry.tags,
      publishedAt: entry.publishedAt,
    },
  };
}

/**
 * Long-form bodies are retained for durable knowledge, important items, and
 * recent articles. Older low-importance news remains fully usable through its
 * bilingual summary and original-source link without growing bodies.json
 * without bound.
 */
export function isBodyRetentionEligible(
  entry: Pick<NormalizedEntry, "evergreen" | "importance" | "publishedAt" | "collectedAt">,
  nowMs = Date.now(),
  retentionDays = DEFAULT_BODY_RETENTION_DAYS,
): boolean {
  if (entry.evergreen === true || (entry.importance ?? 1) >= 2) return true;
  const entryMs = dateMs(entry.publishedAt) || dateMs(entry.collectedAt);
  if (entryMs <= 0) return false;
  return entryMs >= nowMs - Math.max(1, retentionDays) * 86_400_000;
}

/**
 * An entry needs a body when it has a real summary (so it's publishable and the
 * body has context) but no real body yet. `bodiesPresent` is the set of entry
 * ids that already have a real body in data/bodies.json.
 */
export function needsBody(
  entry: Pick<
    NormalizedEntry,
    | "id"
    | "title"
    | "titleJa"
    | "titleEn"
    | "summaryJa"
    | "summaryEn"
    | "contentSnippet"
    | "source"
    | "sourceType"
    | "url"
    | "lang"
  >,
  bodiesPresent: ReadonlySet<string>,
): boolean {
  if (bodiesPresent.has(entry.id)) return false;
  // The body gate is stricter than the summary gate: a body needs the source
  // EXCERPT, not just a descriptive title (see
  // hasSufficientBodySourceGrounding). Without this the collector keeps
  // enqueueing entries that worker-body then rejects with "insufficient source
  // grounding", burning two retries each before the DLQ.
  return (
    hasSufficientBodySourceGrounding(entry) &&
    hasUsableGroundedBilingualSummary(entry, entry)
  );
}

export function selectBodyJobBatch(
  entries: readonly NormalizedEntry[],
  bodiesPresent: ReadonlySet<string>,
  cap: number,
  opts: BodyJobSelectionOpts = {},
): BodyJobBatch {
  const safeCap = Math.max(0, Math.floor(cap));
  const allEligible = entries.filter((entry) => needsBody(entry, bodiesPresent));
  const eligible = opts.excludeEntryIds?.size
    ? allEligible.filter((entry) => !opts.excludeEntryIds!.has(entry.id))
    : allEligible;
  if (eligible.length === 0 || safeCap === 0) {
    return {
      jobs: [],
      eligibleCount: allEligible.length,
      startIndex: 0,
      drainEstimateHours: safeCap > 0 ? Math.ceil(allEligible.length / safeCap) : 0,
    };
  }

  const jobs: BodyJob[] = [];
  const seen = new Set<string>();
  const pushJob = (entry: NormalizedEntry) => {
    if (seen.has(entry.url) || jobs.length >= safeCap) return;
    seen.add(entry.url);
    jobs.push(bodyJobForEntry(entry, opts.publisherContractFingerprint));
  };

  // Reserve half the cap for the newest eligible entries so fresh articles get a
  // body quickly, then round-robin the rest so the backlog drains fairly.
  const recentSlots = Math.floor(safeCap / 2);
  if (recentSlots > 0) {
    const byNewest = [...eligible].sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt));
    let recentTaken = 0;
    for (const entry of byNewest) {
      if (recentTaken >= recentSlots || jobs.length >= safeCap) break;
      const before = jobs.length;
      pushJob(entry);
      if (jobs.length > before) recentTaken += 1;
    }
  }

  const startIndex = roundRobinStart(opts.nowMs ?? Date.now(), eligible.length, safeCap);
  for (let i = 0; i < eligible.length && jobs.length < safeCap; i++) {
    pushJob(eligible[(startIndex + i) % eligible.length]!);
  }

  const drainEstimateHours = Math.ceil(allEligible.length / safeCap);
  return { jobs, eligibleCount: allEligible.length, startIndex, drainEstimateHours };
}

/**
 * Summary and body consumers share the same KV write quota. Summary jobs keep
 * priority, while body jobs may use the unused part of the per-run allowance.
 */
export function bodyEnqueueAllowance(
  totalCap: number,
  summaryEnqueued: number,
  configuredBodyCap: number,
): number {
  const safeTotal = Math.max(0, Math.floor(totalCap));
  const safeSummary = Math.max(0, Math.floor(summaryEnqueued));
  const safeBody = Math.max(0, Math.floor(configuredBodyCap));
  return Math.min(safeBody, Math.max(0, safeTotal - safeSummary));
}

export interface BodyBoundExcerptPriorityOpts extends BodyPipelineSelectionOpts {
  /** BODY_LOOKUP_CAP — the same cap runBodyPipeline hands to selectBodyPipelineJobs. */
  lookupCap: number;
  /** health.bodyMergePendingIds from the previous run (already generated; not re-enqueued). */
  previousPendingIds: readonly string[];
  /** BODY_RETENTION_DAYS — the gate runBodyPipeline applies before any selection. */
  retentionDays?: number;
}

export interface BodyBoundExcerptPriority {
  /** entry id -> rank (0 = this run's body batch, 1 = unlockable); unranked = default lane order. */
  rank: Map<string, number>;
  /**
   * The body batch in selection order. runBodyPipeline must receive it as
   * preferredCandidateIds so the entries the lane enriched are the entries
   * that get enqueued — the batch is pinned, not re-predicted.
   */
  bodyBatchIds: string[];
  /** The same batch as jobs (for the caller's KV pre-lookup). */
  bodyBatchJobs: BodyJob[];
}

/**
 * Selects, before the article excerpt lane runs, the entries whose excerpt
 * must be rich NOW, so bodies are generated from article prose instead of the
 * 100-300 char feed description that pins the excerpt-proportional body band
 * at ~330 JA chars:
 *
 *   rank 0 — the body batch: selectBodyPipelineJobs on the pipeline's own
 *            inputs (retention-eligible entries, the committed bodies.json
 *            after pruneInvalidBodyRecords, previous pending ids, lookupCap,
 *            budget-evicted exclusions, one shared nowMs). The caller pins
 *            this batch into runBodyPipeline (preferredCandidateIds), so the
 *            enriched entries are the ones enqueued rather than a prediction
 *            that drifts with caps, windows or the lane's own enrichment.
 *            Pinned is not identical to enqueued: an entry whose body is
 *            already in KV is merged instead (the caller drops those from
 *            rank 0), and the per-run enqueue cap can still truncate the
 *            batch. health.excerptBodyBatchPinned / excerptBodyBatchEnqueued
 *            report both numbers.
 *   rank 1 — retention-eligible entries with a real bilingual summary but no
 *            body, whose feed excerpt fails hasSufficientBodySourceGrounding
 *            (too thin for a body); newest first. Enrichment is what can make
 *            them body-eligible. Checked with the summary-text gate
 *            (hasUsableBilingualSummary), not the source-grounded one: a thin
 *            excerpt is exactly what makes the grounded gate fail here.
 *
 * Entries outside body retention (they can never be enqueued), entries with a
 * body, previous-run pending ids and budget-evicted ids are not ranked.
 */
export function bodyBoundExcerptPriority(
  entries: readonly NormalizedEntry[],
  bodiesPresent: ReadonlySet<string>,
  opts: BodyBoundExcerptPriorityOpts,
): BodyBoundExcerptPriority {
  const { lookupCap, previousPendingIds, retentionDays = DEFAULT_BODY_RETENTION_DAYS, ...selectionOpts } = opts;
  const nowMs = selectionOpts.nowMs ?? Date.now();
  const retained = entries.filter((entry) => isBodyRetentionEligible(entry, nowMs, retentionDays));
  const selection = selectBodyPipelineJobs(retained, bodiesPresent, previousPendingIds, lookupCap, {
    ...selectionOpts,
    nowMs,
  });
  const rank = new Map<string, number>();
  const bodyBatchIds = selection.candidateJobs.map((job) => job.entry.id);
  for (const id of bodyBatchIds) rank.set(id, 0);
  const skip = new Set<string>([...previousPendingIds, ...(selectionOpts.excludeBudgetEvictedIds ?? [])]);
  const unlockable = retained
    .filter(
      (entry) =>
        !rank.has(entry.id) &&
        !bodiesPresent.has(entry.id) &&
        !skip.has(entry.id) &&
        hasUsableBilingualSummary(entry) &&
        !hasSufficientBodySourceGrounding(entry),
    )
    .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt));
  for (const entry of unlockable) rank.set(entry.id, 1);
  return { rank, bodyBatchIds, bodyBatchJobs: selection.candidateJobs };
}

export function bodyBacklogAfterMerge(eligibleCount: number, mergedCount: number): number {
  return Math.max(0, Math.floor(eligibleCount) - Math.max(0, Math.floor(mergedCount)));
}

export interface BodyPipelineSelectionOpts
  extends Omit<BodyJobSelectionOpts, "excludeEntryIds"> {
  /**
   * Entry ids the body-budget enforcer has been evicting
   * (health.bodyBudgetEvictedIds). Unlike previousPendingIds (a genuine
   * one-hop lookback), this is a PERSISTENT, carried-forward set: see
   * carryForwardBudgetEvictedIds() in bodies-budget.ts, which keeps an id
   * excluded across runs until it is no longer live/retention-eligible, has
   * a real body, or is promoted out of the lowest priority tier -- writing
   * back only "this run's fresh prunes" here would silently forget ids that
   * are still excluded and reintroduce the exact waste loop this option
   * exists to prevent (LL-411 follow-up).
   * Excluded from new-candidate selection so an entry that is deterministically
   * the lowest-priority record present does not get regenerated only to be
   * evicted again next run -- which would both waste Queue/LLM work and make
   * the Web "queued" state a repeating, never-resolving false promise.
   */
  excludeBudgetEvictedIds?: readonly string[];
  /**
   * Candidate ids to enqueue first, in order (the article excerpt lane's
   * body batch, bodyBoundExcerptPriority). Each must still pass needsBody and
   * not be pending/excluded; the round-robin window only fills what is left.
   */
  preferredCandidateIds?: readonly string[];
}

/**
 * Look up the jobs enqueued by the previous publisher run before selecting new
 * candidates. A previous miss receives one priority lookup only; it is excluded
 * from the current candidate window so it cannot consume both lookup slots.
 */
export function selectBodyPipelineJobs(
  entries: readonly NormalizedEntry[],
  bodiesPresent: ReadonlySet<string>,
  previousPendingIds: readonly string[],
  lookupCap: number,
  opts: BodyPipelineSelectionOpts = {},
): BodyPipelineSelection {
  const { excludeBudgetEvictedIds, preferredCandidateIds, ...jobOpts } = opts;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const pendingJobs: BodyJob[] = [];
  const pendingIds = new Set<string>();
  const safeLookupCap = Math.max(0, Math.floor(lookupCap));
  for (const id of previousPendingIds) {
    if (pendingJobs.length >= safeLookupCap || pendingIds.has(id)) continue;
    const entry = byId.get(id);
    if (!entry || !needsBody(entry, bodiesPresent)) continue;
    pendingIds.add(id);
    pendingJobs.push(bodyJobForEntry(entry, jobOpts.publisherContractFingerprint));
  }

  const remainingCandidateCap = Math.max(0, safeLookupCap - pendingJobs.length);
  const excludeIds = new Set(pendingIds);
  for (const id of excludeBudgetEvictedIds ?? []) excludeIds.add(id);

  // Pinned candidates first: the article excerpt lane enriched exactly these
  // entries earlier in the run, so enqueueing them now is what turns the
  // richer excerpt into a longer body in the same run. Built from the current
  // entry objects (which carry the enriched contentSnippet), gated by
  // needsBody, and never duplicated by the round-robin fill.
  const preferredJobs: BodyJob[] = [];
  for (const id of preferredCandidateIds ?? []) {
    if (preferredJobs.length >= remainingCandidateCap || excludeIds.has(id)) continue;
    const entry = byId.get(id);
    if (!entry || !needsBody(entry, bodiesPresent)) continue;
    excludeIds.add(id);
    preferredJobs.push(bodyJobForEntry(entry, jobOpts.publisherContractFingerprint));
  }
  const candidates = selectBodyJobBatch(
    entries,
    bodiesPresent,
    Math.max(0, remainingCandidateCap - preferredJobs.length),
    {
      ...jobOpts,
      excludeEntryIds: excludeIds,
    },
  );
  const candidateJobs = [...preferredJobs, ...candidates.jobs];

  return {
    pendingJobs,
    candidateJobs,
    lookupJobs: [...pendingJobs, ...candidateJobs],
    eligibleCount: candidates.eligibleCount,
    // Drain estimate over the full candidate window, not the part left after
    // the pinned jobs (which would read 0 when the pin fills the window).
    drainEstimateHours:
      remainingCandidateCap > 0 ? Math.ceil(candidates.eligibleCount / remainingCandidateCap) : 0,
  };
}
