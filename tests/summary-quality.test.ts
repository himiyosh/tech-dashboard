import { describe, expect, it } from "vitest";
import {
  hasUsableBilingualSummary,
  isContaminatedSummaryText,
  needsSummaryGeneration,
} from "../harness/pipeline/summary-quality.ts";

describe("summary quality contract", () => {
  it.each([
    "Left some junk in the readme during a pairing session",
    "Forgot to remove oopsies before publishing",
    "Release Notes: N/A or Added/Fixed/Improved ...",
  ])("detects generated summary contamination: %s", (summary) => {
    expect(isContaminatedSummaryText(summary)).toBe(true);
  });

  it("requires clean bilingual summaries that are not bare title echoes", () => {
    const clean = {
      title: "Zed collab-staging",
      titleJa: "Zed コラボレーション更新",
      titleEn: "Zed collab-staging",
      summaryJa: "編集予測の品質計測を改善した。",
      summaryEn: "Zed improved edit prediction quality metrics.",
    };
    expect(hasUsableBilingualSummary(clean)).toBe(true);
    expect(needsSummaryGeneration(clean)).toBe(false);
    expect(needsSummaryGeneration({ ...clean, summaryEn: clean.titleEn })).toBe(true);
    expect(needsSummaryGeneration({
      ...clean,
      summaryEn: "Left some junk in the readme and forgot to remove oopsies",
    })).toBe(true);
  });
});
