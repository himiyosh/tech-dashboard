import { describe, expect, it } from "vitest";
import { mergeEntryEnrichment } from "../harness/pipeline/entry-merge.ts";
import type { NormalizedEntry } from "../harness/types.ts";

function entry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "id-1",
    source: "anthropic-news",
    sourceType: "blog",
    url: "https://example.com/article",
    title: "Fresh title",
    titleJa: "",
    titleEn: "Fresh title",
    summaryJa: "",
    summaryEn: "",
    lang: "en",
    publishedAt: "2026-05-01T00:00:00.000Z",
    collectedAt: "2026-05-12T00:00:00.000Z",
    tags: ["claude"],
    category: "claude",
    importance: 2,
    ...overrides,
  };
}

describe("mergeEntryEnrichment", () => {
  it("記事抜粋と一緒に feedSnippet(収集時のフィード文)を引き継ぐ", () => {
    const fresh = entry({
      id: "fresh",
      contentSnippet: "Feed description re-collected this run.",
    });
    const previous = entry({
      id: "previous",
      contentSnippet: "Article prose fetched by the excerpt lane.",
      excerptOrigin: "article",
      feedSnippet: "Feed description seen at collection time.",
    });
    const merged = mergeEntryEnrichment(fresh, previous);
    expect(merged.contentSnippet).toBe("Article prose fetched by the excerpt lane.");
    expect(merged.excerptOrigin).toBe("article");
    expect(merged.feedSnippet).toBe("Feed description seen at collection time.");

    const primaryEnriched = mergeEntryEnrichment(previous, fresh);
    expect(primaryEnriched.feedSnippet).toBe("Feed description seen at collection time.");

    const untouched = mergeEntryEnrichment(fresh, entry({ id: "plain", contentSnippet: "Older feed text." }));
    expect(untouched.contentSnippet).toBe("Feed description re-collected this run.");
    expect(untouched.feedSnippet).toBeUndefined();
  });

  it("fresh entry が選ばれても既存の本文・要約を保持する", () => {
    const fresh = entry({
      id: "fresh",
      collectedAt: "2026-05-12T01:00:00.000Z",
      summaryJa: "",
      summaryEn: "",
      bodyJa: "",
      bodyEn: "",
      tags: ["claude"],
      importance: 1,
    });
    const previous = entry({
      id: "previous",
      collectedAt: "2026-05-11T01:00:00.000Z",
      titleJa: "既存タイトル",
      summaryJa: "既存の日本語要約",
      summaryEn: "Existing English summary",
      bodyJa: "既存の長文本文",
      bodyEn: "Existing long body",
      tags: ["claude", "research"],
      importance: 3,
      image: { url: "https://example.com/og.png", source: "og" },
    });

    const merged = mergeEntryEnrichment(fresh, previous);

    expect(merged.id).toBe("fresh");
    expect(merged.summaryJa).toBe("既存の日本語要約");
    expect(merged.summaryEn).toBe("Existing English summary");
    expect(merged.bodyJa).toBe("既存の長文本文");
    expect(merged.bodyEn).toBe("Existing long body");
    expect(merged.titleJa).toBe("既存タイトル");
    expect(merged.tags).toEqual(["claude", "research"]);
    expect(merged.importance).toBe(3);
    expect(merged.image?.url).toBe("https://example.com/og.png");
  });

  it("fresh entry の値がある場合は上書きしない", () => {
    const fresh = entry({
      summaryJa: "新しい要約",
      summaryEn: "New summary",
      bodyJa: "新しい本文",
      bodyEn: "New body",
      importance: 2,
    });
    const previous = entry({
      summaryJa: "古い要約",
      summaryEn: "Old summary",
      bodyJa: "古い本文",
      bodyEn: "Old body",
      importance: 1,
    });

    const merged = mergeEntryEnrichment(fresh, previous);

    expect(merged.summaryJa).toBe("新しい要約");
    expect(merged.summaryEn).toBe("New summary");
    expect(merged.bodyJa).toBe("新しい本文");
    expect(merged.bodyEn).toBe("New body");
    expect(merged.importance).toBe(2);
  });

  it("normalizes aliases while merging fresh and cached tags", () => {
    const fresh = entry({
      tags: ["ai-agent", "prerelease", "benchmarks"],
    });
    const previous = entry({
      tags: ["ai-agents", "pre-release", "benchmark", "patch", "zed-editor"],
    });

    const merged = mergeEntryEnrichment(fresh, previous);

    expect(merged.tags).toEqual([
      "ai-agents",
      "benchmark",
      "patch-release",
      "pre-release",
      "zed",
    ]);
  });
});

describe("mergeEntryEnrichment — article excerpt", () => {
  it("keeps the fetched article excerpt when the feed re-collects the item", () => {
    const prior = entry({
      id: "prior",
      collectedAt: "2026-09-01T00:00:00.000Z",
      contentSnippet: "記事本文から抽出した長い抜粋".repeat(20),
      excerptOrigin: "article",
    });
    const fresh = entry({
      id: "fresh",
      collectedAt: "2026-09-01T01:00:00.000Z",
      contentSnippet: "短いフィード説明",
    });
    const merged = mergeEntryEnrichment(fresh, prior);
    expect(merged.id).toBe("fresh");
    expect(merged.contentSnippet).toBe(prior.contentSnippet);
    expect(merged.excerptOrigin).toBe("article");
  });

  it("keeps the one-shot unavailable marker so the lane does not retry hourly", () => {
    const prior = entry({ contentSnippet: "feed", excerptOrigin: "article-unavailable" });
    const fresh = entry({ collectedAt: "2026-09-01T01:00:00.000Z", contentSnippet: "feed again" });
    const merged = mergeEntryEnrichment(fresh, prior);
    expect(merged.excerptOrigin).toBe("article-unavailable");
    expect(merged.contentSnippet).toBe("feed");
  });

  it("prefers the primary's own article excerpt over a stale fallback marker", () => {
    const prior = entry({ contentSnippet: "feed", excerptOrigin: "article-unavailable" });
    const fresh = entry({ contentSnippet: "本文".repeat(300), excerptOrigin: "article" });
    const merged = mergeEntryEnrichment(fresh, prior);
    expect(merged.excerptOrigin).toBe("article");
    expect(merged.contentSnippet).toBe(fresh.contentSnippet);
  });
});
