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
  /** Speaker keys stay "a"/"b" so stored chats remain readable. */
  s: "a" | "b";
  ja: string;
  en: string;
}

export const ARTICLE_CHAT_TURNS = 6;
export const CHAT_TURN_MAX_JA_CHARS = 150;
export const CHAT_TURN_MAX_EN_CHARS = 300;

export const ARTICLE_CHAT_PERSONAS = {
  a: {
    nameJa: "ポコ",
    nameEn: "Poko",
    artKey: "poko",
    roleJa: "「なんで？」から一緒に学ぶ、好奇心旺盛な聞き手",
    roleEn: "a curious questioner who learns alongside the reader",
    profileJa:
      "答えを先に知る先生ではない。読者と一緒に疑問を持ち、素直に聞き、少し勘違いしても確かめながら学ぶ。長い技術説明はしない。",
    profileEn:
      "Not a teacher with the answers. Poko wonders aloud, asks plainly, sometimes gets things wrong, and learns with the reader rather than giving long explanations.",
    speechJa:
      "短く、あたたかく、素直な話し言葉。疑問や驚きをそのまま尋ね、専門知識を持つふりをしない。",
    speechEn:
      "Brief, warm, and candid; asks rather than pretending to know the answer.",
  },
  b: {
    nameJa: "TECHガイド",
    nameEn: "TECH Guide",
    artKey: "tech-guide",
    roleJa: "TECH Dashboard 独自の編集上の案内役 (ポコ・シリーズの公式キャラクターではない)",
    roleEn: "a TECH Dashboard-original editorial guide, not a Poko-series character",
    profileJa:
      "記事から確認できることをやさしく短く言い換える編集ガイド。何でも知っているふりはせず、記事の記述と一般的な用語の説明を区別する。",
    profileEn:
      "A site-original editorial guide who explains what the article actually supports in everyday terms, separates the source from general definitions, and never claims to know everything.",
    speechJa:
      "やさしく簡潔な編集者の話し言葉。記事の事実から答え、出典の範囲を超える断定や博士口調は避ける。",
    speechEn:
      "Warm and concise editorial voice; starts with source-grounded answers.",
  },
} as const;

/** How the two relate — steers tone away from strawman debates. */
export const ARTICLE_CHAT_RELATIONSHIP_JA =
  "ポコは答えを先に知らない聞き手として読者目線で尋ね、TECHガイドは記事に書かれた範囲で答える。TECHガイドはポコを見下さず、ポコは遠慮なく聞き返す。";

/**
 * Old unversioned scripts may address their former cast by name. Only change
 * unmistakable vocatives in the rendered chat; names of products (e.g. Sora)
 * and the stored transcript remain untouched.
 */
export function presentArticleChatTurn(turn: ArticleChatTurn): Pick<ArticleChatTurn, "ja" | "en"> {
  if (turn.s === "a") {
    return {
      ja: turn.ja.replace(/^博士(?=、)/u, ARTICLE_CHAT_PERSONAS.b.nameJa),
      en: turn.en.replace(/^Doc(?=,)/i, ARTICLE_CHAT_PERSONAS.b.nameEn),
    };
  }
  const en = /\byou\b[^.!?]{0,120},\s*Sora[.!?]?\s*$/i.test(turn.en)
    ? turn.en.replace(/(,\s*)Sora(?=[.!?]?\s*$)/i, `$1${ARTICLE_CHAT_PERSONAS.a.nameEn}`)
    : turn.en;
  return {
    ja: turn.ja.replace(/^ソラ(?=、)/u, ARTICLE_CHAT_PERSONAS.a.nameJa),
    en,
  };
}

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
