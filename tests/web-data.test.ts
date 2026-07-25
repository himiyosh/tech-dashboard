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
  latestListedActivityForSource,
  latestListedCollectedAtForEntry,
  effectiveTitleLanguage,
  summaryForLang,
  summaryForLangWithFallback,
  titleForLang,
  titleForLangWithFallback,
  categoryLabel,
  restoreDotsFromUrl,
  restorePrereleaseQualifierFromUrl,
  jstDateKey,
  selectTickerDayEntries,
  selectTickerItems,
  tickerSourcePlatformKey,
  entryHref,
  isRecentlyCollected,
  RECENT_COLLECTION_BADGE,
  RECENT_COLLECTION_WINDOW_HOURS,
  hasCjk,
  isCjkDominantText,
  hasUsableSummaryForLanguage,
  relatedEntries,
  entriesBySource,
  entriesByTag,
  entriesForTagPage,
  adjacentInCategory,
  categoryImportanceStanding,
  isLowSignalRelease,
  isMutableReleaseAliasEntry,
  isOffTopicForHero,
  isListableEntry,
  isSummaryNoise,
  isPublishableEntry,
  isDeterministicFallbackEntry,
  isArxivEntry,
  isResearchListingEntry,
  ALL_ENTRIES,
  STATIC_TAG_PAGE_TAGS,
  SINGLETON_TAG_ENTRY_IDS,
  TAG_PAGE_MIN_ENTRIES,
  tagEntryCount,
  tagHref,
  tagHrefForCount,
} = await import("../web/src/lib/data.ts");
const { decisionRankScore } = await import("../web/src/lib/ranking.ts");

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

  it("不正な timestamp を '日付不明' として扱う", () => {
    expect(relativeTime("not-a-date")).toBe("日付不明");
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

  it("英語主体の要約に日本語の固有名詞が含まれていても保持する", () => {
    const summary = "The agent connects to 技術評論社 resources while keeping the workflow in English.";
    const entry = { ...e1, summaryEn: summary };
    expect(isCjkDominantText(summary)).toBe(false);
    expect(summaryForLang(entry, "en")).toBe(summary);
  });

  it("日本語主体の mixed-script 要約は English slot で拒否する", () => {
    const summary = "この agent は repository の変更内容を英語で説明します。";
    const entry = { ...e1, summaryEn: summary };
    expect(isCjkDominantText(summary)).toBe(true);
    expect(summaryForLang(entry, "en")).toBe("");
  });
});

describe("isCjkDominantText", () => {
  it.each([
    ["English text only", false],
    ["English text with 技術評論社 as a source name", false],
    ["日本語の説明に English terms を含める", true],
    ["日本語だけの要約です。", true],
  ])("%s", (text, expected) => {
    expect(isCjkDominantText(text)).toBe(expected);
  });
});

describe("hasUsableSummaryForLanguage", () => {
  it("field 名ではなく実際の言語で usable summary を判定する", () => {
    const misplaced = {
      ...e1,
      summaryJa: "This English summary was stored in the Japanese field.",
      summaryEn: "このエントリは要約が未生成です。",
    };
    expect(hasUsableSummaryForLanguage(misplaced, misplaced.summaryJa, "ja")).toBe(false);
    expect(hasUsableSummaryForLanguage(misplaced, misplaced.summaryJa, "en")).toBe(true);
    expect(isPublishableEntry(misplaced)).toBe(true);
  });

  it("Hangul が混入した要約を完成扱いしない", () => {
    const contaminated = {
      ...e1,
      summaryJa: "Anthropic が 새しいモデルを公開した。",
      summaryEn: "",
    };
    expect(hasUsableSummaryForLanguage(contaminated, contaminated.summaryJa, "ja")).toBe(false);
    expect(isPublishableEntry(contaminated)).toBe(false);
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
  it("contaminated English summary は有効な日本語要約へフォールバックする", () => {
    const entry = {
      ...e1,
      summaryJa: "編集予測の品質計測を改善した。",
      summaryEn:
        "Left some junk in the readme and forgot to remove oopsies Release Notes: N/A or Added/Fixed/Improved",
    };
    const result = summaryForLangWithFallback(entry, "en");
    expect(result).toEqual({
      text: entry.summaryJa,
      isFallback: true,
      fallbackLang: "ja",
    });
    expect(isPublishableEntry(entry)).toBe(true);
    expect(isListableEntry(entry)).toBe(true);
  });
});

describe("latestListedActivityForSource", () => {
  it("returns the newest collected timestamp for the same source and ignores other sources", () => {
    const activity = latestListedActivityForSource("anthropic-news", [
      {
        source: "anthropic-news",
        publishedAt: "2026-04-01T09:00:00.000Z",
        collectedAt: "2026-04-01T10:00:00.000Z",
      },
      {
        source: "openai-blog",
        publishedAt: "2026-05-03T09:00:00.000Z",
        collectedAt: "2026-05-03T10:00:00.000Z",
      },
      {
        source: "anthropic-news",
        publishedAt: "2026-05-02T09:00:00.000Z",
        collectedAt: "2026-05-02T10:00:00.000Z",
      },
    ]);

    expect(activity.latestCollectedAt).toBe("2026-05-02T10:00:00.000Z");
    expect(activity.latestPublishedAt).toBe("2026-05-02T09:00:00.000Z");
  });
});

describe("latestListedCollectedAtForEntry", () => {
  it("uses the newest listed timestamp from the selected entry's source", () => {
    const selected = {
      ...e1,
      publishedAt: "2026-04-01T09:00:00.000Z",
      collectedAt: "2026-04-01T10:00:00.000Z",
    };
    const entries = [
      selected,
      {
        ...e1,
        id: "newer-same-source",
        publishedAt: "2026-05-02T09:00:00.000Z",
        collectedAt: "2026-05-02T10:00:00.000Z",
      },
      {
        ...e2,
        id: "newer-other-source",
        publishedAt: "2026-05-03T09:00:00.000Z",
        collectedAt: "2026-05-03T10:00:00.000Z",
      },
    ];

    expect(latestListedCollectedAtForEntry(selected, entries)).toBe(
      "2026-05-02T10:00:00.000Z",
    );
  });

  it("falls back to the selected entry collectedAt, then publishedAt", () => {
    const selected = {
      ...e1,
      collectedAt: "2026-04-01T10:00:00.000Z",
      publishedAt: "2026-04-01T09:00:00.000Z",
    };
    expect(latestListedCollectedAtForEntry(selected, [])).toBe(selected.collectedAt);
    expect(
      latestListedCollectedAtForEntry({ ...selected, collectedAt: "" }, []),
    ).toBe(selected.publishedAt);
  });
});

// ============================================================
// isSummaryNoise / isListableEntry / pending cross-language fallback (LL-074)
// ============================================================
const PENDING_JA = "このエントリは ollama-releases から収集した local-llm 領域の最新アップデートです。";

describe("isSummaryNoise", () => {
  it("空文字 / 未定義は noise", () => {
    expect(isSummaryNoise(e1, "")).toBe(true);
    expect(isSummaryNoise(e1, undefined)).toBe(true);
  });
  it("決定論的 pending boilerplate は noise", () => {
    expect(isSummaryNoise(e1, PENDING_JA)).toBe(true);
  });
  it("タイトルの単純な echo は noise", () => {
    // e1.title = "Claude Opus 4.7 released"
    expect(isSummaryNoise(e1, "Claude Opus 4.7 released")).toBe(true);
    expect(isSummaryNoise(e1, "  claude opus 4.7 released  ")).toBe(true);
  });
  it("package または version だけの文字列は noise", () => {
    expect(isSummaryNoise(e1, "@cline/sdk@0.0.53")).toBe(true);
    expect(isSummaryNoise(e1, "Cline CLI v3.0.31")).toBe(true);
    expect(isSummaryNoise(e1, "v2.1.205")).toBe(true);
  });
  it("本物の要約は noise ではない", () => {
    expect(isSummaryNoise(e1, "Anthropic announced Claude Opus 4.7.")).toBe(false);
    expect(isSummaryNoise(e1, "Fixes CVE in OpenSSL 3.0.14")).toBe(false);
  });
  it("version で終わる説明文を持つ entry は publishable", () => {
    const entry = {
      ...e1,
      summaryJa: "OpenSSL 3.0.14 の CVE を修正した。",
      summaryEn: "Fixes CVE in OpenSSL 3.0.14",
    };
    expect(isPublishableEntry(entry)).toBe(true);
  });
  it("生成途中の junk marker は noise", () => {
    expect(isSummaryNoise(
      e1,
      "Left some junk in the readme and forgot to remove oopsies Release Notes: N/A or Added/Fixed/Improved",
    )).toBe(true);
  });
  it("RSS provenance boilerplate は生成済み要約として扱わない", () => {
    expect(
      isSummaryNoise(
        e1,
        "The post Claude Opus 4.7 released appeared first on Anthropic.",
      ),
    ).toBe(true);
  });
});

describe("categoryLabel", () => {
  it("internal category slug を表示名へ変換する", () => {
    expect(categoryLabel("tech-news")).toBe("News/Policy");
    expect(categoryLabel("agent-fw")).toBe("Agent Frameworks");
    expect(categoryLabel("local-llm", "full")).toBe("Local LLM / Open Models");
  });
});

describe("isListableEntry", () => {
  it("publishable なエントリは listable", () => {
    expect(isListableEntry(e1)).toBe(true);
    expect(isPublishableEntry(e1)).toBe(true);
  });
  it("両言語が表示不能な要約なら publishable ではない", () => {
    const unusable = {
      ...e1,
      summaryJa: e1.title,
      summaryEn: "Cline CLI v3.0.31",
    };
    expect(isPublishableEntry(unusable)).toBe(false);
    expect(isListableEntry(unusable)).toBe(true);
  });
  it("片言語の要約が完成していれば cross-language fallback で publishable", () => {
    const pending = {
      ...e1,
      titleJa: "",
      titleEn: "Ollama v0.30.9",
      title: "Ollama v0.30.9",
      summaryJa: PENDING_JA,
      summaryEn: "What's Changed: support for new architecture.",
    };
    expect(isDeterministicFallbackEntry(pending)).toBe(false);
    expect(isPublishableEntry(pending)).toBe(true);
    expect(isListableEntry(pending)).toBe(true);
  });
  it("synthetic タイトルしか無いエントリは listable ではない", () => {
    const synthetic = {
      ...e1,
      source: "ollama-releases",
      titleJa: "",
      titleEn: "",
      title: "Ollama (ollama-releases) 関連アップデート",
      summaryJa: PENDING_JA,
      summaryEn: "",
    };
    expect(isListableEntry(synthetic)).toBe(false);
  });
});

// ============================================================
// Summary-first (LL-112): body is decoupled from publishable status
// ============================================================
describe("body は publishable 分類に影響しない (LL-112/LL-113)", () => {
  const EN_FILLER =
    "This long-form note is completed from the existing summary and collection metadata so the entry remains useful.";
  const JA_FILLER =
    "このエントリでは、元記事の要約と収集時のメタデータから、読者が押さえるべき文脈を補っています。";

  it("実要約 + filler body のエントリは fallback 扱いされず publishable", () => {
    const fillerBody = { ...e1, bodyJa: JA_FILLER, bodyEn: EN_FILLER };
    // Real bilingual summary present → must be publishable regardless of body.
    expect(isDeterministicFallbackEntry(fillerBody)).toBe(false);
    expect(isPublishableEntry(fillerBody)).toBe(true);
  });

  it("実要約 + 空 body のエントリも publishable", () => {
    const emptyBody = { ...e1, bodyJa: "", bodyEn: "" };
    expect(isDeterministicFallbackEntry(emptyBody)).toBe(false);
    expect(isPublishableEntry(emptyBody)).toBe(true);
  });

  it("pending 要約のエントリは body に関わらず fallback のまま", () => {
    const pendingSummary = { ...e1, summaryJa: PENDING_JA, summaryEn: "", bodyJa: "", bodyEn: "" };
    expect(isDeterministicFallbackEntry(pendingSummary)).toBe(true);
    expect(isPublishableEntry(pendingSummary)).toBe(false);
  });
});

describe("pending entry の要約はクロス言語フォールバックする (LL-074)", () => {
  // 英語ソースで JA 要約が未生成 (boilerplate) だが EN 要約は実在するケース。
  const type1 = {
    ...e1,
    titleJa: "",
    titleEn: "Ollama v0.30.9",
    title: "Ollama v0.30.9",
    summaryJa: PENDING_JA,
    summaryEn: "What's Changed: support for the new Cohere2 architecture.",
  };
  it("summaryForLang(ja) は boilerplate を空に潰す", () => {
    expect(summaryForLang(type1, "ja")).toBe("");
  });
  it("JA ビューは実 EN 要約に原文フォールバックする (空欄/boilerplate を出さない)", () => {
    const r = summaryForLangWithFallback(type1, "ja");
    expect(r.text).toBe("What's Changed: support for the new Cohere2 architecture.");
    expect(r.isFallback).toBe(true);
    expect(r.fallbackLang).toBe("en");
  });
  it("EN ビューは実 EN 要約をそのまま出す", () => {
    const r = summaryForLangWithFallback(type1, "en");
    expect(r.text).toBe("What's Changed: support for the new Cohere2 architecture.");
    expect(r.isFallback).toBe(false);
  });
  it("どの言語にも実要約が無いときだけ空 (= pending 状態を表示)", () => {
    const noSummary = {
      ...e1,
      titleEn: "Some Title",
      title: "Some Title",
      summaryJa: PENDING_JA,
      summaryEn: "Some Title", // title echo
    };
    expect(summaryForLangWithFallback(noSummary, "ja").text).toBe("");
    expect(summaryForLangWithFallback(noSummary, "en").text).toBe("");
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

  it("titleJa が空の場合も summary excerpt をタイトルへ流用しない", () => {
    const entry = {
      ...e1,
      lang: "ja" as const,
      title: "日本語の原題",
      titleJa: "",
      summaryJa: "Anthropic が発表した。背景は複雑だ。",
    };
    expect(titleForLang(entry, "ja")).toBe("日本語の原題");
  });

  it("英語主体の titleEn に日本語の固有名詞があっても保持する", () => {
    const titleEn = "Integrating 技術評論社 resources with agent workflows";
    expect(titleForLang({ ...e1, titleEn }, "en")).toBe(titleEn);
  });

  it("日本語主体の titleEn は拒否し、English summary をタイトルへ流用しない", () => {
    const entry = {
      ...e1,
      titleEn: "技術評論社の agent workflow 解説",
      summaryEn: "This is an English fallback title generated from the summary.",
    };
    expect(titleForLang(entry, "en")).toBe("Claude Opus 4.7 released");
  });

  it("英語製品名を含む日本語原題を source language に従って扱う", () => {
    const title = "Claude Code 2.1.209でサブエージェントの進捗表示を改善";
    const entry = { ...e1, lang: "ja" as const, title, titleJa: "", titleEn: "" };

    expect(titleForLang(entry, "ja")).toBe(title);
    expect(titleForLang(entry, "en")).toBe("");
  });

  it("明白な日本語原題は誤った feed language metadata を補正する", () => {
    const title = "Claude Code 2.1.209でサブエージェントの進捗表示を改善";
    const entry = { ...e1, lang: "en" as const, title, titleJa: title, titleEn: "" };

    expect(effectiveTitleLanguage(entry)).toBe("ja");
    expect(titleForLang(entry, "ja")).toBe(title);
    expect(titleForLang(entry, "en")).toBe("");
  });

  it("日本語原題をコピーした titleEn は英語タイトルとして扱わない", () => {
    const title = "Claude Code 2.1.209でサブエージェントの進捗表示を改善";
    const entry = { ...e1, lang: "ja" as const, title, titleJa: title, titleEn: title };

    expect(titleForLang(entry, "en")).toBe("");
  });

  it("日本語固有名詞を少量含む明示的な英語タイトルは維持する", () => {
    const titleEn = "Claude Code 2.1.209 improves サブエージェント progress visibility";
    const entry = {
      ...e1,
      lang: "ja" as const,
      title: "Claude Code 2.1.209でサブエージェントの進捗表示を改善",
      titleJa: "Claude Code 2.1.209でサブエージェントの進捗表示を改善",
      titleEn,
    };

    expect(titleForLang(entry, "en")).toBe(titleEn);
  });

  it("英語 source の mixed raw title を source language に従って扱う", () => {
    const title = "Claude Code adds 日本語 support for agent status";
    const entry = { ...e1, lang: "en" as const, title, titleJa: "", titleEn: "" };

    expect(titleForLang(entry, "en")).toBe(title);
    expect(titleForLang(entry, "ja")).toBe("");
  });

  it("英語 source の ASCII-only titleJa は日本語 title として扱わない", () => {
    const entry = {
      ...e1,
      lang: "en" as const,
      title: "Cline CLI v3.0.33",
      titleJa: "CLI v3.0.33",
      titleEn: "Cline CLI v3.0.33",
    };

    expect(titleForLang(entry, "ja")).toBe("");
    expect(titleForLangWithFallback(entry, "ja")).toEqual({
      text: "Cline CLI v3.0.33",
      isFallback: true,
      fallbackLang: "en",
    });
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
      lang: "ja" as const,
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
    expect(titleForLang(entry, "ja")).toBe("");
    const result = titleForLangWithFallback(entry, "ja");
    expect(result).toEqual({
      text: "Only English Title",
      isFallback: true,
      fallbackLang: "en",
    });
  });

  it("JA の raw title は JA 要求で fallback 扱いにしない", () => {
    const entry = {
      ...e1,
      lang: "ja" as const,
      titleJa: "",
      titleEn: "",
      title: "日本語の原題",
      summaryJa: "",
      summaryEn: "",
    };
    expect(titleForLang(entry, "ja")).toBe("日本語の原題");
    expect(titleForLangWithFallback(entry, "ja")).toEqual({
      text: "日本語の原題",
      isFallback: false,
    });
  });

  it("mixed Japanese raw title は EN 要求で provenance 付き JA fallback になる", () => {
    const title = "Claude Code 2.1.209でサブエージェントの進捗表示を改善";
    const entry = { ...e1, lang: "ja" as const, title, titleJa: "", titleEn: "" };

    expect(titleForLangWithFallback(entry, "en")).toEqual({
      text: title,
      isFallback: true,
      fallbackLang: "ja",
    });
  });

  it("英語 source の raw title は JA 要求で provenance 付き EN fallback になる", () => {
    const title = "Claude Code adds 日本語 support for agent status";
    const entry = { ...e1, lang: "en" as const, title, titleJa: "", titleEn: "" };

    expect(titleForLangWithFallback(entry, "ja")).toEqual({
      text: title,
      isFallback: true,
      fallbackLang: "en",
    });
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

  it("v-prefix を保ったまま版番号を復元する", () => {
    expect(
      restoreDotsFromUrl(
        "Some Tool v4 7 Released",
        "https://example.com/releases/v4-7",
      ),
    ).toBe("Some Tool v4.7 Released");
  });

  it("モデルサイズの単位付き数字を版番号へ変換しない", () => {
    expect(
      restoreDotsFromUrl(
        "Gemma 4 12B",
        "https://example.com/models/gemma-4-12b",
      ),
    ).toBe("Gemma 4 12B");
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

describe("restorePrereleaseQualifierFromUrl", () => {
  it("URL と title の base version が一致するときだけ RC qualifier を復元する", () => {
    const url = "https://github.com/ollama/ollama/releases/tag/v0.32.0-rc0";
    expect(
      restorePrereleaseQualifierFromUrl("Ollama v0.32.0 リリース", url),
    ).toBe("Ollama v0.32.0-rc0 リリース");
  });

  it("qualifier が既にある title は変更しない", () => {
    const title = "Ollama v0.32.0-rc0 release";
    const url = "https://github.com/ollama/ollama/releases/tag/v0.32.0-rc0";
    expect(restorePrereleaseQualifierFromUrl(title, url)).toBe(title);
  });

  it("URL の prerelease separator と大文字小文字をそのまま保持する", () => {
    expect(
      restorePrereleaseQualifierFromUrl(
        "Some Tool v1.2.3 release",
        "https://example.com/releases/tag/v1.2.3-beta.1",
      ),
    ).toBe("Some Tool v1.2.3-beta.1 release");
    expect(
      restorePrereleaseQualifierFromUrl(
        "Some Tool v1.2.3 release",
        "https://example.com/releases/tag/v1.2.3-RC-2",
      ),
    ).toBe("Some Tool v1.2.3-RC-2 release");
  });

  it("title と URL の base version が一致しない場合は推測で書き換えない", () => {
    const title = "Ollama v0.31.0 release";
    const url = "https://github.com/ollama/ollama/releases/tag/v0.32.0-rc0";
    expect(restorePrereleaseQualifierFromUrl(title, url)).toBe(title);
  });

  it("URL の短い base version を長い title version の prefix に適用しない", () => {
    const title = "Some Tool v1.2.3 release";
    const url = "https://example.com/releases/tag/v1.2-rc1";
    expect(restorePrereleaseQualifierFromUrl(title, url)).toBe(title);
  });
});

describe("Research と arXiv の表示レーン", () => {
  const arxivEntry = {
    ...e1,
    id: "arxiv-entry",
    source: "arxiv-cs-ai",
    sourceType: "paper" as const,
    category: "research",
    url: "https://arxiv.org/abs/2607.01234",
  };
  const reportEntry = {
    ...e1,
    id: "research-report",
    source: "anthropic-engineering",
    sourceType: "blog" as const,
    category: "research",
    url: "https://www.anthropic.com/research/example",
  };

  it("arXiv paper を専用 lane として識別する", () => {
    expect(isArxivEntry(arxivEntry)).toBe(true);
    expect(isResearchListingEntry(arxivEntry)).toBe(false);
  });

  it("非 arXiv の research entry は Research listing に残す", () => {
    expect(isArxivEntry(reportEntry)).toBe(false);
    expect(isResearchListingEntry(reportEntry)).toBe(true);
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

describe("selectTickerDayEntries", () => {
  const now = new Date("2026-05-04T03:00:00.000Z");
  const entryForDay = (id: string, publishedAt: string) => ({
    ...e1,
    id,
    url: `https://example.com/${id}`,
    publishedAt,
  });

  it("当日の候補から除外記事を取り除く", () => {
    const selected = selectTickerDayEntries([
      entryForDay("today-featured", "2026-05-04T01:00:00.000Z"),
      entryForDay("today-ticker", "2026-05-04T00:00:00.000Z"),
      entryForDay("yesterday", "2026-05-03T01:00:00.000Z"),
    ], now, ["today-featured"]);

    expect(selected.dayKey).toBe("2026-05-04");
    expect(selected.dayScope).toBe("today");
    expect(selected.entries.map((entry) => entry.id)).toEqual(["today-ticker"]);
  });

  it("当日が除外記事だけなら残る最新掲載日へ戻る", () => {
    const selected = selectTickerDayEntries([
      entryForDay("today-featured", "2026-05-04T01:00:00.000Z"),
      entryForDay("yesterday", "2026-05-03T01:00:00.000Z"),
    ], now, ["today-featured"]);

    expect(selected.dayKey).toBe("2026-05-03");
    expect(selected.dayScope).toBe("latest");
    expect(selected.entries.map((entry) => entry.id)).toEqual(["yesterday"]);
  });

  it("当日と前日が空でも過去の最新掲載日を選ぶ", () => {
    const selected = selectTickerDayEntries([
      entryForDay("older", "2026-04-30T01:00:00.000Z"),
      entryForDay("latest", "2026-05-01T01:00:00.000Z"),
    ], now);

    expect(selected.dayKey).toBe("2026-05-01");
    expect(selected.dayScope).toBe("latest");
    expect(selected.entries.map((entry) => entry.id)).toEqual(["latest"]);
  });

  it("候補がなければ空状態を返す", () => {
    expect(selectTickerDayEntries([], now)).toEqual({
      dayKey: null,
      dayScope: "latest",
      entries: [],
    });
  });

  describe("selectTickerItems", () => {
    const tickerEntry = (
      id: string,
      source: string,
      sourceType: typeof e1.sourceType,
      url: string,
      importance: typeof e1.importance,
      publishedAt: string,
    ) => ({
      ...e1,
      id,
      source,
      sourceType,
      url,
      importance,
      publishedAt,
    });

    it("同一 source と platform を 2 件までに抑える", () => {
      const selected = selectTickerItems([
        tickerEntry("qiita-1", "qiita-copilot", "community", "https://qiita.com/a/items/1", 3, "2026-05-04T08:00:00.000Z"),
        tickerEntry("qiita-2", "qiita-claude", "community", "https://qiita.com/b/items/2", 3, "2026-05-04T07:00:00.000Z"),
        tickerEntry("qiita-3", "qiita-mcp", "community", "https://qiita.com/c/items/3", 3, "2026-05-04T06:00:00.000Z"),
        tickerEntry("qiita-4", "qiita-copilot", "community", "https://qiita.com/d/items/4", 2, "2026-05-04T05:00:00.000Z"),
        tickerEntry("zenn-1", "zenn-copilot", "community", "https://zenn.dev/a/articles/1", 2, "2026-05-04T04:00:00.000Z"),
      ], 24);

      expect(selected.map((entry) => entry.id)).toEqual(["qiita-1", "qiita-2", "zenn-1"]);
      expect(selected.filter((entry) => tickerSourcePlatformKey(entry) === "qiita.com")).toHaveLength(2);
      expect(selected.filter((entry) => entry.source === "qiita-copilot")).toHaveLength(1);
    });

    it("同じ重要度では公式 source と release を community より優先する", () => {
      const selected = selectTickerItems([
        tickerEntry("community", "qiita-copilot", "community", "https://qiita.com/a/items/1", 2, "2026-05-04T08:00:00.000Z"),
        tickerEntry("official-blog", "anthropic-news", "blog", "https://anthropic.com/news/1", 2, "2026-05-04T06:00:00.000Z"),
        tickerEntry("official-release", "zed-releases", "release", "https://github.com/zed-industries/zed/releases/tag/v1", 2, "2026-05-04T07:00:00.000Z"),
      ], 3);

      expect(selected.map((entry) => entry.id)).toEqual([
        "official-release",
        "official-blog",
        "community",
      ]);
    });

    it("代替候補がある場合は同一 source を連続表示しない", () => {
      const selected = selectTickerItems([
        tickerEntry("zed-stable", "zed-releases", "release", "https://github.com/zed-industries/zed/releases/tag/v2", 3, "2026-05-04T09:00:00.000Z"),
        tickerEntry("zed-preview", "zed-releases", "release", "https://github.com/zed-industries/zed/releases/tag/v2-pre", 3, "2026-05-04T08:00:00.000Z"),
        tickerEntry("anthropic", "anthropic-news", "blog", "https://anthropic.com/news/agent", 3, "2026-05-04T07:00:00.000Z"),
      ], 3);

      expect(selected.map((entry) => entry.id)).toEqual([
        "zed-stable",
        "anthropic",
        "zed-preview",
      ]);
      for (let index = 1; index < selected.length; index += 1) {
        expect(selected[index]!.source).not.toBe(selected[index - 1]!.source);
      }
    });

    it("要約待ち entry を判断用 ticker の候補から除外する", () => {
      const ready = tickerEntry(
        "ready",
        "anthropic-news",
        "blog",
        "https://anthropic.com/news/ready",
        2,
        "2026-05-04T08:00:00.000Z",
      );
      const pending = {
        ...tickerEntry(
          "pending",
          "qiita-copilot",
          "community",
          "https://qiita.com/a/items/pending",
          3,
          "2026-05-04T09:00:00.000Z",
        ),
        summaryJa: "",
        summaryEn: "",
      };

      expect(selectTickerItems([pending, ready], 3).map((entry) => entry.id)).toEqual(["ready"]);
    });
  });
});

// ============================================================
// entryHref
// ============================================================
describe("entryHref", () => {
  it("/e/{id}/ 形式の href を返す", () => {
    expect(entryHref({ id: "entry-001" })).toBe("/e/entry-001/");
  });

  describe("mutable release aliases", () => {
    it("excludes moving GitHub release aliases from listable and publishable surfaces", () => {
      for (const alias of ["nightly", "extension-workflows", "extension-cli"]) {
        const mutable = {
          ...e1,
          sourceType: "release" as const,
          url: `https://github.com/zed-industries/zed/releases/tag/${alias}`,
        };
        expect(isMutableReleaseAliasEntry(mutable)).toBe(true);
        expect(isListableEntry(mutable)).toBe(false);
        expect(isPublishableEntry(mutable)).toBe(false);
      }
    });

    it("keeps immutable release versions and non-release articles", () => {
      expect(isMutableReleaseAliasEntry({
        ...e1,
        sourceType: "release",
        url: "https://github.com/zed-industries/zed/releases/tag/v0.201.4",
      })).toBe(false);
      expect(isMutableReleaseAliasEntry({
        ...e1,
        sourceType: "blog",
        url: "https://github.com/example/project/releases/tag/nightly",
      })).toBe(false);
    });
  });

  describe("categoryImportanceStanding", () => {
    it("reports equal-or-higher counts instead of a misleading percentile", () => {
      expect(categoryImportanceStanding(e1)).toEqual({ total: 2, sameOrHigher: 1 });
      expect(categoryImportanceStanding(e3)).toEqual({ total: 2, sameOrHigher: 2 });
      expect(categoryImportanceStanding(e2)).toEqual({ total: 1, sameOrHigher: 1 });
    });
  });

  describe("decisionRankScore", () => {
    it("uses source authority as a real ranking input", () => {
      const nowMs = Date.parse("2026-05-02T00:00:00.000Z");
      const official = { ...e1, source: "anthropic-news" };
      const aggregator = { ...e1, source: "hn-ai" };
      expect(decisionRankScore(official, nowMs)).toBeGreaterThan(
        decisionRankScore(aggregator, nowMs),
      );
    });
  });
});

// ============================================================
// recently collected badge
// ============================================================
describe("isRecentlyCollected", () => {
  it("collectedAt が 1 時間前のエントリは true", () => {
    const now = Date.now();
    const entry = { ...e1, collectedAt: new Date(now - 3_600_000).toISOString() };
    expect(isRecentlyCollected(entry, now)).toBe(true);
  });

  it("collectedAt が 7 時間前のエントリは false", () => {
    const now = Date.now();
    const entry = { ...e1, collectedAt: new Date(now - 7 * 3_600_000).toISOString() };
    expect(isRecentlyCollected(entry, now)).toBe(false);
  });

  it("publication recency と誤認しない collection-scoped copy を共有する", () => {
    expect(RECENT_COLLECTION_WINDOW_HOURS).toBe(6);
    expect(RECENT_COLLECTION_BADGE).toEqual({
      ja: "新規収集",
      en: "INDEXED",
    });
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

describe("tag page routing", () => {
  it("10 件以上のタグだけを静的ページとして生成する", () => {
    expect(TAG_PAGE_MIN_ENTRIES).toBe(10);
    expect(tagEntryCount("claude")).toBe(2);
    expect(tagEntryCount("CLAUDE")).toBe(2);
    expect(entriesForTagPage("claude").map((entry) => entry.id)).toEqual(["entry-001", "entry-003"]);
    expect(entriesForTagPage("Claude").map((entry) => entry.id)).toEqual(["entry-001", "entry-003"]);
    expect(STATIC_TAG_PAGE_TAGS).not.toContain("claude");
    expect(STATIC_TAG_PAGE_TAGS).not.toContain("release");
    expect(SINGLETON_TAG_ENTRY_IDS.release).toBe("entry-001");
  });

  it("低頻度タグを検索へ送り URL を安全にエンコードする", () => {
    expect(tagHref("claude")).toBe("/search?q=claude&tag=claude");
    expect(tagHref("release")).toBe("/search?q=release&tag=release");
    expect(tagHrefForCount("C++", 1)).toBe("/search?q=c%2B%2B&tag=c%2B%2B");
    expect(tagHrefForCount("C++", 1, "ABCDEF0123456789")).toBe(
      "/search?q=c%2B%2B&tag=c%2B%2B&entry=abcdef0123456789",
    );
    expect(tagHrefForCount("C++", 10)).toBe("/t/c%2B%2B");
    expect(tagHrefForCount("Café", 1)).toBe("/search?q=cafe&tag=cafe");
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

// ============================================================
// isLowSignalRelease
// ============================================================
describe("isLowSignalRelease", () => {
  const rel = (title: string, sourceType = "release") =>
    ({ sourceType, title, titleEn: title, titleJa: title }) as Parameters<typeof isLowSignalRelease>[0];

  it("非 release/changelog ソースは常に false", () => {
    expect(isLowSignalRelease(rel("nightly: anything (#123)", "blog"))).toBe(false);
    expect(isLowSignalRelease(rel("v1.0.0-pre", "paper"))).toBe(false);
  });

  it("nightly / collab-staging / collab-production を検出する", () => {
    expect(isLowSignalRelease(rel("nightly: git: Optimize (#59044)"))).toBe(true);
    expect(isLowSignalRelease(rel("collab-staging: markdown (#59291)"))).toBe(true);
    expect(isLowSignalRelease(rel("collab-production ep: ctx (#58572)"))).toBe(true);
  });

  it("pre-release / rc / beta サフィックスを検出する", () => {
    expect(isLowSignalRelease(rel("Zed Editor Releases v1.7.2-pre"))).toBe(true);
    expect(isLowSignalRelease(rel("v0.30.0-rc32: llama-server (#16353)"))).toBe(true);
    expect(isLowSignalRelease(rel("Some Tool v2.0.0-beta1"))).toBe(true);
    expect(isLowSignalRelease(rel("Some Tool v2.0.0-beta.1"))).toBe(true);
    expect(isLowSignalRelease(rel("Some Tool v2.0.0-RC-2"))).toBe(true);
  });

  it("末尾が PR 番号 (#NNNN) の per-commit CI 項目を検出する", () => {
    expect(isLowSignalRelease(rel("extension-cli: parallel build (#55160)"))).toBe(true);
    expect(isLowSignalRelease(rel("glsl-v0.2.4: Bump (#58704)"))).toBe(true);
  });

  it("安定版リリースは false (誤除外しない)", () => {
    expect(isLowSignalRelease(rel("Zed Editor Releases v1.6.3"))).toBe(false);
    expect(isLowSignalRelease(rel("Cline Releases v3.89.2"))).toBe(false);
    expect(isLowSignalRelease(rel("CLI v3.0.24"))).toBe(false);
    expect(isLowSignalRelease(rel("Continue.dev Releases v1.2.22-vscode"))).toBe(false);
    expect(isLowSignalRelease(rel("langchain-core==1.4.0"))).toBe(false);
  });

  it("一般的なアナウンス系タイトルは false", () => {
    expect(isLowSignalRelease(rel("Introducing Gemma 4 12B", "changelog"))).toBe(false);
    expect(isLowSignalRelease(rel("GitHub Copilot now generally available", "changelog"))).toBe(false);
  });
});

// ============================================================
// isOffTopicForHero (Featured hero + Today's Top 3 のみ除外する consumer gaming ノイズ)
// ============================================================
describe("isOffTopicForHero", () => {
  const t = (title: string) =>
    ({ title, titleEn: title, titleJa: title }) as Parameters<typeof isOffTopicForHero>[0];

  it("named console / gaming タイトルを検出する", () => {
    expect(isOffTopicForHero(t("GTA VI is a worrying sign for the future of physical games"))).toBe(true);
    expect(isOffTopicForHero(t("PlayStation State of Play June 2026: All the news and trailers"))).toBe(true);
    expect(isOffTopicForHero(t("The Steam Machine is the start of an even more expensive future"))).toBe(true);
    expect(isOffTopicForHero(t("Epic wants to let you bring your Fortnite skins to other games"))).toBe(true);
    expect(isOffTopicForHero(t("Bungie hit with significant layoffs after ending Destiny 2"))).toBe(true);
  });

  it("gaming-hardware 複合語 / cloud gaming を検出する", () => {
    expect(isOffTopicForHero(t("The QD-OLED gaming monitor that started it all got a big upgrade"))).toBe(true);
    expect(isOffTopicForHero(t("Cloud Gaming: '007 First Light' Launches on GeForce NOW"))).toBe(true);
  });

  it("bare 'game' / 'gaming' は誤検出しない", () => {
    expect(isOffTopicForHero(t("Our AI Wearables Are Changing the Game for Disabled People"))).toBe(false);
    expect(isOffTopicForHero(t("GUI Agents for Continual Game Generation"))).toBe(false);
    expect(isOffTopicForHero(t("From games to biology and beyond: 10 years of AlphaGo"))).toBe(false);
  });

  it("AI/dev の通常記事は false (誤除外しない)", () => {
    expect(isOffTopicForHero(t("We're Partnering With EssilorLuxottica to Launch Meta Glasses"))).toBe(false);
    expect(isOffTopicForHero(t("Nvidia says its AI data center design runs hotter to use less water"))).toBe(false);
    expect(isOffTopicForHero(t("Midjourney goes from generating cat images to full-body ultrasound"))).toBe(false);
    expect(isOffTopicForHero(t("Introducing Claude Opus 4.8"))).toBe(false);
  });
});
