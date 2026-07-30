import type { APIRoute } from "astro";
import {
  GENERATED_AT,
  KNOWLEDGE_ENTRIES,
} from "../../lib/data.ts";
import { createRssResponse } from "../../lib/rss.ts";
import { SITE_URL } from "../../lib/site.ts";

export const GET: APIRoute = () =>
  createRssResponse(KNOWLEDGE_ENTRIES, {
    title: "TECH Dashboard | Knowledge & Best Practices",
    link: `${SITE_URL}/knowledge/`,
    description: "AI要約済みのevergreenな技術知見を新着順で配信するKnowledge専用feed",
    lastBuildDate: GENERATED_AT,
  });
