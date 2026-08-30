import { readFileSync } from "node:fs";
import {
  buildPublicationGate,
  parsePublicationApprovalManifest,
  type PublicationGate,
} from "../../web/src/lib/publication-gate.ts";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "../../web/src/lib/detail-addressability.ts";

/**
 * The exact publication gate the preview server was built with. Routes no
 * longer depend on it, but INDEXABILITY does: fixtures that expect a page in
 * the sitemap (or "index, follow") must select released entries through this,
 * or they can pick a held entry whose page is correctly noindex.
 *
 * The clock is data/index.json generatedAt, the same value web/src/lib/
 * publication-gate-data.ts feeds the build, so the two agree by construction.
 */
export const SITE_GATE: PublicationGate = buildPublicationGate({
  manifest: parsePublicationApprovalManifest(
    JSON.parse(readFileSync("data/approved-entries.json", "utf8")) as unknown,
  ),
  now: (
    JSON.parse(readFileSync("data/index.json", "utf8")) as { generatedAt: string }
  ).generatedAt,
});

/**
 * The exact route policy the preview server was built with. Route existence is
 * a pure content decision (usable summary, hot/warm tier) — the publication
 * gate only decides index/noindex and sitemap membership, so a held entry's
 * /e/{id}/ page still exists and fixtures may navigate to it. Every e2e
 * fixture that expects a 200 from /e/{id}/ must select through this, otherwise
 * it can pick a summary-pending or cold entry and hit a 404.
 */
export function isBuiltDetailEntry(entry: DetailAddressableEntry): boolean {
  return isAddressableDetailEntry(entry);
}
