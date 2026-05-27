import type { RawEntry, SourceDefinition } from "../types.ts";

export type KeywordFilterEntry = Pick<RawEntry, "title" | "url" | "contentSnippet">;

export function matchesKeywordFilter(entry: KeywordFilterEntry, source: SourceDefinition): boolean {
  const haystack = (source.keywordFilterScope === "title"
    ? entry.title
    : `${entry.title} ${entry.contentSnippet ?? ""} ${entry.url}`).toLowerCase();
  if (source.excludeKeywords?.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    return false;
  }
  if (source.includeKeywords && source.includeKeywords.length > 0) {
    return source.includeKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  }
  return true;
}
