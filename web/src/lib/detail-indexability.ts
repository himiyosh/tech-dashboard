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

export function isIndexableDetailEntry(entry: DetailAddressableEntry): boolean {
  return isAddressableDetailEntry(entry) && hasRealBody(entry.id);
}

/**
 * The robots directive for one detail route. `follow` is kept in both branches:
 * a summary-only page still carries honest internal links to its category, tags
 * and related entries, and to the original source.
 */
export function detailRobotsContent(entry: DetailAddressableEntry): string {
  return isIndexableDetailEntry(entry)
    ? DETAIL_ROBOTS_INDEX
    : DETAIL_ROBOTS_NOINDEX;
}

export function collectIndexableDetailEntries<
  T extends DetailAddressableEntry,
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
