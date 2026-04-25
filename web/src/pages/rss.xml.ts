import type { APIRoute } from "astro";
import { ALL_ENTRIES, GENERATED_AT } from "../lib/data.ts";
import { SITE_URL } from "../lib/site.ts";

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const GET: APIRoute = () => {
  const items = ALL_ENTRIES.slice(0, 100)
    .map((e) => {
      const title = escape(e.titleJa || e.titleEn || e.title);
      const desc = escape(e.summaryJa || e.summaryEn || "");
      const cats = e.tags.map((t) => `<category>${escape(t)}</category>`).join("");
      const pubDate = e.publishedAt ? `<pubDate>${new Date(e.publishedAt).toUTCString()}</pubDate>` : "";
      return `
    <item>
      <title>${title}</title>
      <link>${escape(e.url)}</link>
      <guid isPermaLink="true">${escape(e.url)}</guid>
      ${pubDate}
      <description>${desc}</description>
      <category>${escape(e.category)}</category>
      ${cats}
    </item>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>TECH Dashboard — AI Daily</title>
    <link>${SITE_URL}</link>
    <description>AI コーディング/エコシステムの公式情報を毎日自動収集・要約</description>
    <language>ja</language>
    <lastBuildDate>${new Date(GENERATED_AT).toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
};
