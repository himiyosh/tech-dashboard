/**
 * Shared type definitions for the tech-dashboard harness.
 * See docs/01-architecture.md §3.1 and docs/04-site-spec.md §1.1.
 */

/** 14 categories defined in site-spec §1.1 (+ tech-news). */
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

export const ALL_CATEGORIES: readonly Category[] = [
  "copilot",
  "claude",
  "codex",
  "gemini",
  "vscode",
  "cursor",
  "cline",
  "aider",
  "opencode",
  "local-llm",
  "agent-fw",
  "mcp",
  "research",
  "tech-news",
] as const;

/** Opaque source identifier, e.g. "anthropic-news", "openai-blog". */
export type SourceId = string;

export type SourceType =
  | "blog"
  | "release"
  | "changelog"
  | "paper"
  | "community";

export type Lang = "ja" | "en";

export type Importance = 1 | 2 | 3;

/**
 * Archive tier — current visibility / storage layer of an article.
 * See harness/half-life.ts for the transition rules.
 *
 * - hot   : within Hot window. Featured on top page, sitemap, full HTML.
 * - warm  : older than Hot but still individually addressable. Category pages, sitemap, full HTML.
 * - cold  : aggregated into /archive/{year-month}/. Individual URLs 301-redirect to anchor.
 * - dropped: past Cold threshold. Removed from site (per archive-over-retention policy).
 *           Kept here as a state value so pipelines can mark before deletion.
 */
export type ArchiveTier = "hot" | "warm" | "cold" | "dropped";

/**
 * Information half-life — how fast the article's value decays.
 * Determines per-tier day thresholds. See harness/half-life.ts.
 */
export type HalfLife =
  | "news"          // Release notes, announcements (3-7 day half-life)
  | "tutorial"      // How-to, walkthroughs (6-12 month half-life)
  | "architecture"  // Design discussions, postmortems (2-5 year half-life)
  | "fundamental";  // Core CS / theory (10+ year half-life, never dropped)

/** Raw entry produced by a Collector BEFORE normalization/enrichment. */
export interface RawEntry {
  /** Unique within (sourceId, collector run). Used for content hash. */
  externalId: string;
  url: string;
  title: string;
  /** Raw content snippet / description if available (pre-summarization). */
  contentSnippet?: string;
  /** ISO 8601 timestamp from source. null if the source doesn't expose a date. */
  publishedAt: string | null;
  /** Optional thumbnail from RSS <media:thumbnail> or <enclosure>. */
  mediaThumbnail?: string;
  /** Raw author string if source exposes it. */
  author?: string;
}

export interface ImageRef {
  src: string;
  origSrc: string;
  alt: string;
  width: number;
  height: number;
  source: "media" | "og" | "fallback";
}

/** Fully normalized entry — the canonical dashboard record. */
export interface NormalizedEntry {
  id: string; // sha256(sourceId + url).slice(0,16)
  source: SourceId;
  sourceType: SourceType;
  url: string;
  title: string;
  titleJa: string;
  titleEn: string;
  summaryJa: string;
  summaryEn: string;
  /** Long-form magazine-style article body in Japanese (optional). */
  bodyJa?: string;
  /** Long-form magazine-style article body in English (optional). */
  bodyEn?: string;
  lang: Lang;
  publishedAt: string | null;
  collectedAt: string;
  tags: string[];
  category: Category;
  importance: Importance;
  clusterId?: string;
  image?: ImageRef;
  /**
   * Archive tier — set by pipeline/archive-tier.ts (Phase B).
   * Optional for backward compatibility with pre-archive-strategy entries.
   */
  archiveTier?: ArchiveTier;
  /** Information half-life classification. Optional during rollout. */
  halfLife?: HalfLife;
  /**
   * If true, this article is exempt from tier downgrade (never enters cold/dropped).
   * Set manually for editorial picks or automatically when viewsLast30d is high.
   */
  evergreen?: boolean;
  /** Minimal raw copy for auditing. */
  raw?: unknown;
}

/**
 * Source registry entry — metadata + the collector function.
 */
export interface SourceDefinition {
  id: SourceId;
  displayName: string;
  category: Category;
  sourceType: SourceType;
  /** Default lang of content from this source. */
  defaultLang: Lang;
  /** Tags auto-applied to every entry from this source. */
  autoTags: string[];
  /** Feed or page URL used by the collector. */
  feedUrl: string;
  /** Collector implementation. Receives source def, returns raw entries. */
  collect: (source: SourceDefinition) => Promise<RawEntry[]>;
  /**
   * Tier classification (see site-spec §1.4).
   * 1 = core 15, 2 = Tier 2 additional 15, 3 = future.
   */
  tier: 1 | 2 | 3;
  /**
   * Optional per-source entry cap for data/index.json. Defaults to the global
   * PER_SOURCE_CAP (50). Use lower values for high-volume sources (e.g. arXiv
   * feeds) that would otherwise dominate a single category.
   */
  perSourceCap?: number;
  /**
   * Optional half-life override for this source. If unset, the default mapping
   * in harness/half-life.ts (by category × sourceType) is used.
   * Use this for sources whose decay profile diverges from category default
   * (e.g. Anthropic Engineering = "architecture", not "news").
   */
  halfLifeOverride?: HalfLife;
  /**
   * Opt-in: if the RSS/Atom feed does not expose per-item publish dates
   * (e.g. Google Developers Blog only ships <lastBuildDate>), the RSS
   * collector will fetch each article page and extract the date from
   * <meta property="article:published_time">, JSON-LD datePublished,
   * or <time datetime="...">. Capped to MAX_DATE_FETCHES per run.
   */
  fetchArticleDate?: boolean;
  /**
   * Optional deterministic relevance filters applied by the generic RSS
   * collector before normalization. If includeKeywords is set, at least one
   * keyword must appear in title/snippet/url. excludeKeywords always wins.
   */
  includeKeywords?: readonly string[];
  excludeKeywords?: readonly string[];
  /** `title` is useful for noisy tag feeds where snippets mention the tag incidentally. */
  keywordFilterScope?: "title" | "title-snippet-url";
  /** Optional hard cap after filtering, newest feed order first. */
  maxEntriesPerRun?: number;
}

/** Result of a single collector run — used for telemetry. */
export interface CollectorRunResult {
  sourceId: SourceId;
  ok: boolean;
  count: number;
  durationMs: number;
  error?: string;
}
