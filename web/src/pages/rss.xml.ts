import type { APIRoute } from "astro";
import {
  PUBLISHABLE_ENTRIES,
  GENERATED_AT,
} from "../lib/data.ts";
import {
  publicFeedHtmlUrl,
  SITE_WIDE_RSS_FEED,
} from "../lib/feed-catalog.ts";
import { createRssResponse } from "../lib/rss.ts";

export const GET: APIRoute = () =>
  createRssResponse(PUBLISHABLE_ENTRIES, {
    title: SITE_WIDE_RSS_FEED.title,
    link: publicFeedHtmlUrl(SITE_WIDE_RSS_FEED),
    description: SITE_WIDE_RSS_FEED.description,
    lastBuildDate: GENERATED_AT,
  });
