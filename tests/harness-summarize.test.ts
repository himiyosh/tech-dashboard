/**
 * tests/harness-summarize.test.ts
 *
 * harness/pipeline/summarize.ts の parseModelResponse() 単体テスト。
 * AI モデルへのネットワーク呼び出しは一切行わない。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  isCompleteSummaryResponse,
  needsGeneratedContent,
  parseModelResponse,
  resolveSummarizeModel,
  stripIndexBodies,
  summarize,
} from "../harness/pipeline/summarize.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import { buildSummaryPrompt } from "../worker/src/prompt.ts";

describe("parseModelResponse", () => {
  it("正常な JSON を正しくパースする", () => {
    const text = JSON.stringify({
      titleJa: "Claude Opus 4.7 リリース",
      summaryJa: "Anthropic が新モデルを発表した。",
      summaryEn: "Anthropic released a new model.",
      bodyJa: "本文日本語",
      bodyEn: "English body text",
      importance: 3,
      extraTags: ["claude", "llm"],
    });

    const result = parseModelResponse(text);
    expect(result.titleJa).toBe("Claude Opus 4.7 リリース");
    expect(result.summaryJa).toBe("Anthropic が新モデルを発表した。");
    expect(result.summaryEn).toBe("Anthropic released a new model.");
    expect(result.bodyJa).toBe("本文日本語");
    expect(result.bodyEn).toBe("English body text");
    expect(result.importance).toBe(3);
    expect(result.extraTags).toEqual(["claude", "llm"]);
  });

  it("JSON の前後に余計なテキストがあっても抽出できる", () => {
    const text = `以下が出力です:\n${JSON.stringify({ titleJa: "タイトル", summaryJa: "要約", summaryEn: "summary", bodyJa: "body", bodyEn: "body en", importance: 1, extraTags: [] })}\n以上です。`;
    const result = parseModelResponse(text);
    expect(result.titleJa).toBe("タイトル");
  });

  it("JSON 文字列内の生改行を復旧してパースする", () => {
    const text = `{
      "titleJa": "タイトル",
      "summaryJa": "要約",
      "summaryEn": "summary",
      "bodyJa": "前半

後半",
      "bodyEn": "First paragraph.

Second paragraph.",
      "importance": 1,
      "extraTags": []
    }`;
    const result = parseModelResponse(text);
    expect(result.bodyJa).toBe("前半\n\n後半");
    expect(result.bodyEn).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("JSON が空の場合は空文字列のデフォルトを返す", () => {
    const result = parseModelResponse("JSON が見当たりません");
    expect(result.titleJa).toBe("");
    expect(result.summaryJa).toBe("");
    expect(result.importance).toBe(1);
    expect(result.extraTags).toEqual([]);
  });

  it("importance が範囲外の場合は 1〜3 にクランプする", () => {
    const text = JSON.stringify({ titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 99, extraTags: [] });
    expect(parseModelResponse(text).importance).toBe(3);

    const text2 = JSON.stringify({ titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 0, extraTags: [] });
    expect(parseModelResponse(text2).importance).toBe(1);
  });

  it("extraTags は最大 6 件にトリミングされる", () => {
    const tags = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const text = JSON.stringify({ titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 1, extraTags: tags });
    expect(parseModelResponse(text).extraTags).toHaveLength(6);
  });

  it("extraTags に文字列以外が混在しても文字列のみを返す", () => {
    const text = JSON.stringify({ titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 1, extraTags: ["ok", 123, null, "good"] });
    const result = parseModelResponse(text);
    expect(result.extraTags).toEqual(["ok", "good"]);
  });

  it("壊れた JSON (途中で切れている) は空のデフォルトを返す", () => {
    const brokenJson = `{"titleJa": "壊れた JSON", "summaryJa": "途中で切`;
    const result = parseModelResponse(brokenJson);
    expect(result.titleJa).toBe("");
  });

  it("bodyEn が欠落している場合は空文字列を返す", () => {
    const text = JSON.stringify({ titleJa: "T", summaryJa: "S", summaryEn: "S", bodyJa: "B", importance: 1, extraTags: [] });
    expect(parseModelResponse(text).bodyEn).toBe("");
  });
});

describe("resolveSummarizeModel", () => {
  it("補完/backfill で許可されたモデルを受け付ける", () => {
    expect(resolveSummarizeModel("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(resolveSummarizeModel("claude-opus-4.7")).toBe("claude-opus-4.7");
    expect(resolveSummarizeModel("gpt-5.5")).toBe("gpt-5.5");
  });

  it("補完/backfill で許可されていないモデルは拒否する", () => {
    expect(() => resolveSummarizeModel("gpt-4o")).toThrow(
      /Unsupported SUMMARIZE_MODEL/,
    );
  });
});

describe("needsGeneratedContent", () => {
  it("deterministic fallback summary は backfill 対象にする", () => {
    expect(needsGeneratedContent({
      summaryJa: "このエントリは zenn から収集した tech-news 領域の最新アップデートです。",
      summaryEn: "English summary.",
    })).toBe(true);
    expect(needsGeneratedContent({
      summaryJa: "日本語要約",
      summaryEn: "tech-news update from zenn. AI summary not yet available; a future Worker run will refresh this entry.",
    })).toBe(true);
  });

  it("empty bodies でも real bilingual summaries が揃っていれば backfill 対象にしない", () => {
    expect(needsGeneratedContent({
      summaryJa: "日本語要約",
      summaryEn: "English summary.",
    })).toBe(false);
  });

  it("non-empty contaminated summary は backfill 対象にする", () => {
    expect(needsGeneratedContent({
      title: "collab-staging",
      titleEn: "collab-staging",
      summaryJa: "編集予測の品質計測を改善した。",
      summaryEn: "Left some junk in the readme and forgot to remove oopsies Release Notes: N/A or Added/Fixed/Improved",
    })).toBe(true);
  });

});

describe("summarize cache application", () => {
  it("does not overwrite a valid entry with contaminated cache when generation is unavailable", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tech-dashboard-summary-cache-"));
    const url = "https://example.com/clean-entry";
    const entry: NormalizedEntry = {
      id: "clean-entry",
      source: "example",
      sourceType: "blog",
      url,
      title: "A clean release",
      titleJa: "クリーンなリリース",
      titleEn: "A clean release",
      summaryJa: "既存の有効な日本語要約。",
      summaryEn: "The existing English summary is valid.",
      lang: "en",
      publishedAt: "2026-07-01T00:00:00.000Z",
      collectedAt: "2026-07-01T01:00:00.000Z",
      tags: ["release"],
      category: "tech-news",
      importance: 2,
    };
    writeFileSync(
      join(dataDir, "_summary-cache.json"),
      JSON.stringify({
        [url]: {
          titleJa: "汚染されたタイトル",
          summaryJa: "汚染された日本語要約。",
          summaryEn: "Forgot to remove oopsies before publishing.",
          importance: 3,
          extraTags: ["contaminated"],
        },
      }),
      "utf8",
    );

    const previousToken = process.env.COPILOT_TOKEN;
    const previousPat = process.env.COPILOT_PAT;
    delete process.env.COPILOT_TOKEN;
    delete process.env.COPILOT_PAT;
    try {
      const result = await summarize([entry], dataDir);
      expect(result.entries[0]?.titleJa).toBe(entry.titleJa);
      expect(result.entries[0]?.summaryJa).toBe(entry.summaryJa);
      expect(result.entries[0]?.summaryEn).toBe(entry.summaryEn);
      expect(result.entries[0]?.tags).toEqual(entry.tags);
      expect(result.stats).toMatchObject({ cached: 0, skipped: 1 });
    } finally {
      if (previousToken === undefined) delete process.env.COPILOT_TOKEN;
      else process.env.COPILOT_TOKEN = previousToken;
      if (previousPat === undefined) delete process.env.COPILOT_PAT;
      else process.env.COPILOT_PAT = previousPat;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("isCompleteSummaryResponse", () => {
  it("titleJa + bilingual summary があれば本文なしでも成功扱いにする", () => {
    const parsed = parseModelResponse(
      JSON.stringify({
        titleJa: "タイトル",
        summaryJa: "日本語要約",
        summaryEn: "English summary.",
        bodyJa: "",
        bodyEn: "",
        importance: 2,
        extraTags: [],
      }),
    );

    expect(isCompleteSummaryResponse(parsed)).toBe(true);
    expect(isCompleteSummaryResponse(parseModelResponse("not json"))).toBe(
      false,
    );
  });

  it("contaminated summary response は成功扱いにしない", () => {
    const parsed = parseModelResponse(JSON.stringify({
      titleJa: "タイトル",
      summaryJa: "有効な日本語要約。",
      summaryEn: "Forgot to remove oopsies before publishing.",
      importance: 2,
      extraTags: [],
    }));
    expect(isCompleteSummaryResponse(parsed)).toBe(false);
  });

  it("元記事タイトルをそのまま返す summary response は成功扱いにしない", () => {
    const parsed = parseModelResponse(JSON.stringify({
      titleJa: "モデルが生成した日本語タイトル",
      summaryJa: "更新の要点を日本語で説明した。",
      summaryEn: "Original release title.",
      importance: 2,
      extraTags: [],
    }));

    expect(
      isCompleteSummaryResponse(parsed, ["Original release title"]),
    ).toBe(false);
  });
});

describe("buildSummaryPrompt", () => {
  it("summary-only contract で body fields や long-form 要求を含まない", () => {
    const prompt = buildSummaryPrompt({
      title: "Amazon Bedrock introduces new advanced prompt optimization and migration tool",
      category: "agent-fw",
      source: "aws-ml-blog",
      sourceType: "blog",
      url: "https://example.com/bedrock",
      contentSnippet: "AWS announced prompt optimization improvements for Bedrock.",
    });

    expect(prompt).toContain('"titleJa"');
    expect(prompt).toContain('"summaryJa"');
    expect(prompt).toContain('"summaryEn"');
    expect(prompt).not.toContain('"bodyJa"');
    expect(prompt).not.toContain('"bodyEn"');
    expect(prompt).not.toContain("700〜1100");
    expect(prompt).not.toContain("500-800 words");
  });
});

describe("stripIndexBodies", () => {
  it("legacy cache hit body values cannot repopulate index entries", () => {
    const stripped = stripIndexBodies({
      id: "entry-1",
      source: "aws-ml-blog",
      sourceType: "blog",
      url: "https://example.com/bedrock",
      title: "Amazon Bedrock introduces new advanced prompt optimization and migration tool",
      titleJa: "Bedrock の高度な最適化",
      titleEn: "Amazon Bedrock introduces new advanced prompt optimization and migration tool",
      summaryJa: "日本語要約",
      summaryEn: "English summary.",
      bodyJa: "legacy cached body",
      bodyEn: "legacy cached english body",
      lang: "en",
      publishedAt: "2026-07-01T00:00:00.000Z",
      collectedAt: "2026-07-01T01:00:00.000Z",
      tags: ["aws"],
      category: "agent-fw",
      importance: 2,
    });
    expect(stripped.bodyJa).toBe("");
    expect(stripped.bodyEn).toBe("");
  });
});
