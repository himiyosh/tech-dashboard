import { describe, expect, it, vi } from "vitest";

const titleForLangWithFallback = vi.fn(() => ({
  text: "検証済みタイトル",
  isFallback: false,
}));
const summaryForLangWithFallback = vi.fn(() => ({
  text: "検証済み要約。",
  isFallback: false,
}));

vi.mock("../web/src/lib/data.ts", () => ({
  GENERATED_AT: "2026-01-01T00:00:00.000Z",
  PUBLISHABLE_ENTRIES: [
    {
      id: "feed-entry",
      source: "official-source",
      sourceType: "blog",
      url: "https://example.com/article",
      title: "RAW_TITLE",
      titleJa: "",
      titleEn: "Raw title",
      summaryJa: "RAW_SUMMARY",
      summaryEn: "Raw summary",
      publishedAt: "2026-01-01T00:00:00.000Z",
      collectedAt: "2026-01-01T01:00:00.000Z",
      tags: ["agent"],
      category: "agent-fw",
      importance: 2,
    },
  ],
  summaryForLangWithFallback,
  titleForLangWithFallback,
}));

const { GET: getRss } = await import("../web/src/pages/rss.xml.ts");
const { GET: getJsonFeed } = await import("../web/src/pages/feed.json.ts");

describe("public feeds", () => {
  it("RSS publishes validated display title and summary", async () => {
    const response = (await getRss({} as never)) as Response;
    const xml = await response.text();

    expect(response.headers.get("content-type")).toContain("application/rss+xml");
    expect(xml).toContain("<title>検証済みタイトル</title>");
    expect(xml).toContain("<description>検証済み要約。</description>");
    expect(xml).not.toContain("RAW_TITLE");
    expect(xml).not.toContain("RAW_SUMMARY");
  });

  it("JSON Feed publishes validated display title and summary", async () => {
    const response = (await getJsonFeed({} as never)) as Response;
    const feed = await response.json();

    expect(response.headers.get("content-type")).toContain("application/feed+json");
    expect(feed.items[0]).toMatchObject({
      title: "検証済みタイトル",
      content_text: "検証済み要約。",
    });
    expect(JSON.stringify(feed)).not.toContain("RAW_TITLE");
    expect(JSON.stringify(feed)).not.toContain("RAW_SUMMARY");
  });
});
