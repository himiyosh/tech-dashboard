/**
 * Data loader — imports data/index.json at build time and re-exports typed.
 * Astro's static output inlines this, so no runtime fetch is needed.
 */
// Path: web/src/lib/data.ts → tech-dashboard/data/index.json (3 levels up)
import indexJson from "../../../data/index.json";

export type Category =
  | "copilot"
  | "claude"
  | "codex"
  | "gemini"
  | "vscode"
  | "cursor"
  | "cline"
  | "aider"
  | "opencode"
  | "local-llm"
  | "agent-fw"
  | "mcp"
  | "research"
  | "tech-news";

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
  summaryQueueBacklog?: number;
  summaryQueueDrainEstimateHours?: number;
  summaryQueueStartIndex?: number;
  summaryQueueCooldownCount?: number;
  kvLookupCap?: number;
  kvLookupCount?: number;
}

interface IndexPayload {
  generatedAt: string;
  count: number;
  health?: WorkerHealth;
  entries: NormalizedEntry[];
}

const data = indexJson as IndexPayload;

// Fallback detection constants (from main's data quality improvements).
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

export function isSyntheticFallbackTitle(e: NormalizedEntry, text: string | undefined | null): boolean {
  const value = (text ?? "").trim();
  if (!value) return false;
  return value.includes(`(${e.source})`) && /\u95a2\u9023\u30a2\u30c3\u30d7\u30c7\u30fc\u30c8|related update/i.test(value);
}

/**
 * Returns true if this entry still lacks a real AI **summary** (pending
 * boilerplate or synthetic title). Summary-first design (LL-112): the long-form
 * body is no longer stored on the entry (LL-113: it lives in data/bodies.json),
 * so body presence must NOT affect "fallback" classification. Body rendering is
 * judged separately by `bodyForEntry` (web/src/lib/bodies.ts).
 */
export function isDeterministicFallbackEntry(e: NormalizedEntry): boolean {
  return (
    isPendingSummaryText(e.summaryJa) ||
    isPendingSummaryText(e.summaryEn) ||
    isContaminatedSummaryText(e.summaryJa) ||
    isContaminatedSummaryText(e.summaryEn) ||
    isSyntheticFallbackTitle(e, e.titleJa) ||
    isSyntheticFallbackTitle(e, e.titleEn)
  );
}

function hasGeneratedSummary(e: NormalizedEntry): boolean {
  const summaryJa = (e.summaryJa ?? "").trim();
  const summaryEn = (e.summaryEn ?? "").trim();
  return (
    (!!summaryJa && !isPendingSummaryText(summaryJa)) ||
    (!!summaryEn && !isPendingSummaryText(summaryEn))
  );
}

const MUTABLE_GITHUB_RELEASE_ALIAS_RE =
  /\/releases\/tag\/(?:nightly|canary|snapshot|rolling|extension-(?:workflows|cli)|collab-(?:staging|production|prod))\/?$/i;

export function isMutableReleaseAliasEntry(
  entry: Pick<NormalizedEntry, "sourceType" | "url">,
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

/** Decision-critical slots (Featured / Top-3) and feeds require a real summary. */
export function isPublishableEntry(e: NormalizedEntry): boolean {
  return !isMutableReleaseAliasEntry(e)
    && hasGeneratedSummary(e)
    && !isDeterministicFallbackEntry(e);
}

/**
 * An entry is "listable" when it should appear in the Timeline / category / tag
 * listings. It is listable if it is publishable (real AI summary) OR it is still
 * waiting for its summary but has a real, human-readable title to show.
 *
 * This is the LL-074 / LL-083 / LL-087 family fix: do NOT hide a freshly
 * collected article just because its async AI summary has not been generated
 * yet. The summary queue drains at a capped rate, so the newest entries are
 * disproportionately still in the fallback state — hiding them makes recent days
 * look empty even though collection is healthy. Listing them (with a "summary
 * generating" state in the card) keeps the site reflecting reality, while the
 * real summary upgrades in place once the queue catches up.
 *
 * Synthetic-title-only entries (no real title, just "X (source) related
 * update") are still excluded — there is nothing meaningful to list.
 */
export function isListableEntry(e: NormalizedEntry): boolean {
  if (isMutableReleaseAliasEntry(e)) return false;
  if (isPublishableEntry(e)) return true;
  return (
    (!!(e.titleEn ?? "").trim() && !isSyntheticFallbackTitle(e, e.titleEn)) ||
    (!!(e.titleJa ?? "").trim() && !isSyntheticFallbackTitle(e, e.titleJa)) ||
    (!!(e.title ?? "").trim() && !isSyntheticFallbackTitle(e, e.title))
  );
}

/**
 * True when `text` is not a genuine summary to display: empty, deterministic
 * pending boilerplate ("このエントリは ..."), or a bare echo of the entry title
 * (some feeds set summary = title for un-summarized items). Cards use this to
 * fall back to a clean "summary generating" state instead of showing
 * placeholder text (agentic §4.7 / LL-074).
 */
export function isSummaryNoise(e: NormalizedEntry, text: string | undefined | null): boolean {
  const value = (text ?? "").trim();
  if (!value) return true;
  if (isPendingSummaryText(value)) return true;
  const lower = value.toLowerCase();
  if (isContaminatedSummaryText(value)) return true;
  return [e.title, e.titleEn, e.titleJa].some(
    (t) => !!t && t.trim().toLowerCase() === lower,
  );
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

export function isArxivEntry(entry: Pick<NormalizedEntry, "source" | "sourceType" | "url">): boolean {
  return entry.source.startsWith("arxiv-") || (entry.sourceType === "paper" && entry.url.includes("arxiv.org"));
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
  entry: Pick<NormalizedEntry, "sourceType" | "title" | "titleEn" | "titleJa">,
): boolean {
  if (entry.sourceType !== "release" && entry.sourceType !== "changelog") return false;
  // Test each title independently so the trailing "(#1234)" PR-ref anchor works
  // (joining titles with spaces would break the end-of-string match).
  return [entry.title, entry.titleEn, entry.titleJa].some(
    (t) => !!t && LOW_SIGNAL_RELEASE_RE.test(t),
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

export const ARXIV_ENTRIES: readonly NormalizedEntry[] = ALL_ENTRIES.filter(isArxivEntry);
export const MAIN_TIMELINE_ENTRIES: readonly NormalizedEntry[] = ALL_ENTRIES.filter((entry) => !isArxivEntry(entry));

/**
 * Evergreen knowledge / best-practice entries (R-022). These come from sources
 * marked `evergreen: true` in the registry (vendor engineering blogs, how-to,
 * best-practice guides). They accumulate instead of decaying, so they get a
 * dedicated page separate from the time-sensitive news Timeline. Newest first.
 *
 * Unlike the news Timeline, the Knowledge lane stays publishable-only: it is a
 * curated lane whose cards rely on a real bilingual summary (uniform card
 * layout, LL-096) and whose value is the digested insight, not breaking news.
 * Evergreen entries get summary-queue priority (LL-098) so they surface quickly
 * after collection; until then they simply aren't listed here (the news
 * Timeline is where freshly collected, not-yet-summarized items show up).
 */
export const KNOWLEDGE_ENTRIES: readonly NormalizedEntry[] = PUBLISHABLE_ENTRIES.filter(
  (entry) => entry.evergreen === true,
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

export type CategoryGroup =
  | "microsoft"
  | "anthropic"
  | "openai"
  | "google"
  | "coding-tools"
  | "open-models"
  | "agent-tools"
  | "research"
  | "industry";

/** Category slugs are stable URLs; group/name provide the visible taxonomy. */
export interface CategoryMeta {
  slug: Category;
  name: string;
  /** Compact label for narrow surfaces (sidebar). */
  shortLabel: string;
  /** Natural-language queries that should prioritize the category landing page. */
  searchAliases?: readonly string[];
  color: string;
  initial: string;
  emoji: string;
  group: CategoryGroup;
}

export const CATEGORY_META: ReadonlyArray<CategoryMeta> = [
    { slug: "copilot", name: "GitHub Copilot", shortLabel: "Copilot", color: "#5eead4", initial: "Co", emoji: "\u{1F9E0}", group: "microsoft" },
    { slug: "vscode", name: "VS Code / Dev Env", shortLabel: "VS Code", color: "#63a2ff", initial: "Vs", emoji: "\u{1F537}", group: "microsoft" },
    { slug: "claude", name: "Claude / Claude Code", shortLabel: "Claude Code", color: "#fbbf24", initial: "Cl", emoji: "\u{1F9E1}", group: "anthropic" },
    { slug: "codex", name: "OpenAI / Codex", shortLabel: "Codex", color: "#93c5fd", initial: "Cx", emoji: "\u{1F4D8}", group: "openai" },
    { slug: "gemini", name: "Gemini / Gemma", shortLabel: "Gemini/Gemma", color: "#60a5fa", initial: "Gm", emoji: "\u{2728}", group: "google" },
    { slug: "cursor", name: "AI Editors", shortLabel: "AI Editors", color: "#cbd5e1", initial: "Ed", emoji: "\u{1F5B1}\u{FE0F}", group: "coding-tools" },
    { slug: "cline", name: "Cline / Roo", shortLabel: "Cline/Roo", color: "#c4b5fd", initial: "Cn", emoji: "\u{1F9F5}", group: "coding-tools" },
    { slug: "aider", name: "Aider", shortLabel: "Aider", color: "#d6d3a1", initial: "Ai", emoji: "\u{1F91D}", group: "coding-tools" },
    { slug: "opencode", name: "OpenHands / OpenCode", shortLabel: "OpenHands/OpenCode", color: "#a5b4fc", initial: "Oh", emoji: "\u{1F310}", group: "coding-tools" },
    { slug: "local-llm", name: "Local LLM / Open Models", shortLabel: "Local Models", searchAliases: ["local model", "local models", "local ai", "on-device ai", "open source model", "open source models"], color: "#f87171", initial: "Lm", emoji: "\u{1F3E0}", group: "open-models" },
    { slug: "agent-fw", name: "Agent Frameworks", shortLabel: "Agent Frameworks", color: "#34d399", initial: "Af", emoji: "\u{1F916}", group: "agent-tools" },
    { slug: "mcp", name: "MCP / Tooling", shortLabel: "MCP", color: "#f472b6", initial: "Mc", emoji: "\u{1F517}", group: "agent-tools" },
    { slug: "research", name: "Papers / Benchmarks", shortLabel: "Papers/Benchmarks", searchAliases: ["benchmark", "benchmarks", "paper", "papers", "research"], color: "#fda4af", initial: "Pb", emoji: "\u{1F52C}", group: "research" },
    { slug: "tech-news", name: "Industry & Policy", shortLabel: "News/Policy", color: "#fb923c", initial: "Ip", emoji: "\u{1F4F0}", group: "industry" },
  ];

/**
 * Categories sorted alphabetically for navigation/directory lists (sidebar,
 * categories directory, about coverage). Predictable A→Z order instead of the
 * vendor-group definition order, which read as "scattered" to users.
 * CATEGORY_META keeps its original order for anything that still needs the
 * authored sequence.
 */
export const CATEGORIES_BY_NAME: readonly CategoryMeta[] = [...CATEGORY_META].sort((a, b) =>
  a.name.localeCompare(b.name),
);
/** Like CATEGORIES_BY_NAME but ordered by the compact sidebar label. */
export const CATEGORIES_BY_SHORT_LABEL: readonly CategoryMeta[] = [...CATEGORY_META].sort((a, b) =>
  a.shortLabel.localeCompare(b.shortLabel),
);

export function countByCategory(): Record<Category, number> {
  const counts = Object.fromEntries(
    CATEGORY_META.map((c) => [c.slug, 0] as const),
  ) as Record<Category, number>;
  for (const e of ALL_ENTRIES) {
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
  for (const e of ALL_ENTRIES) {
    if (e.category !== category) continue;
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
  return ALL_ENTRIES.filter((e) => e.category === category);
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
  const eligible = (e: NormalizedEntry) => !isLowSignalRelease(e) && !isOffTopicForHero(e);
  return (
    // 1. High-importance real announcement/blog with a real summary.
    MAIN_TIMELINE_ENTRIES.find(
      (e) => e.importance === 3 && !isRoutineRelease(e) && !isDeterministicFallbackEntry(e) && eligible(e),
    ) ??
    // 2. High-importance stable release with a real summary.
    MAIN_TIMELINE_ENTRIES.find(
      (e) => e.importance === 3 && !isDeterministicFallbackEntry(e) && eligible(e),
    ) ??
    // 3. Medium-importance announcement/blog with a real summary.
    MAIN_TIMELINE_ENTRIES.find(
      (e) => e.importance === 2 && !isRoutineRelease(e) && !isDeterministicFallbackEntry(e) && eligible(e),
    ) ??
    MAIN_TIMELINE_ENTRIES.find(
      (e) => e.importance === 2 && !isDeterministicFallbackEntry(e) && eligible(e),
    ) ??
    // 4. Last resort: any high/medium entry that is not a low-signal build.
    MAIN_TIMELINE_ENTRIES.find((e) => e.importance === 3 && eligible(e)) ??
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

export function relativeTime(iso: string | null, now = new Date()): string {
  if (!iso) return "日付不明";
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Whether the entry was collected within the last 6 hours (NEW badge). */
export function isNew(e: NormalizedEntry, now = Date.now()): boolean {
  return now - new Date(e.collectedAt).getTime() < 6 * 60 * 60_000;
}

const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f]/;

/** true when the string contains Japanese/CJK characters. */
export function hasCjk(s: string | undefined | null): boolean {
  return !!s && CJK_RE.test(s);
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
    const matches = path.match(/\d+(?:-\d+){1,}/g);
    if (!matches) return title;
    let out = title;
    for (const m of matches) {
      const spaced = m.replace(/-/g, " ");
      const dotted = m.replace(/-/g, ".");
      // Replace only as a whole token surrounded by non-digit boundaries.
      const re = new RegExp(
        `(^|[^\\d.])${spaced.replace(/\s/g, "\\s")}(?=$|[^\\d.])`,
      );
      out = out.replace(re, (_, pre) => `${pre}${dotted}`);
    }
    return out;
  } catch {
    return title;
  }
}

/**
 * Returns the summary to display for the given site language.
 * Guards against the normalize pipeline stuffing raw Japanese text into
 * `summaryEn` for JP-source feeds: in EN view, we hide it when it's
 * actually Japanese.
 */
export function summaryForLang(
  e: NormalizedEntry,
  lang: "ja" | "en",
): string {
  const ja = (e.summaryJa ?? "").trim();
  const en = (e.summaryEn ?? "").trim();
  // A field is a usable summary only when it is not deterministic pending
  // boilerplate, a synthetic "(source) related update" string, or a bare echo
  // of the entry title (isSummaryNoise). Returning "" for noise lets
  // summaryForLangWithFallback fall back across languages instead of surfacing
  // placeholder text (LL-074). Classification (isPublishableEntry) is unaffected
  // because it reads the raw fields, not this display helper.
  const usable = (text: string) =>
    !isSummaryNoise(e, text) && !isSyntheticFallbackTitle(e, text);
  if (lang === "ja") {
    if (usable(ja)) return ja;
    return hasCjk(en) && usable(en) ? en : "";
  }
  if (usable(en) && !hasCjk(en)) return en;
  return "";
}

/**
 * Like summaryForLang but returns the original-language summary as a
 * last-resort fallback when the requested language is empty. Callers
 * should visually flag such fallbacks (e.g. `[ja]` badge).
 */
export function summaryForLangWithFallback(
  e: NormalizedEntry,
  lang: "ja" | "en",
): { text: string; isFallback: boolean; fallbackLang?: "ja" | "en" } {
  const primary = summaryForLang(e, lang);
  if (primary) return { text: primary, isFallback: false };
  // Fall back to the other language's usable summary (e.g. an English-source
  // entry whose Japanese summary has not been generated yet still shows its real
  // English summary, flagged with a language badge). Uses summaryForLang so the
  // fallback is noise-filtered too (no boilerplate / title-echo leaks).
  const other: "ja" | "en" = lang === "ja" ? "en" : "ja";
  const fallback = summaryForLang(e, other);
  if (fallback) return { text: fallback, isFallback: true, fallbackLang: other };
  return { text: "", isFallback: false };
}

export function titleForLang(
  e: NormalizedEntry,
  lang: "ja" | "en",
): string {
  const ja = (e.titleJa ?? "").trim();
  const enRaw = (e.titleEn ?? "").trim();
  const titleRaw = (e.title ?? "").trim();
  const sumJa = (e.summaryJa ?? "").trim();
  const sumEn = (e.summaryEn ?? "").trim();
  const url = (e.url ?? "").trim();

  // Recover version-number dots lost during slug→title conversion.
  const en = restoreDotsFromUrl(enRaw, url);
  const title = restoreDotsFromUrl(titleRaw, url);

  const firstClause = (s: string, max: number): string => {
    if (!s) return "";
    // Break on Japanese terminators, newline, or Western sentence-end
    // followed by whitespace. Bare "." / "!" / "?" inside a word (e.g.
    // version numbers "Claude Opus 4.7", abbreviations "U.S.") is preserved.
    const m = s.match(/[。！？\n]|[.!?](?=\s)/);
    const idx = m && m.index !== undefined ? m.index : -1;
    const head = idx > 0 ? s.slice(0, idx) : s;
    return head.length > max ? head.slice(0, max) + "…" : head;
  };

  if (lang === "ja") {
    if (ja && !isSyntheticFallbackTitle(e, ja)) return ja;
    // AI summary (Japanese) is available for most entries — use its first clause as headline.
    // Skip deterministic fallback summaries (LL-041 lead): they describe the
    // entry generically and would make the card title read 「このエントリは…」.
    // For those, fall through to the original (English) title.
    if (sumJa && !isPendingSummaryText(sumJa)) return firstClause(sumJa, 70);
    return title || en;
  }
  if (lang === "en") {
    if (en && !isSyntheticFallbackTitle(e, en)) return en;
    if (sumEn && !hasCjk(sumEn) && !isPendingSummaryText(sumEn)) return firstClause(sumEn, 90);
    if (title && !hasCjk(title)) return title;
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
  // Absolute last resort: raw `title` (always present for normalized entries).
  return { text: (e.title ?? "").trim(), isFallback: true, fallbackLang: other };
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

/**
 * Internal href to the in-site article summary page for an entry.
 * All article links across the site should route through this helper
 * so that users land on the in-site summary rather than the original
 * source URL. The original URL is still surfaced on the detail page.
 */
export function entryHref(e: Pick<NormalizedEntry, "id">): string {
  return `/e/${e.id}/`;
}

/** Look up an entry by id (used by the detail page). */
export function getEntryById(id: string): NormalizedEntry | undefined {
  return ALL_ENTRIES.find((e) => e.id === id);
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
  return ALL_ENTRIES.filter((x) => x.id !== e.id && x.category === e.category).slice(0, n);
}

/** Newest entries from the same source, excluding self. */
export function entriesBySource(
  e: NormalizedEntry,
  n = 5,
): NormalizedEntry[] {
  return ALL_ENTRIES.filter((x) => x.id !== e.id && x.source === e.source).slice(0, n);
}

/** Newest entries sharing any tag with `e`, excluding self and same-category dupes. */
export function entriesByTag(
  e: NormalizedEntry,
  n = 5,
): NormalizedEntry[] {
  if (e.tags.length === 0) return [];
  const tagset = new Set(e.tags.map((t) => t.toLowerCase()));
  return ALL_ENTRIES.filter((x) => {
    if (x.id === e.id) return false;
    return x.tags.some((t) => tagset.has(t.toLowerCase()));
  }).slice(0, n);
}

/** Previous and next entries within the same category (newest = index 0). */
export function adjacentInCategory(
  e: NormalizedEntry,
): { prev?: NormalizedEntry; next?: NormalizedEntry } {
  const cat = ALL_ENTRIES.filter((x) => x.category === e.category);
  const i = cat.findIndex((x) => x.id === e.id);
  if (i < 0) return {};
  return { prev: cat[i - 1], next: cat[i + 1] };
}

export function categoryImportanceStanding(
  e: NormalizedEntry,
): { total: number; sameOrHigher: number } {
  const categoryEntries = ALL_ENTRIES.filter((entry) => entry.category === e.category);
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
  const recent = ALL_ENTRIES.filter((x) => x.source === e.source).slice(0, n);
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
