/**
 * dedupe.ts - URL-based dedup for collector and data merge output.
 * Heavier similarity checks belong in audit/reporting, not the hot publish path.
 */
import type { NormalizedEntry } from "../types.ts";
import { canonicalUrlKey } from "./url.ts";

export function dedupeByUrl(entries: NormalizedEntry[]): NormalizedEntry[] {
  const seen = new Map<string, NormalizedEntry>();
  for (const e of entries) {
    const key = canonicalUrlKey(e.url) ?? e.url;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
      continue;
    }
    // Keep the one with earliest publishedAt, but merge tags.
    const mergedTags = Array.from(new Set([...existing.tags, ...e.tags]));
    const existMs = existing.publishedAt ? new Date(existing.publishedAt).getTime() : Infinity;
    const eMs = e.publishedAt ? new Date(e.publishedAt).getTime() : Infinity;
    const winner = existMs <= eMs ? existing : e;
    seen.set(key, { ...winner, tags: mergedTags });
  }
  return Array.from(seen.values());
}
