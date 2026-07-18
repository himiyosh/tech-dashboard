import {
  isBareTitleEcho,
  isUsableSummaryText,
} from "./summary-quality.ts";

export interface TitleEnDerivableEntry {
  title?: string | null;
  titleJa?: string | null;
  titleEn?: string | null;
  summaryEn?: string | null;
}

export interface TitleEnFillCounts {
  alreadySet: number;
  missing: number;
  fromSummaryEn: number;
  correctedDerivedTitles: number;
  pendingOrFallback: number;
  totalUpdated: number;
}

function clampTitle(title: unknown): string {
  const line = String(title ?? "").trim().replace(/[.!?]+$/, "").trim();
  if (!line) return "";
  if (line.length <= 80) return line;
  const trimmed = line.slice(0, 80);
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace > 40 ? `${trimmed.slice(0, lastSpace)}…` : `${trimmed}…`;
}

export function extractLegacyTitleFromSummary(summary: unknown): string {
  const line = String(summary ?? "").split("\n")[0]?.trim() ?? "";
  if (!line) return "";
  const sentenceEnd = line.search(/[.!?]/);
  if (sentenceEnd > 10 && sentenceEnd <= 120) {
    return line.slice(0, sentenceEnd).trim();
  }
  return clampTitle(line);
}

function normalizeSummary(summary: unknown): string {
  return String(summary ?? "").replace(/\s+/g, " ").trim();
}

function fallbackSentenceMatch(text: string): string {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!char || !/[.!?]/.test(char)) continue;
    if (char === "!") {
      if (i < text.length - 1 && !/\s/.test(text[i + 1] ?? "")) continue;
      return text.slice(0, i + 1);
    }
    if (char === "?") {
      if (i < text.length - 1 && !/\s/.test(text[i + 1] ?? "")) continue;
      return text.slice(0, i + 1);
    }
    const next = text[i + 1] ?? "";
    if (next && !/\s/.test(next)) continue;
    const nextNonSpace = text.slice(i + 1).trimStart()[0] ?? "";
    if (nextNonSpace && !/["'([{A-Z0-9]/.test(nextNonSpace)) continue;
    return text.slice(0, i + 1);
  }
  return text;
}

export function extractTitleFromSummary(summary: unknown): string {
  const text = normalizeSummary(summary);
  if (!text) return "";
  if (typeof Intl.Segmenter === "function") {
    const segments = new Intl.Segmenter("en", { granularity: "sentence" }).segment(text);
    for (const segment of segments) {
      const rawSegment = segment.segment;
      if (!rawSegment?.trim()) continue;
      const segmentText = rawSegment.replace(/\s+$/, "");
      const terminalMatch = segmentText.match(/[.!?]+$/);
      if (terminalMatch) {
        const punctuationIndex = segment.index + segmentText.length - terminalMatch[0].length;
        const nextChar = text[punctuationIndex + terminalMatch[0].length] ?? "";
        if (nextChar && !/\s/.test(nextChar)) {
          return clampTitle(fallbackSentenceMatch(text));
        }
      }
      const candidate = clampTitle(rawSegment);
      if (candidate) return candidate;
    }
  }
  return clampTitle(fallbackSentenceMatch(text));
}

export function deriveTitleEnFromEntry(entry: TitleEnDerivableEntry): string {
  const summaryEn = (entry.summaryEn ?? "").trim();
  const sourceTitles = [entry.title, entry.titleJa, entry.titleEn];
  if (!isUsableSummaryText(summaryEn, sourceTitles)) return "";

  const derived = extractTitleFromSummary(summaryEn);
  if (
    !derived ||
    isBareTitleEcho(derived, sourceTitles) ||
    isBareTitleEcho(summaryEn, [derived])
  ) {
    return "";
  }
  return derived;
}

export function shouldCorrectLegacyDerivedTitle(entry: TitleEnDerivableEntry): boolean {
  const existing = (entry.titleEn ?? "").trim();
  if (!existing) return false;
  const originalTitle = (entry.title ?? "").trim();
  if (originalTitle && existing === originalTitle) return false;
  const summaryEn = (entry.summaryEn ?? "").trim();
  const derived = deriveTitleEnFromEntry({ ...entry, titleEn: "" });
  if (!derived) return false;
  const legacy = extractLegacyTitleFromSummary(summaryEn);
  return existing === legacy && derived !== legacy;
}

export function fillMissingTitleEnEntries<T extends TitleEnDerivableEntry>(
  entries: readonly T[],
): { entries: T[]; counts: TitleEnFillCounts } {
  let alreadySet = 0;
  let missing = 0;
  let fromSummaryEn = 0;
  let correctedDerivedTitles = 0;
  let pendingOrFallback = 0;

  const nextEntries = entries.map((entry) => {
    const existing = (entry.titleEn ?? "").trim();
    const derived = deriveTitleEnFromEntry(entry);
    if (existing) {
      if (derived && shouldCorrectLegacyDerivedTitle(entry)) {
        correctedDerivedTitles++;
        return { ...entry, titleEn: derived };
      }
      alreadySet++;
      return entry;
    }

    missing++;
    if (!derived) {
      pendingOrFallback++;
      return entry;
    }

    fromSummaryEn++;
    return { ...entry, titleEn: derived };
  });

  return {
    entries: nextEntries,
    counts: {
      alreadySet,
      missing,
      fromSummaryEn,
      correctedDerivedTitles,
      pendingOrFallback,
      totalUpdated: fromSummaryEn + correctedDerivedTitles,
    },
  };
}
