/**
 * tests/worker-parse.test.ts
 *
 * worker/src/prompt.ts の buildPrompt / parseResponse ユニットテスト。
 * Cloudflare Worker 環境・ネットワーク呼び出しには依存しない。
 */
import { describe, it, expect } from "vitest";
import { buildPrompt, buildQueuePrompt, parseResponse } from "../worker/src/prompt.ts";
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
// buildQueuePrompt
// ============================================================
describe("buildQueuePrompt", () => {
  it("Worker Queue 用に短い本文制約を含み、長文 backfill 制約を含まない", () => {
    const prompt = buildQueuePrompt(mockEntry);
    expect(prompt).toContain("240-420 chars");
    expect(prompt).toContain("140-220 words");
    expect(prompt).not.toContain("500-800 words");
    expect(prompt).not.toContain("700〜1100");
  });

  it("収集済み snippet を fallback でなければ含める", () => {
    const prompt = buildQueuePrompt({
      ...mockEntry,
      summaryEn: "Release notes mention stronger coding and tool-use behavior.",
    });
    expect(prompt).toContain("Existing English note/snippet");
    expect(prompt).toContain("stronger coding");
  });

  it("deterministic fallback text はプロンプトの根拠として渡さない", () => {
    const prompt = buildQueuePrompt({
      ...mockEntry,
      summaryJa: "このエントリは anthropic-news から収集した claude 領域の最新アップデートです。",
      summaryEn: "AI summary not yet available.",
    });
    expect(prompt).not.toContain("最新アップデートです");
    expect(prompt).not.toContain("AI summary not yet available.");
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

  it("本文文字列に生の改行が混ざっても JSON として復旧する", () => {
    const text = `{
      "titleJa": "T",
      "summaryJa": "S",
      "summaryEn": "S",
      "bodyJa": "1段落目

2段落目",
      "bodyEn": "First paragraph.

Second paragraph.",
      "importance": 2,
      "extraTags": ["copilot"]
    }`;

    const result = parseResponse(text);
    expect(result.bodyJa).toBe("1段落目\n\n2段落目");
    expect(result.bodyEn).toBe("First paragraph.\n\nSecond paragraph.");
    expect(result.extraTags).toEqual(["copilot"]);
  });

  it("文字列内の未エスケープ ASCII 引用符を限定的に復旧する", () => {
    const text = `{
      "titleJa": "自作MCPサーバーが動かない: AIの"自白"を物証で崩した話",
      "summaryJa": "ログと実験で原因を究明した。",
      "summaryEn": "The developer identified the cause using logs and experiments.",
      "importance": 2,
      "extraTags": ["debugging"]
    }`;

    const result = parseResponse(text);
    expect(result.titleJa).toBe("自作MCPサーバーが動かない: AIの\"自白\"を物証で崩した話");
    expect(result.summaryJa).toBe("ログと実験で原因を究明した。");
    expect(result.summaryEn).toContain("identified the cause");
    expect(result.importance).toBe(2);
  });

  it("カンマが続く英語の未エスケープ引用句も field 境界と区別して復旧する", () => {
    const text = `{
      "titleJa": "キャッシュ障害の原因",
      "summaryJa": "遅延の原因を切り分けた。",
      "summaryEn": "The post explains why "prompt caching", not rate limits, caused the slowdown.",
      "importance": 2,
      "extraTags": ["prompt-caching", "debugging"]
    }`;

    const result = parseResponse(text);
    expect(result.summaryEn).toBe(
      "The post explains why \"prompt caching\", not rate limits, caused the slowdown.",
    );
    expect(result.extraTags).toEqual(["prompt-caching", "debugging"]);
  });

  it("複数の波括弧ブロックがある場合は最初の妥当な JSON オブジェクトを読む", () => {
    const json = JSON.stringify({ titleJa: "T", summaryJa: "S", summaryEn: "S", bodyJa: "B", bodyEn: "E", importance: 2, extraTags: [] });
    const text = `${json}\n補足: {これは JSON ではありません}`;
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
