import { hasRealBody } from "./bodies.ts";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "./detail-addressability.ts";
import { isNonIndexableLane } from "./detail-index-policy.ts";

export {
  NON_INDEXABLE_SOURCE_TYPES,
  isNonIndexableLane,
} from "./detail-index-policy.ts";

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
 * A real body is necessary but NOT sufficient: the release/changelog lane is
 * excluded even when it has one. detail-index-policy.ts holds that rule, the
 * measurement behind it, and the reason it lives in a data-free module.
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
 * raw stored rows and fixtures stay testable; detail-index-policy.ts documents
 * why an absent value stays indexable rather than excluded.
 */
export interface DetailIndexableEntry extends DetailAddressableEntry {
  sourceType?: string;
}

export function isIndexableDetailEntry(entry: DetailIndexableEntry): boolean {
  // The publication gate lives HERE, not in route existence: a held entry
  // keeps its /e/[id]/ route so card titles always land in-site, but stays
  // `noindex` and out of the sitemap until released. This is what keeps a
  // bulk ingest from surfacing to search engines as a single-day burst of
  // new indexable pages (publication-gate.ts dailyReleaseLimit).
  if (entry.publicationHold === true) return false;
  // Cold-tier rows keep a reachable (noindex) route so listing cards land
  // in-site, but decayed content must not stay in the search index.
  if (entry.archiveTier === "cold" || entry.archiveTier === "dropped") {
    return false;
  }
  // A real body is necessary but not sufficient: the version-note lane is
  // excluded outright (detail-index-policy.ts).
  if (isNonIndexableLane(entry)) return false;
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
