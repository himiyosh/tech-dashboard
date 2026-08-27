/**
 * tests/verbatim-summaries.test.ts
 *
 * 生成された summary が収集元 excerpt をそのまま再利用していないことを保証する。
 * 閾値は data/index.json (1,917 live entries) の実測に基づく:
 *  - 二つのシグナル合計の発火: summaryEn 159 件 / summaryJa 0 件
 *  - 語彙的に最長の製品名 run は 33 文字なので、名前だけでは 0.50 に届かない
 */
import { describe, expect, it } from "vitest";
import {
  VERBATIM_COVERAGE_RATIO,
  VERBATIM_SHINGLE_CHARS,
  findVerbatimSourceReuse,
  hasUsableGroundedBilingualSummary,
  hasVerbatimSourceReuse,
  needsSummaryGeneration,
  sanitizeStoredSummaryGrounding,
} from "../harness/pipeline/summary-quality.ts";

const EXCERPT =
  "Cursor now supports automations for building always-on agents that run based on triggers and instructions you define.";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    title: "Cursor Automations",
    titleJa: "Cursor Automations",
    titleEn: "Cursor Automations",
    lang: "en" as const,
    source: "cursor-changelog",
    sourceType: "changelog" as const,
    url: "https://cursor.com/changelog/automations",
    contentSnippet: EXCERPT,
    summaryJa:
      "Cursor がトリガーと指示に基づいて常時稼働するエージェントを構築できる自動化機能に対応し、定型作業を人手を介さず回せるようになった。",
    summaryEn:
      "Cursor added an automations feature that lets teams stand up always-on agents driven by triggers, removing the need to babysit repetitive workflows.",
    ...overrides,
  };
}

describe("verbatim source reuse guard", () => {
  it("calibration constants are the measured ones", () => {
    expect(VERBATIM_SHINGLE_CHARS).toBe(24);
    expect(VERBATIM_COVERAGE_RATIO).toBe(0.5);
  });

  it("accepts a genuine rewrite of the excerpt", () => {
    const clean = entry();
    expect(findVerbatimSourceReuse(clean, clean)).toEqual([]);
    expect(needsSummaryGeneration(clean)).toBe(false);
    expect(hasUsableGroundedBilingualSummary(clean, clean)).toBe(true);
  });

  it("rejects a summary that is the excerpt verbatim", () => {
    const copied = entry({ summaryEn: EXCERPT });
    const issues = findVerbatimSourceReuse(copied, copied);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "verbatim-source-reuse",
      field: "summaryEn",
      exact: true,
    });
    expect(hasVerbatimSourceReuse(copied, copied)).toBe(true);
    expect(hasUsableGroundedBilingualSummary(copied, copied)).toBe(false);
  });

  it("rejects a summary whose majority is lifted from the excerpt", () => {
    const mostlyCopied = entry({
      summaryEn:
        "Cursor now supports automations for building always-on agents that run based on triggers you define, per the changelog.",
    });
    const issues = findVerbatimSourceReuse(mostlyCopied, mostlyCopied);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("summaryEn");
    expect(issues[0]?.exact).toBe(false);
    expect(issues[0]?.coverage).toBeGreaterThanOrEqual(VERBATIM_COVERAGE_RATIO);
  });

  it("does NOT fire on a long product or version name reused from the excerpt", () => {
    // "watsonx orchestrate adk extension" (33 chars) is the longest pure
    // product-name run measured in data/index.json. It must not be enough.
    const named = entry({
      contentSnippet:
        "watsonx Orchestrate ADK Extension は IBM Bob 上で利用でき、開発者は拡張をインストールするだけで既存プロジェクトに接続できます。",
      summaryJa:
        "IBM Bob 向けに watsonx Orchestrate ADK Extension が提供され、追加設定なしで既存の開発フローへ組み込める点が実務上の利点となる。",
      summaryEn:
        "IBM Bob now ships the watsonx Orchestrate ADK Extension, letting developers wire an existing project into Orchestrate without extra scaffolding.",
    });
    expect(findVerbatimSourceReuse(named, named)).toEqual([]);
    expect(needsSummaryGeneration(named)).toBe(false);
  });

  it("does not fire when the entry carries no excerpt", () => {
    const noSnippet = entry({ contentSnippet: "", summaryEn: EXCERPT });
    expect(findVerbatimSourceReuse(noSnippet, noSnippet)).toEqual([]);
  });

  it("clears only the copied language and re-queues the entry", () => {
    const copied = entry({ summaryEn: EXCERPT });
    const result = sanitizeStoredSummaryGrounding(copied);

    expect(result.verbatimRejected).toBe(true);
    expect(result.verbatimIssues.map((issue) => issue.field)).toEqual([
      "summaryEn",
    ]);
    // grounding category is untouched: this is not a material fact conflict
    expect(result.rejected).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.entry.summaryEn).toBe("");
    expect(result.entry.summaryJa).toBe(copied.summaryJa);
    // blanked summary => the entry is queue-eligible again
    expect(needsSummaryGeneration(result.entry)).toBe(true);
  });

  it("a material grounding conflict still clears BOTH summaries", () => {
    const conflicting = {
      title: "Cursor Start",
      titleJa: "Cursor Start",
      titleEn: "Cursor Start",
      lang: "en" as const,
      contentSnippet:
        "Cursor Start is a new ₹649 monthly plan for developers in India with local pricing and UPI.",
      summaryJa: "Cursor Startはプロジェクト初期化を支援する新機能だ。",
      summaryEn: "Cursor Start is a project initialization and onboarding feature.",
    };
    const result = sanitizeStoredSummaryGrounding(conflicting);
    expect(result.rejected).toBe(true);
    expect(result.entry.summaryJa).toBe("");
    expect(result.entry.summaryEn).toBe("");
  });
});
