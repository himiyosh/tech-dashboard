export interface FeedSnippetEntry {
  contentSnippet?: string;
  /** "article" once contentSnippet holds prose fetched from the article page. */
  excerptOrigin?: string;
  /** The feed description as collected, kept alongside an article excerpt. */
  feedSnippet?: string;
}

/**
 * The text that source-owned decisions (keyword filters, category, importance,
 * knowledge eligibility) must be evaluated on.
 *
 * The collector makes those decisions on the feed description. The article
 * excerpt lane (worker/src/article-excerpt.ts) later replaces contentSnippet
 * with article prose for the model and keeps the feed text in feedSnippet.
 * Re-evaluating on the prose would change categories and filter outcomes
 * after the fact (the publisher's fail-closed gate then reports drift), so
 * every evaluator reads the feed text through this helper.
 *
 * An article-origin entry without feedSnippet (never produced by the current
 * lane; guarded for older artifacts) evaluates on its title alone: the prose
 * is not source text, and title-only is the documented lossy fallback.
 */
/**
 * True when contentSnippet holds article prose but the feed text was not
 * kept (entries enriched before feedSnippet existed). Nothing but the title
 * is source text any more, so evaluators keep the stored source-owned values
 * instead of re-deriving them from a text the collector never saw.
 * entry-merge.ts heals these on the next re-collection of the feed item.
 */
export function isSourceTextUnverifiable(entry: FeedSnippetEntry): boolean {
  return entry.excerptOrigin === "article" && sourceOwnedSnippet(entry) === undefined;
}

export function sourceOwnedSnippet(entry: FeedSnippetEntry): string | undefined {
  if (entry.excerptOrigin === "article") {
    const feed = typeof entry.feedSnippet === "string" ? entry.feedSnippet.trim() : "";
    return feed ? entry.feedSnippet : undefined;
  }
  return entry.contentSnippet;
}
