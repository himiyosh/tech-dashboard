/**
 * worker/src/body-generate.ts
 *
 * Plain-text long-form body prompts for the body-file architecture (LL-115).
 *
 * Unlike the summary prompt (which asks for a single bilingual JSON object),
 * the body is generated as TWO SEPARATE plain-text calls — one Japanese, one
 * English. This is deliberate (LL-106 / LL-115): asking a reasoning model
 * (claude-opus-4.8) for both long bodies in one JSON response risks the
 * reasoning-loop-empties failure that killed the original body generation.
 * Two single-language plain-text calls each finish cleanly (verified by live
 * API probe: JA ~1000 chars / EN ~700 words, finish_reason=stop, even at
 * reasoning_effort=max).
 *
 * Cloudflare-type-free so it can be unit-tested directly.
 */
import type { NormalizedEntry } from "../../harness/types.ts";

export type BodyPromptEntry = Pick<
  NormalizedEntry,
  "title" | "category" | "source" | "sourceType" | "url"
> &
  Partial<
    Pick<
      NormalizedEntry,
      | "titleJa"
      | "titleEn"
      | "summaryJa"
      | "summaryEn"
      | "contentSnippet"
      | "lang"
      | "publishedAt"
      | "tags"
    >
  >;

/** Queue message produced by the collector for the body consumer. Kept small. */
export interface BodyJob {
  url: string;
  publisherContractFingerprint?: string;
  entry: BodyPromptEntry & Pick<NormalizedEntry, "id">;
}

const FALLBACK_SUMMARY_JA_PREFIX = "このエントリは ";
const FALLBACK_SUMMARY_EN_NEEDLE = "AI summary not yet available";
const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";
const FALLBACK_BODY_JA_NEEDLE = "元記事の要約と収集時のメタデータから";

function compact(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isFallbackText(value: string | undefined): boolean {
  const text = value ?? "";
  return (
    text.startsWith(FALLBACK_SUMMARY_JA_PREFIX) ||
    text.includes(FALLBACK_SUMMARY_EN_NEEDLE) ||
    text.includes(FALLBACK_BODY_EN_NEEDLE) ||
    text.includes(FALLBACK_BODY_JA_NEEDLE)
  );
}

/** Shared context block (title, category, summaries, tags) for both languages. */
function contextLines(e: BodyPromptEntry): string[] {
  const lines: string[] = [];
  lines.push(`タイトル / Title: ${compact(e.titleJa || e.title, 200)}`);
  if (e.titleEn && e.titleEn !== e.title) lines.push(`English title: ${compact(e.titleEn, 200)}`);
  lines.push(`カテゴリ / Category: ${e.category} · ソース / Source: ${e.source} (${e.sourceType})`);
  if (e.publishedAt) lines.push(`公開日時 / Published: ${e.publishedAt}`);
  if (e.tags?.length) lines.push(`タグ / Tags: ${e.tags.slice(0, 8).join(", ")}`);
  if (e.contentSnippet && !isFallbackText(e.contentSnippet)) {
    lines.push(`収集元の抜粋 / Source excerpt: ${compact(e.contentSnippet, 900)}`);
  }
  if (e.summaryJa && !isFallbackText(e.summaryJa)) {
    lines.push(`既存の日本語要約: ${compact(e.summaryJa, 600)}`);
  }
  if (e.summaryEn && !isFallbackText(e.summaryEn)) {
    lines.push(`Existing English summary / snippet: ${compact(e.summaryEn, 800)}`);
  }
  return lines;
}

export interface BodyLengthPlan {
  sourceChars: number;
  jaMinChars: number;
  jaMaxChars: number;
  enMinWords: number;
  enMaxWords: number;
  minSections: number;
  maxSections: number;
}

/**
 * The factual budget for a body is the SOURCE EXCERPT only.
 *
 * The summaries in contextLines() are themselves generated from this same
 * excerpt, so counting them would double-count the input and license the model
 * to expand on its own prior output. Measured before this change: 6,770,705
 * generated body characters came out of 289,687 characters of excerpt (23.4x
 * overall) while the collector capped the excerpt at 280 chars. Asking for
 * 700-1100 JA chars and 500-800 EN words from that is a standing instruction
 * to invent, so the requested band scales with what the source supplied. The
 * collector cap now matches this budget (900, harness/pipeline/normalize.ts),
 * so rich feeds earn the full band honestly; thin feeds stay short.
 */
function sourceBudgetChars(e: BodyPromptEntry): number {
  if (!e.contentSnippet || isFallbackText(e.contentSnippet)) return 0;
  return compact(e.contentSnippet, 900).length;
}

const JA_CHARS_PER_SOURCE_CHAR = 1.6;
const JA_FLOOR_CHARS = 300;
const JA_CEILING_CHARS = 900;
const EN_WORDS_PER_SOURCE_CHAR = 0.7;
const EN_FLOOR_WORDS = 130;
const EN_CEILING_WORDS = 400;
const LENGTH_BAND_LOWER_RATIO = 0.6;

function clampLength(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundToTen(value: number): number {
  return Math.round(value / 10) * 10;
}

/**
 * Length band derived from the excerpt. Floors are deliberate: entries below
 * the body grounding gate (48 chars / 8 words / 20 CJK) never reach generation
 * at all, so the smallest input that gets here is a real short excerpt, and the
 * JA floor of 300 keeps the requested minimum (180) at 1.5x the hard
 * MIN_BODY_CHARS=120 check in worker-body/src/index.ts:73 - a model that
 * undershoots the band still clears the completeness gate instead of failing
 * the job into the DLQ.
 *
 * Worked points: 48-187 source chars -> JA 180-300 / EN 80-130 words;
 * 280 (the legacy collector cap; most of the stored corpus) -> JA 270-450 /
 * EN 120-200; 563+ (rich feeds under the 900 collector cap) -> JA 540-900 /
 * EN 240-400 (the full band).
 */
export function bodyLengthPlan(e: BodyPromptEntry): BodyLengthPlan {
  const sourceChars = sourceBudgetChars(e);
  const jaMaxChars = roundToTen(
    clampLength(
      sourceChars * JA_CHARS_PER_SOURCE_CHAR,
      JA_FLOOR_CHARS,
      JA_CEILING_CHARS,
    ),
  );
  const enMaxWords = roundToTen(
    clampLength(
      sourceChars * EN_WORDS_PER_SOURCE_CHAR,
      EN_FLOOR_WORDS,
      EN_CEILING_WORDS,
    ),
  );
  const maxSections = jaMaxChars >= 600 ? 4 : jaMaxChars >= 400 ? 3 : 2;
  return {
    sourceChars,
    jaMinChars: roundToTen(jaMaxChars * LENGTH_BAND_LOWER_RATIO),
    jaMaxChars,
    enMinWords: roundToTen(enMaxWords * LENGTH_BAND_LOWER_RATIO),
    enMaxWords,
    minSections: Math.max(2, maxSections - 1),
    maxSections,
  };
}

function sectionRange(plan: BodyLengthPlan, separator: string): string {
  return plan.minSections === plan.maxSections
    ? String(plan.minSections)
    : `${plan.minSections}${separator}${plan.maxSections}`;
}

/**
 * Japanese explainer prompt (plain text, no JSON). Length scales with the
 * source excerpt (bodyLengthPlan). Sections carry "## " heading lines (the ONLY
 * allowed markup) so the detail page can render 項目 + TOC; legacy bodies
 * without headings get structural sections derived at render time
 * (web/src/lib/body-sections.ts).
 */
export function buildBodyPromptJa(e: BodyPromptEntry): string {
  const plan = bodyLengthPlan(e);
  return [
    "あなたはプロのテック編集者です。以下の「記事情報」に書かれていることだけを材料に、日本語の解説本文を書いてください。",
    "",
    "絶対条件 (1つでも破った出力は破棄されます):",
    "・記事情報に無い事実を書かない。製品名・企業名・人名・バージョン番号・数値・日付・価格・対応プラットフォーム・ベンチマーク・引用のうち、記事情報に現れないものを持ち込まない。",
    "・記事情報の外にある背景を補わない。周辺ツール、他社や業界の動向、前提知識の解説を足さない。読み応えを出すための一般論での水増しを禁止する。",
    "・記事情報から読み取れないことは書かずに省く。動機・ロードマップ・今後の影響を推し量らない。",
    "・材料が少ないときは短く書いて終える。分量を満たすために内容を作らない。",
    "・収集元のタイトルと抜粋を事実の上限とし、料金・対象地域・対応OS・既存版からの展開を別の機能や新製品へ置き換えない。",
    "",
    "書式:",
    `・${plan.jaMinChars}〜${plan.jaMaxChars} 文字。複数の段落に分け、段落の区切りは空行 (改行2つ) のみ。`,
    `・本文を ${sectionRange(plan, "〜")} 個のセクションに分け、各セクションの先頭に「## 」で始まる 12 文字以内の内容見出し行を置く (見出し行の前後は空行)。見出しは「概要」のような汎用語ではなく、記事情報に実際に出てくる言葉を使う。`,
    "・リード文で主題と重要性を 1〜2 文で提示し、残りは記事情報にある技術的内容の噛み砕きに充てる。",
    "・中立かつ事実ベース。記事情報が断定していない事柄は「と説明されている」「とされる」等で出典に帰属させ、自分の判断として断定しない。",
    "・「## 」見出し行以外はプレーンテキストのみ。リスト記号 (- , *) や他の Markdown 記法、コードフェンス、前置きは書かない。",
    "・本文のみを返す。タイトルや「以下が本文です」等のメタ説明は書かない。",
    "",
    "記事情報:",
    ...contextLines(e),
  ].join("\n");
}

/**
 * English explainer prompt (plain text, no JSON). Length scales with the source
 * excerpt (bodyLengthPlan), written natively in English (not a literal
 * translation of the Japanese body).
 */
export function buildBodyPromptEn(e: BodyPromptEntry): string {
  const plan = bodyLengthPlan(e);
  return [
    "You are a professional technology editor. Write an English explainer body for the item below, using ONLY what the \"Article info\" block states as your material.",
    "",
    "Hard constraints (output that breaks any one of these is discarded):",
    "- State no fact that is absent from the Article info block. Do not introduce product names, companies, people, version numbers, figures, dates, prices, supported platforms, benchmarks, or quotations that do not appear there.",
    "- Do not supply background from outside the block: no adjacent tools, no competitor or industry moves, no prerequisite-concept explainers. Do not pad with general knowledge to make the piece feel substantial.",
    "- Leave out anything the block does not support. Do not speculate about motives, roadmaps, or downstream impact.",
    "- When the material is thin, write a shorter body and stop. Never invent content to reach a length.",
    "- Treat the collected title and source excerpt as the factual boundary. Preserve pricing, region, platform, and expansion facts instead of replacing them with a different feature or a new-product claim.",
    "",
    "Format:",
    `- ${plan.enMinWords}-${plan.enMaxWords} words, multiple paragraphs separated by a blank line (two newlines).`,
    `- Split the body into ${sectionRange(plan, "-")} sections. Start each section with one heading line beginning with "## " (max 6 words), with a blank line before and after it. Draw the headings from wording that appears in the Article info block, not from generic labels like "Overview".`,
    "- Open with one or two sentences stating the topic and why it matters, then explain the technical detail the block actually provides.",
    "- Neutral and fact-based. Attribute anything the block does not assert outright (\"the announcement says\", \"according to the source\") instead of stating it as established.",
    "- Other than the \"## \" heading lines, plain text only: no list markers (-, *), no other Markdown, no code fences, no preamble.",
    "- Return ONLY the body text. Do not write a title or any meta commentary such as \"Here is the body\".",
    "",
    "Article info:",
    ...contextLines(e),
  ].join("\n");
}

/** Strip accidental wrapping (code fences, leading "Body:" labels) from output. */
export function cleanBodyText(text: string): string {
  let out = (text ?? "").trim();
  // Remove a leading ```lang fence and trailing ``` if the model wrapped it.
  out = out.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
  // Drop a leading meta label line like "本文:" / "Body:".
  out = out.replace(/^(本文|Body)\s*[:：]\s*/i, "");
  return out.trim();
}
