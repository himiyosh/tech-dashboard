import type { APIRoute } from "astro";
import {
  ARXIV_FEED_ENTRIES,
  GENERATED_AT,
} from "../../lib/data.ts";
import { createRssResponse } from "../../lib/rss.ts";
import { SITE_URL } from "../../lib/site.ts";

export const GET: APIRoute = () =>
  createRssResponse(ARXIV_FEED_ENTRIES, {
    title: "TECH Dashboard | arXiv Papers",
    link: `${SITE_URL}/arxiv/`,
    description: "AI要約済みのarXiv論文を新着順で配信する専用feed",
    lastBuildDate: GENERATED_AT,
  });
