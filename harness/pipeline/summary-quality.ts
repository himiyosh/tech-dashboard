import {
  findSummaryGroundingIssues,
  hasSufficientSourceGrounding,
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
] as const;

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
  return Boolean(text && CONTAMINATED_SUMMARY_MARKERS.some((marker) => text.includes(marker)));
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

export function hasUsableGroundedBilingualSummary(
  source: SourceGroundingInput,
  generated: SummaryQualityInput,
  additionalTitleCandidates: ReadonlyArray<string | null | undefined> = [],
): boolean {
  return (
    hasSufficientSourceGrounding(source) &&
    hasUsableBilingualSummary(generated, additionalTitleCandidates) &&
    findSummaryGroundingIssues(source, generated).length === 0
  );
}

export function needsSummaryGeneration(input: SummaryQualityInput): boolean {
  return (
    !hasUsableBilingualSummary(input) ||
    findSummaryGroundingIssues(input, input).length > 0
  );
}

export interface SummaryGroundingSanitization<T extends SummaryQualityInput> {
  entry: T;
  rejected: boolean;
  issues: GroundingIssue[];
}

export function sanitizeStoredSummaryGrounding<T extends SummaryQualityInput>(
  entry: T,
): SummaryGroundingSanitization<T> {
  if (!hasUsableBilingualSummary(entry)) {
    return { entry, rejected: false, issues: [] };
  }
  const issues = findSummaryGroundingIssues(entry, entry);
  if (issues.length === 0) {
    return { entry, rejected: false, issues };
  }

  const titleJaRejected = issues.some((issue) => issue.field === "titleJa");
  const titleEnRejected = issues.some((issue) => issue.field === "titleEn");
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
      summaryJa: "",
      summaryEn: "",
    },
    rejected: true,
    issues,
  };
}
