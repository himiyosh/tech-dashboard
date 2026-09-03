import type { Importance, NormalizedEntry } from "../types.ts";
import { normalizeTags } from "./tag.ts";

function filled(value: string | undefined): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function fillText(primary: string | undefined, fallback: string | undefined): string {
  return filled(primary) || filled(fallback);
}

function maxImportance(primary: Importance, fallback: Importance): Importance {
  return Math.max(primary, fallback) as Importance;
}

function dedupeTags(tags: string[]): string[] {
  return normalizeTags(tags, 10);
}

export function mergeEntryEnrichment(
  primary: NormalizedEntry,
  fallback: NormalizedEntry | undefined,
): NormalizedEntry {
  if (!fallback) return primary;

  // A fetched article excerpt (or the record of a failed attempt) must not be
  // overwritten by the feed description every time the item is re-collected:
  // the article lane is bounded per run and marks each attempt exactly once.
  // feedSnippet travels with the marker: it is the text source-owned
  // decisions keep being evaluated on once contentSnippet holds article prose.
  // An article-origin side that lost its feed text (enriched before
  // feedSnippet existed) heals from the feed-origin side's contentSnippet,
  // which is the freshly collected feed description.
  const feedTextOf = (side: NormalizedEntry): string | undefined =>
    !side.excerptOrigin && typeof side.contentSnippet === "string" && side.contentSnippet.trim()
      ? side.contentSnippet
      : undefined;
  const carry = (enriched: NormalizedEntry, other: NormalizedEntry) => {
    const feedSnippet = enriched.feedSnippet ?? (enriched.excerptOrigin === "article" ? feedTextOf(other) : undefined);
    return {
      contentSnippet: enriched.contentSnippet,
      excerptOrigin: enriched.excerptOrigin,
      ...(feedSnippet !== undefined ? { feedSnippet } : {}),
    };
  };
  const excerpt = primary.excerptOrigin
    ? carry(primary, fallback)
    : fallback.excerptOrigin
      ? carry(fallback, primary)
      : {};

  return {
    ...primary,
    ...excerpt,
    titleJa: fillText(primary.titleJa, fallback.titleJa),
    titleEn: fillText(primary.titleEn, fallback.titleEn),
    summaryJa: fillText(primary.summaryJa, fallback.summaryJa),
    summaryEn: fillText(primary.summaryEn, fallback.summaryEn),
    bodyJa: fillText(primary.bodyJa, fallback.bodyJa),
    bodyEn: fillText(primary.bodyEn, fallback.bodyEn),
    publishedAt: primary.publishedAt ?? fallback.publishedAt,
    tags: dedupeTags([...primary.tags, ...fallback.tags]),
    importance: maxImportance(primary.importance, fallback.importance),
    image: primary.image ?? fallback.image,
    clusterId: primary.clusterId ?? fallback.clusterId,
    evergreen: primary.evergreen ?? fallback.evergreen,
    raw: primary.raw ?? fallback.raw,
  };
}
