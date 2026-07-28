import { describe, expect, it } from "vitest";
import {
  filterArxivEntries,
  filterCategoryListingEntries,
  isArxivEntry,
  isResearchListingEntry,
  type CategoryLaneEntry,
} from "../web/src/lib/research-lane.ts";
import {
  isPublishableEntry,
  type PublicationEntry,
} from "../web/src/lib/entry-publication.ts";

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

const publicationFixtures: Array<CategoryLaneEntry & PublicationEntry & { id: string }> = [
  {
    id: "curated-publishable",
    category: "research",
    source: "dora-insights",
    sourceType: "blog",
    url: "https://example.com/research/report",
    title: "Research report",
    titleJa: "Research レポート",
    titleEn: "Research report",
    summaryJa: "選定した Research レポートの要約。",
    summaryEn: "A curated Research report summary.",
  },
  {
    id: "arxiv-ja-only",
    category: "research",
    source: "arxiv-cs-ai",
    sourceType: "paper",
    url: "https://arxiv.org/abs/2607.10001",
    title: "日本語要約付き arXiv 論文",
    titleJa: "日本語要約付き arXiv 論文",
    titleEn: "",
    summaryJa: "日本語の検証済み要約。",
    summaryEn: "AI summary pending",
  },
  {
    id: "arxiv-en-only",
    category: "research",
    source: "paper-mirror",
    sourceType: "paper",
    url: "https://arxiv.org/abs/2607.10002",
    title: "arXiv paper with an English summary",
    titleJa: "",
    titleEn: "arXiv paper with an English summary",
    summaryJa: "AI 要約未生成",
    summaryEn: "A verified English summary for this arXiv paper.",
  },
  {
    id: "arxiv-pending",
    category: "research",
    source: "arxiv-cs-lg",
    sourceType: "paper",
    url: "https://arxiv.org/abs/2607.10003",
    title: "Pending arXiv paper",
    titleJa: "",
    titleEn: "Pending arXiv paper",
    summaryJa: "AI 要約未生成",
    summaryEn: "AI summary pending",
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

  it("publishes only summary-ready arXiv entries even when every fixture shares Research", () => {
    expect(publicationFixtures.every((entry) => entry.category === "research")).toBe(true);
    expect(
      filterArxivEntries(publicationFixtures.filter(isPublishableEntry)).map(
        (entry) => entry.id,
      ),
    ).toEqual(["arxiv-ja-only", "arxiv-en-only"]);
  });
});
