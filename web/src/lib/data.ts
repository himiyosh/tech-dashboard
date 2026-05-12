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
}

interface IndexPayload {
  generatedAt: string;
  count: number;
  health?: WorkerHealth;
  entries: NormalizedEntry[];
}

const data = indexJson as IndexPayload;

export const ALL_ENTRIES: readonly NormalizedEntry[] = data.entries;
export const GENERATED_AT = data.generatedAt;
export const WORKER_HEALTH: WorkerHealth | null = data.health ?? null;

/** Items per page on timeline / category / tag pages. */
export const PAGE_SIZE = 30;

/** 13 categories in display order (matches site-spec §1.1 and mockup-D sidebar). */
export const CATEGORY_META: ReadonlyArray<{
  slug: Category;
  name: string;
  color: string;
  initial: string;
  emoji: string;
  group: "coding" | "platform" | "ecosystem" | "research";
}> = [
    { slug: "copilot", name: "Copilot", color: "#5eead4", initial: "Co", emoji: "\u{1F9E0}", group: "coding" },
    { slug: "claude", name: "Claude", color: "#fbbf24", initial: "Cl", emoji: "\u{1F9E1}", group: "coding" },
    { slug: "codex", name: "Codex", color: "#93c5fd", initial: "Cx", emoji: "\u{1F4D8}", group: "coding" },
    { slug: "gemini", name: "Gemini", color: "#60a5fa", initial: "Gm", emoji: "\u{2728}", group: "coding" },
    { slug: "cursor", name: "Cursor", color: "#cbd5e1", initial: "Cu", emoji: "\u{1F5B1}\u{FE0F}", group: "coding" },
    { slug: "cline", name: "Cline / Roo", color: "#c4b5fd", initial: "Cn", emoji: "\u{1F9F5}", group: "coding" },
    { slug: "aider", name: "Aider", color: "#d6d3a1", initial: "Ai", emoji: "\u{1F91D}", group: "coding" },
    { slug: "opencode", name: "OpenCode", color: "#a5b4fc", initial: "Oc", emoji: "\u{1F310}", group: "coding" },
    { slug: "vscode", name: "VSCode", color: "#63a2ff", initial: "Vs", emoji: "\u{1F537}", group: "platform" },
    { slug: "local-llm", name: "Local LLM", color: "#f87171", initial: "Ll", emoji: "\u{1F3E0}", group: "platform" },
    { slug: "agent-fw", name: "Agent FW", color: "#34d399", initial: "Af", emoji: "\u{1F916}", group: "ecosystem" },
    { slug: "mcp", name: "MCP", color: "#f472b6", initial: "Mc", emoji: "\u{1F517}", group: "ecosystem" },
    { slug: "tech-news", name: "Tech News", color: "#fb923c", initial: "Tn", emoji: "\u{1F4F0}", group: "ecosystem" },
    { slug: "research", name: "Research", color: "#fda4af", initial: "Rs", emoji: "\u{1F52C}", group: "research" },
  ];

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
  return ALL_ENTRIES.slice(0, n);
}

/** Entries with importance === 3 (major releases). Newest first. */
export function featured(): NormalizedEntry | undefined {
  return ALL_ENTRIES.find((e) => e.importance === 3) ?? ALL_ENTRIES.find((e) => e.importance === 2);
}

/** Top tags from the most recent 200 entries. */
export function trendingTags(n = 10): Array<{ tag: string; count: number }> {
  const recent = ALL_ENTRIES.slice(0, 200);
  const counts = new Map<string, number>();
  for (const e of recent) {
    for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
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
  if (lang === "ja") {
    if (ja) return ja;
    return hasCjk(en) ? en : "";
  }
  if (en && !hasCjk(en)) return en;
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
  const ja = (e.summaryJa ?? "").trim();
  const en = (e.summaryEn ?? "").trim();
  if (lang === "en" && ja) {
    return { text: ja, isFallback: true, fallbackLang: "ja" };
  }
  if (lang === "ja" && en && !hasCjk(en)) {
    return { text: en, isFallback: true, fallbackLang: "en" };
  }
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
    if (ja) return ja;
    // AI summary (Japanese) is available for most entries — use its first clause as headline.
    if (sumJa) return firstClause(sumJa, 70);
    return title || en;
  }
  if (en) return en;
  if (sumEn && !hasCjk(sumEn)) return firstClause(sumEn, 90);
  if (title && !hasCjk(title)) return title;
  return "";
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

/** Category-relative importance percentile (0-100, higher = more important). */
export function importancePercentile(e: NormalizedEntry): number {
  const cat = ALL_ENTRIES.filter((x) => x.category === e.category);
  if (cat.length === 0) return 50;
  const lower = cat.filter((x) => x.importance < e.importance).length;
  return Math.round((lower / cat.length) * 100);
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

