import type { APIRoute } from "astro";
import {
  GENERATED_AT,
  KNOWLEDGE_ENTRIES,
} from "../../lib/data.ts";
import {
  KNOWLEDGE_RSS_FEED,
  publicFeedHtmlUrl,
} from "../../lib/feed-catalog.ts";
import { createRssResponse } from "../../lib/rss.ts";

export const GET: APIRoute = () =>
  createRssResponse(KNOWLEDGE_ENTRIES, {
    title: KNOWLEDGE_RSS_FEED.title,
    link: publicFeedHtmlUrl(KNOWLEDGE_RSS_FEED),
    description: KNOWLEDGE_RSS_FEED.description,
    lastBuildDate: GENERATED_AT,
  });
