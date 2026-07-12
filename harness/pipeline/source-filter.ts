import type { NormalizedEntry, RawEntry, SourceDefinition } from "../types.ts";

export type KeywordFilterEntry = Pick<RawEntry, "title" | "url" | "contentSnippet">;
export type KeywordFilterDecision =
  | { keep: false; reason: "exclude" | "missing-include"; keyword: string | null; trusted: true }
  | {
      keep: true;
      reason: "pass" | "include" | "missing-include-unverified";
      keyword: string | null;
      trusted: boolean;
    };

type KeywordFilterNormalizedEntry = Pick<
  NormalizedEntry,
  "title" | "url" | "contentSnippet" | "titleJa" | "titleEn" | "summaryJa" | "summaryEn"
>;

const ASCII_WORD_RE = /^[\x00-\x7F]+$/;
const ASCII_ALNUM_RE = /[A-Za-z0-9]/;
const ASCII_BOUNDARY_CLASS = "A-Za-z0-9";
const ASCII_SEPARATOR_RE = "[\\s/._:+-]+";
const MUTABLE_GITHUB_RELEASE_ALIAS_RE =
  /\/releases\/tag\/(?:nightly|canary|snapshot|rolling|extension-(?:workflows|cli)|collab-(?:staging|production|prod))\/?$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTokenAwareAsciiKeyword(keyword: string): boolean {
  return ASCII_WORD_RE.test(keyword) && ASCII_ALNUM_RE.test(keyword);
}

function pluralVariants(token: string): string[] {
  const trimmed = token.trim();
  if (!trimmed) return [];
  const variants = new Set([trimmed]);
  if (/s$/i.test(trimmed)) return [...variants];
  if (/[b-df-hj-np-tv-z]y$/i.test(trimmed)) variants.add(`${trimmed.slice(0, -1)}ies`);
  if (/(?:ch|sh|x|z|o)$/i.test(trimmed)) variants.add(`${trimmed}es`);
  variants.add(`${trimmed}s`);
  return [...variants];
}

function allowsNumericFamilySuffix(token: string, allowPluralVariant: boolean): boolean {
  return allowPluralVariant && /^[A-Za-z]{4,}$/.test(token);
}

function compileAsciiTokenPattern(token: string, allowPluralVariant: boolean): string {
  const variants = allowPluralVariant ? pluralVariants(token) : [token];
  const exactVariants = variants.map((variant) => escapeRegExp(variant));
  if (!allowsNumericFamilySuffix(token, allowPluralVariant)) {
    if (exactVariants.length === 1) return exactVariants[0]!;
    return `(?:${exactVariants.join("|")})`;
  }
  const numericFamily = `${escapeRegExp(token)}(?:\\d+(?:[._-]?\\d+)*)?`;
  const parts = [numericFamily, ...exactVariants.filter((variant) => variant !== escapeRegExp(token))];
  return `(?:${parts.join("|")})`;
}

function compileKeywordPattern(keyword: string): RegExp | null {
  const trimmed = keyword.trim();
  if (!trimmed || !isTokenAwareAsciiKeyword(trimmed)) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const body = parts
    .map((part, index) => compileAsciiTokenPattern(part, index === parts.length - 1))
    .join(ASCII_SEPARATOR_RE);
  const prefix = /^[A-Za-z0-9]/.test(trimmed) ? `(^|[^${ASCII_BOUNDARY_CLASS}])` : "";
  const suffix = /[A-Za-z0-9]$/.test(trimmed) ? `(?=$|[^${ASCII_BOUNDARY_CLASS}])` : "";
  return new RegExp(`${prefix}${body}${suffix}`, "i");
}

export function keywordMatchesHaystack(haystack: string, keyword: string): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;
  const pattern = compileKeywordPattern(trimmed);
  if (pattern) return pattern.test(haystack);
  return haystack.toLowerCase().includes(trimmed.toLowerCase());
}

export function keywordHaystack(entry: KeywordFilterEntry, source: SourceDefinition): string {
  return source.keywordFilterScope === "title"
    ? entry.title
    : `${entry.title} ${entry.contentSnippet ?? ""} ${entry.url}`;
}

export function isMutableReleaseAliasUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === "github.com"
      && MUTABLE_GITHUB_RELEASE_ALIAS_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function matchingKeyword(
  haystack: string,
  keywords: readonly string[] | undefined,
): string | null {
  if (!keywords || keywords.length === 0) return null;
  for (const keyword of keywords) {
    if (keywordMatchesHaystack(haystack, keyword)) return keyword;
  }
  return null;
}

export function keywordFilterEntryFromNormalized(entry: KeywordFilterNormalizedEntry): KeywordFilterEntry {
  const contentSnippet = entry.contentSnippet
    ?? [entry.titleJa, entry.titleEn, entry.summaryJa, entry.summaryEn].filter(Boolean).join(" ");
  return {
    title: entry.title,
    url: entry.url,
    ...(contentSnippet ? { contentSnippet } : {}),
  };
}

export function evaluateKeywordFilter(
  entry: KeywordFilterEntry,
  source: SourceDefinition,
  options: { allowLossyMissingInclude?: boolean } = {},
): KeywordFilterDecision {
  if (
    (source.sourceType === "release" || source.sourceType === "changelog")
    && isMutableReleaseAliasUrl(entry.url)
  ) {
    return {
      keep: false,
      reason: "exclude",
      keyword: "mutable-release-alias",
      trusted: true,
    };
  }
  const haystack = keywordHaystack(entry, source);
  const excludeHit = matchingKeyword(haystack, source.excludeKeywords);
  if (excludeHit) {
    return { keep: false, reason: "exclude", keyword: excludeHit, trusted: true };
  }
  if (source.includeKeywords && source.includeKeywords.length > 0) {
    const includeHit = matchingKeyword(haystack, source.includeKeywords);
    if (includeHit) {
      return { keep: true, reason: "include", keyword: includeHit, trusted: true };
    }
    if (options.allowLossyMissingInclude && source.keywordFilterScope !== "title") {
      return {
        keep: true,
        reason: "missing-include-unverified",
        keyword: null,
        trusted: false,
      };
    }
    return { keep: false, reason: "missing-include", keyword: null, trusted: true };
  }
  return { keep: true, reason: "pass", keyword: null, trusted: true };
}

export function matchesKeywordFilter(
  entry: KeywordFilterEntry,
  source: SourceDefinition,
  options?: { allowLossyMissingInclude?: boolean },
): boolean {
  return evaluateKeywordFilter(entry, source, options).keep;
}
