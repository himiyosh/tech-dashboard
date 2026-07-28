import {
  hasUsableSummaryForLanguage,
  isSyntheticFallbackTitle,
  type SummaryDisplayEntry,
} from "./summary-display.ts";

export interface PublicationEntry extends SummaryDisplayEntry {
  sourceType: "blog" | "release" | "changelog" | "paper" | "community";
  url: string;
}

const MUTABLE_GITHUB_RELEASE_ALIAS_RE =
  /\/releases\/tag\/(?:nightly|canary|snapshot|rolling|extension-(?:workflows|cli)|collab-(?:staging|production|prod))\/?$/i;

export function isDeterministicFallbackEntry(entry: PublicationEntry): boolean {
  return !(
    hasUsableSummaryForLanguage(entry, entry.summaryJa, "ja")
    || hasUsableSummaryForLanguage(entry, entry.summaryEn, "en")
    || hasUsableSummaryForLanguage(entry, entry.summaryJa, "en")
    || hasUsableSummaryForLanguage(entry, entry.summaryEn, "ja")
  );
}

export function isMutableReleaseAliasEntry(
  entry: Pick<PublicationEntry, "sourceType" | "url">,
): boolean {
  if (entry.sourceType !== "release" && entry.sourceType !== "changelog") return false;
  try {
    const parsed = new URL(entry.url);
    return parsed.hostname.toLowerCase() === "github.com"
      && MUTABLE_GITHUB_RELEASE_ALIAS_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Decision-critical slots and public feeds require at least one usable AI summary. */
export function isPublishableEntry(entry: PublicationEntry): boolean {
  return !isMutableReleaseAliasEntry(entry)
    && !isDeterministicFallbackEntry(entry);
}

export function isListableEntry(entry: PublicationEntry): boolean {
  if (isMutableReleaseAliasEntry(entry)) return false;
  if (isPublishableEntry(entry)) return true;
  return (
    (!!(entry.titleEn ?? "").trim()
      && !isSyntheticFallbackTitle(entry, entry.titleEn))
    || (!!(entry.titleJa ?? "").trim()
      && !isSyntheticFallbackTitle(entry, entry.titleJa))
    || (!!(entry.title ?? "").trim()
      && !isSyntheticFallbackTitle(entry, entry.title))
  );
}
