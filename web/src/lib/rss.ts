import {
  titleForLangWithFallback,
  type NormalizedEntry,
} from "./data.ts";
import { buildFeedDecisionDigest } from "./feed-decision-digest.ts";
export {
  ARXIV_RSS_HREF,
  KNOWLEDGE_RSS_HREF,
  MAJOR_RSS_HREF,
  SITE_WIDE_RSS_HREF,
  categoryRssHref,
} from "./feed-catalog.ts";

export const RSS_CONTENT_TYPE = "application/rss+xml; charset=utf-8";
export const RSS_ITEM_LIMIT = 100;

export interface RssChannel {
  title: string;
  link: string;
  description: string;
  lastBuildDate: string;
}

export interface RssItemOptions<T extends NormalizedEntry = NormalizedEntry> {
  /** Override the reader destination without changing the stable source URL GUID. */
  itemLink?: (entry: T) => string;
  itemGuid?: (entry: T) => string;
  itemDate?: (entry: T) => string;
}

function isXml10CodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

export function escapeXml(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isXml10CodePoint(codePoint)) continue;

    switch (character) {
      case "&":
        escaped += "&amp;";
        break;
      case "<":
        escaped += "&lt;";
        break;
      case ">":
        escaped += "&gt;";
        break;
      case '"':
        escaped += "&quot;";
        break;
      case "'":
        escaped += "&apos;";
        break;
      default:
        escaped += character;
    }
  }
  return escaped;
}

export function serializeRssFeed<T extends NormalizedEntry>(
  entries: readonly T[],
  channel: RssChannel,
  options: RssItemOptions<T> = {},
): string {
  const items = entries.slice(0, RSS_ITEM_LIMIT)
    .map((entry) => {
      const itemLink = options.itemLink?.(entry) ?? entry.url;
      const guid = options.itemGuid?.(entry) ?? entry.url;
      const date = options.itemDate?.(entry) ?? entry.publishedAt;
      const title = escapeXml(titleForLangWithFallback(entry, "ja").text);
      const description = escapeXml(buildFeedDecisionDigest(entry).text);
      const tags = entry.tags
        .map((tag) => `<category>${escapeXml(tag)}</category>`)
        .join("");
      const publishedAt = date
        ? `<pubDate>${new Date(date).toUTCString()}</pubDate>`
        : "";
      return `
    <item>
      <title>${title}</title>
      <link>${escapeXml(itemLink)}</link>
      <guid isPermaLink="${options.itemGuid ? "false" : "true"}">${escapeXml(guid)}</guid>
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

export function createRssResponse<T extends NormalizedEntry>(
  entries: readonly T[],
  channel: RssChannel,
  options: RssItemOptions<T> = {},
): Response {
  return new Response(serializeRssFeed(entries, channel, options), {
    headers: { "content-type": RSS_CONTENT_TYPE },
  });
}
