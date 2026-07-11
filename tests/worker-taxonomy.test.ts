import { describe, expect, it } from "vitest";
import { REGISTRY } from "../harness/registry.ts";
import type { NormalizedEntry, SourceDefinition } from "../harness/types.ts";
import { applyCurrentSourceRules, mergeFreshAndPriorEntries } from "../worker/src/index.ts";

function baseEntry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "entry-1",
    source: "hn-ai",
    sourceType: "community",
    url: "https://example.com/story",
    title: "Show HN: Example",
    titleJa: "",
    titleEn: "Show HN: Example",
    summaryJa: "pending",
    summaryEn: "pending",
    lang: "en",
    publishedAt: "2026-06-29T00:00:00.000Z",
    collectedAt: "2026-06-29T01:00:00.000Z",
    tags: ["community"],
    category: "research",
    importance: 1,
    archiveTier: "hot",
    ...overrides,
  };
}

describe("applyCurrentSourceRules", () => {
  it("restamps stale prior hn-ai entries to the current registry category", () => {
    const stale = baseEntry({
      source: "hn-ai",
      title: "Show HN: InsForge – Open-source Heroku for coding agents",
      titleEn: "Show HN: InsForge – Open-source Heroku for coding agents",
      category: "research",
      summaryEn: "Open-source platform for coding agents",
    });
    const next = applyCurrentSourceRules(stale, REGISTRY["hn-ai"], "2026-06-30T00:00:00.000Z");
    expect(next).not.toBeNull();
    expect(next?.category).toBe("tech-news");
    expect(next?.sourceType).toBe("community");
  });

  it("drops stale prior entries that fail the current shared tech-news filters", () => {
    const stale = baseEntry({
      source: "the-verge",
      sourceType: "blog",
      title: "Sony’s AI Camera Assistant is exactly as bad as it looks",
      titleEn: "Sony’s AI Camera Assistant is exactly as bad as it looks",
      url: "https://www.theverge.com/story",
      category: "tech-news",
      tags: ["verge", "news"],
    });
    const next = applyCurrentSourceRules(stale, REGISTRY["the-verge"], "2026-06-30T00:00:00.000Z");
    expect(next).toBeNull();
  });

  it("preserves non-title prior entries on unverified missing-include but still drops title-scope misses and excludes", () => {
    const nonTitleSource: SourceDefinition = {
      ...REGISTRY["google-cloud-blog"],
      includeKeywords: ["developer tool"],
      excludeKeywords: ["weekly roundup"],
      keywordFilterScope: undefined,
    };
    const nonTitlePrior = baseEntry({
      id: "prior-non-title",
      source: "non-title-blog",
      sourceType: "blog",
      title: "Neutral platform recap",
      titleEn: "Neutral platform recap",
      url: "https://cloud.google.com/blog/products/example",
      category: "gemini",
      tags: ["google-cloud"],
      contentSnippet: "",
    });
    const kept = applyCurrentSourceRules(nonTitlePrior, nonTitleSource, "2026-06-30T00:00:00.000Z");
    expect(kept).not.toBeNull();
    expect(kept?.category).toBe("gemini");

    const titleScopePrior = baseEntry({
      id: "prior-title-scope",
      source: "hn-ai",
      title: "Who is hiring this month?",
      titleEn: "Who is hiring this month?",
      url: "https://news.ycombinator.com/item?id=42",
      category: "tech-news",
      summaryEn: "",
      contentSnippet: "",
      tags: ["hackernews"],
    });
    expect(applyCurrentSourceRules(titleScopePrior, REGISTRY["hn-ai"], "2026-06-30T00:00:00.000Z")).toBeNull();

    const excludedPrior = baseEntry({
      id: "prior-exclude",
      source: "non-title-blog",
      sourceType: "blog",
      title: "Weekly roundup for retail teams",
      titleEn: "Weekly roundup for retail teams",
      url: "https://cloud.google.com/blog/products/example-roundup",
      category: "gemini",
      tags: ["google-cloud"],
    });
    expect(applyCurrentSourceRules(excludedPrior, nonTitleSource, "2026-06-30T00:00:00.000Z")).toBeNull();
  });

  it("evaluates populated prior contentSnippet values for include, exclude, and lossy missing-include decisions", () => {
    const source: SourceDefinition = {
      ...REGISTRY["google-cloud-blog"],
      includeKeywords: ["developer tool"],
      excludeKeywords: ["weekly roundup"],
      keywordFilterScope: undefined,
    };
    const included = baseEntry({
      id: "prior-snippet-include",
      source: "google-cloud-blog",
      title: "Neutral platform recap",
      titleEn: "Neutral platform recap",
      category: "gemini",
      contentSnippet: "A developer tool for evaluating agent workflows.",
    });
    const excluded = baseEntry({
      id: "prior-snippet-exclude",
      source: "google-cloud-blog",
      title: "Neutral platform recap",
      titleEn: "Neutral platform recap",
      category: "gemini",
      contentSnippet: "A weekly roundup for retail teams.",
    });
    const unverified = baseEntry({
      id: "prior-snippet-unverified",
      source: "google-cloud-blog",
      title: "Neutral platform recap",
      titleEn: "Neutral platform recap",
      category: "gemini",
      contentSnippet: "A general infrastructure overview without the configured include phrase.",
    });

    expect(applyCurrentSourceRules(included, source, "2026-06-30T00:00:00.000Z")).not.toBeNull();
    expect(applyCurrentSourceRules(excluded, source, "2026-06-30T00:00:00.000Z")).toBeNull();
    expect(applyCurrentSourceRules(unverified, source, "2026-06-30T00:00:00.000Z")).not.toBeNull();
  });

  it("reapplies current filters only to prior merged entries, not already-filtered fresh ones", () => {
    const sourceDefs = new Map(Object.values(REGISTRY).map((source) => [source.id, source]));
    const fresh = baseEntry({
      id: "fresh-1",
      source: "techcrunch",
      sourceType: "blog",
      title: "Fresh entry whose validating keyword lived past the raw-snippet truncation boundary",
      titleEn: "Fresh entry whose validating keyword lived past the raw-snippet truncation boundary",
      url: "https://techcrunch.com/fresh-long-snippet",
      category: "tech-news",
      tags: ["techcrunch", "news"],
      contentSnippet: "x".repeat(280),
    });
    const priorNoise = baseEntry({
      id: "prior-noise",
      source: "the-verge",
      sourceType: "blog",
      title: "Sony’s AI Camera Assistant is exactly as bad as it looks",
      titleEn: "Sony’s AI Camera Assistant is exactly as bad as it looks",
      url: "https://www.theverge.com/story",
      category: "tech-news",
      tags: ["verge", "news"],
    });
    const priorStale = baseEntry({
      id: "prior-stale",
      source: "hn-ai",
      title: "Show HN: InsForge – Open-source Heroku for coding agents",
      titleEn: "Show HN: InsForge – Open-source Heroku for coding agents",
      url: "https://news.ycombinator.com/item?id=1",
      category: "research",
      summaryEn: "Open-source platform for coding agents",
    });

    const merged = mergeFreshAndPriorEntries(
      [fresh],
      [priorNoise, priorStale],
      sourceDefs,
      "2026-06-30T00:00:00.000Z",
    );

    expect(merged.filteredPriorCount).toBe(1);
    expect(merged.entries.map((entry) => entry.id).sort()).toEqual(["fresh-1", "prior-stale"]);
    expect(merged.entries.find((entry) => entry.id === "fresh-1")?.url).toBe(fresh.url);
    expect(merged.entries.find((entry) => entry.id === "prior-stale")?.category).toBe("tech-news");
  });
});
