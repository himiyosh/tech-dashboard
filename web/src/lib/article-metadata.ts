import {
  CATEGORY_META,
  summaryForLangWithFallback,
  titleForLang,
  titleForLangWithFallback,
  type NormalizedEntry,
} from "./data.ts";
import {
  canonicalSourceUrl,
  sourceLabel,
} from "./source-meta.ts";
import {
  localizedArticleMetadataTitle,
  localizedPendingArticleMetadataTitle,
} from "./social-metadata.ts";

export interface ArticleMetadataTitles {
  ja: string;
  en: string;
}

function sourceUrlIdentityLabel(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const raw = segments.at(-1) ?? url.hostname;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  } catch {
    return sourceUrl;
  }
}

function buildArticleMetadataTitles(
  entry: NormalizedEntry,
  identityDiscriminator?: string,
): ArticleMetadataTitles {
  const categoryLabel = CATEGORY_META.find(
    (category) => category.slug === entry.category,
  )?.name ?? "Technology";
  const sourceUrl = canonicalSourceUrl(entry.url);
  const common = {
    sourceLabel: sourceLabel(entry.source, entry.url),
    categoryLabel,
    publishedAt: entry.publishedAt,
    sourceUrl,
    identityDiscriminator,
  };
  const summaryAbsent = !summaryForLangWithFallback(entry, "ja").text
    && !summaryForLangWithFallback(entry, "en").text;
  const titleBuilder = summaryAbsent
    ? localizedPendingArticleMetadataTitle
    : localizedArticleMetadataTitle;

  return {
    ja: titleBuilder({
      ...common,
      title: summaryAbsent
        ? titleForLangWithFallback(entry, "ja").text
        : titleForLang(entry, "ja"),
      lang: "ja",
    }),
    en: titleBuilder({
      ...common,
      title: summaryAbsent
        ? titleForLangWithFallback(entry, "en").text
        : titleForLang(entry, "en"),
      lang: "en",
    }),
  };
}

function duplicateTitleIds(
  records: ReadonlyMap<string, ArticleMetadataTitles>,
): Set<string> {
  const duplicateIds = new Set<string>();
  for (const lang of ["ja", "en"] as const) {
    const idsByTitle = new Map<string, string[]>();
    for (const [id, titles] of records) {
      const ids = idsByTitle.get(titles[lang]) ?? [];
      ids.push(id);
      idsByTitle.set(titles[lang], ids);
    }
    for (const ids of idsByTitle.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) duplicateIds.add(id);
    }
  }
  return duplicateIds;
}

export function buildUniqueArticleMetadataTitleMap(
  entries: readonly NormalizedEntry[],
): ReadonlyMap<string, ArticleMetadataTitles> {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const titlesById = new Map(
    entries.map((entry) => [entry.id, buildArticleMetadataTitles(entry)]),
  );
  const collidingIds = duplicateTitleIds(titlesById);

  for (const id of collidingIds) {
    const entry = entriesById.get(id);
    if (!entry) continue;
    titlesById.set(
      id,
      buildArticleMetadataTitles(
        entry,
        sourceUrlIdentityLabel(canonicalSourceUrl(entry.url)),
      ),
    );
  }

  for (const id of duplicateTitleIds(titlesById)) {
    const entry = entriesById.get(id);
    if (!entry) continue;
    const sourceIdentity = sourceUrlIdentityLabel(canonicalSourceUrl(entry.url));
    titlesById.set(
      id,
      buildArticleMetadataTitles(entry, `[${entry.id}] ${sourceIdentity}`),
    );
  }

  return titlesById;
}
