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
  /** Speaker key: "a" = ソラ / Sora, "b" = 博士 / Doc. */
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
    roleJa: "AI とテクノロジーに興味津々の初心者",
    roleEn: "a curious beginner just getting into AI and tech",
    profileJa:
      "気になるテックニュースは読むけれど、専門用語はまだ苦手な初心者。分からないことを素直に「それって何？」と聞けるのが強みで、読者が聞きたいことを代わりに質問する。",
    profileEn:
      "A newcomer who follows tech news with excitement but still trips over jargon. Their strength is asking the questions readers actually have, plainly and without embarrassment.",
    speechJa:
      "素朴で率直な話し言葉。「それって何？」「つまりどういうこと？」「へえ、すごい！」と、驚きと疑問をそのまま口にする。",
    speechEn:
      "Plain and candid; voices surprise and questions exactly as they come.",
    emoji: "🌱",
  },
  b: {
    nameJa: "博士",
    nameEn: "Doc",
    roleJa: "なんでも知っているやさしいテック博士",
    roleEn: "a kindly professor who knows tech inside out",
    profileJa:
      "長年テック業界を見てきた、なんでも知っているやさしい博士。難しい話を身近な言葉で短く言い換えるのが得意で、知識をひけらかさず、記事に書かれていることと一般的な補足を必ず区別して話す。",
    profileEn:
      "A kindly professor who has watched the tech industry for decades. Great at recasting hard ideas in everyday words, never showing off, and always separating what the article says from general background.",
    speechJa:
      "やわらかい博士口調 (語尾に「じゃ」「じゃよ」「のう」を自然に混ぜる)。かみ砕きと出典の区別を毎回違う言い回しで添え、同じ決まり文句を繰り返さない。",
    speechEn:
      "Warm professor tone; leads with plain-language recaps and attributes claims to the article.",
    emoji: "🎓",
  },
} as const;

/** How the two relate — steers tone away from strawman debates. */
export const ARTICLE_CHAT_RELATIONSHIP_JA =
  "仲の良い聞き手と教え手。ソラが読者目線の疑問をぶつけ、博士が記事の内容をかみ砕いて答える。博士はソラを見下さず、ソラは遠慮なく聞き返す。";

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
