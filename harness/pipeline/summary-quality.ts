export interface SummaryQualityInput {
  summaryJa?: string | null;
  summaryEn?: string | null;
  title?: string | null;
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
  const summary = normalized(value);
  return Boolean(summary && titles.some((title) => normalized(title) === summary));
}

export function hasUsableBilingualSummary(input: SummaryQualityInput): boolean {
  const titles = [input.title, input.titleJa, input.titleEn];
  return [input.summaryJa, input.summaryEn].every((summary) => {
    const value = (summary ?? "").trim();
    return Boolean(
      value &&
        !isDeterministicPendingSummaryText(value) &&
        !isContaminatedSummaryText(value) &&
        !isBareTitleEcho(value, titles),
    );
  });
}

export function needsSummaryGeneration(input: SummaryQualityInput): boolean {
  return !hasUsableBilingualSummary(input);
}
