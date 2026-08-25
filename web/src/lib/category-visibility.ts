/**
 * category-visibility.ts — per-reader category filter for the timeline.
 *
 * Noisy release-firehose lanes (e.g. cline: every extension/CLI/SDK build)
 * are muted on the Timeline BY DEFAULT so routine version bumps do not crowd
 * the reading list. The reader can re-enable a muted category (or mute any
 * other category) from the timeline filter UI; the choice is stored per
 * browser in localStorage and never leaves the device.
 *
 * Pure module: no DOM and no data-artifact imports, so the collector-side
 * code and unit tests can share the policy (R-005). DOM wiring lives in
 * category-visibility-client.ts.
 */

/**
 * Categories hidden from the Timeline unless the reader opts in.
 * A lane belongs here when most of its inflow is routine per-build release
 * noise or tool-specific chatter rather than decisions. Current set chosen by
 * the site owner (2026-08-25): editor/CLI release lanes plus the highest-noise
 * community lanes.
 */
export const DEFAULT_MUTED_CATEGORIES: readonly string[] = [
  "cursor",
  "cline",
  "local-llm",
  "agent-fw",
];

/** Versioned storage key (bump the suffix when the schema changes). */
export const CATEGORY_VISIBILITY_STORAGE_KEY = "techdb.category-visibility.v1";

/** Reader override per category slug: show it or hide it on the Timeline. */
export type CategoryVisibilityOverride = "shown" | "hidden";

export type CategoryVisibilityOverrides = Readonly<
  Record<string, CategoryVisibilityOverride>
>;

export function isDefaultMutedCategory(slug: string): boolean {
  return DEFAULT_MUTED_CATEGORIES.includes(slug);
}

/**
 * Fail-closed parser for the stored JSON: anything malformed degrades to
 * "no overrides" (= the shipped defaults) instead of throwing or trusting
 * unexpected shapes.
 */
export function parseCategoryVisibilityOverrides(
  raw: string | null | undefined,
): CategoryVisibilityOverrides {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const overrides: Record<string, CategoryVisibilityOverride> = {};
    for (const [slug, value] of Object.entries(parsed)) {
      if (
        /^[a-z0-9-]{1,40}$/.test(slug) &&
        (value === "shown" || value === "hidden")
      ) {
        overrides[slug] = value;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

export function serializeCategoryVisibilityOverrides(
  overrides: CategoryVisibilityOverrides,
): string {
  return JSON.stringify(overrides);
}

/** Effective visibility of one category under the reader's overrides. */
export function isCategoryHidden(
  slug: string,
  overrides: CategoryVisibilityOverrides,
): boolean {
  const override = overrides[slug];
  if (override === "shown") return false;
  if (override === "hidden") return true;
  return isDefaultMutedCategory(slug);
}

/**
 * Next override map after the reader toggles one category. Overrides that
 * merely restate the default are dropped so storage stays minimal and future
 * default changes take effect for readers who never touched that category.
 */
export function toggleCategoryVisibility(
  slug: string,
  overrides: CategoryVisibilityOverrides,
): CategoryVisibilityOverrides {
  const next: Record<string, CategoryVisibilityOverride> = { ...overrides };
  const wantHidden = !isCategoryHidden(slug, overrides);
  const matchesDefault = wantHidden === isDefaultMutedCategory(slug);
  if (matchesDefault) {
    delete next[slug];
  } else {
    next[slug] = wantHidden ? "hidden" : "shown";
  }
  return next;
}
