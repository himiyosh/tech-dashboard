import type { APIRoute } from "astro";
import {
  ARXIV_FEED_ENTRIES,
  GENERATED_AT,
} from "../../lib/data.ts";
import {
  ARXIV_RSS_FEED,
  publicFeedHtmlUrl,
} from "../../lib/feed-catalog.ts";
import { createRssResponse } from "../../lib/rss.ts";

export const GET: APIRoute = () =>
  createRssResponse(ARXIV_FEED_ENTRIES, {
    title: ARXIV_RSS_FEED.title,
    link: publicFeedHtmlUrl(ARXIV_RSS_FEED),
    description: ARXIV_RSS_FEED.description,
    lastBuildDate: GENERATED_AT,
  });
