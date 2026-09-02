import { describe, expect, it } from "vitest";
import {
  hasUsableBilingualSummary,
  isContaminatedSummaryText,
  needsSummaryGeneration,
  hasForeignScriptContamination,
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

  it.each([
    ["Zed collab-staging.", "summaryEn"],
    ['"Zed collab-staging"', "summaryEn"],
    ["「Zed コラボレーション更新」", "summaryJa"],
  ])("treats a punctuated or quoted title echo as incomplete: %s", (summary, field) => {
    const input = {
      title: "Zed collab-staging",
      titleJa: "Zed コラボレーション更新",
      titleEn: "Zed collab-staging",
      summaryJa: "編集予測の品質計測を改善した。",
      summaryEn: "Zed improved edit prediction quality metrics.",
      [field]: summary,
    };
    expect(needsSummaryGeneration(input)).toBe(true);
  });

  it("rejects a model summary that echoes an original title outside the response", () => {
    const response = {
      titleJa: "モデルが生成した別タイトル",
      summaryJa: "元記事の内容を日本語で要約した。",
      summaryEn: "Original source title.",
    };

    expect(
      hasUsableBilingualSummary(response, ["Original source title"]),
    ).toBe(false);
  });
});


describe("summary contamination gates (site audit)", () => {
  it("rejects feed and git chrome that reached summaryEn on release feeds", () => {
    expect(isContaminatedSummaryText("fix: handle persisted agent_kind ( #14306 ) Co-authored-by: openhands <openhands@all-hands.dev>")).toBe(true);
    expect(isContaminatedSummaryText("Learn what's new in Visual Studio Code 1.114 Read the full article")).toBe(true);
    expect(isContaminatedSummaryText("What's Changed chore: jb-66 by @RomneyDa in #11909 Full Changelog")).toBe(true);
    expect(isContaminatedSummaryText("The post Foo appeared first on Source.")).toBe(true);
    expect(isContaminatedSummaryText("Copilot CLI adds a --resume flag so long sessions survive restarts.")).toBe(false);
  });

  it("rejects foreign-script contamination in Japanese or English editorial text", () => {
    expect(hasForeignScriptContamination("Anthropicの「AI for Science」희귀疾患研究グラント募集開始")).toBe(true);
    expect(isContaminatedSummaryText("Anthropicの「AI for Science」희귀疾患研究グラント募集開始")).toBe(true);
    expect(hasForeignScriptContamination("Claude Code v2.1.246 で API キー漏洩を修正")).toBe(false);
    expect(hasForeignScriptContamination("Introducing Hy4 Preview — a 770B open-weight model")).toBe(false);
  });
});
