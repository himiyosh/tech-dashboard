import {
  findSummaryGroundingIssues,
  hasSufficientSourceGrounding,
  normalizedSourceText,
  type GroundingIssue,
  type SourceGroundingInput,
} from "./source-grounding.ts";

export interface SummaryQualityInput extends SourceGroundingInput {
  summaryJa?: string | null;
  summaryEn?: string | null;
  titleJa?: string | null;
  titleEn?: string | null;
}

const PENDING_SUMMARY_JA_PREFIX = "このエントリは ";
const PENDING_SUMMARY_JA_MARKERS = [
  "AI 要約未生成",
  "後続の Worker run",
  "要約が未生成",
] as const;
const PENDING_SUMMARY_EN_MARKERS = [
  "ai summary not yet available",
  "ai summary pending",
  "summary is pending",
] as const;

export const CONTAMINATED_SUMMARY_MARKERS = [
  "left some junk in the readme",
  "forgot to remove oopsies",
  "release notes: n/a or added/fixed/improved",
  // Raw feed / git chrome that reached summaryEn on release and changelog
  // feeds (site audit): trailers with e-mail addresses, "read more" stubs,
  // and GitHub release-note scaffolding are never an AI summary.
  "co-authored-by:",
  "signed-off-by:",
  "read the full article",
  "what's changed",
  "full changelog",
  "appeared first on",
] as const;

/**
 * Scripts that never belong in Japanese or English editorial text. A
 * translation that slips into Hangul, Cyrillic, Thai, Arabic or Hebrew
 * (observed: 「AI for Science」희귀疾患研究) is a contaminated generation.
 */
const FOREIGN_SCRIPT_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u0400-\u04ff\u0e00-\u0e7f\u0600-\u06ff\u0590-\u05ff]/u;

export function hasForeignScriptContamination(value: string | null | undefined): boolean {
  return FOREIGN_SCRIPT_RE.test(value ?? "");
}

function normalized(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizedTitleEchoCandidate(value: string | null | undefined): string {
  return normalized(value).replace(/^\p{P}+|\p{P}+$/gu, "").trim();
}

export function isDeterministicPendingSummaryText(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  const lower = text.toLowerCase();
  return Boolean(
    text &&
      (
        text.startsWith(PENDING_SUMMARY_JA_PREFIX) ||
        PENDING_SUMMARY_JA_MARKERS.some((marker) => text.includes(marker)) ||
        PENDING_SUMMARY_EN_MARKERS.some((marker) => lower.includes(marker))
      ),
  );
}

export function isContaminatedSummaryText(value: string | null | undefined): boolean {
  const text = normalized(value);
  return Boolean(
    text
      && (CONTAMINATED_SUMMARY_MARKERS.some((marker) => text.includes(marker))
        || hasForeignScriptContamination(text)),
  );
}

export function isBareTitleEcho(
  value: string | null | undefined,
  titles: ReadonlyArray<string | null | undefined>,
): boolean {
  const summary = normalizedTitleEchoCandidate(value);
  return Boolean(
    summary
      && titles.some((title) => normalizedTitleEchoCandidate(title) === summary),
  );
}

export function isUsableSummaryText(
  value: string | null | undefined,
  titles: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const text = (value ?? "").trim();
  return Boolean(
    text &&
      !isDeterministicPendingSummaryText(text) &&
      !isContaminatedSummaryText(text) &&
      !isBareTitleEcho(text, titles),
  );
}

export function hasUsableBilingualSummary(
  input: SummaryQualityInput,
  additionalTitleCandidates: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const titles = [input.title, input.titleJa, input.titleEn, ...additionalTitleCandidates];
  return [input.summaryJa, input.summaryEn].every((summary) =>
    isUsableSummaryText(summary, titles)
  );
}

/**
 * Verbatim-reuse guard.
 *
 * A summary that reproduces the collected excerpt is not a summary: it is text
 * the SOURCE wrote, republished under our byline. worker/src/prompt.ts asks the
 * model not to do it, but a prompt line is not a guard, and until now nothing
 * in this module ever read `contentSnippet` when judging a summary.
 *
 * Two deterministic signals, both measured on data/index.json (1,917 live
 * entries, 2026-08-26):
 *
 * EXACT  - the normalized summary occurs verbatim inside the normalized
 *          excerpt (or swallows the whole excerpt). No false positive is
 *          possible: the entire summary is source text.
 * COVER  - at least VERBATIM_COVERAGE_RATIO of the summary's characters sit
 *          inside runs of >= VERBATIM_SHINGLE_CHARS characters shared with the
 *          excerpt.
 *
 * Combined firings, measured: 159 live entries, all on summaryEn, zero on
 * summaryJa.
 *
 * Why coverage and NOT "longest shared run >= N": one long shared run is not
 * evidence of copying. A >= 40-char shared run flags 249 live summaryEn, and
 * that band is dominated by genuine rewrites reusing a single source phrase
 * ("Google's open-source TPU microbenchmark suite", "generative AI inference
 * recommendations", "project-level language server settings being ignored").
 *
 * VERBATIM_SHINGLE_CHARS = 24 sits above the point where product names
 * dominate: the longest pure product/version run in the corpus is 33 chars
 * ("watsonx orchestrate adk extension"), which covers 0.22 of a 150-char
 * summary and cannot reach the 0.50 ratio on its own. At a 16-char shingle the
 * ratio fires on 2 summaryJa, both legitimate entity-name-heavy rewrites; at 24
 * it fires on 0.
 */
export const VERBATIM_SHINGLE_CHARS = 24;
export const VERBATIM_COVERAGE_RATIO = 0.5;

export type VerbatimReuseField = "summaryJa" | "summaryEn";

export interface VerbatimReuseIssue {
  code: "verbatim-source-reuse";
  field: VerbatimReuseField;
  /** Share of the summary covered by runs shared verbatim with the excerpt. */
  coverage: number;
  /** True when summary and excerpt contain one another outright. */
  exact: boolean;
}

function verbatimCoverage(summary: string, snippet: string): number {
  const chars = [...summary];
  const total = chars.length;
  if (total < VERBATIM_SHINGLE_CHARS) return 0;
  const covered = new Uint8Array(total);
  for (let start = 0; start + VERBATIM_SHINGLE_CHARS <= total; start++) {
    const shingle = chars.slice(start, start + VERBATIM_SHINGLE_CHARS).join("");
    if (snippet.includes(shingle)) {
      covered.fill(1, start, start + VERBATIM_SHINGLE_CHARS);
    }
  }
  let hits = 0;
  for (const flag of covered) hits += flag;
  return hits / total;
}

function verbatimReuseIssue(
  source: SourceGroundingInput,
  value: string | null | undefined,
  field: VerbatimReuseField,
): VerbatimReuseIssue | null {
  const snippet = normalizedSourceText(source.contentSnippet);
  const summary = normalizedSourceText(value);
  // No excerpt means no comparison is possible, so there is no evidence either
  // way and this specific check reports nothing. It does NOT weaken any other
  // guard: a missing snippet is already reported by hasSufficientSourceGrounding
  // and the caller still runs hasUsableBilingualSummary and
  // findSummaryGroundingIssues.
  if (!snippet || !summary) return null;
  const exact = snippet.includes(summary) || summary.includes(snippet);
  const coverage = verbatimCoverage(summary, snippet);
  if (!exact && coverage < VERBATIM_COVERAGE_RATIO) return null;
  return { code: "verbatim-source-reuse", field, coverage, exact };
}

/**
 * Per-field verbatim-reuse findings for a generated summary pair. Empty array
 * means no reuse was detected; each issue carries the measured coverage so the
 * caller can log evidence rather than a bare boolean.
 */
export function findVerbatimSourceReuse(
  source: SourceGroundingInput,
  generated: SummaryQualityInput,
): VerbatimReuseIssue[] {
  return [
    verbatimReuseIssue(source, generated.summaryJa, "summaryJa"),
    verbatimReuseIssue(source, generated.summaryEn, "summaryEn"),
  ].filter((issue): issue is VerbatimReuseIssue => issue !== null);
}

export function hasVerbatimSourceReuse(
  source: SourceGroundingInput,
  generated: SummaryQualityInput,
): boolean {
  return findVerbatimSourceReuse(source, generated).length > 0;
}

export function hasUsableGroundedBilingualSummary(
  source: SourceGroundingInput,
  generated: SummaryQualityInput,
  additionalTitleCandidates: ReadonlyArray<string | null | undefined> = [],
): boolean {
  return (
    hasSufficientSourceGrounding(source) &&
    hasUsableBilingualSummary(generated, additionalTitleCandidates) &&
    findSummaryGroundingIssues(source, generated).length === 0 &&
    findVerbatimSourceReuse(source, generated).length === 0
  );
}

export function needsSummaryGeneration(input: SummaryQualityInput): boolean {
  return (
    !hasUsableBilingualSummary(input) ||
    findSummaryGroundingIssues(input, input).length > 0 ||
    findVerbatimSourceReuse(input, input).length > 0
  );
}

export interface SummaryGroundingSanitization<T extends SummaryQualityInput> {
  entry: T;
  /** A MATERIAL GROUNDING conflict was found. Kept category-pure on purpose. */
  rejected: boolean;
  issues: GroundingIssue[];
  /** Verbatim reuse of the source excerpt. Reported separately from `rejected`. */
  verbatimRejected: boolean;
  verbatimIssues: VerbatimReuseIssue[];
}

export function sanitizeStoredSummaryGrounding<T extends SummaryQualityInput>(
  entry: T,
): SummaryGroundingSanitization<T> {
  if (!hasUsableBilingualSummary(entry)) {
    return {
      entry,
      rejected: false,
      issues: [],
      verbatimRejected: false,
      verbatimIssues: [],
    };
  }
  const issues = findSummaryGroundingIssues(entry, entry);
  const verbatimIssues = findVerbatimSourceReuse(entry, entry);
  if (issues.length === 0 && verbatimIssues.length === 0) {
    return {
      entry,
      rejected: false,
      issues,
      verbatimRejected: false,
      verbatimIssues,
    };
  }

  const titleJaRejected = issues.some((issue) => issue.field === "titleJa");
  const titleEnRejected = issues.some((issue) => issue.field === "titleEn");
  // A material grounding conflict invalidates BOTH summaries: stored text that
  // contradicts the source cannot be trusted in either language. Verbatim reuse
  // is per-field, because in practice only one language is copied (measured:
  // 159 live entries, all summaryEn, zero summaryJa), and blanking a genuine
  // Japanese summary alongside a copied English one would throw away good
  // content and double the regeneration backlog for no evidence.
  const groundingRejected = issues.length > 0;
  const verbatimJa = verbatimIssues.some((issue) => issue.field === "summaryJa");
  const verbatimEn = verbatimIssues.some((issue) => issue.field === "summaryEn");
  return {
    entry: {
      ...entry,
      titleJa: titleJaRejected
        ? entry.lang === "ja"
          ? entry.title ?? ""
          : ""
        : entry.titleJa,
      titleEn: titleEnRejected
        ? entry.lang === "en"
          ? entry.title ?? ""
          : ""
        : entry.titleEn,
      summaryJa: groundingRejected || verbatimJa ? "" : entry.summaryJa,
      summaryEn: groundingRejected || verbatimEn ? "" : entry.summaryEn,
    },
    rejected: groundingRejected,
    issues,
    verbatimRejected: verbatimIssues.length > 0,
    verbatimIssues,
  };
}
