/**
 * tests/data-schema.test.ts
 *
 * data/index.json の整合性を実データに対して検証する。
 * 新エントリ追加・worker 改修で形が崩れないか早期検知する。
 */
import { describe, it, expect } from "vitest";
import indexJson from "../data/index.json";

interface RawEntry {
  id?: unknown;
  source?: unknown;
  sourceType?: unknown;
  url?: unknown;
  title?: unknown;
  titleJa?: unknown;
  summaryJa?: unknown;
  publishedAt?: unknown;
  collectedAt?: unknown;
  tags?: unknown;
  category?: unknown;
  importance?: unknown;
  bodyJa?: unknown;
  bodyEn?: unknown;
}

interface IndexShape {
  generatedAt: string;
  count: number;
  entries: RawEntry[];
}

const VALID_SOURCE_TYPES = new Set([
  "blog",
  "release",
  "changelog",
  "paper",
  "community",
]);

const VALID_CATEGORIES = new Set([
  "copilot",
  "claude",
  "codex",
  "gemini",
  "vscode",
  "cursor",
  "cline",
  "aider",
  "opencode",
  "local-llm",
  "agent-fw",
  "mcp",
  "research",
  "tech-news",
]);

const data = indexJson as unknown as IndexShape;

describe("data/index.json トップレベル", () => {
  it("generatedAt が ISO 8601 文字列である", () => {
    expect(typeof data.generatedAt).toBe("string");
    expect(Number.isFinite(Date.parse(data.generatedAt))).toBe(true);
  });

  it("count が entries.length と一致する", () => {
    expect(data.count).toBe(data.entries.length);
  });

  it("entries が 1 件以上ある", () => {
    expect(data.entries.length).toBeGreaterThan(0);
  });

  it("entries の id は重複しない", () => {
    const ids = data.entries.map((e) => String(e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("data/index.json 各エントリ", () => {
  it("必須フィールドが全エントリに存在する", () => {
    const errors: string[] = [];
    for (const e of data.entries) {
      if (typeof e.id !== "string" || !e.id) errors.push(`id missing: ${JSON.stringify(e).slice(0, 80)}`);
      if (typeof e.source !== "string" || !e.source) errors.push(`source missing on ${e.id}`);
      if (typeof e.url !== "string" || !e.url) errors.push(`url missing on ${e.id}`);
      if (typeof e.title !== "string") errors.push(`title missing on ${e.id}`);
      if (typeof e.publishedAt !== "string") errors.push(`publishedAt missing on ${e.id}`);
      if (typeof e.collectedAt !== "string") errors.push(`collectedAt missing on ${e.id}`);
    }
    expect(errors).toEqual([]);
  });

  it("sourceType が有効な値である", () => {
    const invalid = data.entries
      .filter((e) => !VALID_SOURCE_TYPES.has(String(e.sourceType)))
      .map((e) => `${e.id}:${String(e.sourceType)}`);
    expect(invalid).toEqual([]);
  });

  it("category が有効な値である", () => {
    const invalid = data.entries
      .filter((e) => !VALID_CATEGORIES.has(String(e.category)))
      .map((e) => `${e.id}:${String(e.category)}`);
    expect(invalid).toEqual([]);
  });

  it("importance が 1〜3 の整数である", () => {
    const invalid = data.entries
      .filter((e) => !(e.importance === 1 || e.importance === 2 || e.importance === 3))
      .map((e) => `${e.id}:${String(e.importance)}`);
    expect(invalid).toEqual([]);
  });

  it("tags が文字列配列である", () => {
    const invalid = data.entries
      .filter((e) => !Array.isArray(e.tags) || (e.tags as unknown[]).some((t) => typeof t !== "string"))
      .map((e) => String(e.id));
    expect(invalid).toEqual([]);
  });

  it("publishedAt と collectedAt が ISO 8601 として解釈可能", () => {
    const bad = data.entries
      .filter(
        (e) =>
          !Number.isFinite(Date.parse(String(e.publishedAt))) ||
          !Number.isFinite(Date.parse(String(e.collectedAt))),
      )
      .map((e) => String(e.id));
    expect(bad).toEqual([]);
  });

  it("url が URL コンストラクタで解釈できる", () => {
    const bad: string[] = [];
    for (const e of data.entries) {
      try {
        new URL(String(e.url));
      } catch {
        bad.push(String(e.id));
      }
    }
    expect(bad).toEqual([]);
  });

  it("bodyJa / bodyEn が定義されているなら文字列である", () => {
    const bad = data.entries
      .filter(
        (e) =>
          (e.bodyJa !== undefined && typeof e.bodyJa !== "string") ||
          (e.bodyEn !== undefined && typeof e.bodyEn !== "string"),
      )
      .map((e) => String(e.id));
    expect(bad).toEqual([]);
  });
});

describe("data/index.json カバレッジ統計 (情報のみ)", () => {
  it("bodyJa / bodyEn のカバレッジを記録する", () => {
    const total = data.entries.length;
    const withJa = data.entries.filter(
      (e) => typeof e.bodyJa === "string" && (e.bodyJa as string).trim().length > 0,
    ).length;
    const withEn = data.entries.filter(
      (e) => typeof e.bodyEn === "string" && (e.bodyEn as string).trim().length > 0,
    ).length;
    // ログ目的。閾値のアサートはせず、極端なリグレッション検知だけしておく。
    // worker が新着記事を追加すると body 未生成のエントリが大量に増える
    // (INDEX_LIMIT 2000 、全件を順次 LLM 要約して追い付いていく) ため、閾値は低くとる。
    // 「1件以上は body がある」だけアサートしてそれ以外はログとして記録する。
    expect(withJa).toBeGreaterThan(0);
    expect(withEn).toBeGreaterThan(0);
  });
});
