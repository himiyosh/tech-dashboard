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

/** Raw entry produced by a Collector BEFORE normalization/enrichment. */
export interface RawEntry {
  /** Unique within (sourceId, collector run). Used for content hash. */
  externalId: string;
  url: string;
  title: string;
  /** Raw content snippet / description if available (pre-summarization). */
  contentSnippet?: string;
  /** ISO 8601 timestamp from source. If missing, collector should default to now. */
  publishedAt: string;
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
  lang: Lang;
  publishedAt: string;
  collectedAt: string;
  tags: string[];
  category: Category;
  importance: Importance;
  clusterId?: string;
  image?: ImageRef;
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
}

/** Result of a single collector run — used for telemetry. */
export interface CollectorRunResult {
  sourceId: SourceId;
  ok: boolean;
  count: number;
  durationMs: number;
  error?: string;
}
