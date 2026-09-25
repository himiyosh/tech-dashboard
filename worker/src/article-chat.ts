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
  /** Speaker keys stay "a"/"b" so stored chats remain readable. */
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
      "往復1 (発言1-2): ポコが記事で一番気になった具体的な点を短く聞き、TECHガイドが記事の記述に沿ってかみ砕いて答える。",
      "往復2 (発言3-4): ポコが「それは誰にどう役立つのか」を自分の言葉で確かめ、TECHガイドが記事に書かれた範囲で意味や影響を説明する。",
      "往復3 (発言5-6): ポコが分かったことを短くまとめ、TECHガイドが記事の範囲で注意点をひとこと添える。",
    ],
  },
  {
    key: "surprise-first",
    ja: [
      "往復1 (発言1-2): ポコが記事の中で驚いた数字や変化を挙げて「これって大きいこと？」と聞き、TECHガイドが記事の記述をもとに平易に説明する。",
      "往復2 (発言3-4): ポコが専門用語や仕組みを一つ選んで短く尋ね、TECHガイドが身近な言葉で言い換える。",
      "往復3 (発言5-6): ポコが「自分ならどう使うか」を想像して締め、TECHガイドが記事に書かれた条件や制約を添えて現実的に受け止める。",
    ],
  },
  {
    key: "usecase-first",
    ja: [
      "往復1 (発言1-2): ポコが「これは普段の何が変わるの？」と生活や仕事の場面から入り、TECHガイドが記事の記述に沿って答える。",
      "往復2 (発言3-4): ポコが「前はできなかったの？」と比較で聞き、TECHガイドが記事に書かれた範囲で従来との違いを説明する (書かれていなければ違いは分からないと正直に言う)。",
      "往復3 (発言5-6): ポコが一番の収穫を自分の言葉で言い、TECHガイドが記事の範囲で次に注目すべき点をひとこと添える。",
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
    "あなたはテックメディアの編集部コーナーの脚本家です。ポコとTECH Dashboard独自のTECHガイドが、下の「記事情報」に書かれている内容について短いチャットで議論します。TECHガイドはポコ・シリーズの公式キャラクターではありません。",
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
    `・各発言は 1〜2 文の話し言葉。ja は日本語 (120 文字以内)、en は同じ趣旨を自然な英語で (40 語以内)。en は直訳でなくネイティブのチャットとして、各キャラの口調 (${a.nameEn}: ${a.speechEn} / ${b.nameEn}: ${b.speechEn}) で書く。`,
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
