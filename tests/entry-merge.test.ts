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
});
