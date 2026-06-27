/**
 * web/src/lib/bodies.ts
 *
 * Body-file architecture (LL-113). Long-form article bodies live in
 * data/bodies.json, NOT in data/index.json. This keeps the index small (under
 * the CI size budget, LL-112) while full bodies can grow without bound. The
 * article detail page reads bodies from here, keyed by entry id.
 *
 * Bodies are generated separately (Phase B: a dedicated cloud worker using
 * opus-4.8). Entries without a body simply have no key here and the detail page
 * falls back to the summary-first "AI summary digest + read original" view.
 */
import bodiesJson from "../../../data/bodies.json";

export interface BodyRecord {
  bodyJa: string;
  bodyEn: string;
  model?: string;
  generatedAt?: string;
}

interface BodiesPayload {
  generatedAt: string;
  count: number;
  bodies: Record<string, BodyRecord>;
}

const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";
const FALLBACK_BODY_JA_NEEDLE = "元記事の要約と収集時のメタデータから";

const data = bodiesJson as BodiesPayload;

export const BODIES: Readonly<Record<string, BodyRecord>> = data.bodies ?? {};
export const BODIES_GENERATED_AT = data.generatedAt;
export const BODIES_COUNT = data.count ?? Object.keys(BODIES).length;

function isFillerBody(record: BodyRecord): boolean {
  return (
    (record.bodyEn ?? "").includes(FALLBACK_BODY_EN_NEEDLE) ||
    (record.bodyJa ?? "").includes(FALLBACK_BODY_JA_NEEDLE)
  );
}

/**
 * Returns the real long-form body for an entry id, or null when there is no
 * usable body (missing, empty, or legacy deterministic filler). The detail page
 * renders prose when this is non-null and the summary-first digest otherwise.
 */
export function bodyForEntry(id: string): BodyRecord | null {
  const record = BODIES[id];
  if (!record) return null;
  const ja = (record.bodyJa ?? "").trim();
  const en = (record.bodyEn ?? "").trim();
  if (!ja && !en) return null;
  if (isFillerBody(record)) return null;
  return record;
}

/** True when the entry id has a real, renderable long-form body. */
export function hasRealBody(id: string): boolean {
  return bodyForEntry(id) !== null;
}
