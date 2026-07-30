import {
  CATEGORY_META,
  type Category,
  type CategoryMeta,
} from "./category-meta.ts";
import { SITE_URL } from "./site.ts";

export const SITE_WIDE_RSS_HREF = "/rss.xml" as const;
export const ARXIV_RSS_HREF = "/rss/arxiv.xml" as const;
export const KNOWLEDGE_RSS_HREF = "/rss/knowledge.xml" as const;
export const PUBLIC_RSS_LANGUAGE = "ja" as const;
export const OPML_HREF = "/feeds.opml" as const;
export const OPML_MEDIA_TYPE = "text/x-opml" as const;
export const OPML_CONTENT_TYPE = `${OPML_MEDIA_TYPE}; charset=utf-8` as const;
export const OPML_TITLE = "TECH Dashboard public RSS subscriptions" as const;

export interface PublicRssFeed {
  key: string;
  href: string;
  htmlHref: string;
  title: string;
  description: string;
}

export const SITE_WIDE_RSS_FEED: PublicRssFeed = {
  key: "site-wide",
  href: SITE_WIDE_RSS_HREF,
  htmlHref: "/",
  title: "TECH Dashboard \u2014 AI Daily",
  description: "AI コーディング/エコシステムの公式情報を毎日自動収集・要約",
};

export const ARXIV_RSS_FEED: PublicRssFeed = {
  key: "arxiv",
  href: ARXIV_RSS_HREF,
  htmlHref: "/arxiv/",
  title: "TECH Dashboard | arXiv Papers",
  description: "AI要約済みのarXiv論文を新着順で配信する専用feed",
};

export const KNOWLEDGE_RSS_FEED: PublicRssFeed = {
  key: "knowledge",
  href: KNOWLEDGE_RSS_HREF,
  htmlHref: "/knowledge/",
  title: "TECH Dashboard | Knowledge & Best Practices",
  description: "AI要約済みのevergreenな技術知見を新着順で配信するKnowledge専用feed",
};

export function categoryRssHref(category: Category): `/rss/${Category}.xml` {
  return `/rss/${category}.xml`;
}

export function categoryRssFeed(
  category: Pick<CategoryMeta, "slug" | "name">,
): PublicRssFeed {
  return {
    key: `category:${category.slug}`,
    href: categoryRssHref(category.slug),
    htmlHref: `/c/${category.slug}/`,
    title: `TECH Dashboard | ${category.name}`,
    description: `${category.name} カテゴリの AI 要約済み最新記事`,
  };
}

export function publicRssFeeds(
  categories: ReadonlyArray<Pick<CategoryMeta, "slug" | "name">> = CATEGORY_META,
): readonly PublicRssFeed[] {
  const feeds = [
    SITE_WIDE_RSS_FEED,
    ...categories.map(categoryRssFeed),
    ARXIV_RSS_FEED,
    KNOWLEDGE_RSS_FEED,
  ];
  const hrefs = new Set<string>();
  for (const feed of feeds) {
    if (hrefs.has(feed.href)) {
      throw new Error(`Duplicate public RSS URL: ${feed.href}`);
    }
    hrefs.add(feed.href);
  }
  return feeds;
}

export function publicFeedXmlUrl(feed: PublicRssFeed): string {
  return new URL(feed.href, SITE_URL).toString();
}

export function publicFeedHtmlUrl(feed: PublicRssFeed): string {
  return feed.htmlHref === "/"
    ? SITE_URL
    : new URL(feed.htmlHref, SITE_URL).toString();
}
