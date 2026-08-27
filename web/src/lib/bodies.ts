/**
 * web/src/lib/bodies.ts
 *
 * Body-file architecture (LL-115). Long-form article bodies live in
 * data/bodies.json, NOT in data/index.json. This keeps the index small (under
 * the CI size budget, LL-112). Retention is bounded to evergreen, important,
 * or recent entries so the sidecar remains within its own size budget. The
 * article detail page reads retained bodies from here, keyed by entry id.
 *
 * Bodies are generated separately (Phase B: a dedicated cloud worker using
 * opus-4.8). Entries without a body simply have no key here and the detail page
 * falls back to the summary-first "AI summary digest + read original" view.
 */
import bodiesJson from "../../../data/bodies.json";
import {
  hasMeaningfulSourceSnippet,
  type SourceSnippetInput,
} from "./source-snippet.ts";
import { isRealBodyRecord } from "./body-quality.ts";

export interface BodyRecord {
  bodyJa: string;
  bodyEn: string;
  model?: string;
  generatedAt?: string;
}

export type ArticleBodyState = "ready" | "queued" | "summary-only";

interface BodiesPayload {
  generatedAt: string;
  count: number;
  bodies: Record<string, BodyRecord>;
}

const data = bodiesJson as BodiesPayload;

export const BODIES: Readonly<Record<string, BodyRecord>> = data.bodies ?? {};
export const BODIES_GENERATED_AT = data.generatedAt;
export const BODIES_COUNT = data.count ?? Object.keys(BODIES).length;

/** The minimum an entry must carry for its stored body to be renderable. */
export type BodySourceEntry = SourceSnippetInput & { id: string };

/**
 * Returns the real long-form body for an entry, or null when there is no
 * renderable body: missing, empty, legacy deterministic filler, OR generated
 * from a source that cannot support it.
 *
 * The record-shape rule lives in body-quality.ts, which imports no data
 * artifact, so route policy (detail-indexability.ts), unit tests, and the
 * Playwright publisher spec all apply the identical predicate without loading
 * the multi-megabyte data/bodies.json.
 *
 * The source-grounding rule is the load-bearing addition. 65 already-published
 * /e/ pages hold a body that was generated while the pipeline let a descriptive
 * TITLE alone stand in for source text; 53 of those entries have an entirely
 * empty contentSnippet, so the prose asserts facts no source supplied. The
 * pipeline now refuses to generate them and prunes the stored records, but that
 * needs a publisher run and this build does not - so the guard runs here too
 * and those pages stop rendering prose on the very next deploy.
 *
 * The ENTRY - not just its id - is required on purpose. A call site that only
 * had the id could render a body without ever presenting the source it is
 * supposed to be grounded in; making the source a required argument means the
 * type checker rejects that instead of silently skipping the guard.
 */
export function bodyForEntry(entry: BodySourceEntry): BodyRecord | null {
  const record: BodyRecord | undefined = BODIES[entry.id];
  if (!record || !isRealBodyRecord(record)) return null;
  if (!hasMeaningfulSourceSnippet(entry)) return null;
  return record;
}

/**
 * "queued" promises the reader that a body is on its way. An entry without a
 * usable source excerpt is no longer enqueued at all, so claiming it is queued
 * would be false - and WORKER_HEALTH.bodyMergePendingIds can still carry such
 * an id from the last run before the change. Report summary-only for those.
 */
export function articleBodyState(
  entry: BodySourceEntry,
  body: BodyRecord | null,
  pendingIds: readonly string[] = [],
): ArticleBodyState {
  if (body) return "ready";
  if (!hasMeaningfulSourceSnippet(entry)) return "summary-only";
  return pendingIds.includes(entry.id) ? "queued" : "summary-only";
}

/** True when the entry has a real, renderable, source-grounded body. */
export function hasRealBody(entry: BodySourceEntry): boolean {
  return bodyForEntry(entry) !== null;
}
