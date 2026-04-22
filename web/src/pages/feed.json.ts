import type { APIRoute } from "astro";
import { ALL_ENTRIES, GENERATED_AT } from "../lib/data.ts";

const SITE = "https://tech-dashboard.pages.dev";

export const GET: APIRoute = () => {
  const feed = {
    version: "https://jsonfeed.org/version/1.1",
    title: "TECH Dashboard — AI Daily",
    home_page_url: SITE,
    feed_url: `${SITE}/feed.json`,
    description: "AI コーディング/エコシステムの公式情報を毎日自動収集・要約",
    language: "ja",
    _generated_at: GENERATED_AT,
    items: ALL_ENTRIES.slice(0, 100).map((e) => ({
      id: e.id,
      url: e.url,
      title: e.titleJa || e.titleEn || e.title,
      content_text: e.summaryJa || e.summaryEn || "",
      ...(e.publishedAt ? { date_published: e.publishedAt } : {}),
      tags: [e.category, ...e.tags],
      _source: e.source,
      _importance: e.importance,
    })),
  };
  return new Response(JSON.stringify(feed, null, 2), {
    headers: { "content-type": "application/feed+json; charset=utf-8" },
  });
};
