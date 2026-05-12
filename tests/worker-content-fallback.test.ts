import { describe, expect, it } from "vitest";
import { applyDeterministicContentFallback } from "../worker/src/content-fallback.ts";
import type { NormalizedEntry } from "../harness/types.ts";

const baseEntry: NormalizedEntry = {
  id: "entry-1",
  source: "anthropic-engineering",
  sourceType: "blog",
  url: "https://www.anthropic.com/engineering/managed-agents",
  title: "Managed Agents",
  titleJa: "",
  titleEn: "Managed Agents",
  summaryJa: "",
  summaryEn: "",
  lang: "en",
  publishedAt: "2026-05-12T09:00:00.000Z",
  collectedAt: "2026-05-12T10:00:00.000Z",
  tags: ["anthropic", "agents"],
  category: "agent-fw",
  importance: 2,
};

describe("applyDeterministicContentFallback", () => {
  it("summary と body が空の entry を publish 可能な形に補完する", () => {
    const result = applyDeterministicContentFallback(baseEntry);

    expect(result.summaryFallbacks).toBe(1);
    expect(result.bodyFallbacks).toBe(2);
    expect(result.entry.summaryEn).toBe("Managed Agents");
    expect(result.entry.bodyJa).toContain("Managed Agents は、anthropic-engineering が伝えた agent-fw 領域の更新です");
    expect(result.entry.bodyEn).toContain("completed from the existing summary and collection metadata");
  });

  it("既存の summary/body は上書きしない", () => {
    const entry = {
      ...baseEntry,
      summaryEn: "Existing summary",
      bodyJa: "既存本文",
      bodyEn: "Existing body",
    };
    const result = applyDeterministicContentFallback(entry);

    expect(result.summaryFallbacks).toBe(0);
    expect(result.bodyFallbacks).toBe(0);
    expect(result.entry.summaryEn).toBe("Existing summary");
    expect(result.entry.bodyJa).toBe("既存本文");
    expect(result.entry.bodyEn).toBe("Existing body");
  });

  it("日本語 title の entry は summaryJa を補完する", () => {
    const result = applyDeterministicContentFallback({
      ...baseEntry,
      title: "新しいエージェント基盤",
      titleJa: "新しいエージェント基盤",
      titleEn: "",
      lang: "ja",
    });

    expect(result.entry.summaryJa).toBe("新しいエージェント基盤");
    expect(result.entry.summaryEn).toBe("");
  });
});