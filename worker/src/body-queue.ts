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
import { type BodyJob } from "./body-generate.ts";
import { needsGeneratedContent, roundRobinStart } from "./summary-queue.ts";

export interface BodyJobBatch {
  jobs: BodyJob[];
  eligibleCount: number;
  startIndex: number;
  drainEstimateHours: number;
}

export interface BodyJobSelectionOpts {
  nowMs?: number;
  publisherContractFingerprint?: string;
}

export const DEFAULT_BODY_RETENTION_DAYS = 30;

function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function toBodyJob(
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
  entry: Pick<NormalizedEntry, "id" | "summaryJa" | "summaryEn">,
  bodiesPresent: ReadonlySet<string>,
): boolean {
  if (bodiesPresent.has(entry.id)) return false;
  // Reuse the summary contract: only entries with a real bilingual summary are
  // eligible (an entry still in summary-fallback should get its summary first).
  return !needsGeneratedContent(entry);
}

export function selectBodyJobBatch(
  entries: readonly NormalizedEntry[],
  bodiesPresent: ReadonlySet<string>,
  cap: number,
  opts: BodyJobSelectionOpts = {},
): BodyJobBatch {
  const safeCap = Math.max(1, Math.floor(cap));
  const eligible = entries.filter((entry) => needsBody(entry, bodiesPresent));
  if (eligible.length === 0) {
    return { jobs: [], eligibleCount: 0, startIndex: 0, drainEstimateHours: 0 };
  }

  const jobs: BodyJob[] = [];
  const seen = new Set<string>();
  const pushJob = (entry: NormalizedEntry) => {
    if (seen.has(entry.url) || jobs.length >= safeCap) return;
    seen.add(entry.url);
    jobs.push(toBodyJob(entry, opts.publisherContractFingerprint));
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

  const drainEstimateHours = Math.ceil(eligible.length / safeCap);
  return { jobs, eligibleCount: eligible.length, startIndex, drainEstimateHours };
}
