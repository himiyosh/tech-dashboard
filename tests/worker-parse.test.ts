/**
 * tests/worker-parse.test.ts
 *
 * worker/src/prompt.ts の buildPrompt / parseResponse ユニットテスト。
 * Cloudflare Worker 環境・ネットワーク呼び出しには依存しない。
 */
import { describe, it, expect } from "vitest";
import { buildPrompt, parseResponse } from "../worker/src/prompt.ts";
import type { NormalizedEntry } from "../harness/types.ts";

// テスト用エントリフィクスチャ
const mockEntry: NormalizedEntry = {
  id: "test-001",
  source: "anthropic-news",
  sourceType: "blog",
  url: "https://anthropic.com/news/claude-4",
  title: "Claude 4 released",
  titleJa: "Claude 4 リリース",
  titleEn: "Claude 4 Released",
  summaryJa: "Anthropic が Claude 4 を発表した。",
  summaryEn: "Anthropic announced Claude 4.",
  lang: "en",
  publishedAt: "2026-05-01T09:00:00.000Z",
  collectedAt: "2026-05-01T10:00:00.000Z",
  tags: ["claude", "llm"],
  category: "claude",
  importance: 3,
};

// ============================================================
// buildPrompt
// ============================================================
describe("buildPrompt", () => {
  it("エントリのタイトル・カテゴリ・URL をプロンプト内に含む", () => {
    const prompt = buildPrompt(mockEntry);
    expect(prompt).toContain("Claude 4 released");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("https://anthropic.com/news/claude-4");
    expect(prompt).toContain("anthropic-news");
  });

  it("bodyJa・bodyEn フィールドの指示を含む", () => {
    const prompt = buildPrompt(mockEntry);
    expect(prompt).toContain("bodyJa");
    expect(prompt).toContain("bodyEn");
  });

  it("importance の指示を含む", () => {
    const prompt = buildPrompt(mockEntry);
    expect(prompt).toContain("importance");
    expect(prompt).toContain("extraTags");
  });

  it("プロンプトが文字列で空でない", () => {
    const prompt = buildPrompt(mockEntry);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });
});

// ============================================================
// parseResponse
// ============================================================
describe("parseResponse", () => {
  it("正常な JSON レスポンスをパースする", () => {
    const json = JSON.stringify({
      titleJa: "Claude 4 リリース",
      summaryJa: "Anthropic が新モデルを発表した。",
      summaryEn: "Anthropic released a new model.",
      bodyJa: "日本語本文テキスト",
      bodyEn: "English body text",
      importance: 3,
      extraTags: ["claude", "llm", "release"],
    });

    const result = parseResponse(json);
    expect(result.titleJa).toBe("Claude 4 リリース");
    expect(result.summaryJa).toBe("Anthropic が新モデルを発表した。");
    expect(result.summaryEn).toBe("Anthropic released a new model.");
    expect(result.bodyJa).toBe("日本語本文テキスト");
    expect(result.bodyEn).toBe("English body text");
    expect(result.importance).toBe(3);
    expect(result.extraTags).toEqual(["claude", "llm", "release"]);
  });

  it("JSON の前後にテキストがあっても抽出できる", () => {
    const text = `ここから出力します\n${JSON.stringify({ titleJa: "T", summaryJa: "S", summaryEn: "S", bodyJa: "B", bodyEn: "E", importance: 2, extraTags: [] })}\n以上です`;
    expect(parseResponse(text).titleJa).toBe("T");
  });

  it("JSON が含まれない場合は空のデフォルトを返す", () => {
    const result = parseResponse("No JSON here.");
    expect(result.titleJa).toBe("");
    expect(result.summaryJa).toBe("");
    expect(result.importance).toBe(1);
    expect(result.extraTags).toEqual([]);
  });

  it("importance が 3 より大きい場合は 3 にクランプする", () => {
    const json = JSON.stringify({ titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 5, extraTags: [] });
    expect(parseResponse(json).importance).toBe(3);
  });

  it("importance が 1 より小さい場合は 1 にクランプする", () => {
    const json = JSON.stringify({ titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: -1, extraTags: [] });
    expect(parseResponse(json).importance).toBe(1);
  });

  it("extraTags が 6 件を超える場合はトリミングする", () => {
    const json = JSON.stringify({
      titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "",
      importance: 1,
      extraTags: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(parseResponse(json).extraTags).toHaveLength(6);
  });

  it("extraTags に数値・null が混在しても文字列のみ返す", () => {
    const json = JSON.stringify({
      titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "",
      importance: 1,
      extraTags: ["ok", 42, null, "valid"],
    });
    expect(parseResponse(json).extraTags).toEqual(["ok", "valid"]);
  });

  it("max_tokens で JSON が途中で切れている場合は空デフォルトを返す", () => {
    // bodyEn の途中で JSON が終わるケース (実際のトークン超過を模倣)
    const truncated = `{"titleJa":"T","summaryJa":"S","summaryEn":"S","bodyJa":"B","bodyEn":"This is a long article that gets cut`;
    const result = parseResponse(truncated);
    expect(result.titleJa).toBe("");
    expect(result.bodyEn).toBe("");
  });

  it("値のトリミングが行われる (前後スペースを削除)", () => {
    const json = JSON.stringify({
      titleJa: "  タイトル  ",
      summaryJa: "  要約  ",
      summaryEn: "  summary  ",
      bodyJa: "  body  ",
      bodyEn: "  body en  ",
      importance: 1,
      extraTags: [],
    });
    const result = parseResponse(json);
    expect(result.titleJa).toBe("タイトル");
    expect(result.bodyEn).toBe("body en");
  });
});
