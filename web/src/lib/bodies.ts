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

/**
 * Returns the real long-form body for an entry id, or null when there is no
 * usable body (missing, empty, or legacy deterministic filler). The detail page
 * renders prose when this is non-null and the summary-first digest otherwise.
 *
 * The quality rule itself lives in body-quality.ts, which imports no data
 * artifact, so route policy (detail-indexability.ts), unit tests, and the
 * Playwright publisher spec all apply the identical predicate without loading
 * the multi-megabyte data/bodies.json.
 */
export function bodyForEntry(id: string): BodyRecord | null {
  const record: BodyRecord | undefined = BODIES[id];
  if (!record || !isRealBodyRecord(record)) return null;
  return record;
}

export function articleBodyState(
  id: string,
  body: BodyRecord | null,
  pendingIds: readonly string[] = [],
): ArticleBodyState {
  if (body) return "ready";
  return pendingIds.includes(id) ? "queued" : "summary-only";
}

/** True when the entry id has a real, renderable long-form body. */
export function hasRealBody(id: string): boolean {
  return bodyForEntry(id) !== null;
}
