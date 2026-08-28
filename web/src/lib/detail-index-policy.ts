/**
 * Which detail lanes may be advertised to search engines at all.
 *
 * Kept separate from detail-indexability.ts, and free of any data import, for
 * the same reason as detail-addressability.ts and body-quality.ts: the
 * Playwright publisher spec and scripts/publisher-impact.ts have to apply the
 * identical predicate without pulling in the multi-megabyte data/bodies.json
 * that detail-indexability.ts loads through bodies.ts.
 *
 * The rule itself: release and changelog entries never earn indexing, however
 * good their generated body is. Measuring the 1,204 indexed detail pages
 * showed every near-duplicate cluster came from that lane -- 18x "Zed Editor
 * v1.17.2", 16x "Ollama v0.33.0", 15x "OpenHands v1.15.0", 11x "Zed
 * v1.18.0-pre", 9x Cline, 9x/8x langchain -- with 137 pages (11.4%) in a
 * same-source/version-stripped-title cluster and 60 of them in a cluster of
 * ten or more. Consecutive version notes differ only by a version number, so
 * an AI explainer over them is the most mass-produced-looking content on the
 * site while carrying the least independent value, which is exactly what the
 * AdSense "low value content" review and search spam policy on scaled content
 * target. Excluding the lane by sourceType removes all of it with one rule.
 *
 * This is a DE-INDEXING policy only. Excluded pages keep their route and are
 * served `noindex, follow`, so inbound links, feed items and in-site cards are
 * unaffected and no URL 404s or redirects.
 */

/** Lanes whose entries are never listed in sitemap.xml nor served `index`. */
export const NON_INDEXABLE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "release",
  "changelog",
]);

/**
 * True when the entry belongs to a lane that must never be indexed.
 *
 * An absent `sourceType` is treated as indexable, not excluded. This gate must
 * not be able to empty the sitemap because one caller forgot to thread a
 * descriptive field through; the corpus-level assertions in
 * tests/web-sitemap.test.ts and the built-output check in
 * web/scripts/validate-sitemap-dist.mjs are what catch a genuinely missing
 * value.
 */
export function isNonIndexableLane(
  entry: { sourceType?: string | null | undefined },
): boolean {
  const sourceType = entry.sourceType;
  return typeof sourceType === "string" && NON_INDEXABLE_SOURCE_TYPES.has(sourceType);
}
