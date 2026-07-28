import {
  summaryForLangWithFallback,
  titleForLangWithFallback,
  type NormalizedEntry,
} from "./data.ts";
import type { Category } from "./category-meta.ts";

export const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";
export const RSS_ITEM_LIMIT = 100;

export interface RssChannel {
  title: string;
  link: string;
  description: string;
  lastBuildDate: string;
}

export function categoryRssHref(category: Category): `/rss/${Category}.xml` {
  return `/rss/${category}.xml`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function serializeRssFeed(
  entries: readonly NormalizedEntry[],
  channel: RssChannel,
): string {
  const items = entries.slice(0, RSS_ITEM_LIMIT)
    .map((entry) => {
      const title = escapeXml(titleForLangWithFallback(entry, "ja").text);
      const description = escapeXml(summaryForLangWithFallback(entry, "ja").text);
      const tags = entry.tags
        .map((tag) => `<category>${escapeXml(tag)}</category>`)
        .join("");
      const publishedAt = entry.publishedAt
        ? `<pubDate>${new Date(entry.publishedAt).toUTCString()}</pubDate>`
        : "";
      return `
    <item>
      <title>${title}</title>
      <link>${escapeXml(entry.url)}</link>
      <guid isPermaLink="true">${escapeXml(entry.url)}</guid>
      ${publishedAt}
      <description>${description}</description>
      <category>${escapeXml(entry.category)}</category>
      ${tags}
    </item>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(channel.title)}</title>
    <link>${escapeXml(channel.link)}</link>
    <description>${escapeXml(channel.description)}</description>
    <language>ja</language>
    <lastBuildDate>${new Date(channel.lastBuildDate).toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>
`;
}

export function createRssResponse(
  entries: readonly NormalizedEntry[],
  channel: RssChannel,
): Response {
  return new Response(serializeRssFeed(entries, channel), {
    headers: { "content-type": RSS_CONTENT_TYPE },
  });
}
