/**
 * 記事ディスカッション (article chat) — two fixed editorial characters discuss
 * the article in a short chat-bubble exchange rendered on the detail page.
 *
 * Site-owner feature request (2026-08-29): 「二人のキャラクターが対話・チャット
 * の吹き出し形式 3 往復くらい、記事についての議論を行う」. The chat is a
 * PRESENTATION of the collected facts, not a source of new ones: it obeys the
 * same source-grounding contract as the body (only what the Article info block
 * states; opinions must be framed as reactions to those stated facts).
 *
 * Shape: exactly 6 turns (3 exchanges), strictly alternating a, b, a, b, a, b.
 * Each turn carries a Japanese and an English rendition so the existing
 * i18n-ja / i18n-en toggle works without a second generation pass.
 *
 * The personas are mirrored in web/src/lib/article-chat.ts for rendering.
 * The Cloudflare Workers bundle must not import web/src (see body-quality.ts
 * scope note), so tests/worker-article-chat.test.ts pins both copies equal
 * instead of sharing a module.
 */

export interface ArticleChatTurn {
  /** Speaker key: "a" = ソラ / Sora, "b" = 博士 / Doc. */
  s: "a" | "b";
  ja: string;
  en: string;
}

export const ARTICLE_CHAT_TURNS = 6;
/** Bubbles are chat-sized, not paragraphs. */
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

export interface ChatPromptEntry {
  title?: string;
  titleJa?: string | null;
  titleEn?: string | null;
  summaryJa?: string | null;
  summaryEn?: string | null;
  contentSnippet?: string | null;
  source?: string;
  sourceType?: string;
  category?: string;
  tags?: readonly string[];
}

function compact(value: string | null | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function contextLines(e: ChatPromptEntry): string[] {
  const lines: string[] = [];
  if (e.title) lines.push(`原題: ${compact(e.title, 200)}`);
  if (e.titleJa && e.titleJa !== e.title) lines.push(`日本語タイトル: ${compact(e.titleJa, 200)}`);
  if (e.summaryJa) lines.push(`日本語要約: ${compact(e.summaryJa, 400)}`);
  if (e.summaryEn) lines.push(`英語要約: ${compact(e.summaryEn, 500)}`);
  if (e.contentSnippet) lines.push(`本文: ${compact(e.contentSnippet, 900)}`);
  if (e.source) lines.push(`source: ${e.source} (${e.sourceType ?? "?"})`);
  if (e.category) lines.push(`カテゴリ: ${e.category}`);
  // Tags are classification labels, not facts; they were quoted as such.
  return lines;
}

/**
 * Three conversation arcs, chosen deterministically per article so the
 * corner does not read as one template repeated 1,000 times (site audit:
 * every chat opened with 「簡単に言うと」 and 「それって何が嬉しいの？」).
 */
export const ARTICLE_CHAT_ARC_VARIANTS = [
  {
    key: "question-first",
    ja: [
      "往復1 (発言1-2): ソラが記事で一番気になった具体的な点を自分の言葉で聞き、博士が記事の記述に沿ってかみ砕いて答える。",
      "往復2 (発言3-4): ソラが「それは誰にどう役立つのか」を自分なりの例えで確かめ、博士が記事に書かれた範囲で意味や影響を説明する。",
      "往復3 (発言5-6): ソラが分かったことを一言でまとめ、博士が記事の範囲で注意点や見どころをひとこと添える。",
    ],
  },
  {
    key: "surprise-first",
    ja: [
      "往復1 (発言1-2): ソラが記事の中で驚いた数字や変化を挙げて「これって大きいこと？」と聞き、博士が記事の記述をもとに大きさや位置づけを平易に説明する。",
      "往復2 (発言3-4): ソラが専門用語や仕組みを一つ選んで「つまりどういうこと？」と掘り、博士が身近な言葉で言い換える。",
      "往復3 (発言5-6): ソラが「自分ならどう使うか」を想像して締め、博士が記事に書かれた条件や制約を添えて現実的に受け止める。",
    ],
  },
  {
    key: "usecase-first",
    ja: [
      "往復1 (発言1-2): ソラが「これは普段の何が変わるの？」と生活や仕事の場面から入り、博士が記事の記述に沿って何ができるようになるかを答える。",
      "往復2 (発言3-4): ソラが「前はできなかったの？」と比較で聞き、博士が記事に書かれた範囲で従来との違いを説明する (書かれていなければ違いは分からないと正直に言う)。",
      "往復3 (発言5-6): ソラが一番の収穫を自分の言葉で言い、博士が記事の範囲で次に注目すべき点をひとこと添える。",
    ],
  },
] as const;

/** Phrases that made every chat sound identical; the prompt forbids them. */
export const ARTICLE_CHAT_STOCK_PHRASES = [
  "簡単に言うと",
  "それって何が嬉しいの",
  "記事によれば",
  "その理解でよいぞ",
  "見どころ",
  "今後の見どころ",
  "抜粋",
  "記事情報",
] as const;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function articleChatArcFor(e: ChatPromptEntry): (typeof ARTICLE_CHAT_ARC_VARIANTS)[number] {
  const seed = `${e.title ?? ""}|${e.titleJa ?? ""}|${e.source ?? ""}`;
  return ARTICLE_CHAT_ARC_VARIANTS[stableHash(seed) % ARTICLE_CHAT_ARC_VARIANTS.length]!;
}

/**
 * One bilingual JSON call. Kept summary-sized on purpose: the chat is six
 * short bubbles per language, comfortably inside the summarizer-scale token
 * budget, so it does NOT need the two-single-language-calls split the long
 * bodies required (LL-106/LL-115).
 */
export function buildArticleChatPrompt(e: ChatPromptEntry): string {
  const a = ARTICLE_CHAT_PERSONAS.a;
  const b = ARTICLE_CHAT_PERSONAS.b;
  const arc = articleChatArcFor(e);
  return [
    "あなたはテックメディアの編集部コーナーの脚本家です。固定キャラクター 2 人が、下の「記事情報」に書かれている内容について短いチャットで議論します。",
    "",
    "キャラクター設定 (口調と視点を必ず反映する):",
    `・a = ${a.nameJa} (${a.nameEn}): ${a.roleJa}。${a.profileJa}`,
    `  口調: ${a.speechJa}`,
    `・b = ${b.nameJa} (${b.nameEn}): ${b.roleJa}。${b.profileJa}`,
    `  口調: ${b.speechJa}`,
    `・関係性: ${ARTICLE_CHAT_RELATIONSHIP_JA}`,
    "",
    "絶対条件 (1つでも破った出力は破棄されます):",
    "・記事情報に無い事実を持ち込まない。製品名・企業名・数値・日付・価格・ベンチマーク・対応環境は記事情報に現れるものだけを使う。",
    "・周辺知識や他社動向で水増ししない。感想・評価は「記事情報に書かれている事実への反応」として述べ、新しい事実の主張にしない。",
    "・記事情報が断定していないことは断定しない。推測は「〜なら」「〜かもね」のような仮定・伝聞の形にとどめる。キャラの背景設定は口調と視点にだけ使い、経験談として新しい事実を語らせない。",
    "・例外はひとつ: 記事情報に登場する専門用語を、広く知られた一般的な定義の範囲で短く平易に言い換えるのはよい (例:「オープンウェイト＝モデルの中身が公開されている、くらいの意味」)。その場合も具体的な数値・日付・製品仕様・他社動向は足さない。",
    "・記事情報は読者には見えない台本用の材料である。「抜粋」「記事情報」「要約」などの材料名や、材料に書かれていないこと自体には触れない。二人は記事そのものを読んだ前提で話す。",
    `・次の決まり文句は使わない: ${ARTICLE_CHAT_STOCK_PHRASES.map((p) => `「${p}」`).join("")}。出典に触れるときは「この記事では」「記事だと」のように毎回言い方を変える。`,
    "",
    "会話の設計:",
    `・ちょうど ${ARTICLE_CHAT_TURNS} 発言 (3 往復)。a → b → a → b → a → b の順で交互。`,
    ...arc.ja.map((line) => `・${line}`),
    "・各発言は 1〜2 文の話し言葉。ja は日本語 (120 文字以内)、en は同じ趣旨を自然な英語で (40 語以内)。en は直訳でなくネイティブのチャットとして、各キャラの口調 (Sora: " + a.speechEn + " / Ren: " + b.speechEn + ") で書く。",
    "・記事タイトルの復唱や挨拶で発言を浪費しない。1 発言目から内容に入る。",
    "",
    "出力は次の JSON 配列だけを返す (コードフェンス・前置き・後書き禁止):",
    `[{"s":"a","ja":"...","en":"..."},{"s":"b","ja":"...","en":"..."}, ...全 ${ARTICLE_CHAT_TURNS} 要素]`,
    "",
    "記事情報:",
    ...contextLines(e),
  ].join("\n");
}

/**
 * Parse + structural validation. Returns null (never throws) on anything that
 * is not exactly the contract: the chat is best-effort garnish and a broken
 * one must not fail or retry the surrounding body job.
 */
export function parseArticleChat(text: string): ArticleChatTurn[] | null {
  let raw = (text ?? "").trim();
  const fence = raw.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1]!.trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  return validateArticleChat(parsed);
}

/** Structural contract shared by the generator, merge, and web rendering. */
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

/** Concatenated per-language text for the source-grounding checker. */
export function chatGroundingText(turns: readonly ArticleChatTurn[]): {
  ja: string;
  en: string;
} {
  return {
    ja: turns.map((turn) => turn.ja).join("\n"),
    en: turns.map((turn) => turn.en).join("\n"),
  };
}
