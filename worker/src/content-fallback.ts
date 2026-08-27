import type { NormalizedEntry } from "../../harness/types.ts";
import {
  isContaminatedSummaryText,
  sanitizeStoredSummaryGrounding,
} from "../../harness/pipeline/summary-quality.ts";

export interface ContentFallbackResult {
  entry: NormalizedEntry;
  summaryFallbacks: number;
  bodyFallbacks: number;
  summaryGroundingRejected: number;
  /**
   * Summaries cleared because they reproduced the collected source excerpt
   * verbatim. Counted separately from summaryGroundingRejected so the publish
   * log names the category, not just a number.
   */
  summaryVerbatimRejected: number;
}

function text(value: string | undefined | null): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function firstText(...values: Array<string | undefined | null>): string {
  return values.map(text).find(Boolean) ?? "";
}

function hasCjk(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text(value));
}

function englishText(value: string | undefined | null): string {
  const next = text(value);
  return next && !hasCjk(next) ? next : "";
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
  // The JA template intentionally LEADS with a Japanese descriptor (source/
  // category) so the card opener doesn't look like English — the original
  // title goes after a 原題: marker.
  const summaryJa = titleJa
    ? shortenForSummary(titleJa, 140)
    : shortenForSummary(
        `このエントリは ${source} から収集した ${category} 領域の最新アップデートです。原題:「${titleEn || titleAny}」。AI による日本語要約は次回以降の Worker run で生成されます。`,
        220,
      );
  const summaryEn = titleEn
    ? shortenForSummary(titleEn, 200)
    : shortenForSummary(`${category} update from ${source}. AI summary not yet available; a future Worker run will refresh this entry.`, 200);
  return { summaryJa, summaryEn };
}

export function applyDeterministicContentFallback(entry: NormalizedEntry): ContentFallbackResult {
  const grounding = sanitizeStoredSummaryGrounding(entry);
  const next: NormalizedEntry = { ...grounding.entry };
  if (isContaminatedSummaryText(next.summaryJa)) next.summaryJa = "";
  if (isContaminatedSummaryText(next.summaryEn)) next.summaryEn = "";
  const summary = buildFallbackSummary(next);
  let summaryFallbacks = 0;

  if (!text(next.summaryJa) && text(summary.summaryJa)) {
    next.summaryJa = summary.summaryJa;
    summaryFallbacks++;
  }
  if (!text(next.summaryEn) && text(summary.summaryEn)) {
    next.summaryEn = summary.summaryEn;
    summaryFallbacks++;
  }

  // Summary-first design (LL-112): the long-form body is NO LONGER generated.
  // Queue summarization is summary-only (LL-106), so a per-entry body was only
  // ever a deterministic filler ("...は ... 領域の更新です" / "completed from the
  // existing summary and collection metadata"). That filler added ~43% to
  // index.json (CI size budget overflow), was hidden behind a false "本文は近日
  // 中に AI が生成" promise on the detail page, AND flipped real-summary entries
  // to non-publishable (dropping them from Featured/Top-3/feeds). We now leave
  // body empty; the real AI summary is the primary content and the detail page
  // links to the original article. Pre-existing real AI bodies (from the old
  // generation path) are preserved upstream in the cache merge and still render.
  return {
    entry: next,
    summaryFallbacks,
    bodyFallbacks: 0,
    summaryGroundingRejected: grounding.rejected ? 1 : 0,
    summaryVerbatimRejected: grounding.verbatimRejected ? 1 : 0,
  };
}