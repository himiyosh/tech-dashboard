import type { APIRoute } from "astro";
import {
  CATEGORY_META,
  GENERATED_AT,
  PUBLISHABLE_ENTRIES,
} from "../../lib/data.ts";
import {
  categoryRssFeed,
  publicFeedHtmlUrl,
} from "../../lib/feed-catalog.ts";
import {
  createRssResponse,
} from "../../lib/rss.ts";
import { filterCategoryListingEntries } from "../../lib/research-lane.ts";

export function getStaticPaths() {
  return CATEGORY_META.map((category) => ({
    params: { category: category.slug },
  }));
}

export const GET: APIRoute = ({ params }) => {
  const category = CATEGORY_META.find((item) => item.slug === params.category);
  if (!category) {
    return new Response("Not found", { status: 404 });
  }

  const entries = filterCategoryListingEntries(
    PUBLISHABLE_ENTRIES,
    category.slug,
  );
  const feed = categoryRssFeed(category);
  return createRssResponse(entries, {
    title: feed.title,
    link: publicFeedHtmlUrl(feed),
    description: feed.description,
    lastBuildDate: GENERATED_AT,
  });
};
