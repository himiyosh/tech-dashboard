/**
 * worker/src/bodies-budget.ts
 *
 * Deterministic byte-budget enforcement for data/bodies.json (body-file
 * architecture, LL-115). isBodyRetentionEligible() in body-queue.ts is a
 * boolean GATE (evergreen / importance>=2 / recent-only for importance==1):
 * it decides which entries are ALLOWED to have a body at all. It has no
 * concept of total payload size, so as long as content keeps flowing into the
 * eligible set (importance>=2 entries never age out while live), the file
 * grows without bound and can exceed the operational size budget.
 *
 * This module adds a SEPARATE, additional layer: given the merged bodies
 * payload, prune the deterministic lowest-priority records (oldest within the
 * lowest eligible tier first) until the EXACT serialized byte length is at or
 * under a target budget -- independent of, and always at least as strict as,
 * the boolean retention gate. Evergreen entries are the HIGHEST-priority tier
 * (pruned only as an absolute last resort, after every other tier has already
 * been fully removed and the payload is STILL over budget) but they are NOT
 * exempt: enforceBodiesBudget() guarantees the result fits at or under
 * targetBytes for any realistic positive target (in particular, always for
 * the production DEFAULT_BODY_BUDGET_TARGET_BYTES), matching R-012's
 * "evergreen is prioritized, not unconditionally unbounded" intent.
 * "Protected" here means "pruned last", not "never pruned" (LL-411
 * follow-up). The only theoretical exception is a target smaller than the
 * minimal possible JSON envelope itself, which never occurs in production.
 *
 * Cloudflare-type-free (no @cloudflare/workers-types import) so it can be
 * unit-tested directly, same as body-queue.ts / bodies-file.ts.
 */
import { dateMs } from "./body-queue.ts";
import { serializeBodies, type BodiesPayload, type BodyRecord } from "./bodies-file.ts";

/**
 * Operational target for data/bodies.json (LL-411). Kept well below the much
 * larger `tests/data-schema.test.ts` hard ceiling (10,000,000 bytes,
 * unchanged) so this target is the thing that actively keeps the file small,
 * while the hard ceiling remains a safety net that can absorb many runs'
 * worth of growth even if this enforcement were ever skipped. Chosen at the
 * upper end of the operator-suggested 8.5-9.0MB range to minimize one-time
 * pruning of existing content while still leaving a full 1,000,000 byte
 * (10%) margin below the hard ceiling -- multiple times the largest observed
 * single-run growth (~185,000 bytes, the incident that motivated this file).
 */
export const DEFAULT_BODY_BUDGET_TARGET_BYTES = 9_000_000;

export interface BodyBudgetPriorityInput {
  id: string;
  evergreen?: boolean;
  importance?: number;
  publishedAt?: string | null;
  collectedAt?: string | null;
}

/**
 * Priority tier for body-budget pruning. Lower rank means the body is
 * protected LONGER (pruned LATER), not that it is exempt from pruning.
 * Rank 0 (evergreen) is the highest-priority tier -- bodyBudgetPruneOrder()
 * always sorts it to the very end of the removal order -- but
 * enforceBodiesBudget() will still prune it as a last resort if every lower
 * (higher-numbered) tier has already been fully removed and the payload is
 * still over target. "Protected" therefore means "pruned last", not "never
 * pruned" (LL-411 follow-up: an earlier version treated evergreen as
 * unconditionally exempt, which left the operational size guarantee
 * unbounded whenever the evergreen corpus alone grew past target).
 */
export function bodyBudgetPriorityRank(
  entry: Pick<BodyBudgetPriorityInput, "evergreen" | "importance">,
): 0 | 1 | 2 | 3 {
  if (entry.evergreen === true) return 0;
  const importance = entry.importance ?? 1;
  if (importance >= 3) return 1;
  if (importance === 2) return 2;
  return 3;
}

function priorityEntryMs(
  entry: Pick<BodyBudgetPriorityInput, "publishedAt" | "collectedAt">,
): number {
  return dateMs(entry.publishedAt) || dateMs(entry.collectedAt);
}

/**
 * Deterministic prune order for a set of candidate entries: ids earlier in
 * the returned array are pruned FIRST when the payload exceeds the target
 * byte budget. ALL entries are included, evergreen ones too -- evergreen just
 * sorts to the very end (last-resort tier) rather than being excluded from
 * the pool entirely, so enforceBodiesBudget() can still guarantee the target
 * is met when nothing else is left to remove (LL-411 follow-up).
 *
 * Order (ascending removal priority, i.e. first-to-prune first):
 *   1. importance 1 (recent-only retention) -- oldest first
 *   2. importance 2 -- oldest first
 *   3. importance >= 3 -- oldest first
 *   4. evergreen -- oldest first (last resort only)
 * Ties within the same tier and the same effective date (publishedAt falling
 * back to collectedAt, matching isBodyRetentionEligible) are broken by
 * ascending entry id, so the order is fully deterministic and stable across
 * repeated runs given identical input data.
 */
export function bodyBudgetPruneOrder(
  candidates: readonly BodyBudgetPriorityInput[],
): string[] {
  const ranked = candidates.map((entry) => ({
    id: entry.id,
    rank: bodyBudgetPriorityRank(entry),
    ms: priorityEntryMs(entry),
  }));
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank; // higher rank (lower priority) pruned first
    if (a.ms !== b.ms) return a.ms - b.ms; // older pruned first
    if (a.id < b.id) return -1; // deterministic tie-break
    if (a.id > b.id) return 1;
    return 0;
  });
  return ranked.map((entry) => entry.id);
}

/**
 * Exact serialized byte length of a bodies payload -- the same bytes that
 * would be committed to data/bodies.json, envelope (generatedAt/count keys,
 * 2-space indentation, trailing newline) and multi-byte UTF-8 characters
 * included. Uses TextEncoder (not Buffer) so this stays portable to a
 * Cloudflare Workers runtime as well as Node.
 */
export function serializedByteLength(payload: BodiesPayload): number {
  return new TextEncoder().encode(serializeBodies(payload)).byteLength;
}

export interface EnforceBodiesBudgetResult {
  payload: BodiesPayload;
  /** Ids removed by this enforcement pass, in the order they were pruned. */
  prunedIds: string[];
  /** Exact serialized byte length of the returned payload. */
  bytes: number;
  changed: boolean;
}

/**
 * Trims data/bodies.json down to at most `targetBytes` of serialized JSON,
 * pruning the deterministic lowest-priority records first
 * (bodyBudgetPruneOrder). This is a separate, additional layer on top of
 * isBodyRetentionEligible: an entry can be boolean-eligible for retention
 * (importance>=2 / evergreen / recent) yet still get pruned here if the
 * overall payload is over budget and it is among the lowest-priority records
 * present.
 *
 * Evergreen entries are the highest-priority (pruned-last) tier, but they are
 * NOT exempt: if every other tier has already been removed and the payload is
 * STILL over target, evergreen records are pruned too, oldest first, only as
 * many as strictly necessary. This guarantees the returned payload's bytes
 * are always at or under targetBytes for any REALISTIC target -- in
 * particular, always for the production `DEFAULT_BODY_BUDGET_TARGET_BYTES`
 * (9,000,000 bytes) -- there is no "accepted over-target" outcome once every
 * tier including evergreen is on the table (LL-411 follow-up: an earlier
 * version left evergreen unconditionally exempt, which meant the operational
 * size guarantee could be violated forever once the evergreen corpus alone
 * exceeded target, eventually recreating the exact Publisher hard-ceiling
 * failure this module exists to prevent). The one theoretical exception is a
 * pathologically misconfigured `targetBytes` smaller than the minimal
 * possible JSON envelope (`{"generatedAt":...,"count":0,"bodies":{}}`, well
 * under 100 bytes): in that degenerate case, pruning every record still
 * cannot go below the envelope's own byte length, so the result may remain
 * marginally over such an unrealistic target. This never occurs with the
 * production constant, which is many orders of magnitude larger.
 *
 * Uses an exact minimal-removal binary search over the deterministic prune
 * order rather than approximating per-record byte contributions, so the
 * result is always measured against the real serialized payload (what will
 * actually be committed), envelope and multi-byte UTF-8 bytes included.
 */
export function enforceBodiesBudget(
  payload: BodiesPayload,
  entries: readonly BodyBudgetPriorityInput[],
  targetBytes: number,
): EnforceBodiesBudgetResult {
  const currentBytes = serializedByteLength(payload);
  const presentIds = Object.keys(payload.bodies);
  if (presentIds.length === 0 || currentBytes <= targetBytes) {
    return { payload, prunedIds: [], bytes: currentBytes, changed: false };
  }

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const known: BodyBudgetPriorityInput[] = [];
  const orphanIds: string[] = [];
  for (const id of presentIds) {
    const entry = entryById.get(id);
    if (entry) known.push(entry);
    else orphanIds.push(id);
  }
  // Orphan records (a body present with no matching entry in `entries`) carry
  // no priority information and are treated as the very lowest priority --
  // pruned before anything ranked. In normal operation this should not occur
  // (mergeBodies already prunes anything not in liveIds before this runs),
  // but keeps this function correct and defensive standing alone. Every
  // present id ends up in either `orphanIds` or `known`, and
  // bodyBudgetPruneOrder() now returns ALL of `known` (evergreen included,
  // sorted last) rather than filtering any of it out, so `pruneOrder` always
  // has the same length as `presentIds` here -- there is no "nothing left to
  // prune" case to special-case.
  const pruneOrder = [...orphanIds.sort(), ...bodyBudgetPruneOrder(known)];

  const buildWithoutFirst = (k: number): BodiesPayload => {
    const drop = new Set(pruneOrder.slice(0, k));
    const bodies: Record<string, BodyRecord> = {};
    for (const [id, record] of Object.entries(payload.bodies)) {
      if (!drop.has(id)) bodies[id] = record;
    }
    return { generatedAt: payload.generatedAt, count: Object.keys(bodies).length, bodies };
  };

  // Binary search the minimal k (0..pruneOrder.length) such that dropping the
  // first k lowest-priority ids brings the serialized payload at or under
  // target. Removing strictly more records can only shrink (never grow) the
  // serialized size, so the "fits under target" predicate is monotonic in k
  // and a binary search converges to the exact minimal removal count in
  // O(log n) full, exact serializations rather than O(n). Dropping ALL
  // present ids (k = pruneOrder.length) leaves only the tiny generatedAt/
  // count/bodies:{} envelope, which fits under any realistic positive
  // target, so hi is always a valid upper bound and the loop always
  // terminates with bytes <= targetBytes.
  let lo = 0;
  let hi = pruneOrder.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bytes = serializedByteLength(buildWithoutFirst(mid));
    if (bytes <= targetBytes) hi = mid;
    else lo = mid + 1;
  }

  const finalPayload = buildWithoutFirst(lo);
  return {
    payload: finalPayload,
    prunedIds: pruneOrder.slice(0, lo),
    bytes: serializedByteLength(finalPayload),
    changed: lo > 0,
  };
}

/**
 * Computes the persistent, cross-run set of entry ids that should remain
 * excluded from new body-generation candidates because budget enforcement
 * has been evicting them (LL-411 follow-up).
 *
 * A naive "only remember what THIS run pruned" design has a state-loss bug:
 * if a run excludes an id (so nothing new is merged/pruned for it) and then
 * writes back only its OWN prunedIds, the persisted list goes empty even
 * though the id is still missing a body and still budget-doomed. The NEXT
 * run then reads an empty list, re-admits the id as a fresh candidate,
 * regenerates it, and gets it evicted again -- an every-other-run waste loop
 * that (at Web level) also makes a "queued, coming soon" state repeat
 * forever without ever resolving.
 *
 * This function fixes that by carrying forward the previous run's evicted
 * ids, filtered to only those that are still relevant, and unions them with
 * this run's freshly pruned ids:
 *
 *   - Dropped if the id is no longer live/retention-eligible (it naturally
 *     falls out of scope; keeping it around would leak stale references and
 *     let the set grow without bound as old ids age out of the live index).
 *   - Dropped if the id NOW has a real body in the final payload (some other
 *     process -- e.g. a manual backfill or a later re-merge -- gave it one;
 *     excluding it from future generation candidates would be meaningless
 *     since needsBody() already treats it as satisfied).
 *   - Dropped ("released") if the entry's CURRENT priority rank is STRICTLY
 *     BETTER (numerically lower) than `worstSurvivingRank`: the worst
 *     (highest-numbered) rank among entries that CURRENTLY have a real body
 *     in the final payload, i.e. the tier boundary that "made the cut" this
 *     run. A registry/config change (importance bumped, or the entry became
 *     evergreen) that pushes an id past that boundary means it is no longer
 *     the kind of record budget enforcement keeps evicting, so it is
 *     released back to normal candidate selection to recover.
 *
 * Since evergreen is now a last-resort PRUNABLE tier rather than an exempt
 * one (see enforceBodiesBudget), a fixed "only rank 3 is ever excluded"
 * check would be wrong: it would incorrectly release an evergreen (or
 * importance>=2) id that got pruned in a tight-budget scenario purely
 * because its rank differs from 3, even though nothing about its situation
 * actually improved -- reintroducing the exact waste loop this function
 * exists to prevent, just for a higher tier. Comparing against the DYNAMIC
 * `worstSurvivingRank` (rather than a fixed threshold) stays correct
 * regardless of which tier enforcement is currently having to prune from: a
 * tie (same rank as the worst survivor) is kept excluded conservatively,
 * since the excluded id may simply be older within that same tier.
 * `worstSurvivingRank` defaults to -1 (lower than any real rank) when
 * nothing currently has a body, so nothing is ever speculatively released in
 * that degenerate scenario.
 *
 * The result is deterministically sorted (ascending id) rather than kept in
 * insertion order, and NOT arbitrarily truncated to a fixed count: the true
 * size of this set is already bounded by the retention-eligible population
 * lacking a body (at most a few thousand entries in realistic data), so an
 * arbitrary cap would either be a no-op or -- worse -- silently reintroduce
 * the exact waste loop this function exists to prevent by dropping ids that
 * are still legitimately excluded.
 */
export function carryForwardBudgetEvictedIds(
  previousIds: readonly string[],
  entries: readonly BodyBudgetPriorityInput[],
  bodiesPresent: ReadonlySet<string>,
  newlyPrunedIds: readonly string[] = [],
): string[] {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  let worstSurvivingRank = -1;
  for (const entry of entries) {
    if (!bodiesPresent.has(entry.id)) continue;
    const rank = bodyBudgetPriorityRank(entry);
    if (rank > worstSurvivingRank) worstSurvivingRank = rank;
  }

  const carried = previousIds.filter((id) => {
    if (bodiesPresent.has(id)) return false;
    const entry = entryById.get(id);
    if (!entry) return false;
    return bodyBudgetPriorityRank(entry) >= worstSurvivingRank;
  });
  return [...new Set([...carried, ...newlyPrunedIds])].sort();
}
