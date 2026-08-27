/**
 * Pure body-quality policy for the web build. This module deliberately imports
 * no data artifact (mirroring detail-addressability.ts) so route policy, unit
 * tests, and the Playwright publisher spec can all apply the identical
 * predicate without loading the multi-megabyte data/bodies.json.
 *
 * Scope note: worker/src/bodies-file.ts, worker/src/body-generate.ts and
 * worker/src/prompt.ts keep their own copies of the same needles because the
 * Cloudflare Worker bundles from a separate package and tsconfig and must not
 * import web/src. Any change to the needles below has to be mirrored there.
 */

export interface BodyTextRecord {
  bodyJa?: string;
  bodyEn?: string;
}

/**
 * Legacy deterministic filler produced before real body generation existed. It
 * paraphrases the summary and collection metadata rather than the article, so
 * it must never count as long-form content.
 */
const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";
const FALLBACK_BODY_JA_NEEDLE = "元記事の要約と収集時のメタデータから";

export function isFillerBodyRecord(record: BodyTextRecord): boolean {
  return (
    (record.bodyEn ?? "").includes(FALLBACK_BODY_EN_NEEDLE) ||
    (record.bodyJa ?? "").includes(FALLBACK_BODY_JA_NEEDLE)
  );
}

/** True when the record carries renderable long-form prose in at least one language. */
export function isRealBodyRecord(
  record: BodyTextRecord | null | undefined,
): boolean {
  if (!record) return false;
  const ja = (record.bodyJa ?? "").trim();
  const en = (record.bodyEn ?? "").trim();
  if (!ja && !en) return false;
  return !isFillerBodyRecord(record);
}
