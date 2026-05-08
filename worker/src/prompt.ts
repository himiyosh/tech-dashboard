/**
 * worker/src/prompt.ts
 *
 * Copilot に渡すプロンプト生成と、レスポンス JSON のパース。
 * Cloudflare 固有の型に依存しないため、ユニットテストから直接 import できる。
 */
import type { NormalizedEntry } from "../../harness/types.ts";

export function buildPrompt(e: NormalizedEntry): string {
  return [
    `# 記事`,
    `タイトル: ${e.title}`,
    `カテゴリ: ${e.category}`,
    `ソース: ${e.source} (${e.sourceType})`,
    `URL: ${e.url}`,
    ``,
    `以下の JSON を**余計な文字を付けず**出力してください:`,
    `{`,
    `  "titleJa": "日本語タイトル (30〜60文字)。原題が日本語ならそのまま。英語なら自然な日本語に翻訳",`,
    `  "summaryJa": "2〜3 行の日本語要約 (120〜200 文字)",`,
    `  "summaryEn": "1-2 sentence English summary (140-260 chars). Plain English only, no Japanese.",`,
    `  "bodyJa": "プロライター視点で書かれた日本語本文 (700〜1100 文字)。以下の構成で、独立した記事として読めるように書くこと:\\n· リード文: 主題と重要性を 1、2 文で提示\\n· 本文: 元記事の主要ポイント・技術的内容・背景を掛い摩んで説明。複数パラグラフを \\\\n\\\\n で区切る\\n· 関連知見: キーワードに関わる背景・雑学・周辺ツールや他社動向との関連を含めて読み応えを上げる\\n· トーン: 中立、事実ベース。誤った断定や推測の単言は避ける\\n· 推測を含める際は「と見られる」「可能性がある」等のヘッジ表現を使う\\n· 出力はプレーンテキスト。Markdown 見出しやリスト記号は使わず、改行は \\\\n\\\\n のみ",`,
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

export function parseResponse(text: string): {
  titleJa: string;
  summaryJa: string;
  summaryEn: string;
  bodyJa: string;
  bodyEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
} {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 1, extraTags: [] };
  try {
    const obj = JSON.parse(match[0]) as {
      titleJa?: string;
      summaryJa?: string;
      summaryEn?: string;
      bodyJa?: string;
      bodyEn?: string;
      importance?: number;
      extraTags?: string[];
    };
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
  } catch {
    return { titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", bodyEn: "", importance: 1, extraTags: [] };
  }
}
