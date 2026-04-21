import type { RawEntry, SourceDefinition } from "../types.ts";

/**
 * HN Algolia collector — queries the public Algolia API for recent front-page
 * stories tagged with AI/dev keywords. Unlike RSS, Algolia supports filtering,
 * which is essential for Tier 3's noise-vs-signal tradeoff.
 *
 * Spec: https://hn.algolia.com/api
 */
export async function collectHnAlgolia(
  source: SourceDefinition,
): Promise<RawEntry[]> {
  // Allow custom query via feedUrl (e.g., ?query=mcp&tags=story)
  const url =
    source.feedUrl ||
    "https://hn.algolia.com/api/v1/search?query=AI+coding&tags=story&hitsPerPage=30";

  const res = await fetch(url, {
    headers: {
      "User-Agent": "tech-dashboard-harness/0.1",
    },
  });
  if (!res.ok) throw new Error(`hn-algolia HTTP ${res.status}`);
  const data = (await res.json()) as {
    hits: Array<{
      title: string;
      url?: string;
      story_id: number;
      objectID: string;
      created_at: string;
      author: string;
      points: number;
      num_comments: number;
    }>;
  };

  return data.hits
    .filter((h) => h.url && h.points >= 50) // skip low-signal
    .map((h) => ({
      externalId: `hn-${h.objectID}`,
      url: h.url!,
      title: h.title,
      contentSnippet: `HN: ${h.points} points, ${h.num_comments} comments · @${h.author} · https://news.ycombinator.com/item?id=${h.objectID}`,
      publishedAt: new Date(h.created_at).toISOString(),
    }));
}
