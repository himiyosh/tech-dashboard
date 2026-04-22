/**
 * dedupe.ts — Phase 1: URL-based dedup only.
 * Phase 2 will add title-similarity clustering via embeddings.
 */
import type { NormalizedEntry } from "../types.ts";

export function dedupeByUrl(entries: NormalizedEntry[]): NormalizedEntry[] {
  const seen = new Map<string, NormalizedEntry>();
  for (const e of entries) {
    const key = canonicalUrl(e.url);
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

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip common tracking params.
    const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref", "ref_src"];
    for (const p of drop) u.searchParams.delete(p);
    u.hash = "";
    // Normalize trailing slash.
    const path = u.pathname.replace(/\/+$/, "") || "/";
    u.pathname = path;
    return u.toString();
  } catch {
    return url;
  }
}
