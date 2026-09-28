import type { APIRoute } from "astro";
import { GENERATED_AT } from "../../lib/data.ts";
import { MAJOR_RSS_FEED } from "../../lib/feed-catalog.ts";
import { MAJOR_UPDATE_STATE } from "../../lib/major-update-data.ts";
import {
  publicMajorUpdate,
  recentMajorUpdateEvents,
} from "../../lib/major-update-public.ts";
import { createRssResponse } from "../../lib/rss.ts";
import { SITE_URL } from "../../lib/site.ts";

export const GET: APIRoute = () =>
  createRssResponse(recentMajorUpdateEvents(MAJOR_UPDATE_STATE, 100), {
    title: MAJOR_RSS_FEED.title,
    link: SITE_URL,
    description: MAJOR_RSS_FEED.description,
    lastBuildDate: MAJOR_UPDATE_STATE.index.lastObservedAt ?? GENERATED_AT,
  }, {
    itemLink: (event) => event.siteUrl,
    itemGuid: (event) => publicMajorUpdate(event).id,
    itemDate: (event) => event.observedAt,
  });
