import type { Category } from "./category-meta.ts";

export interface CategoryLaneEntry {
  category: Category;
  source: string;
  sourceType: string;
  url: string;
}

export function isArxivEntry(
  entry: Pick<CategoryLaneEntry, "source" | "sourceType" | "url">,
): boolean {
  return entry.source.startsWith("arxiv-")
    || (entry.sourceType === "paper" && entry.url.includes("arxiv.org"));
}

export function isResearchListingEntry(entry: CategoryLaneEntry): boolean {
  return entry.category === "research" && !isArxivEntry(entry);
}

export function isCategoryListingEntry(
  entry: CategoryLaneEntry,
  category: Category,
): boolean {
  if (entry.category !== category) return false;
  return category !== "research" || isResearchListingEntry(entry);
}

export function filterCategoryListingEntries<T extends CategoryLaneEntry>(
  entries: readonly T[],
  category: Category,
): T[] {
  return entries.filter((entry) => isCategoryListingEntry(entry, category));
}
