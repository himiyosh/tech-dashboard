export type BoundedDescriptionLanguage = "ja" | "en";

export const SOCIAL_DESCRIPTION_CHARACTER_LIMIT = 160;

interface EntityRange {
  start: number;
  end: number;
}

const SENTENCE_END_PATTERN = /([.!?。！？]+)["'”’」』）)\]】》〉}]*$/u;
const HTML_ENTITY_PATTERN = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/giu;
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
]);
const CLEAR_SENTENCE_STARTERS = new Set([
  "a",
  "an",
  "he",
  "however",
  "it",
  "meanwhile",
  "next",
  "she",
  "that",
  "the",
  "these",
  "they",
  "this",
  "those",
  "we",
]);

const segmenters = {
  ja: {
    grapheme: new Intl.Segmenter("ja", { granularity: "grapheme" }),
    sentence: new Intl.Segmenter("ja", { granularity: "sentence" }),
    word: new Intl.Segmenter("ja", { granularity: "word" }),
  },
  en: {
    grapheme: new Intl.Segmenter("en", { granularity: "grapheme" }),
    sentence: new Intl.Segmenter("en", { granularity: "sentence" }),
    word: new Intl.Segmenter("en", { granularity: "word" }),
  },
} as const;

function unicodeCharacterLength(value: string): number {
  return Array.from(value).length;
}

function entityRanges(value: string): EntityRange[] {
  return [...value.matchAll(HTML_ENTITY_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function splitsEntity(index: number, ranges: readonly EntityRange[]): boolean {
  return ranges.some((range) => range.start < index && index < range.end);
}

function nextWord(value: string, start: number): string {
  return value.slice(start).trimStart().match(/^[\p{L}\p{N}]+/u)?.[0] ?? "";
}

// Intl can expose fragments such as ".NET", "U.S.", and "Dr." as sentences.
// Reject only high-confidence continuation shapes, then let a later real
// terminal include the coalesced prefix.
function isFalsePeriodBoundary(value: string, end: number, segmentText: string): boolean {
  if (end >= value.length) return false;
  const immediateNext = value[end] ?? "";
  if (immediateNext && !/\s/u.test(immediateNext) && /[\p{L}\p{N}]/u.test(immediateNext)) {
    return true;
  }

  const followingWord = nextWord(value, end);
  if (!followingWord) return false;
  const followingLower = followingWord.toLowerCase();
  const followsClearSentenceStarter = CLEAR_SENTENCE_STARTERS.has(followingLower);
  const terminalCore = segmentText.replace(/["'”’」』）)\]】》〉}]+$/u, "");
  const abbreviation = terminalCore.match(/([\p{L}]+)\.$/u)?.[1]?.toLowerCase();
  if (
    abbreviation
    && NON_TERMINAL_ABBREVIATIONS.has(abbreviation)
    && !followsClearSentenceStarter
  ) {
    return true;
  }

  const initialismMatch = terminalCore.match(/(?:\p{L}\.){2,}$/u);
  if (!initialismMatch) return false;
  if (/\p{Ll}/u.test(initialismMatch[0])) return true;
  if (followsClearSentenceStarter) return false;
  if (/^\p{Ll}/u.test(followingWord) || /^\p{Lu}{2,}$/u.test(followingWord)) return true;

  const prefix = terminalCore.slice(0, initialismMatch.index).trim();
  return !prefix || /(?:^|\s)(?:the|an?)$/iu.test(prefix);
}

function longestCompleteSentencePrefix(
  value: string,
  language: BoundedDescriptionLanguage,
  limit: number,
): string {
  let longest = "";
  for (const segment of segmenters[language].sentence.segment(value)) {
    const segmentText = segment.segment.trimEnd();
    const terminalMatch = segmentText.match(SENTENCE_END_PATTERN);
    if (!terminalMatch) continue;
    const end = segment.index + segmentText.length;
    if (terminalMatch[1] === "." && isFalsePeriodBoundary(value, end, segmentText)) {
      continue;
    }
    const candidate = value.slice(0, end);
    if (unicodeCharacterLength(candidate) > limit) break;
    longest = candidate;
  }
  return longest;
}

function graphemeCutoff(
  value: string,
  language: BoundedDescriptionLanguage,
  limit: number,
  ranges: readonly EntityRange[],
): number {
  let used = 0;
  let end = 0;
  for (const segment of segmenters[language].grapheme.segment(value)) {
    const nextUsed = used + unicodeCharacterLength(segment.segment);
    if (nextUsed > limit) break;
    used = nextUsed;
    end = segment.index + segment.segment.length;
  }
  while (end > 0 && splitsEntity(end, ranges)) {
    const containingEntity = ranges.find((range) => range.start < end && end < range.end);
    end = containingEntity?.start ?? 0;
  }
  return end;
}

function wordCutoff(
  value: string,
  language: BoundedDescriptionLanguage,
  maximumEnd: number,
  ranges: readonly EntityRange[],
): number {
  let end = 0;
  for (const segment of segmenters[language].word.segment(value)) {
    const segmentEnd = segment.index + segment.segment.length;
    if (segmentEnd > maximumEnd) {
      if (segment.isWordLike && segment.index < maximumEnd) {
        return end || segment.index;
      }
      break;
    }
    if (segment.isWordLike && !splitsEntity(segmentEnd, ranges)) end = segmentEnd;
  }
  return end || maximumEnd;
}

export function boundedSocialDescription(
  value: string,
  language: BoundedDescriptionLanguage,
  limit = SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
): string {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Description limit must be a positive integer.");
  }

  const text = value.trim();
  if (!text || unicodeCharacterLength(text) <= limit) return text;

  const completePrefix = longestCompleteSentencePrefix(text, language, limit);
  if (completePrefix) return completePrefix;

  if (limit === 1) return "…";
  const ranges = entityRanges(text);
  const maximumEnd = graphemeCutoff(text, language, limit - 1, ranges);
  const preferredEnd = wordCutoff(text, language, maximumEnd, ranges);
  const prefix = text.slice(0, preferredEnd).trimEnd();
  return prefix ? `${prefix}…` : "…";
}
