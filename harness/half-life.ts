/**
 * Archive strategy — half-life classification & tier transition.
 *
 * Background
 * ----------
 * Tech articles decay at very different rates. A release note is worthless
 * after the next version ships; a CS fundamentals post stays relevant for
 * a decade. A single "delete after 90 days" rule throws away long-tail
 * SEO value. This module classifies each article by half-life and computes
 * which archive tier it belongs to at any given time.
 *
 * Policy (per user direction, 2026-04-28)
 * ---------------------------------------
 * - 3 active tiers: hot / warm / cold (no Frozen/R2 tier).
 * - Articles past the cold threshold are MARKED dropped, then deleted.
 *   Long-term retention is sacrificed in favor of operational simplicity
 *   and zero paid-DB dependency.
 * - Cold-tier articles live as anchors inside /archive/{year-month}/
 *   aggregate pages. Old individual URLs 301-redirect to those anchors.
 *
 * Default mapping (Category × SourceType → HalfLife)
 * --------------------------------------------------
 * The defaults are intentionally conservative: when in doubt, decay slower.
 * Per-source overrides can be set via SourceDefinition.halfLifeOverride.
 */

import type { Category, HalfLife, SourceType, ArchiveTier } from "./types.ts";

/** Day thresholds per half-life. Past `cold`, the article is dropped. */
export interface TierThresholds {
  /** age (days) < hot   → tier "hot"   */
  hot: number;
  /** age (days) < warm  → tier "warm"  */
  warm: number;
  /** age (days) < cold  → tier "cold"; otherwise "dropped" (Infinity = never drop) */
  cold: number;
}

export const TIER_THRESHOLDS: Readonly<Record<HalfLife, TierThresholds>> = Object.freeze({
  news:         { hot: 14, warm: 90,   cold: 730 },          // ~2y total
  tutorial:     { hot: 30, warm: 365,  cold: 1825 },         // ~5y total
  architecture: { hot: 60, warm: 730,  cold: 3650 },         // ~10y total
  fundamental:  { hot: 90, warm: 1825, cold: Number.POSITIVE_INFINITY },
});

/**
 * Default half-life by SourceType. Applied when no Category-specific or
 * per-source override matches.
 *
 * Rationale:
 * - release/changelog: superseded by next version → news
 * - paper:             arxiv papers retain citation value for years → architecture
 * - community:         HN threads age fast → news
 * - blog:              vendor announcements dominate → news (override per source)
 */
const SOURCE_TYPE_DEFAULT: Readonly<Record<SourceType, HalfLife>> = Object.freeze({
  blog:      "news",
  release:   "news",
  changelog: "news",
  paper:     "architecture",
  community: "news",
});

/**
 * Category-level overrides. Use sparingly — prefer per-source overrides
 * (SourceDefinition.halfLifeOverride) when only one source in a category
 * differs from the rest.
 */
const CATEGORY_OVERRIDE: Readonly<Partial<Record<Category, HalfLife>>> = Object.freeze({
  // research category sources are mostly arxiv (paper) + Zenn AI tutorials.
  // We don't override here; let SourceType+per-source overrides do the work.
  // Add entries here only when an entire category should diverge from defaults.
  "tech-news": "news",
});

/**
 * Source-id prefix overrides. Useful for community blog platforms whose
 * SourceType is "blog" but whose content is overwhelmingly tutorials.
 * Checked in order; first match wins.
 */
const SOURCE_ID_PREFIX_OVERRIDE: ReadonlyArray<{ prefix: string; halfLife: HalfLife }> = Object.freeze([
  { prefix: "zenn-",  halfLife: "tutorial" },
  { prefix: "qiita-", halfLife: "tutorial" },
]);

/**
 * Resolve the effective half-life for an article.
 * Priority: source override → source-id prefix → category override → source-type default.
 */
export function resolveHalfLife(args: {
  category: Category;
  sourceType: SourceType;
  sourceId?: string;
  sourceOverride?: HalfLife;
}): HalfLife {
  if (args.sourceOverride) return args.sourceOverride;
  if (args.sourceId) {
    const hit = SOURCE_ID_PREFIX_OVERRIDE.find((p) => args.sourceId!.startsWith(p.prefix));
    if (hit) return hit.halfLife;
  }
  const cat = CATEGORY_OVERRIDE[args.category];
  if (cat) return cat;
  return SOURCE_TYPE_DEFAULT[args.sourceType];
}

/** Compute the integer day delta between two ISO timestamps (UTC, floor). */
function daysBetween(fromIso: string, to: Date): number {
  const ms = to.getTime() - new Date(fromIso).getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * Decide the archive tier for an article at a given moment.
 *
 * @param article  Minimal fields needed for the decision.
 * @param now      Reference timestamp (default: current time). Pass explicitly
 *                 in tests and batch jobs for determinism.
 *
 * Promotion / demotion rules:
 * - evergreen=true → never drops below "warm" (kept individually addressable).
 * - viewsLast30d ≥ POPULAR_VIEWS_THRESHOLD multiplies thresholds by POPULAR_BOOST,
 *   slowing demotion for articles with proven traffic.
 * - publishedAt missing → treated as "now" (stay in hot until next run sets it).
 */
export const POPULAR_VIEWS_THRESHOLD = 500;
export const POPULAR_BOOST = 1.5;

export function decideTier(
  article: {
    publishedAt: string | null;
    halfLife: HalfLife;
    evergreen?: boolean;
    viewsLast30d?: number;
  },
  now: Date = new Date(),
): ArchiveTier {
  if (!article.publishedAt) return "hot";

  const ageDays = daysBetween(article.publishedAt, now);
  const t = TIER_THRESHOLDS[article.halfLife];
  const boost = (article.viewsLast30d ?? 0) >= POPULAR_VIEWS_THRESHOLD ? POPULAR_BOOST : 1;

  const hot = t.hot * boost;
  const warm = t.warm * boost;
  const cold = t.cold === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : t.cold * boost;

  if (ageDays < hot) return "hot";
  if (ageDays < warm) return "warm";
  if (ageDays < cold) return "cold";

  // Evergreen safety net: never drop. Pin to "warm" to keep an individual URL.
  if (article.evergreen) return "warm";
  return "dropped";
}
