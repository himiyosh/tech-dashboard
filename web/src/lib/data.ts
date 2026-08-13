/**
 * Data loader — imports data/index.json at build time and re-exports typed.
 * Astro's static output inlines this, so no runtime fetch is needed.
 */
// Path: web/src/lib/data.ts → tech-dashboard/data/index.json (3 levels up)
import indexJson from "../../../data/index.json";
import {
  effectiveTitleLanguage,
  hasCjk,
  hasUsableSummaryForLanguage,
  isCjkDominantText,
  isPendingSummaryText,
  isSummaryNoise,
  isSyntheticFallbackTitle,
  summaryForLang,
  summaryForLangWithFallback,
} from "./summary-display.ts";
import {
  CATEGORIES_BY_NAME,
  CATEGORIES_BY_SHORT_LABEL,
  CATEGORY_META,
  categoryLabel,
  type Category,
  type CategoryGroup,
  type CategoryMeta,
} from "./category-meta.ts";
import {
  filterCategoryListingEntries,
  filterArxivEntries,
  isArxivEntry,
  isCategoryListingEntry,
  isResearchListingEntry,
} from "./research-lane.ts";
import {
  isDeterministicFallbackEntry,
  isListableEntry,
  isMutableReleaseAliasEntry,
  isPublishableEntry,
} from "./entry-publication.ts";
import { isKnowledgeEligibleEntry } from "./knowledge-eligibility.ts";
import { sourceAuthority } from "./source-meta.ts";
import { normalizeTagKey } from "./tag-normalize.ts";
import { TAG_PAGE_MIN_ENTRIES } from "./route-inventory.ts";

export {
  effectiveTitleLanguage,
  hasCjk,
  hasUsableSummaryForLanguage,
  isCjkDominantText,
  isPendingSummaryText,
  isSummaryNoise,
  isSyntheticFallbackTitle,
  summaryForLang,
  summaryForLangWithFallback,
};
export { relativeTime } from "./relative-time.ts";
export { TAG_PAGE_MIN_ENTRIES } from "./route-inventory.ts";
export {
  CATEGORIES_BY_NAME,
  CATEGORIES_BY_SHORT_LABEL,
  CATEGORY_META,
  categoryLabel,
};
export { isArxivEntry, isResearchListingEntry };
export {
  isDeterministicFallbackEntry,
  isListableEntry,
  isMutableReleaseAliasEntry,
  isPublishableEntry,
};
export type { Category, CategoryGroup, CategoryMeta };

export interface NormalizedEntry {
  id: string;
  source: string;
  sourceType: "blog" | "release" | "changelog" | "paper" | "community";
  url: string;
  title: string;
  titleJa: string;
  titleEn: string;
  summaryJa: string;
  summaryEn: string;
  /** Raw feed/article excerpt retained as source context, not an AI summary. */
  contentSnippet?: string;
  /** Long-form article body in Japanese (optional, populated by worker). */
  bodyJa?: string;
  /** Long-form article body in English (optional, populated by worker). */
  bodyEn?: string;
  lang: "ja" | "en";
  publishedAt: string;
  collectedAt: string;
  tags: string[];
  category: Category;
  importance: 1 | 2 | 3;
  clusterId?: string;
  /** Archive classification (added Phase B, optional during rollout). */
  archiveTier?: "hot" | "warm" | "cold" | "dropped";
  halfLife?: "news" | "tutorial" | "architecture" | "fundamental";
  evergreen?: boolean;
  knowledgeEligible?: boolean;
  image?: {
    src: string;
    origSrc: string;
    alt: string;
    width: number;
    height: number;
    source: "media" | "og" | "fallback";
  };
}

export type ImportanceTone = "high" | "medium" | "normal";

export interface ImportanceLabel {
  tone: ImportanceTone;
  ja: string;
  en: string;
}

const IMPORTANCE_LABELS: Record<NormalizedEntry["importance"], ImportanceLabel> = {
  3: { tone: "high", ja: "重要度 High", en: "High priority" },
  2: { tone: "medium", ja: "重要度 Medium", en: "Medium priority" },
  1: { tone: "normal", ja: "重要度 Info", en: "Informational" },
};

export function importanceLabel(level: NormalizedEntry["importance"]): ImportanceLabel {
  return IMPORTANCE_LABELS[level];
}

export interface WorkerHealth {
  lastRunAt: string;
  batchIndex: number;
  batchTotal: number;
  sourcesAttempted: number;
  sourcesOk: number;
  sourcesFailed: string[];
  summarized: number;
  summarizeErrors: number;
  copilotOk: boolean;
  copilotError: string | null;
  ogCached: number;
  ogNewHits: number;
  summaryFallbacks?: number;
  bodyFallbacks?: number;
  fallbackTotal?: number;
  fallbackPercent?: number;
  queueMode?: string;
  queueCap?: number;
  enqueueCandidates?: number;
  summaryQueueSnapshotStage?: string;
  summaryQueueBacklog?: number;
  summaryQueueEnqueued?: number;
  summaryQueueDrainEstimateHours?: number;
  summaryQueueStartIndex?: number;
  summaryQueueCooldownCount?: number;
  kvLookupCap?: number;
  kvLookupCount?: number;
  bodyQueueMode?: string;
  bodyBacklog?: number;
  bodyEnqueueCandidates?: number;
  bodyEnqueueCap?: number;
  bodyEnqueued?: number;
  bodyLookupCount?: number;
  bodyMerged?: number;
  bodyPruned?: number;
  bodyQueueDrainEstimateHours?: number;
  /** Legacy artifact key retained while older Publisher snapshots age out. */
  bodyDrainEstimateHours?: number;
  bodyMergePendingIds?: string[];
  enrichmentEnqueueCap?: number;
  enrichmentEnqueued?: number;
  enrichmentRemaining?: number;
}

interface IndexPayload {
  generatedAt: string;
  count: number;
  health?: WorkerHealth;
  entries: NormalizedEntry[];
}

const data = indexJson as IndexPayload;

function sameTitleValue(left: string, right: string): boolean {
  return left.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase() ===
    right.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export const RAW_ENTRIES: readonly NormalizedEntry[] = data.entries;
/** Entries with a real, generated AI summary (decision-critical slots, feeds). */
export const PUBLISHABLE_ENTRIES: readonly NormalizedEntry[] = RAW_ENTRIES.filter(isPublishableEntry);
/** Entries still waiting for an AI summary (rendered with a pending state). */
export const PENDING_SUMMARY_ENTRIES: readonly NormalizedEntry[] = RAW_ENTRIES.filter(
  (entry) => !isMutableReleaseAliasEntry(entry) && !isPublishableEntry(entry),
);
/**
 * Everything shown in listings (Timeline / category / tag / archive). Includes
 * pending-summary entries with a real title so newly collected articles are
 * visible immediately instead of hidden behind the async summary gate (LL-087).
 */
export const ALL_ENTRIES: readonly NormalizedEntry[] = RAW_ENTRIES.filter(isListableEntry);
export const GENERATED_AT = data.generatedAt;
export const WORKER_HEALTH: WorkerHealth | null = data.health ?? null;


const TAG_ENTRIES_BY_NAME = new Map<string, NormalizedEntry[]>();
const ENTRY_BY_ID = new Map<string, NormalizedEntry>();
const ENTRY_ORDER_BY_ID = new Map<string, number>();
const SOURCE_ENTRIES_BY_ID = new Map<string, NormalizedEntry[]>();
for (const entry of ALL_ENTRIES) {
  ENTRY_BY_ID.set(entry.id, entry);
  ENTRY_ORDER_BY_ID.set(entry.id, ENTRY_ORDER_BY_ID.size);
  const sourceEntries = SOURCE_ENTRIES_BY_ID.get(entry.source);
  if (sourceEntries) sourceEntries.push(entry);
  else SOURCE_ENTRIES_BY_ID.set(entry.source, [entry]);
  for (const tag of new Set(entry.tags.map(normalizeTagKey).filter(Boolean))) {
    const matches = TAG_ENTRIES_BY_NAME.get(tag);
    if (matches) matches.push(entry);
    else TAG_ENTRIES_BY_NAME.set(tag, [entry]);
  }
}

export const STATIC_TAG_PAGE_TAGS: readonly string[] = [...TAG_ENTRIES_BY_NAME.entries()]
  .filter(([, entries]) => entries.length >= TAG_PAGE_MIN_ENTRIES)
  .map(([tag]) => tag)
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

export const SINGLETON_TAG_ENTRY_IDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    [...TAG_ENTRIES_BY_NAME.entries()]
      .filter(([, entries]) => entries.length === 1)
      .map(([tag, entries]) => [tag, entries[0]!.id]),
  ),
);

export function tagEntryCount(tag: string): number {
  return TAG_ENTRIES_BY_NAME.get(normalizeTagKey(tag))?.length ?? 0;
}

export function entriesForTagPage(tag: string): readonly NormalizedEntry[] {
  return TAG_ENTRIES_BY_NAME.get(normalizeTagKey(tag)) ?? [];
}

export function tagHrefForCount(tag: string, count: number, entryId?: string): string {
  const normalizedTag = normalizeTagKey(tag);
  const encodedTag = encodeURIComponent(normalizedTag);
  const recoveryEntryId = entryId ?? (
    count === 1 ? SINGLETON_TAG_ENTRY_IDS[normalizedTag] : undefined
  );
  const directEntry = recoveryEntryId && /^[a-f0-9]{16}$/i.test(recoveryEntryId)
    ? `&entry=${encodeURIComponent(recoveryEntryId.toLowerCase())}`
    : "";
  return count >= TAG_PAGE_MIN_ENTRIES
    ? `/t/${encodedTag}`
    : `/search?q=${encodedTag}&tag=${encodedTag}${directEntry}`;
}

export function tagHref(tag: string, entryId?: string): string {
  return tagHrefForCount(tag, tagEntryCount(tag), entryId);
}

/**
 * Low-signal release builds: nightly snapshots, pre-releases, release
 * candidates, betas/alphas, and internal staging builds. These are dev
 * artifacts, not notable updates, yet the collector over-scores release feeds
 * (any "vN." match) to importance 3 (see harness/pipeline/normalize.ts). A
 * fast-releasing source (e.g. Zed nightly/-pre) would otherwise dominate the
 * Featured hero and Top-3 decision slots.
 *
 * Detected from the title so the web layer stays robust to imperfect stored
 * importance, even before a corrected collector is redeployed (LL-083 style:
 * fix the display, don't depend on the data being perfect).
 */
const LOW_SIGNAL_RELEASE_RE =
  /\b(?:nightly|canary|snapshot)\b|\bcollab-(?:staging|production|prod)\b|[-_.](?:pre|preview|rc|alpha|beta)\d*\b|\(#\d+\)\s*$/i;

export function isLowSignalRelease(
  entry: Pick<NormalizedEntry, "sourceType" | "title" | "titleEn" | "titleJa"> & {
    url?: string;
  },
): boolean {
  if (entry.sourceType !== "release" && entry.sourceType !== "changelog") return false;
  // Test each title independently so the trailing "(#1234)" PR-ref anchor works
  // (joining titles with spaces would break the end-of-string match).
  return [entry.title, entry.titleEn, entry.titleJa].some(
    (t) => {
      if (!t) return false;
      const restored = restorePrereleaseQualifierFromUrl(t, entry.url ?? "");
      return LOW_SIGNAL_RELEASE_RE.test(restored);
    },
  );
}

/**
 * Consumer gaming / entertainment-hardware noise that broad tech-news feeds
 * (the-verge, nvidia GeForce NOW, etc.) emit. These are legitimately "tech
 * news" so they stay in the Timeline, but they must never occupy the single
 * most prominent decision slots (Featured hero + Today's Top 3) on an AI/dev
 * dashboard, even when the collector stamped importance 3 (e.g. "GTA VI is a
 * worrying sign for the future of physical games").
 *
 * Title-scoped only (LL-081: url/summary substring matches cause false
 * positives) and intentionally tight: it targets named consoles/titles and
 * gaming-hardware compounds, never the bare words "game"/"gaming" (which would
 * wrongly catch "Changing the Game", "Game Generation" research, etc.). This
 * is hero/Top-3 editorial curation in the web layer, robust to imperfect
 * stored importance without a collector redeploy (LL-090 style).
 */
const OFF_TOPIC_HERO_RE =
  /\b(?:gta|grand theft auto|playstation|ps5|ps6|xbox|nintendo|switch\s*2|fortnite|call of duty|bungie|destiny\s*2|steam\s*(?:machine|deck)|cloud gaming|geforce now|gaming\s*(?:monitor|laptop|handheld|pc|rig|chair|mouse|keyboard|headset)|qd-?oled|handheld console|game console)\b/i;

export function isOffTopicForHero(
  entry: Pick<NormalizedEntry, "title" | "titleEn" | "titleJa">,
): boolean {
  return [entry.title, entry.titleEn, entry.titleJa].some(
    (t) => !!t && OFF_TOPIC_HERO_RE.test(t),
  );
}

export const ARXIV_ENTRIES: readonly NormalizedEntry[] = filterArxivEntries(ALL_ENTRIES);
export const ARXIV_FEED_ENTRIES: readonly NormalizedEntry[] = filterArxivEntries(
  PUBLISHABLE_ENTRIES,
);
export const RESEARCH_ENTRIES: readonly NormalizedEntry[] = filterCategoryListingEntries(
  ALL_ENTRIES,
  "research",
);
export const MAIN_TIMELINE_ENTRIES: readonly NormalizedEntry[] = ALL_ENTRIES.filter((entry) => !isArxivEntry(entry));

const CATEGORY_ENTRIES_BY_SLUG = new Map<Category, NormalizedEntry[]>();
for (const entry of ALL_ENTRIES) {
  if (!isCategoryListingEntry(entry, entry.category)) continue;
  const entries = CATEGORY_ENTRIES_BY_SLUG.get(entry.category);
  if (entries) entries.push(entry);
  else CATEGORY_ENTRIES_BY_SLUG.set(entry.category, [entry]);
}
const CATEGORY_POSITION_BY_ID = new Map<string, number>();
for (const entries of CATEGORY_ENTRIES_BY_SLUG.values()) {
  entries.forEach((entry, index) => CATEGORY_POSITION_BY_ID.set(entry.id, index));
}
const ARXIV_POSITION_BY_ID = new Map(
  ARXIV_ENTRIES.map((entry, index) => [entry.id, index] as const),
);

/**
 * Evergreen knowledge / best-practice entries (R-022). Source-level evergreen
 * marks the candidate pool; the shared raw title/snippet contract removes
 * announcement-only items before they reach this durable lane. Newest first.
 *
 * Unlike the news Timeline, the Knowledge lane stays publishable-only: it is a
 * curated lane whose cards rely on a real bilingual summary (uniform card
 * layout, LL-096) and whose value is the digested insight, not breaking news.
 * Evergreen entries get summary-queue priority (LL-098) so they surface quickly
 * after collection; until then they simply aren't listed here (the news
 * Timeline is where freshly collected, not-yet-summarized items show up).
 */
export const KNOWLEDGE_ENTRIES: readonly NormalizedEntry[] = PUBLISHABLE_ENTRIES.filter(
  isKnowledgeEligibleEntry,
);

/** Knowledge entries grouped by source, each group newest-first, groups by size desc. */
export function knowledgeBySource(): Array<{ source: string; items: NormalizedEntry[] }> {
  const bySource = new Map<string, NormalizedEntry[]>();
  for (const entry of KNOWLEDGE_ENTRIES) {
    const arr = bySource.get(entry.source) ?? [];
    arr.push(entry);
    bySource.set(entry.source, arr);
  }
  return [...bySource.entries()]
    .map(([source, items]) => ({
      source,
      items: [...items].sort(
        (a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""),
      ),
    }))
    .sort((a, b) => b.items.length - a.items.length);
}


/** Items per page on timeline / category / tag pages. */
export const PAGE_SIZE = 30;

export function countByCategory(): Record<Category, number> {
  const counts = Object.fromEntries(
    CATEGORY_META.map((c) => [c.slug, 0] as const),
  ) as Record<Category, number>;
  for (const e of ALL_ENTRIES) {
    if (!isCategoryListingEntry(e, e.category)) continue;
    if (e.category in counts) counts[e.category]++;
  }
  return counts;
}

/**
 * Sparkline buckets: last 7 days' entry counts (oldest→newest).
 * Used by the sidebar indicator bars (mockup-D/-F §3.2.1).
 */
export function sparkline(category: Category): number[] {
  const buckets = new Array(7).fill(0) as number[];
  const now = Date.now();
  const DAY = 86_400_000;
  for (const e of entriesFor(category)) {
    const age = now - new Date(e.publishedAt).getTime();
    if (age < 0) continue;
    const idx = Math.floor(age / DAY);
    if (idx >= 0 && idx < 7) {
      const slot = 6 - idx; // oldest → index 0
      const current = buckets[slot] ?? 0;
      buckets[slot] = current + 1;
    }
  }
  return buckets;
}

export function sparklineHeights(category: Category): number[] {
  const b = sparkline(category);
  const max = Math.max(1, ...b);
  return b.map((v) => Math.round((v / max) * 100));
}

/** Entries filtered by category, newest first. */
export function entriesFor(category: Category): NormalizedEntry[] {
  return [...(CATEGORY_ENTRIES_BY_SLUG.get(category) ?? [])];
}

/** Newest N entries across all categories. */
export function latest(n: number): NormalizedEntry[] {
  return MAIN_TIMELINE_ENTRIES.slice(0, n);
}

/**
 * The Featured hero. Prefer a genuinely notable update over a routine version
 * bump: real announcements/blogs (importance 3, non-release) first, then stable
 * releases. Low-signal builds (nightly/pre/rc/beta/staging) are never eligible,
 * so a fast-releasing source cannot dominate the hero (see isLowSignalRelease).
 */
export function featured(): NormalizedEntry | undefined {
  const isRoutineRelease = (e: NormalizedEntry) =>
    e.sourceType === "release" || e.sourceType === "changelog";
  const eligible = (e: NormalizedEntry) =>
    isPublishableEntry(e) && !isLowSignalRelease(e) && !isOffTopicForHero(e);
  return (
    // 1. High-importance real announcement/blog with a real summary.
    MAIN_TIMELINE_ENTRIES.find(
      (e) => e.importance === 3 && !isRoutineRelease(e) && eligible(e),
    ) ??
    // 2. High-importance stable release with a real summary.
    MAIN_TIMELINE_ENTRIES.find((e) => e.importance === 3 && eligible(e)) ??
    // 3. Medium-importance announcement/blog with a real summary.
    MAIN_TIMELINE_ENTRIES.find(
      (e) => e.importance === 2 && !isRoutineRelease(e) && eligible(e),
    ) ??
    MAIN_TIMELINE_ENTRIES.find((e) => e.importance === 2 && eligible(e))
  );
}

/** Top tags from the most recent 200 entries. */
export function trendingTags(
  n = 10,
  opts: { exclude?: ReadonlySet<string> } = {},
): Array<{ tag: string; count: number }> {
  const recent = ALL_ENTRIES.slice(0, 200);
  const counts = new Map<string, number>();
  for (const e of recent) {
    for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const exclude = opts.exclude;
  return [...counts.entries()]
    .filter(([tag]) => !exclude?.has(tag.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag, count]) => ({ tag, count }));
}

export const RECENT_COLLECTION_WINDOW_HOURS = 6;
export const RECENT_COLLECTION_BADGE = {
  ja: "新規収集",
  en: "INDEXED",
} as const;

/** Whether the entry was added to this dashboard within the recent collection window. */
export function isRecentlyCollected(e: NormalizedEntry, now = Date.now()): boolean {
  return now - new Date(e.collectedAt).getTime()
    < RECENT_COLLECTION_WINDOW_HOURS * 60 * 60_000;
}

/**
 * Some source feeds derive the title from the URL slug, which strips
 * dots (e.g. "claude-opus-4-7" → "Claude Opus 4 7"). If the URL
 * preserves the original digit-dot-digit pattern with hyphens, restore
 * the dots so version numbers render correctly.
 */
export function restoreDotsFromUrl(title: string, url: string): string {
  if (!title || !url) return title;
  try {
    const path = new URL(url).pathname;
    // Match sequences like "4-7" or "4-7-1" in the URL.
    const matches = [...path.matchAll(/\d+(?:-\d+){1,}/g)];
    if (matches.length === 0) return title;
    let out = title;
    for (const match of matches) {
      const m = match[0];
      const matchEnd = (match.index ?? 0) + m.length;
      // A trailing letter denotes a size or unit token such as "4-12b",
      // not a dotted version number.
      if (/[A-Za-z]/.test(path[matchEnd] ?? "")) continue;

      const spaced = m.replace(/-/g, " ");
      const dotted = m.replace(/-/g, ".");
      // Keep an optional v-prefix, but do not rewrite alphanumeric suffixes
      // such as the B in "Gemma 4 12B".
      const re = new RegExp(
        `(^|[^A-Za-z0-9.])(v?)${spaced.replace(/\s/g, "\\s")}(?=$|[^A-Za-z0-9.])`,
        "i",
      );
      out = out.replace(re, (_, pre, prefix) => `${pre}${prefix}${dotted}`);
    }
    return out;
  } catch {
    return title;
  }
}

/**
 * Restore a prerelease qualifier that was dropped from a localized title.
 * The title must already contain the same base version exposed by the URL.
 */
export function restorePrereleaseQualifierFromUrl(title: string, url: string): string {
  if (!title || !url) return title;

  let decodedUrl = url;
  try {
    decodedUrl = decodeURIComponent(url);
  } catch {
    // Keep the original URL when a malformed escape sequence is present.
  }

  const candidate = decodedUrl.match(
    /\bv?(\d+(?:\.\d+){1,3})((?:[-._])(?:rc|alpha|beta|pre|preview)(?:[.-]?\d+)?)\b/i,
  );
  if (!candidate) return title;

  const [, baseVersion, qualifierSuffix] = candidate;
  const escapedBase = baseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualifiedVersion = new RegExp(
    `\\bv?${escapedBase}[-._](?:rc|alpha|beta|pre|preview)(?:[.-]?\\d+)?\\b`,
    "i",
  );
  if (qualifiedVersion.test(title)) return title;

  const baseInTitle = new RegExp(
    `(^|[^A-Za-z0-9.])(v?${escapedBase})(?=$|[^A-Za-z0-9.])`,
    "i",
  );
  if (!baseInTitle.test(title)) return title;

  return title.replace(
    baseInTitle,
    (_, boundary, version) => `${boundary}${version}${qualifierSuffix}`,
  );
}

export function titleForLang(
  e: NormalizedEntry,
  lang: "ja" | "en",
): string {
  const jaRaw = (e.titleJa ?? "").trim();
  const enRaw = (e.titleEn ?? "").trim();
  const titleRaw = (e.title ?? "").trim();
  const url = (e.url ?? "").trim();

  // Recover version punctuation and prerelease qualifiers lost during title
  // localization or slug-to-title conversion.
  const restoreVersion = (value: string) =>
    restorePrereleaseQualifierFromUrl(restoreDotsFromUrl(value, url), url);
  const ja = restoreVersion(jaRaw);
  const en = restoreVersion(enRaw);
  const title = restoreVersion(titleRaw);
  // Collection metadata remains authoritative for genuinely mixed titles, but
  // an unmistakably Japanese raw title must not be mislabeled as English when
  // a source feed reports the wrong language.
  const sourceLang = effectiveTitleLanguage(e);

  if (lang === "ja") {
    const copiedEnglishSource =
      sourceLang === "en" &&
      ja &&
      title &&
      sameTitleValue(ja, title);
    const lacksJapaneseEvidence = sourceLang === "en" && ja && !hasCjk(ja);
    if (
      ja &&
      !copiedEnglishSource &&
      !lacksJapaneseEvidence &&
      !isSyntheticFallbackTitle(e, ja)
    ) return ja;
    if (title && sourceLang === "ja" && !isSyntheticFallbackTitle(e, title)) return title;
    return "";
  }
  if (lang === "en") {
    const copiedJapaneseSource =
      sourceLang === "ja" &&
      en &&
      ((title && sameTitleValue(en, title)) || (ja && sameTitleValue(en, ja)));
    if (en && !copiedJapaneseSource && !isCjkDominantText(en) && !isSyntheticFallbackTitle(e, en)) return en;
    if (title && sourceLang === "en" && !isSyntheticFallbackTitle(e, title)) return title;
    return "";
  }
  // Defensive fallback for any future lang values.
  return "";
}

/**
 * Like titleForLang but returns the original-language title as a
 * last-resort fallback when the requested language is empty. Callers
 * should visually flag such fallbacks (e.g. `JA` badge), mirroring the
 * pattern used by summaryForLangWithFallback.
 *
 * Guarantees a non-empty string when the entry has ANY title-like
 * content, which is always true for normalized entries (collectors
 * never publish an entry with an empty `title`).
 */
export function titleForLangWithFallback(
  e: NormalizedEntry,
  lang: "ja" | "en",
): { text: string; isFallback: boolean; fallbackLang?: "ja" | "en" } {
  const primary = titleForLang(e, lang);
  if (primary) return { text: primary, isFallback: false };
  const other: "ja" | "en" = lang === "en" ? "ja" : "en";
  const fallback = titleForLang(e, other);
  if (fallback) return { text: fallback, isFallback: true, fallbackLang: other };
  // Absolute last resort: preserve the raw title's actual language provenance.
  const raw = (e.title ?? e.titleJa ?? e.titleEn ?? "").trim();
  const rawLang = effectiveTitleLanguage(e);
  return { text: raw, isFallback: rawLang !== lang, fallbackLang: rawLang };
}

/** YYYY-MM-DD in JST for grouping timelines by day. */
export function jstDateKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Label like "TODAY" / "YESTERDAY" / "Apr 17 (Sat)" for day-header UI. */
export function jstDayLabel(key: string, now = new Date()): string {
  const today = jstDateKey(now.toISOString());
  const yesterday = jstDateKey(
    new Date(now.getTime() - 86_400_000).toISOString(),
  );
  if (key === today) return "TODAY";
  if (key === yesterday) return "YESTERDAY";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${key}T00:00:00+09:00`));
}

/** Group entries by JST day key, newest first. */
export function groupByDay(
  entries: readonly NormalizedEntry[],
): Array<{ key: string; items: NormalizedEntry[] }> {
  const map = new Map<string, NormalizedEntry[]>();
  for (const e of entries) {
    const k = jstDateKey(e.publishedAt);
    const arr = map.get(k) ?? [];
    arr.push(e);
    map.set(k, arr);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([key, items]) => ({ key, items }));
}

export interface TickerDaySelection {
  dayKey: string | null;
  dayScope: "today" | "latest";
  entries: NormalizedEntry[];
}

function tickerTypeWeight(sourceType: NormalizedEntry["sourceType"]): number {
  if (sourceType === "release" || sourceType === "changelog") return 2;
  if (sourceType === "paper") return 1;
  return 0;
}

function tickerAuthorityWeight(entry: Pick<NormalizedEntry, "source" | "sourceType">): number {
  switch (sourceAuthority(entry.source, entry.sourceType).kind) {
    case "official":
      return 4;
    case "paper":
      return 3;
    case "news":
      return 2;
    case "source":
      return 1;
    case "community":
      return 0;
    case "aggregator":
      return -1;
  }
}

export function tickerSourcePlatformKey(
  entry: Pick<NormalizedEntry, "source" | "url">,
): string {
  try {
    return new URL(entry.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return entry.source;
  }
}

/**
 * Rank a ticker day, then cap repeated source streams and host platforms.
 * The ticker is a highlight surface; the full Timeline remains the complete list.
 */
export function selectTickerItems(
  entries: readonly NormalizedEntry[],
  limit = 24,
  maxPerSource = 2,
  maxPerPlatform = 2,
): NormalizedEntry[] {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];

  const sourceCap = Math.max(1, Math.floor(maxPerSource));
  const platformCap = Math.max(1, Math.floor(maxPerPlatform));
  const sourceCounts = new Map<string, number>();
  const platformCounts = new Map<string, number>();
  const selected: NormalizedEntry[] = [];
  const ranked = entries.filter(isPublishableEntry).sort((a, b) => {
    const importance = (b.importance ?? 1) - (a.importance ?? 1);
    if (importance !== 0) return importance;
    const authority = tickerAuthorityWeight(b) - tickerAuthorityWeight(a);
    if (authority !== 0) return authority;
    const sourceType = tickerTypeWeight(b.sourceType) - tickerTypeWeight(a.sourceType);
    if (sourceType !== 0) return sourceType;
    const published = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    if (published !== 0) return published;
    return a.id.localeCompare(b.id);
  });

  const candidates = [...ranked];
  while (candidates.length > 0 && selected.length < safeLimit) {
    const lastSource = selected.at(-1)?.source;
    const eligible = (entry: NormalizedEntry) => {
      const platform = tickerSourcePlatformKey(entry);
      return (sourceCounts.get(entry.source) ?? 0) < sourceCap
        && (platformCounts.get(platform) ?? 0) < platformCap;
    };
    let candidateIndex = candidates.findIndex(
      (entry) => eligible(entry) && entry.source !== lastSource,
    );
    if (candidateIndex < 0) {
      candidateIndex = candidates.findIndex(eligible);
    }
    if (candidateIndex < 0) break;

    const [entry] = candidates.splice(candidateIndex, 1);
    if (!entry) break;
    const platform = tickerSourcePlatformKey(entry);
    selected.push(entry);
    sourceCounts.set(entry.source, (sourceCounts.get(entry.source) ?? 0) + 1);
    platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + 1);
  }

  return selected;
}

/**
 * Select the newest JST publication day that still has ticker candidates.
 * Exclusions are applied first so a Spotlight-only day cannot leave the ticker empty.
 */
export function selectTickerDayEntries(
  entries: readonly NormalizedEntry[],
  now = new Date(),
  excludedEntryIds: readonly string[] = [],
): TickerDaySelection {
  const excluded = new Set(excludedEntryIds);
  const todayKey = jstDateKey(now.toISOString());
  const selected = groupByDay(entries.filter((entry) => !excluded.has(entry.id)))
    .find((group) => group.key <= todayKey);

  if (!selected) {
    return { dayKey: null, dayScope: "latest", entries: [] };
  }

  return {
    dayKey: selected.key,
    dayScope: selected.key === todayKey ? "today" : "latest",
    entries: selected.items,
  };
}

/** Look up an entry by id (used by the detail page). */
export function getEntryById(id: string): NormalizedEntry | undefined {
  return ENTRY_BY_ID.get(id);
}

export interface SourceListedActivity {
  latestCollectedAt?: string;
  latestPublishedAt?: string;
}

/**
 * Latest listed-entry activity for a source using the same truthful entry set
 * that powers the web UI (`ALL_ENTRIES` by default). This intentionally tracks
 * the latest collected/published entry retained for the source, not the viewed
 * article's own age.
 */
export function latestListedActivityForSource(
  sourceId: string,
  entries: readonly Pick<NormalizedEntry, "source" | "publishedAt" | "collectedAt">[] = ALL_ENTRIES,
): SourceListedActivity {
  let latestCollectedAt: string | undefined;
  let latestPublishedAt: string | undefined;
  for (const entry of entries) {
    if (entry.source !== sourceId) continue;
    const collectedAt = entry.collectedAt ?? entry.publishedAt;
    if (collectedAt && (!latestCollectedAt || collectedAt > latestCollectedAt)) {
      latestCollectedAt = collectedAt;
    }
    if (entry.publishedAt && (!latestPublishedAt || entry.publishedAt > latestPublishedAt)) {
      latestPublishedAt = entry.publishedAt;
    }
  }
  return { latestCollectedAt, latestPublishedAt };
}

/**
 * Source-feed freshness reference for a selected entry. Home and detail views
 * use this helper so an older article is not mistaken for a stale source when
 * the same source has a newer listed entry.
 */
export function latestListedCollectedAtForEntry(
  entry: Pick<NormalizedEntry, "source" | "publishedAt" | "collectedAt">,
  entries: readonly Pick<NormalizedEntry, "source" | "publishedAt" | "collectedAt">[] = ALL_ENTRIES,
): string {
  return (
    latestListedActivityForSource(entry.source, entries).latestCollectedAt ||
    entry.collectedAt ||
    entry.publishedAt
  );
}

/** Related entries: same category, excluding self, newest first. */
export function relatedEntries(
  e: NormalizedEntry,
  n = 6,
): NormalizedEntry[] {
  const lane = isArxivEntry(e)
    ? ARXIV_ENTRIES
    : CATEGORY_ENTRIES_BY_SLUG.get(e.category) ?? [];
  return lane.filter((x) => x.id !== e.id).slice(0, n);
}

/** Newest entries from the same source, excluding self. */
export function entriesBySource(
  e: NormalizedEntry,
  n = 5,
): NormalizedEntry[] {
  return (SOURCE_ENTRIES_BY_ID.get(e.source) ?? [])
    .filter((x) => x.id !== e.id)
    .slice(0, n);
}

/** Newest entries sharing any tag with `e`, excluding self and same-category dupes. */
export function entriesByTag(
  e: NormalizedEntry,
  n = 5,
): NormalizedEntry[] {
  if (e.tags.length === 0) return [];
  const candidates = new Map<string, NormalizedEntry>();
  for (const tag of new Set(e.tags.map(normalizeTagKey).filter(Boolean))) {
    for (const candidate of TAG_ENTRIES_BY_NAME.get(tag) ?? []) {
      if (candidate.id !== e.id) candidates.set(candidate.id, candidate);
    }
  }
  return [...candidates.values()]
    .sort(
      (a, b) =>
        (ENTRY_ORDER_BY_ID.get(a.id) ?? Number.MAX_SAFE_INTEGER)
        - (ENTRY_ORDER_BY_ID.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, n);
}

/** Previous and next entries within the same category (newest = index 0). */
export function adjacentInCategory(
  e: NormalizedEntry,
): { prev?: NormalizedEntry; next?: NormalizedEntry } {
  const arxiv = isArxivEntry(e);
  const cat = arxiv
    ? ARXIV_ENTRIES
    : CATEGORY_ENTRIES_BY_SLUG.get(e.category) ?? [];
  const i = arxiv
    ? ARXIV_POSITION_BY_ID.get(e.id) ?? -1
    : CATEGORY_POSITION_BY_ID.get(e.id) ?? -1;
  if (i < 0) return {};
  return { prev: cat[i - 1], next: cat[i + 1] };
}

export function categoryImportanceStanding(
  e: NormalizedEntry,
): { total: number; sameOrHigher: number } {
  const categoryEntries = isArxivEntry(e)
    ? ARXIV_ENTRIES
    : CATEGORY_ENTRIES_BY_SLUG.get(e.category) ?? [];
  return {
    total: categoryEntries.length,
    sameOrHigher: categoryEntries.filter((entry) => entry.importance >= e.importance).length,
  };
}

/** Average importance over the last N entries from this source. */
export function sourceAvgImportance(
  e: NormalizedEntry,
  n = 30,
): number {
  const recent = (SOURCE_ENTRIES_BY_ID.get(e.source) ?? []).slice(0, n);
  if (recent.length === 0) return e.importance;
  return Math.round(
    (recent.reduce((s, x) => s + x.importance, 0) / recent.length) * 10,
  ) / 10;
}

/** Aggregate fallback metrics for a set of entries. */
export function fallbackMetrics(entries: readonly NormalizedEntry[] = ALL_ENTRIES): {
  fallbackEntries: number;
  realSummaryEntries: number;
  fallbackPercent: number;
} {
  const fallbackEntries = entries.filter(isDeterministicFallbackEntry).length;
  return {
    fallbackEntries,
    realSummaryEntries: entries.length - fallbackEntries,
    fallbackPercent: entries.length === 0 ? 0 : Math.round((fallbackEntries / entries.length) * 100),
  };
}
