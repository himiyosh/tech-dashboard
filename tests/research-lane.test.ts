import { describe, expect, it } from "vitest";
import {
  filterCategoryListingEntries,
  isArxivEntry,
  isResearchListingEntry,
  type CategoryLaneEntry,
} from "../web/src/lib/research-lane.ts";

const fixtures: Array<CategoryLaneEntry & { id: string }> = [
  {
    id: "curated-research",
    category: "research",
    source: "dora-insights",
    sourceType: "blog",
    url: "https://example.com/research/report",
  },
  {
    id: "arxiv-source",
    category: "research",
    source: "arxiv-cs-ai",
    sourceType: "paper",
    url: "https://example.com/mirrored-paper",
  },
  {
    id: "arxiv-url",
    category: "research",
    source: "paper-mirror",
    sourceType: "paper",
    url: "https://arxiv.org/abs/2607.01234",
  },
  {
    id: "other-category",
    category: "claude",
    source: "anthropic-news",
    sourceType: "blog",
    url: "https://example.com/claude",
  },
];

describe("Research lane membership", () => {
  it("separates arXiv papers from curated Research even when the category matches", () => {
    expect(fixtures.filter(isResearchListingEntry).map((entry) => entry.id)).toEqual([
      "curated-research",
    ]);
    expect(fixtures.filter(isArxivEntry).map((entry) => entry.id)).toEqual([
      "arxiv-source",
      "arxiv-url",
    ]);
  });

  it("filters Research with the lane predicate while preserving other category behavior", () => {
    expect(
      filterCategoryListingEntries(fixtures, "research").map((entry) => entry.id),
    ).toEqual(["curated-research"]);
    expect(
      filterCategoryListingEntries(fixtures, "claude").map((entry) => entry.id),
    ).toEqual(["other-category"]);
  });
});
