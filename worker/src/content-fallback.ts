import type { NormalizedEntry } from "../../harness/types.ts";

export interface ContentFallbackResult {
  entry: NormalizedEntry;
  summaryFallbacks: number;
  bodyFallbacks: number;
}

function text(value: string | undefined | null): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function firstText(...values: Array<string | undefined | null>): string {
  return values.map(text).find(Boolean) ?? "";
}

function sentence(value: string, fallback: string): string {
  const source = firstText(value, fallback);
  return source.replace(/[。.!?]\s*$/, "");
}

function hasCjk(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text(value));
}

function englishText(value: string | undefined | null): string {
  const next = text(value);
  return next && !hasCjk(next) ? next : "";
}

function fallbackTags(entry: NormalizedEntry): string[] {
  return [...new Set((entry.tags ?? []).filter((tag) => typeof tag === "string" && tag.trim()))].slice(0, 4);
}

function shortenForSummary(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function buildFallbackSummary(entry: NormalizedEntry): Pick<NormalizedEntry, "summaryJa" | "summaryEn"> {
  const titleAny = firstText(entry.titleJa, entry.titleEn, entry.title, entry.url, "TECH Dashboard entry");
  const titleEn = englishText(entry.titleEn) || englishText(entry.title) || englishText(titleAny);
  const titleJa = hasCjk(entry.titleJa ?? "") ? text(entry.titleJa) : hasCjk(entry.title) ? text(entry.title) : "";
  const source = firstText(entry.source, "unknown source");
  const category = firstText(entry.category, "tech-news");
  // Deterministic summary must be populated in BOTH languages so that the UI
  // never has to show a cross-language fallback badge on a Worker-published
  // entry. JA users land on `data-lang=ja` and expect Japanese copy even when
  // the upstream article is English; EN users expect the opposite. See LL-028.
  const summaryJa = titleJa
    ? shortenForSummary(titleJa, 140)
    : shortenForSummary(`「${titleEn || titleAny}」 (${source}) の ${category} 関連アップデート。AI 要約が未生成のため、後続の Worker run で本文が補完されます。`, 180);
  const summaryEn = titleEn
    ? shortenForSummary(titleEn, 200)
    : shortenForSummary(`${category} update from ${source}. AI summary not yet available; a future Worker run will refresh this entry.`, 200);
  return { summaryJa, summaryEn };
}

export function buildFallbackBody(entry: NormalizedEntry): Required<Pick<NormalizedEntry, "bodyJa" | "bodyEn">> {
  const titleJa = firstText(entry.titleJa, entry.titleEn, entry.title, "TECH Dashboard entry");
  const titleEn = firstText(entry.titleEn, entry.title, entry.titleJa, "TECH Dashboard entry");
  const titleEnDisplay = englishText(titleEn) || `The source item "${titleEn}"`;
  const summaryJa = sentence(firstText(entry.summaryJa, entry.summaryEn, entry.title), titleJa);
  const summaryEn = sentence(englishText(entry.summaryEn), "");
  const source = firstText(entry.source, "unknown source");
  const sourceType = firstText(entry.sourceType, "source");
  const category = firstText(entry.category, "tech-news");
  const tags = fallbackTags(entry);
  const tagJa = tags.length ? `関連キーワードは ${tags.join(", ")} です。` : "関連キーワードは今後の分類更新で補われます。";
  const tagEn = tags.length ? `Related tags include ${tags.join(", ")}.` : "Related tags can be refined as the entry is enriched.";
  const englishLead = summaryEn
    ? `${summaryEn}.`
    : "The original summary for this entry is not available in English, so this note stays close to the collected metadata and avoids adding claims beyond the source.";

  return {
    bodyJa: [
      `${titleJa} は、${source} が伝えた ${category} 領域の更新です。${summaryJa}。`,
      `このエントリでは、元記事の要約と収集時のメタデータから、読者が押さえるべき文脈を補っています。${sourceType} 系の情報は、リリース、導入事例、研究動向、実装ノウハウのいずれであっても、周辺ツールや運用判断に影響しやすいため、単なるニュースとしてではなく、利用者が次に確認すべき変化として読む価値があります。`,
      `${tagJa} 詳細を確認する際は、元記事で示されている前提条件、対象バージョン、提供範囲、制限事項を合わせて見ると、実務への影響を判断しやすくなります。未確認の部分については断定せず、公開情報に基づく補完として扱うのが安全です。`,
    ].join("\n\n"),
    bodyEn: [
      `${titleEnDisplay} is a ${category} update collected from ${source}. ${englishLead}`,
      `This long-form note is completed from the existing summary and collection metadata so the entry remains useful even when a full model-generated article body is unavailable. For ${sourceType} sources, the practical value is usually in the context: what changed, who is likely to be affected, and which adjacent tools, releases, or research threads may become relevant next.`,
      `${tagEn} When evaluating the original item, readers should still check the source for version details, availability, limitations, and implementation assumptions. Any broader implication should be treated as a cautious reading of the public information rather than a claim beyond the source material.`,
    ].join("\n\n"),
  };
}

export function applyDeterministicContentFallback(entry: NormalizedEntry): ContentFallbackResult {
  const next: NormalizedEntry = { ...entry };
  const summary = buildFallbackSummary(entry);
  let summaryFallbacks = 0;
  let bodyFallbacks = 0;

  if (!text(next.summaryJa) && text(summary.summaryJa)) {
    next.summaryJa = summary.summaryJa;
    summaryFallbacks++;
  }
  if (!text(next.summaryEn) && text(summary.summaryEn)) {
    next.summaryEn = summary.summaryEn;
    summaryFallbacks++;
  }

  const body = buildFallbackBody(next);
  if (!text(next.bodyJa)) {
    next.bodyJa = body.bodyJa;
    bodyFallbacks++;
  }
  if (!text(next.bodyEn)) {
    next.bodyEn = body.bodyEn;
    bodyFallbacks++;
  }

  return { entry: next, summaryFallbacks, bodyFallbacks };
}