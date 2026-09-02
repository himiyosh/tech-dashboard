/**
 * tests/worker-article-chat.test.ts
 *
 * 記事ディスカッション (article chat): structural contract, prompt policy,
 * merge grafting, and the worker/web mirror pin.
 */
import { describe, expect, it } from "vitest";
import {
  ARTICLE_CHAT_ARC_VARIANTS,
  ARTICLE_CHAT_STOCK_PHRASES,
  articleChatArcFor,
} from "../worker/src/article-chat.ts";
import {
  ARTICLE_CHAT_PERSONAS,
  ARTICLE_CHAT_TURNS,
  CHAT_TURN_MAX_EN_CHARS,
  CHAT_TURN_MAX_JA_CHARS,
  buildArticleChatPrompt,
  chatGroundingText,
  parseArticleChat,
  validateArticleChat,
  type ArticleChatTurn,
} from "../worker/src/article-chat.ts";
import * as webChat from "../web/src/lib/article-chat.ts";
import { mergeBodies, type BodiesPayload } from "../worker/src/bodies-file.ts";

function goodChat(): ArticleChatTurn[] {
  return Array.from({ length: ARTICLE_CHAT_TURNS }, (_, index) => ({
    s: index % 2 === 0 ? ("a" as const) : ("b" as const),
    ja: `発言${index + 1}です。`,
    en: `Turn ${index + 1} text.`,
  }));
}

describe("worker/web mirror", () => {
  it("keeps the personas and structural constants identical in both copies", () => {
    // The Workers bundle cannot import web/src and vice versa, so the module
    // is duplicated; this pin is what allows that duplication to exist.
    expect(webChat.ARTICLE_CHAT_PERSONAS).toEqual(ARTICLE_CHAT_PERSONAS);
    expect(webChat.ARTICLE_CHAT_TURNS).toBe(ARTICLE_CHAT_TURNS);
    expect(webChat.CHAT_TURN_MAX_JA_CHARS).toBe(CHAT_TURN_MAX_JA_CHARS);
    expect(webChat.CHAT_TURN_MAX_EN_CHARS).toBe(CHAT_TURN_MAX_EN_CHARS);
  });

  it("validates identically in both copies", () => {
    const chat = goodChat();
    expect(webChat.validateArticleChat(chat)).toEqual(validateArticleChat(chat));
    const broken = [...chat.slice(0, 5)];
    expect(webChat.validateArticleChat(broken)).toBeNull();
    expect(validateArticleChat(broken)).toBeNull();
  });
});

describe("validateArticleChat", () => {
  it("accepts exactly six alternating bilingual turns", () => {
    expect(validateArticleChat(goodChat())).toHaveLength(ARTICLE_CHAT_TURNS);
  });

  it("rejects wrong turn counts, wrong alternation, and empty text", () => {
    expect(validateArticleChat(goodChat().slice(0, 4))).toBeNull();
    expect(validateArticleChat([...goodChat(), ...goodChat().slice(0, 1)])).toBeNull();
    const swapped = goodChat();
    swapped[1] = { ...swapped[1]!, s: "a" };
    expect(validateArticleChat(swapped)).toBeNull();
    const empty = goodChat();
    empty[3] = { ...empty[3]!, en: "  " };
    expect(validateArticleChat(empty)).toBeNull();
  });

  it("rejects bubbles over the length caps (paragraphs are not chat)", () => {
    const longJa = goodChat();
    longJa[0] = { ...longJa[0]!, ja: "あ".repeat(CHAT_TURN_MAX_JA_CHARS + 1) };
    expect(validateArticleChat(longJa)).toBeNull();
    const longEn = goodChat();
    longEn[0] = { ...longEn[0]!, en: "x".repeat(CHAT_TURN_MAX_EN_CHARS + 1) };
    expect(validateArticleChat(longEn)).toBeNull();
  });

  it("rejects non-arrays and junk items", () => {
    expect(validateArticleChat(undefined)).toBeNull();
    expect(validateArticleChat({})).toBeNull();
    expect(validateArticleChat([1, 2, 3, 4, 5, 6])).toBeNull();
  });
});

describe("parseArticleChat", () => {
  it("parses a plain JSON array and one wrapped in a code fence", () => {
    const json = JSON.stringify(goodChat());
    expect(parseArticleChat(json)).toHaveLength(ARTICLE_CHAT_TURNS);
    expect(parseArticleChat("```json\n" + json + "\n```")).toHaveLength(ARTICLE_CHAT_TURNS);
    expect(parseArticleChat("Here is the chat:\n" + json)).toHaveLength(ARTICLE_CHAT_TURNS);
  });

  it("returns null (never throws) on garbage", () => {
    expect(parseArticleChat("")).toBeNull();
    expect(parseArticleChat("not json")).toBeNull();
    expect(parseArticleChat('{"s":"a"}')).toBeNull();
    expect(parseArticleChat("[1,2]")).toBeNull();
  });
});

describe("buildArticleChatPrompt", () => {
  const entry = {
    title: "Example Tool v2 adds incremental sync",
    summaryJa: "Example Tool v2 が増分同期を追加した。",
    summaryEn: "Example Tool v2 adds incremental sync.",
    contentSnippet: "Example Tool v2 introduces incremental sync for large repositories.",
    source: "example-blog",
    sourceType: "blog",
    category: "tech-news",
    tags: ["sync"],
  };

  it("carries the personas, the exact turn contract, and the grounding rules", () => {
    const prompt = buildArticleChatPrompt(entry);
    expect(prompt).toContain(ARTICLE_CHAT_PERSONAS.a.nameJa);
    expect(prompt).toContain(ARTICLE_CHAT_PERSONAS.b.nameJa);
    expect(prompt).toContain(`ちょうど ${ARTICLE_CHAT_TURNS} 発言`);
    expect(prompt).toContain("記事情報に無い事実を持ち込まない");
    expect(prompt).toContain("水増ししない");
    expect(prompt).toContain(entry.contentSnippet);
  });
});

describe("chatGroundingText", () => {
  it("concatenates per-language text for the grounding checker", () => {
    const text = chatGroundingText(goodChat());
    expect(text.ja.split("\n")).toHaveLength(ARTICLE_CHAT_TURNS);
    expect(text.en).toContain("Turn 1 text.");
  });
});

describe("mergeBodies chat handling", () => {
  const generatedAt = "2026-08-29T00:00:00.000Z";
  const liveIds = new Set(["x1"]);
  const base = (record?: object): BodiesPayload => ({
    generatedAt,
    count: record ? 1 : 0,
    bodies: record ? { x1: record as never } : {},
  });
  const realBody = { bodyJa: "既存の日本語本文。", bodyEn: "Existing English body." };

  it("stores a validated chat with a brand-new body", () => {
    const merge = mergeBodies(
      base(),
      [{ id: "x1", bodyJa: "新しい本文。", bodyEn: "New body.", chat: goodChat() }],
      liveIds,
      generatedAt,
    );
    expect(merge.added).toBe(1);
    expect(merge.payload.bodies.x1?.chat).toHaveLength(ARTICLE_CHAT_TURNS);
  });

  it("grafts a chat onto an existing real body without touching its prose", () => {
    const merge = mergeBodies(
      base({ ...realBody, model: "m", generatedAt }),
      [{ id: "x1", bodyJa: "別の本文。", bodyEn: "Different body.", chat: goodChat() }],
      liveIds,
      generatedAt,
    );
    expect(merge.added).toBe(1);
    const record = merge.payload.bodies.x1!;
    expect(record.bodyJa).toBe(realBody.bodyJa);
    expect(record.bodyEn).toBe(realBody.bodyEn);
    expect(record.chat).toHaveLength(ARTICLE_CHAT_TURNS);
  });

  it("never overwrites an existing chat and drops invalid incoming chats", () => {
    const existingChat = goodChat();
    existingChat[0] = { ...existingChat[0]!, ja: "既存チャットの一言目。" };
    const noop = mergeBodies(
      base({ ...realBody, chat: existingChat, model: "m", generatedAt }),
      [{ id: "x1", ...realBody, chat: goodChat() }],
      liveIds,
      generatedAt,
    );
    expect(noop.added).toBe(0);
    expect(noop.payload.bodies.x1?.chat?.[0]?.ja).toBe("既存チャットの一言目。");

    const invalid = mergeBodies(
      base(),
      [{ id: "x1", bodyJa: "本文。", bodyEn: "Body.", chat: goodChat().slice(0, 3) as never }],
      liveIds,
      generatedAt,
    );
    expect(invalid.payload.bodies.x1?.chat).toBeUndefined();
  });
});

describe("detail page wiring", () => {
  it("renders the chat only alongside a real body and only after validation", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../web/src/pages/e/[id].astro", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const articleChat = body ? validateArticleChat(body.chat) : null;");
    expect(source).toContain("{articleChat && <ArticleChat chat={articleChat} />}");
  });
});


describe("buildArticleChatPrompt — variety and provenance", () => {
  const base = {
    title: "Sample article",
    titleJa: "サンプル記事",
    summaryJa: "サンプルの要約です。",
    summaryEn: "A sample summary.",
    contentSnippet: "Sample excerpt text for grounding the chat.",
    source: "qiita-claude",
    sourceType: "community",
    category: "claude",
    tags: ["bedrock", "agents"],
  };

  it("picks one of three arcs deterministically per article", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const arc = articleChatArcFor({ ...base, title: `Sample article ${i}` });
      expect(ARTICLE_CHAT_ARC_VARIANTS.map((v) => v.key)).toContain(arc.key);
      seen.add(arc.key);
      expect(articleChatArcFor({ ...base, title: `Sample article ${i}` }).key).toBe(arc.key);
    }
    expect(seen.size).toBe(3);
  });

  it("forbids the stock phrases, keeps tags out of the material, and names the arc", () => {
    const prompt = buildArticleChatPrompt(base);
    for (const phrase of ARTICLE_CHAT_STOCK_PHRASES) expect(prompt).toContain(`「${phrase}」`);
    expect(prompt).toContain("次の決まり文句は使わない");
    expect(prompt).toContain("二人は記事そのものを読んだ前提で話す");
    expect(prompt).not.toContain("タグ:");
    expect(prompt).not.toContain("収集元抜粋");
    expect(prompt).toContain("本文: Sample excerpt text");
    expect(prompt).toContain(articleChatArcFor(base).ja[0]);
  });
});
