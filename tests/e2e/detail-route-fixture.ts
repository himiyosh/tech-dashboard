import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "../../web/src/lib/detail-addressability.ts";

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
