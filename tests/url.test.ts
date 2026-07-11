import { describe, expect, it } from "vitest";
import { dedupeByUrl } from "../harness/pipeline/dedupe.ts";
import { canonicalUrlKey, normalizeMediaUrl } from "../harness/pipeline/url.ts";
import type { NormalizedEntry } from "../harness/types.ts";

function entry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "entry",
    source: "netflix-techblog",
    sourceType: "blog",
    url: "https://example.com/article",
    title: "Article",
    titleJa: "記事",
    titleEn: "Article",
    summaryJa: "要約",
    summaryEn: "Summary",
    lang: "en",
    publishedAt: "2026-07-01T00:00:00.000Z",
    collectedAt: "2026-07-01T01:00:00.000Z",
    tags: [],
    category: "tech-news",
    importance: 2,
    ...overrides,
  };
}

describe("media URL normalization", () => {
  it("repeatedly decodes nested named and numeric HTML entities", () => {
    expect(normalizeMediaUrl(" https://cdn.example/img.jpg?a=1&amp;amp;b=2&#38;c=3&#x26;d=4 ")).toBe(
      "https://cdn.example/img.jpg?a=1&b=2&c=3&d=4",
    );
  });

  it("does not percent-decode nested imgix source URLs", () => {
    const encoded =
      "https://images.example/imgix?url=https%3A%2F%2Fcdn.example%2Fa.jpg%3Fx%3D1%2526y%253D2&amp;amp;w=1200";
    const normalized = normalizeMediaUrl(encoded);
    expect(normalized).toBe(
      "https://images.example/imgix?url=https%3A%2F%2Fcdn.example%2Fa.jpg%3Fx%3D1%2526y%253D2&w=1200",
    );
    expect(normalized).toContain("%2526");
  });
});

describe("canonical URL authorities", () => {
  it("preserves non-default ports so different origins do not deduplicate", () => {
    expect(canonicalUrlKey("https://example.com:8443/article")).toBe(
      "example.com:8443/article",
    );
    expect(canonicalUrlKey("https://example.com:8443/article")).not.toBe(
      canonicalUrlKey("https://example.com:9443/article"),
    );
  });

  it("continues to omit default ports normalized by URL parsing", () => {
    expect(canonicalUrlKey("https://example.com:443/article")).toBe(
      "example.com/article",
    );
  });
});

describe("Netflix TechBlog canonical URLs", () => {
  const medium =
    "https://medium.com/netflix-techblog/data-projects-managing-data-assets-at-netflix-scale-7ca25888591e?source=rss----2615bd06b42e---4";
  const custom =
    "https://netflixtechblog.com/data-projects-managing-data-assets-at-netflix-scale-7ca25888591e?source=rss----2615bd06b42e---4";

  it("maps the known Medium publication path to the custom-domain key", () => {
    expect(canonicalUrlKey(medium)).toBe(canonicalUrlKey(custom));
    expect(canonicalUrlKey(medium)).toBe(
      "netflixtechblog.com/data-projects-managing-data-assets-at-netflix-scale-7ca25888591e",
    );
  });

  it("does not collapse unrelated Medium publications", () => {
    expect(canonicalUrlKey("https://medium.com/another-publication/data-projects-7ca25888591e")).not.toBe(
      canonicalUrlKey(custom),
    );
  });

  it("collector dedupe collapses the alias pair while preserving winner and tags", () => {
    const deduped = dedupeByUrl([
      entry({
        id: "medium",
        url: medium,
        publishedAt: "2026-07-02T00:00:00.000Z",
        tags: ["medium"],
      }),
      entry({
        id: "custom",
        url: custom,
        publishedAt: "2026-07-01T00:00:00.000Z",
        tags: ["custom"],
      }),
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.id).toBe("custom");
    expect(deduped[0]!.tags).toEqual(["medium", "custom"]);
  });
});
