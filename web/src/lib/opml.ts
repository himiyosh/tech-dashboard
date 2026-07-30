import {
  OPML_CONTENT_TYPE,
  OPML_MEDIA_TYPE,
  OPML_HREF,
  OPML_TITLE,
  PUBLIC_RSS_LANGUAGE,
  publicFeedHtmlUrl,
  publicFeedXmlUrl,
  publicRssFeeds,
  type PublicRssFeed,
} from "./feed-catalog.ts";
import { escapeXml } from "./rss.ts";
import { SITE_URL } from "./site.ts";

export {
  OPML_CONTENT_TYPE,
  OPML_HREF,
  OPML_MEDIA_TYPE,
  OPML_TITLE,
};

function assertCanonicalPublicUrl(value: string, field: string): void {
  const url = new URL(value);
  if (url.origin !== new URL(SITE_URL).origin) {
    throw new Error(`${field} must use the canonical site origin: ${value}`);
  }
}

export function serializeOpml(
  feeds: readonly PublicRssFeed[] = publicRssFeeds(),
): string {
  const outlines = feeds.map((feed) => {
    if (!feed.title.trim() || !feed.description.trim()) {
      throw new Error(`Public RSS metadata is incomplete for ${feed.key}`);
    }
    const xmlUrl = publicFeedXmlUrl(feed);
    const htmlUrl = publicFeedHtmlUrl(feed);
    assertCanonicalPublicUrl(xmlUrl, "xmlUrl");
    assertCanonicalPublicUrl(htmlUrl, "htmlUrl");
    return {
      xmlUrl,
      markup: `    <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(xmlUrl)}" htmlUrl="${escapeXml(htmlUrl)}" description="${escapeXml(feed.description)}" language="${PUBLIC_RSS_LANGUAGE}" version="RSS" />`,
    };
  });
  const uniqueUrls = new Set(outlines.map((outline) => outline.xmlUrl));
  if (uniqueUrls.size !== outlines.length) {
    throw new Error("Public OPML contains duplicate RSS URLs");
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(OPML_TITLE)}</title>
  </head>
  <body>
${outlines.map((outline) => outline.markup).join("\n")}
  </body>
</opml>
`;
}

export function createOpmlResponse(): Response {
  return new Response(serializeOpml(), {
    headers: { "content-type": OPML_CONTENT_TYPE },
  });
}
