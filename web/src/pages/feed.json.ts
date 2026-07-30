import type { APIRoute } from "astro";
import {
  PUBLISHABLE_ENTRIES,
  GENERATED_AT,
  titleForLangWithFallback,
} from "../lib/data.ts";
import { buildFeedDecisionDigest } from "../lib/feed-decision-digest.ts";
import { SITE_URL } from "../lib/site.ts";

export const GET: APIRoute = () => {
  const feed = {
    version: "https://jsonfeed.org/version/1.1",
    title: "TECH Dashboard — AI Daily",
    home_page_url: SITE_URL,
    feed_url: `${SITE_URL}/feed.json`,
    description: "AI コーディング/エコシステムの公式情報を毎日自動収集・要約",
    language: "ja",
    _generated_at: GENERATED_AT,
    items: PUBLISHABLE_ENTRIES.slice(0, 100).map((e) => {
      const title = titleForLangWithFallback(e, "ja");
      const digest = buildFeedDecisionDigest(e);
      return {
        id: e.id,
        url: e.url,
        title: title.text,
        summary: digest.text,
        content_text: digest.text,
        ...(e.publishedAt ? { date_published: e.publishedAt } : {}),
        tags: [e.category, ...e.tags],
        _source: e.source,
        _importance: e.importance,
      };
    }),
  };
  return new Response(JSON.stringify(feed, null, 2), {
    headers: { "content-type": "application/feed+json; charset=utf-8" },
  });
};
