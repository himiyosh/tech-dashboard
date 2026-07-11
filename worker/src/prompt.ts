/**
 * worker/src/prompt.ts
 *
 * Copilot に渡すプロンプト生成と、レスポンス JSON のパース。
 * Cloudflare 固有の型に依存しないため、ユニットテストから直接 import できる。
 */
import type { NormalizedEntry } from "../../harness/types.ts";

export type PromptEntry = Pick<
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
      | "bodyJa"
      | "bodyEn"
      | "lang"
      | "publishedAt"
      | "tags"
      | "importance"
    >
  >;

const FALLBACK_SUMMARY_JA_PREFIX = "このエントリは ";
const FALLBACK_SUMMARY_JA_NEEDLE = "AI 要約が未生成";
const FALLBACK_SUMMARY_EN_NEEDLE = "AI summary not yet available";
const FALLBACK_BODY_EN_NEEDLE = "completed from the existing summary and collection metadata";

export interface ParsedSummaryResponse {
  titleJa: string;
  summaryJa: string;
  summaryEn: string;
  bodyJa: string;
  bodyEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
}

function compact(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isFallbackText(value: string | undefined): boolean {
  const text = value ?? "";
  return (
    text.startsWith(FALLBACK_SUMMARY_JA_PREFIX) ||
    text.includes(FALLBACK_SUMMARY_JA_NEEDLE) ||
    text.includes(FALLBACK_SUMMARY_EN_NEEDLE) ||
    text.includes(FALLBACK_BODY_EN_NEEDLE)
  );
}

function sourceContextLines(e: PromptEntry): string[] {
  const lines: string[] = [];
  if (e.titleJa) lines.push(`日本語タイトル候補: ${compact(e.titleJa, 160)}`);
  if (e.titleEn) lines.push(`English title candidate: ${compact(e.titleEn, 160)}`);
  if (e.publishedAt) lines.push(`公開日時: ${e.publishedAt}`);
  if (e.tags?.length) lines.push(`既存タグ: ${e.tags.slice(0, 8).join(", ")}`);
  // Raw pre-summarization snippet is the primary material for a real summary.
  // Prefer the dedicated field; fall back to legacy summaryJa/summaryEn that
  // still hold a raw snippet for entries collected before the field existed.
  if (e.contentSnippet && !isFallbackText(e.contentSnippet)) {
    lines.push(`元記事の抜粋 (要約の主材料): ${compact(e.contentSnippet, 700)}`);
  }
  if (e.summaryJa && !isFallbackText(e.summaryJa)) {
    lines.push(`既存日本語メモ: ${compact(e.summaryJa, 420)}`);
  }
  if (e.summaryEn && !isFallbackText(e.summaryEn)) {
    lines.push(`Existing English note/snippet: ${compact(e.summaryEn, 700)}`);
  }
  return lines;
}

export function buildPrompt(e: PromptEntry): string {
  const context = sourceContextLines(e);
  return [
    `# 記事`,
    `タイトル: ${e.title}`,
    `カテゴリ: ${e.category}`,
    `ソース: ${e.source} (${e.sourceType})`,
    `URL: ${e.url}`,
    ...(context.length ? [``, `# 収集済みコンテキスト`, ...context] : []),
    ``,
    `以下の JSON を**余計な文字を付けず**出力してください:`,
    `{`,
    `  "titleJa": "日本語タイトル (30〜60文字)。原題が日本語ならそのまま。英語なら自然な日本語に翻訳",`,
    `  "summaryJa": "2〜3 行の日本語要約 (120〜200 文字)",`,
    `  "summaryEn": "1-2 sentence English summary (140-260 chars). Plain English only, no Japanese.",`,
    `  "bodyJa": "プロライター視点で書かれた日本語本文 (700〜1100 文字)。以下の構成で、独立した記事として読めるように書くこと:\\n· リード文: 主題と重要性を 1、2 文で提示\\n· 本文: 元記事の主要ポイント・技術的内容・背景を噛み砕いて説明。複数パラグラフを \\\\n\\\\n で区切る\\n· 関連知見: キーワードに関わる背景・雑学・周辺ツールや他社動向との関連を含めて読み応えを上げる\\n· トーン: 中立、事実ベース。誤った断定や推測の断言は避ける\\n· 推測を含める際は「と見られる」「可能性がある」等のヘッジ表現を使う\\n· 出力はプレーンテキスト。Markdown 見出しやリスト記号は使わず、改行は \\\\n\\\\n のみ",`,
    `  "bodyEn": "Plain English long-form article (500-800 words). Same content and structure as bodyJa but written natively in English (do not translate literally — write as a professional tech editor would in English). Use \\\\n\\\\n between paragraphs. No Markdown headings or list symbols. Include the same kind of background context, related ecosystem references, and hedged speculation when appropriate.",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["英小文字 kebab", ...]`,
    `}`,
    ``,
    `importance 基準: 3=メジャーリリース/重大発表、2=機能追加/重要論文、1=通常更新。`,
    `titleJa: 固有名詞 (製品名・企業名) は英語のまま保持。バージョン番号 (例: 4.7) も正確に保持する。`,
    `summaryJa と summaryEn は同じ内容を各言語で表現すること。`,
    `bodyJa は読んで価値のある独立した記事にすること。要約の重複を避け、背景・関連知見を付加して厚みを出す。`,
    `bodyEn must be written natively in English with the same depth as bodyJa (not a literal translation).`,
  ].join("\n");
}

/**
 * Queue consumer prompt for Cloudflare Workers.
 *
 * The consumer has a 28s timeout and a small max_tokens budget. Keep this
 * contract compact so the model can close valid JSON reliably; richer
 * long-form backfills can still use buildPrompt() from local batch scripts.
 */
export function buildQueuePrompt(e: PromptEntry): string {
  const context = sourceContextLines(e);
  return [
    `# Article`,
    `Title: ${e.title}`,
    `Category: ${e.category}`,
    `Source: ${e.source} (${e.sourceType})`,
    `URL: ${e.url}`,
    ...(context.length ? [``, `# Collected context`, ...context] : []),
    ``,
    `Return exactly one valid JSON object. All string fields must be non-empty. Do not use Markdown fences.`,
    `{`,
    `  "titleJa": "Natural Japanese title. Keep product/company names and version numbers unchanged.",`,
    `  "summaryJa": "Japanese summary, 80-140 chars.",`,
    `  "summaryEn": "English summary, 90-170 chars.",`,
    `  "bodyJa": "Japanese context note, 240-420 chars, 2-3 paragraphs separated by \\\\n\\\\n. Stay within facts from the title/context. If context is thin, explain what can be safely inferred and what readers should verify at the source.",`,
    `  "bodyEn": "Native English context note, 140-220 words, 2-3 paragraphs separated by \\\\n\\\\n. Same substance as bodyJa. Stay within facts from the title/context and hedge uncertain implications.",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["lowercase-kebab", ...]`,
    `}`,
    ``,
    `importance: 3=major release/critical announcement, 2=important feature/research, 1=routine update.`,
    `Never copy deterministic fallback text such as "AI summary not yet available".`,
  ].join("\n");
}

/**
 * Summary-only prompt for the Queue consumer (LL-106).
 *
 * claude-sonnet-4.6 is a reasoning model: it emits opaque reasoning tokens
 * that count against max_tokens. When the prompt also asks for a long
 * bilingual body (700-1100 JA chars + 500-800 EN words), reasoning + the long
 * output exhausts the budget and the Copilot chat endpoint returns
 * {"choices":[]} (empty) -- surfacing as "incomplete summary" and writing ZERO
 * summaries to KV. Asking for only title + JA/EN summary keeps the output
 * short enough that reasoning + answer fit, so the model finishes
 * (finish_reason=stop) and returns valid JSON. Long-form body generation is
 * handled separately by worker-body and stored in data/bodies.json, so this
 * summary contract intentionally does not request or synthesize body text.
 */
export function buildSummaryPrompt(e: PromptEntry): string {
  const context = sourceContextLines(e);
  return [
    `# Article`,
    `Title: ${e.title}`,
    `Category: ${e.category}`,
    `Source: ${e.source} (${e.sourceType})`,
    `URL: ${e.url}`,
    ...(context.length ? [``, `# Collected context`, ...context] : []),
    ``,
    `Return exactly one valid JSON object with ONLY these fields. All strings must be non-empty.`,
    `Do NOT write a body or any long-form text. Keep the whole response short.`,
    `Write a genuine summary of what the article is about and why it matters -- do NOT copy or truncate the opening sentence of the excerpt.`,
    `Every summary must be grammatically complete: never cut off mid-sentence or mid-word, and always end with proper punctuation.`,
    `{`,
    `  "titleJa": "Natural Japanese title. Keep product/company names and version numbers unchanged.",`,
    `  "summaryJa": "Complete Japanese summary in 1-2 full sentences (90-150 chars). State what changed and why it matters.",`,
    `  "summaryEn": "Complete English summary in 1-2 full sentences (100-180 chars). State what changed and why it matters.",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["lowercase-kebab", ...]`,
    `}`,
    ``,
    `importance: 3=major release/critical announcement, 2=important feature/research, 1=routine update.`,
    `Never copy deterministic fallback text such as "AI summary not yet available".`,
  ].join("\n");
}

function emptyParsedResponse(): ParsedSummaryResponse {
  return { titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 1, extraTags: [] };
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (start === -1) {
      if (ch === "{") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  if (candidates.length) return candidates;
  const match = text.match(/\{[\s\S]*\}/);
  return match ? [match[0]] : [];
}

function escapeRawControlCharsInJsonStrings(candidate: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const ch of candidate) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") continue;
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        out += " ";
        continue;
      }
    } else if (ch === "\"") {
      inString = true;
    }
    out += ch;
  }

  return out;
}

function stripTrailingCommas(candidate: string): string {
  return candidate.replace(/,\s*([}\]])/g, "$1");
}

function parseJsonObjectCandidate(candidate: string): Record<string, unknown> | null {
  const escapedControls = escapeRawControlCharsInJsonStrings(candidate);
  const variants = [
    candidate,
    escapedControls,
    stripTrailingCommas(escapedControls),
  ];
  for (const variant of variants) {
    try {
      const obj = JSON.parse(variant) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // Try the next recovery variant.
    }
  }
  return null;
}

function coerceParsedResponse(obj: Record<string, unknown>): ParsedSummaryResponse {
  const imp = Math.max(1, Math.min(3, Number(obj.importance ?? 1))) as 1 | 2 | 3;
  return {
    titleJa: String(obj.titleJa ?? "").trim(),
    summaryJa: String(obj.summaryJa ?? "").trim(),
    summaryEn: String(obj.summaryEn ?? "").trim(),
    bodyJa: String(obj.bodyJa ?? "").trim(),
    bodyEn: String(obj.bodyEn ?? "").trim(),
    importance: imp,
    extraTags: Array.isArray(obj.extraTags)
      ? obj.extraTags.filter((t): t is string => typeof t === "string").slice(0, 6)
      : [],
  };
}

export function parseResponse(text: string): ParsedSummaryResponse {
  const candidates = extractJsonObjectCandidates(text);
  if (!candidates.length) return emptyParsedResponse();
  for (const candidate of candidates) {
    const obj = parseJsonObjectCandidate(candidate);
    if (obj) return coerceParsedResponse(obj);
  }
  return emptyParsedResponse();
}
