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

/**
 * Japanese long-form body prompt (plain text, no JSON). ~700-1100 chars,
 * multiple paragraphs separated by blank lines. Sections carry "## " heading
 * lines (the ONLY allowed markup) so the detail page can render 項目 + TOC;
 * legacy bodies without headings get structural sections derived at render
 * time (web/src/lib/body-sections.ts).
 */
export function buildBodyPromptJa(e: BodyPromptEntry): string {
  return [
    "あなたはプロのテック編集者です。次の記事について、日本語の本文記事を書いてください。",
    "",
    "要件:",
    "・700〜1100 文字。複数の段落に分け、段落の区切りは空行 (改行2つ) のみ。",
    "・本文を 3〜5 個のセクションに分け、各セクションの先頭に「## 」で始まる 12 文字以内の内容見出し行を置く (見出し行の前後は空行)。見出しは「概要」のような汎用語ではなく、その記事の内容を表す具体的な言葉にする。",
    "・リード文で主題と重要性を 1〜2 文で提示し、本文で技術的内容・背景・影響を噛み砕いて説明する。",
    "・関連する周辺ツール・他社動向・前提知識など、読み応えを高める文脈を適度に含める。",
    "・中立かつ事実ベース。誤った断定や推測の断言は避け、推測は「と見られる」「可能性がある」等のヘッジ表現を使う。",
    "・収集元のタイトルと抜粋を事実の上限とし、料金・対象地域・対応OS・既存版からの展開を別の機能や新製品へ置き換えない。",
    "・「## 」見出し行以外はプレーンテキストのみ。リスト記号 (- , *) や他の Markdown 記法、コードフェンス、前置きは書かない。",
    "・本文のみを返す。タイトルや「以下が本文です」等のメタ説明は書かない。",
    "",
    "記事情報:",
    ...contextLines(e),
  ].join("\n");
}

/**
 * English long-form body prompt (plain text, no JSON). 500-800 words, multiple
 * paragraphs, written natively in English (not a literal translation).
 */
export function buildBodyPromptEn(e: BodyPromptEntry): string {
  return [
    "You are a professional technology editor. Write an English article body for the following item.",
    "",
    "Requirements:",
    "- 500-800 words, multiple paragraphs separated by a blank line (two newlines).",
    "- Split the body into 3-5 sections. Start each section with one heading line beginning with \"## \" (max 6 words), with a blank line before and after it. Make headings specific to this article's content, not generic labels like \"Overview\".",
    "- Open with one or two sentences stating the topic and why it matters, then explain the key points, technical detail, and context.",
    "- Add useful background: adjacent tools, related industry moves, or prerequisite concepts, to make it worth reading.",
    "- Neutral and fact-based. Avoid overclaiming; hedge speculation with phrases like \"appears to\" or \"is likely\".",
    "- Treat the collected title and source excerpt as the factual boundary. Preserve pricing, region, platform, and expansion facts instead of replacing them with a different feature or a new-product claim.",
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
