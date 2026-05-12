/**
 * tests/web-data.test.ts
 *
 * web/src/lib/data.ts のピュア関数 (import data に依存しない) のユニットテスト。
 * ALL_ENTRIES に依存する関数は小さなフィクスチャで検証する。
 */
import { describe, it, expect, vi } from "vitest";

// data/index.json を import するモジュールは vi.mock でスタブ化する
vi.mock("../data/index.json", () => ({
  default: {
    generatedAt: "2026-01-01T00:00:00.000Z",
    count: 3,
    entries: [
      {
        id: "entry-001",
        source: "anthropic-news",
        sourceType: "blog",
        url: "https://anthropic.com/news/claude-opus-4-7",
        title: "Claude Opus 4.7 released",
        titleJa: "Claude Opus 4.7 リリース",
        titleEn: "Claude Opus 4.7 Released",
        summaryJa: "Anthropic が Claude Opus 4.7 を発表した。",
        summaryEn: "Anthropic announced Claude Opus 4.7.",
        bodyJa: "本文日本語",
        bodyEn: "English body",
        lang: "en",
        publishedAt: "2026-05-01T09:00:00.000Z",
        collectedAt: "2026-05-01T10:00:00.000Z",
        tags: ["claude", "llm", "release"],
        category: "claude",
        importance: 3,
      },
      {
        id: "entry-002",
        source: "openai-blog",
        sourceType: "blog",
        url: "https://openai.com/blog/gpt-5",
        title: "GPT-5 update",
        titleJa: "GPT-5 アップデート",
        titleEn: "GPT-5 Update",
        summaryJa: "OpenAI が GPT-5 を更新した。",
        summaryEn: "OpenAI updated GPT-5.",
        lang: "en",
        publishedAt: "2026-04-30T09:00:00.000Z",
        collectedAt: "2026-04-30T10:00:00.000Z",
        tags: ["openai", "gpt", "llm"],
        category: "tech-news",
        importance: 2,
      },
      {
        id: "entry-003",
        source: "anthropic-news",
        sourceType: "release",
        url: "https://anthropic.com/news/claude-haiku-3-5",
        title: "Claude Haiku 3.5",
        titleJa: "Claude Haiku 3.5 リリース",
        titleEn: "Claude Haiku 3.5",
        summaryJa: "Claude Haiku 3.5 が公開された。",
        summaryEn: "Claude Haiku 3.5 is now available.",
        lang: "en",
        publishedAt: "2026-04-28T09:00:00.000Z",
        collectedAt: "2026-04-28T10:00:00.000Z",
        tags: ["claude", "llm"],
        category: "claude",
        importance: 2,
      },
    ],
  },
}));

// モック後に import する (Vitest の hoisting により vi.mock は先行する)
const {
  relativeTime,
  summaryForLang,
  summaryForLangWithFallback,
  titleForLang,
  titleForLangWithFallback,
  restoreDotsFromUrl,
  jstDateKey,
  entryHref,
  isNew,
  hasCjk,
  relatedEntries,
  entriesBySource,
  entriesByTag,
  adjacentInCategory,
  ALL_ENTRIES,
} = await import("../web/src/lib/data.ts");

// ---- フィクスチャ参照ヘルパー ----
const e1 = ALL_ENTRIES[0]!; // entry-001 (claude)
const e2 = ALL_ENTRIES[1]!; // entry-002 (tech-news)
const e3 = ALL_ENTRIES[2]!; // entry-003 (claude)

// ============================================================
// relativeTime
// ============================================================
describe("relativeTime", () => {
  it("null を渡すと '日付不明' を返す", () => {
    expect(relativeTime(null)).toBe("日付不明");
  });

  it("1 分未満は 'just now'", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 30_000).toISOString();
    expect(relativeTime(iso, now)).toBe("just now");
  });

  it("30 分後は '30m ago'", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 30 * 60_000).toISOString();
    expect(relativeTime(iso, now)).toBe("30m ago");
  });

  it("5 時間後は '5h ago'", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 5 * 3_600_000).toISOString();
    expect(relativeTime(iso, now)).toBe("5h ago");
  });

  it("3 日後は '3d ago'", () => {
    const now = new Date();
    const iso = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    expect(relativeTime(iso, now)).toBe("3d ago");
  });
});

// ============================================================
// hasCjk
// ============================================================
describe("hasCjk", () => {
  it("日本語文字列に true を返す", () => {
    expect(hasCjk("これはテストです")).toBe(true);
  });

  it("英語文字列に false を返す", () => {
    expect(hasCjk("Hello World")).toBe(false);
  });

  it("null/undefined に false を返す", () => {
    expect(hasCjk(null)).toBe(false);
    expect(hasCjk(undefined)).toBe(false);
  });
});

// ============================================================
// summaryForLang
// ============================================================
describe("summaryForLang", () => {
  it("lang=ja では summaryJa を返す", () => {
    expect(summaryForLang(e1, "ja")).toBe("Anthropic が Claude Opus 4.7 を発表した。");
  });

  it("lang=en では summaryEn を返す", () => {
    expect(summaryForLang(e1, "en")).toBe("Anthropic announced Claude Opus 4.7.");
  });

  it("summaryEn が日本語の場合、lang=en では空文字列を返す", () => {
    const entry = { ...e1, summaryEn: "これは日本語です" };
    expect(summaryForLang(entry, "en")).toBe("");
  });
});

// ============================================================
// summaryForLangWithFallback
// ============================================================
describe("summaryForLangWithFallback", () => {
  it("en が空のとき ja にフォールバックする", () => {
    const entry = { ...e1, summaryEn: "" };
    const result = summaryForLangWithFallback(entry, "en");
    expect(result.isFallback).toBe(true);
    expect(result.fallbackLang).toBe("ja");
    expect(result.text).toBeTruthy();
  });

  it("どちらも空のとき空文字列を返す", () => {
    const entry = { ...e1, summaryJa: "", summaryEn: "" };
    const result = summaryForLangWithFallback(entry, "en");
    expect(result.text).toBe("");
    expect(result.isFallback).toBe(false);
  });
});

// ============================================================
// titleForLang
// ============================================================
describe("titleForLang", () => {
  it("lang=ja では titleJa を返す", () => {
    expect(titleForLang(e1, "ja")).toBe("Claude Opus 4.7 リリース");
  });

  it("lang=en では titleEn を返す", () => {
    expect(titleForLang(e1, "en")).toBe("Claude Opus 4.7 Released");
  });

  it("titleJa が空の場合 summaryJa の先頭節を返す", () => {
    const entry = { ...e1, titleJa: "", summaryJa: "Anthropic が発表した。背景は複雑だ。" };
    const title = titleForLang(entry, "ja");
    // 最初の句点で切れるはず
    expect(title).toBe("Anthropic が発表した");
  });
});

// ============================================================
// titleForLangWithFallback (LL-029)
// ============================================================
describe("titleForLangWithFallback", () => {
  it("EN を要求し EN がある場合は isFallback=false", () => {
    const result = titleForLangWithFallback(e1, "en");
    expect(result.isFallback).toBe(false);
    expect(result.text).toBe("Claude Opus 4.7 Released");
  });

  it("EN を要求し titleEn / summaryEn / title が全て日本語のときは JA タイトルにフォールバックする", () => {
    const entry = {
      ...e1,
      titleEn: "",
      title: "日本語のみのタイトル",
      summaryEn: "",
      summaryJa: "日本語要約",
    };
    const result = titleForLangWithFallback(entry, "en");
    expect(result.isFallback).toBe(true);
    expect(result.fallbackLang).toBe("ja");
    expect(result.text).toBe("Claude Opus 4.7 リリース");
  });

  it("JA を要求し titleJa が空でも fallback 経由で必ず非空を返す", () => {
    const entry = { ...e1, titleJa: "", titleEn: "Only English Title", title: "Only English Title", summaryJa: "" };
    const result = titleForLangWithFallback(entry, "ja");
    expect(result.text.length).toBeGreaterThan(0);
  });
});

// ============================================================
// restoreDotsFromUrl
// ============================================================
describe("restoreDotsFromUrl", () => {
  it("タイトル中の '4 7' を URL の '4-7' パターンから '4.7' に復元する", () => {
    const title = "Claude Opus 4 7 Released";
    const url = "https://anthropic.com/news/claude-opus-4-7";
    expect(restoreDotsFromUrl(title, url)).toBe("Claude Opus 4.7 Released");
  });

  it("該当パターンがない場合はタイトルをそのまま返す", () => {
    const title = "Claude is great";
    const url = "https://anthropic.com/blog/claude-is-great";
    expect(restoreDotsFromUrl(title, url)).toBe("Claude is great");
  });

  it("空のタイトルはそのまま返す", () => {
    expect(restoreDotsFromUrl("", "https://example.com/v1-2")).toBe("");
  });
});

// ============================================================
// jstDateKey
// ============================================================
describe("jstDateKey", () => {
  it("UTC 15:00 は JST 翌日 00:00 → 翌日の日付キーを返す", () => {
    // 2026-05-01T15:00:00Z = 2026-05-02T00:00:00+09:00
    const key = jstDateKey("2026-05-01T15:00:00.000Z");
    expect(key).toBe("2026-05-02");
  });

  it("UTC 00:00 は JST 09:00 → 同日の日付キーを返す", () => {
    // 2026-05-01T00:00:00Z = 2026-05-01T09:00:00+09:00
    const key = jstDateKey("2026-05-01T00:00:00.000Z");
    expect(key).toBe("2026-05-01");
  });
});

// ============================================================
// entryHref
// ============================================================
describe("entryHref", () => {
  it("/e/{id}/ 形式の href を返す", () => {
    expect(entryHref({ id: "entry-001" })).toBe("/e/entry-001/");
  });
});

// ============================================================
// isNew
// ============================================================
describe("isNew", () => {
  it("collectedAt が 1 時間前のエントリは true", () => {
    const now = Date.now();
    const entry = { ...e1, collectedAt: new Date(now - 3_600_000).toISOString() };
    expect(isNew(entry, now)).toBe(true);
  });

  it("collectedAt が 7 時間前のエントリは false", () => {
    const now = Date.now();
    const entry = { ...e1, collectedAt: new Date(now - 7 * 3_600_000).toISOString() };
    expect(isNew(entry, now)).toBe(false);
  });
});

// ============================================================
// relatedEntries
// ============================================================
describe("relatedEntries", () => {
  it("同カテゴリかつ自分を除くエントリを返す", () => {
    // e1 は claude カテゴリ → e3 (claude) が関連として返るはず
    const related = relatedEntries(e1);
    expect(related.every((x) => x.category === "claude")).toBe(true);
    expect(related.some((x) => x.id === e1.id)).toBe(false);
    expect(related.some((x) => x.id === "entry-003")).toBe(true);
  });

  it("n 件を上限として返す", () => {
    const related = relatedEntries(e1, 1);
    expect(related).toHaveLength(1);
  });
});

// ============================================================
// entriesBySource
// ============================================================
describe("entriesBySource", () => {
  it("同ソース・自分を除くエントリを返す", () => {
    // e1 は anthropic-news → e3 (anthropic-news) が返るはず
    const result = entriesBySource(e1);
    expect(result.every((x) => x.source === "anthropic-news")).toBe(true);
    expect(result.some((x) => x.id === e1.id)).toBe(false);
  });
});

// ============================================================
// entriesByTag
// ============================================================
describe("entriesByTag", () => {
  it("共通タグを持つエントリを返す", () => {
    // e1 は ["claude", "llm", "release"] → e3 ["claude", "llm"] が返るはず
    const result = entriesByTag(e1);
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((x) => x.id === "entry-003")).toBe(true);
  });

  it("タグが空のエントリは空配列を返す", () => {
    const entry = { ...e1, tags: [] };
    expect(entriesByTag(entry)).toEqual([]);
  });
});

// ============================================================
// adjacentInCategory
// ============================================================
describe("adjacentInCategory", () => {
  it("最初のエントリには prev がなく next がある", () => {
    // ALL_ENTRIES[0] = entry-001 (claude), ALL_ENTRIES[2] = entry-003 (claude)
    // category 内では entry-001 が先頭
    const { prev, next } = adjacentInCategory(e1);
    expect(prev).toBeUndefined();
    expect(next?.id).toBe("entry-003");
  });

  it("最後のエントリには next がなく prev がある", () => {
    const { prev, next } = adjacentInCategory(e3);
    expect(prev?.id).toBe("entry-001");
    expect(next).toBeUndefined();
  });
});
