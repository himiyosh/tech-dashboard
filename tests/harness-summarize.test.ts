/**
 * tests/harness-summarize.test.ts
 *
 * harness/pipeline/summarize.ts の parseModelResponse() 単体テスト。
 * AI モデルへのネットワーク呼び出しは一切行わない。
 */
import { describe, it, expect } from "vitest";
import {
  isCompleteSummaryResponse,
  needsGeneratedContent,
  parseModelResponse,
  resolveSummarizeModel,
} from "../harness/pipeline/summarize.ts";

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
  it("deterministic fallback summary と本文欠落を backfill 対象にする", () => {
    expect(needsGeneratedContent({
      summaryJa: "このエントリは zenn から収集した tech-news 領域の最新アップデートです。",
      summaryEn: "English summary.",
      bodyJa: "日本語本文",
      bodyEn: "English body.",
    })).toBe(true);
    expect(needsGeneratedContent({
      summaryJa: "日本語要約",
      summaryEn: "tech-news update from zenn. AI summary not yet available; a future Worker run will refresh this entry.",
      bodyJa: "日本語本文",
      bodyEn: "English body.",
    })).toBe(true);
    expect(needsGeneratedContent({
      summaryJa: "日本語要約",
      summaryEn: "English summary.",
      bodyJa: "",
      bodyEn: "English body.",
    })).toBe(true);
  });

  it("両言語 summary/body が揃った entry は backfill 対象にしない", () => {
    expect(needsGeneratedContent({
      summaryJa: "日本語要約",
      summaryEn: "English summary.",
      bodyJa: "日本語本文",
      bodyEn: "English body.",
    })).toBe(false);
  });
});

describe("isCompleteSummaryResponse", () => {
  it("本文込みの完全な応答だけを成功扱いにする", () => {
    const parsed = parseModelResponse(
      JSON.stringify({
        titleJa: "タイトル",
        summaryJa: "日本語要約",
        summaryEn: "English summary.",
        bodyJa: "日本語本文",
        bodyEn: "English body.",
        importance: 2,
        extraTags: [],
      }),
    );

    expect(isCompleteSummaryResponse(parsed)).toBe(true);
    expect(isCompleteSummaryResponse(parseModelResponse("not json"))).toBe(
      false,
    );
  });
});
