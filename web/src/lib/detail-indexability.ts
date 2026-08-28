import { hasRealBody } from "./bodies.ts";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "./detail-addressability.ts";

/**
 * Indexability is a strictly narrower decision than addressability, and the two
 * are deliberately kept apart:
 *
 * - addressable (detail-addressability.ts): the /e/[id]/ route is generated and
 *   stays reachable, so inbound links, feed items, and in-site cards never 404.
 * - indexable (this module): the route is also listed in sitemap.xml and served
 *   with `index, follow`.
 *
 * A detail page earns indexing only once data/bodies.json holds a real
 * long-form body for it. A summary-only page carries an AI digest plus a link
 * to the source; roughly half of the /e/ surface is in that state, and at that
 * scale it reads as mass-produced thin content both to search engines and to
 * the Google AdSense "low value content" review. Such pages stay reachable with
 * `noindex, follow` until a body lands, at which point the same URL is promoted
 * into the sitemap with no redirect and no URL churn.
 *
 * A real body is necessary but NOT sufficient: release and changelog entries
 * are excluded even when they have one. Measuring the 1,204 indexed detail
 * pages against this policy showed every near-duplicate cluster came from that
 * lane -- 18x "Zed Editor v1.17.2", 16x "Ollama v0.33.0", 15x "OpenHands
 * v1.15.0", 11x "Zed v1.18.0-pre", 9x Cline, 9x/8x langchain -- with 137 pages
 * (11.4%) sitting in a same-source/version-stripped-title cluster and 60 of
 * them in a cluster of ten or more. Version notes differ only by a version
 * number, so an AI explainer over them is the most mass-produced-looking
 * content on the site while carrying the least independent value. Excluding
 * the lane by sourceType removes all of that at once: it subsumes both the
 * >=3 clusters and the bodiless-after-rescore set, and costs 194 of 1,204
 * indexed pages (16%). They stay reachable and `follow`ed like any other
 * body-less page, so inbound links and feed items are unaffected.
 *
 * web/scripts/validate-sitemap-dist.mjs enforces the pairing at build time in
 * both directions: an indexable canonical route missing from the sitemap fails
 * the build, and so does a `noindex` route advertised in the sitemap.
 *
 * Unlike detail-addressability.ts this module DOES depend on a data artifact
 * (data/bodies.json, through bodies.ts). Keep it out of JSON-free consumers
 * such as scripts/publisher-impact.ts and the Playwright specs, which must keep
 * planning routes from the addressability policy alone; body-quality.ts is the
 * JSON-free half they can share.
 */

/** `<meta name="robots">` content for a detail route search engines should index. */
export const DETAIL_ROBOTS_INDEX = "index, follow";
/** `<meta name="robots">` content for a reachable but body-less detail route. */
export const DETAIL_ROBOTS_NOINDEX = "noindex, follow";

/**
 * A detail entry as the indexing decision sees it. `sourceType` is optional so
 * raw stored rows and fixtures stay testable, and an absent value is treated
 * as indexable rather than excluded: this gate must never be able to empty the
 * sitemap because a caller forgot to thread one descriptive field through.
 * tests/web-sitemap.test.ts pins the real corpus against the rule, and
 * web/scripts/validate-sitemap-dist.mjs re-checks the built output, so a
 * genuinely missing sourceType is caught there instead of silently
 * de-indexing the site.
 */
export interface DetailIndexableEntry extends DetailAddressableEntry {
  sourceType?: string;
}

/**
 * Lanes whose entries never earn indexing, however good their body is.
 * See the module comment for the measurement behind this.
 */
export const NON_INDEXABLE_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "release",
  "changelog",
]);

export function isIndexableDetailEntry(entry: DetailIndexableEntry): boolean {
  if (entry.sourceType !== undefined && NON_INDEXABLE_SOURCE_TYPES.has(entry.sourceType)) {
    return false;
  }
  // hasRealBody takes the ENTRY, not the id, so the source-grounding guard
  // cannot be bypassed here: a body generated without a usable source excerpt
  // must not make its page indexable either.
  return isAddressableDetailEntry(entry) && hasRealBody(entry);
}

/**
 * The robots directive for one detail route. `follow` is kept in both branches:
 * a summary-only page still carries honest internal links to its category, tags
 * and related entries, and to the original source.
 */
export function detailRobotsContent(entry: DetailIndexableEntry): string {
  return isIndexableDetailEntry(entry)
    ? DETAIL_ROBOTS_INDEX
    : DETAIL_ROBOTS_NOINDEX;
}

export function collectIndexableDetailEntries<
  T extends DetailIndexableEntry,
>(
  ...entryGroups: ReadonlyArray<readonly T[]>
): readonly T[] {
  const entriesById = new Map<string, T>();
  for (const entries of entryGroups) {
    for (const entry of entries) {
      if (!isIndexableDetailEntry(entry) || entriesById.has(entry.id)) continue;
      entriesById.set(entry.id, entry);
    }
  }
  return [...entriesById.values()];
}
