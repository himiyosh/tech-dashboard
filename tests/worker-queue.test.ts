import { describe, expect, it } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import type { CacheEntry } from "../worker/src/kv-cache.ts";
import { needsGeneratedContent, selectSummaryJobs } from "../worker/src/index.ts";

const baseEntry: NormalizedEntry = {
  id: "entry-1",
  source: "arxiv-cs-ai",
  sourceType: "paper",
  url: "https://example.com/paper",
  title: "Example Paper",
  titleJa: "",
  titleEn: "Example Paper",
  summaryJa: "このエントリは arxiv-cs-ai から収集した research 領域の最新アップデートです。",
  summaryEn: "AI summary not yet available.",
  bodyJa: "このエントリは arxiv-cs-ai から収集した research 領域の最新アップデートです。",
  bodyEn: "This long-form note is completed from the existing summary and collection metadata.",
  lang: "en",
  publishedAt: "2026-05-23T00:00:00.000Z",
  collectedAt: "2026-05-23T01:00:00.000Z",
  tags: ["ai"],
  category: "research",
  importance: 1,
};

const realCache: CacheEntry = {
  titleJa: "Example Paper",
  summaryJa: "実 AI 要約です。",
  summaryEn: "Real AI summary.",
  bodyJa: "実 AI 本文です。",
  bodyEn: "Real AI body.",
  importance: 2,
  extraTags: [],
  model: "claude-sonnet-4.6",
  cachedAt: "2026-05-23T01:30:00.000Z",
};

describe("worker summary queue selection", () => {
  it("deterministic fallback entries are treated as needing generated content", () => {
    expect(needsGeneratedContent(baseEntry)).toBe(true);
  });

  it("does not enqueue entries that were not looked up because they already have real content", () => {
    const jobs = selectSummaryJobs([baseEntry], new Map(), new Set(), 30);
    expect(jobs).toEqual([]);
  });

  it("enqueues looked-up fallback entries with KV miss", () => {
    const jobs = selectSummaryJobs([baseEntry], new Map(), new Set([baseEntry.url]), 30);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.url).toBe(baseEntry.url);
  });

  it("skips entries with a complete non-fallback cache hit", () => {
    const jobs = selectSummaryJobs(
      [baseEntry],
      new Map([[baseEntry.url, realCache]]),
      new Set([baseEntry.url]),
      30,
    );
    expect(jobs).toEqual([]);
  });
});
