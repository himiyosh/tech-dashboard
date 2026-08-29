/**
 * 記事ディスカッション (article chat) — web-side personas, types, and the
 * render gate for the chat-bubble discussion on the detail page.
 *
 * MIRROR of worker/src/article-chat.ts. The Cloudflare Worker bundles from a
 * separate package and must not import web/src (see body-quality.ts scope
 * note), and this module must stay importable without pulling worker code
 * into the Astro build, so the personas and structural contract are kept as
 * two copies. tests/worker-article-chat.test.ts imports BOTH modules and
 * asserts they are identical, so they cannot drift silently.
 */

export interface ArticleChatTurn {
  /** Speaker key: "a" = ソラ / Sora, "b" = レン / Ren. */
  s: "a" | "b";
  ja: string;
  en: string;
}

export const ARTICLE_CHAT_TURNS = 6;
export const CHAT_TURN_MAX_JA_CHARS = 150;
export const CHAT_TURN_MAX_EN_CHARS = 300;

export const ARTICLE_CHAT_PERSONAS = {
  a: {
    nameJa: "ソラ",
    nameEn: "Sora",
    roleJa: "新しい技術に飛びつく好奇心旺盛なエンジニア",
    roleEn: "a curious engineer who is quick to try new technology",
    emoji: "🛰️",
  },
  b: {
    nameJa: "レン",
    nameEn: "Ren",
    roleJa: "根拠と運用コストを先に確かめる慎重なレビュアー",
    roleEn: "a careful reviewer who checks evidence and operating cost first",
    emoji: "🔍",
  },
} as const;

/**
 * Same structural contract as the worker validator: exactly six non-empty
 * bilingual turns, strictly alternating a, b, a, b, a, b, inside the bubble
 * length caps. Anything else renders nothing — a malformed chat must degrade
 * to the article without it, never to a broken section.
 */
export function validateArticleChat(value: unknown): ArticleChatTurn[] | null {
  if (!Array.isArray(value) || value.length !== ARTICLE_CHAT_TURNS) return null;
  const turns: ArticleChatTurn[] = [];
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const expected = index % 2 === 0 ? "a" : "b";
    if (record.s !== expected) return null;
    const ja = typeof record.ja === "string" ? record.ja.trim() : "";
    const en = typeof record.en === "string" ? record.en.trim() : "";
    if (!ja || !en) return null;
    if (ja.length > CHAT_TURN_MAX_JA_CHARS || en.length > CHAT_TURN_MAX_EN_CHARS) return null;
    turns.push({ s: expected, ja, en });
  }
  return turns;
}
