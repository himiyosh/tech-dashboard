export interface SummaryDisplayEntry {
  source: string;
  title: string;
  titleJa?: string | null;
  titleEn?: string | null;
  summaryJa?: string | null;
  summaryEn?: string | null;
}

export interface TitleLanguageEntry {
  title?: string | null;
  lang?: "ja" | "en" | null;
}

export interface SummaryDisplayResult {
  text: string;
  isFallback: boolean;
  fallbackLang?: "ja" | "en";
}

const FALLBACK_SUMMARY_JA_PREFIX = "\u3053\u306e\u30a8\u30f3\u30c8\u30ea\u306f ";
const FALLBACK_SUMMARY_EN_NEEDLE = "AI summary not yet available";
const FALLBACK_SUMMARY_JA_NEEDLES = [
  "AI \u8981\u7d04\u672a\u751f\u6210",
  "\u5f8c\u7d9a\u306e Worker run",
  "\u8981\u7d04\u304c\u672a\u751f\u6210",
] as const;
const FALLBACK_SUMMARY_EN_NEEDLES = [
  FALLBACK_SUMMARY_EN_NEEDLE,
  "AI summary pending",
  "summary is pending",
] as const;

// Keep these pure patterns synchronized with
// harness/pipeline/summary-quality.ts. The web package must remain build-time
// self-contained and cannot import repo-root runtime code (R-005).
const CONTAMINATED_SUMMARY_MARKERS = [
  "left some junk in the readme",
  "forgot to remove oopsies",
  "release notes: n/a or added/fixed/improved",
] as const;

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
const LATIN_RE = /\p{Script=Latin}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;

function isContaminatedSummaryText(text: string | undefined | null): boolean {
  const value = (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(value && CONTAMINATED_SUMMARY_MARKERS.some((marker) => value.includes(marker)));
}

export function isPendingSummaryText(text: string | undefined | null): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return (
    value.startsWith(FALLBACK_SUMMARY_JA_PREFIX) ||
    FALLBACK_SUMMARY_JA_NEEDLES.some((needle) => value.includes(needle)) ||
    FALLBACK_SUMMARY_EN_NEEDLES.some((needle) => value.toLowerCase().includes(needle.toLowerCase()))
  );
}

export function isSyntheticFallbackTitle(
  entry: SummaryDisplayEntry,
  text: string | undefined | null,
): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return value.includes(`(${entry.source})`) &&
    /\u95a2\u9023\u30a2\u30c3\u30d7\u30c7\u30fc\u30c8|related update/i.test(value);
}

export function isSummaryNoise(
  entry: SummaryDisplayEntry,
  text: string | undefined | null,
): boolean {
  const value = (text ?? "").trim();
  if (!value) return true;
  if (isPendingSummaryText(value)) return true;
  const lower = value.toLowerCase();
  if (/\bappeared first on\b/i.test(value)) return true;
  if (isContaminatedSummaryText(value)) return true;
  if ([entry.title, entry.titleEn, entry.titleJa].some(
    (title) => !!title && title.trim().toLowerCase() === lower,
  )) return true;
  if (/^v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/i.test(value)) return true;
  if (/^@?[a-z0-9][a-z0-9._/-]*@v?\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/i.test(value)) {
    return true;
  }
  return /^[a-z][a-z0-9._/-]*(?:\s+[a-z][a-z0-9._/-]*){0,3}\s+v\d+(?:\.\d+){1,3}(?:[-+][a-z0-9.-]+)?$/i.test(value);
}

export function hasCjk(value: string | undefined | null): boolean {
  return !!value && CJK_RE.test(value);
}

export function isCjkDominantText(value: string): boolean {
  let cjk = 0;
  let latin = 0;
  for (const character of value) {
    if (CJK_RE.test(character)) cjk += 1;
    else if (LATIN_RE.test(character)) latin += 1;
  }
  if (cjk === 0) return false;
  if (latin === 0) return true;
  const latinWords =
    value.match(/\p{Script=Latin}[\p{Script=Latin}\p{Number}._/-]*/gu)?.length ?? 0;
  const hasKana = /[\u3040-\u30ff\uff66-\uff9f]/.test(value);
  return cjk * 3 >= latin || (hasKana && cjk >= latinWords * 2);
}

export function effectiveTitleLanguage(entry: TitleLanguageEntry): "ja" | "en" {
  const title = entry.title?.trim() ?? "";
  if (title && isCjkDominantText(title)) return "ja";
  if (title && !hasCjk(title)) return "en";
  return entry.lang === "ja" ? "ja" : "en";
}

export function hasUsableSummaryForLanguage(
  entry: SummaryDisplayEntry,
  value: string | null | undefined,
  lang: "ja" | "en",
): boolean {
  const text = value?.trim() ?? "";
  if (
    isSummaryNoise(entry, text) ||
    isSyntheticFallbackTitle(entry, text) ||
    HANGUL_RE.test(text)
  ) {
    return false;
  }
  return lang === "ja" ? isCjkDominantText(text) : !isCjkDominantText(text);
}

export function summaryForLang(
  entry: SummaryDisplayEntry,
  lang: "ja" | "en",
): string {
  const candidates = lang === "ja"
    ? [entry.summaryJa, entry.summaryEn]
    : [entry.summaryEn, entry.summaryJa];
  for (const value of candidates) {
    const text = value?.trim() ?? "";
    if (hasUsableSummaryForLanguage(entry, text, lang)) return text;
  }
  return "";
}

export function summaryForLangWithFallback(
  entry: SummaryDisplayEntry,
  lang: "ja" | "en",
): SummaryDisplayResult {
  const primary = summaryForLang(entry, lang);
  if (primary) return { text: primary, isFallback: false };

  const other: "ja" | "en" = lang === "ja" ? "en" : "ja";
  const fallback = summaryForLang(entry, other);
  if (fallback) return { text: fallback, isFallback: true, fallbackLang: other };
  return { text: "", isFallback: false };
}
