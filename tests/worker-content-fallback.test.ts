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
  it("英語タイトルの entry でも summaryJa と summaryEn を両方埋める", () => {
    const result = applyDeterministicContentFallback(baseEntry);

    expect(result.summaryFallbacks).toBe(2);
    // Summary-first (LL-112): the long-form body is no longer generated. Only
    // the bilingual summary is filled deterministically; body stays empty.
    expect(result.bodyFallbacks).toBe(0);
    expect(result.entry.summaryEn).toBe("Managed Agents");
    // JA summary must be Japanese (deterministic template) so the JA UI never
    // shows an EN fallback badge for worker-published entries (LL-028). The
    // JA template must also lead with Japanese characters — placing the EN
    // title at the start made cards look English (LL-041).
    expect(result.entry.summaryJa).toContain("Managed Agents");
    expect(result.entry.summaryJa).toMatch(/^[\u3040-\u30ff\u3400-\u9fff]/);
    // No filler body is produced (LL-112): body must stay empty, NOT the legacy
    // "...完了..." / "completed from the existing summary..." filler.
    expect(result.entry.bodyJa ?? "").toBe("");
    expect(result.entry.bodyEn ?? "").toBe("");
  });

  it("既存の summary/body は上書きしない", () => {
    const entry = {
      ...baseEntry,
      summaryJa: "既存の日本語要約",
      summaryEn: "Existing summary",
      bodyJa: "既存本文",
      bodyEn: "Existing body",
    };
    const result = applyDeterministicContentFallback(entry);

    expect(result.summaryFallbacks).toBe(0);
    expect(result.bodyFallbacks).toBe(0);
    expect(result.entry.summaryJa).toBe("既存の日本語要約");
    expect(result.entry.summaryEn).toBe("Existing summary");
    // Pre-existing real AI bodies are preserved (still rendered on detail page).
    expect(result.entry.bodyJa).toBe("既存本文");
    expect(result.entry.bodyEn).toBe("Existing body");
  });

  it("日本語 title の entry は summaryJa と summaryEn を両方埋める", () => {
    const result = applyDeterministicContentFallback({
      ...baseEntry,
      title: "新しいエージェント基盤",
      titleJa: "新しいエージェント基盤",
      titleEn: "",
      lang: "ja",
    });

    expect(result.entry.summaryJa).toBe("新しいエージェント基盤");
    // EN summary must be English (deterministic template) when only Japanese
    // title is available.
    expect(result.entry.summaryEn).not.toBe("");
    expect(result.entry.summaryEn).toMatch(/^[\x20-\x7e]+$/);
  });
});