import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHnAlgolia } from "../harness/collectors/hn-algolia.ts";
import type { SourceDefinition } from "../harness/types.ts";

const source: SourceDefinition = {
  id: "hn-ai",
  displayName: "HN AI",
  category: "tech-news",
  sourceType: "community",
  defaultLang: "en",
  autoTags: ["hn"],
  feedUrl: "https://example.com/hn",
  collect: async () => [],
  tier: 2,
  keywordFilterScope: "title",
  maxEntriesPerRun: 2,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("collectHnAlgolia", () => {
  it("applies maxEntriesPerRun after qualifying-hit filtering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          hits: [
            {
              title: "Low signal should be filtered first",
              url: "https://example.com/low",
              story_id: 1,
              objectID: "1",
              created_at: "2026-07-01T00:00:00.000Z",
              author: "low",
              points: 49,
              num_comments: 1,
            },
            {
              title: "Keep 1",
              url: "https://example.com/keep-1",
              story_id: 2,
              objectID: "2",
              created_at: "2026-07-01T00:00:00.000Z",
              author: "one",
              points: 120,
              num_comments: 10,
            },
            {
              title: "Keep 2",
              url: "https://example.com/keep-2",
              story_id: 3,
              objectID: "3",
              created_at: "2026-07-01T01:00:00.000Z",
              author: "two",
              points: 110,
              num_comments: 8,
            },
            {
              title: "Would qualify but exceeds cap",
              url: "https://example.com/keep-3",
              story_id: 4,
              objectID: "4",
              created_at: "2026-07-01T02:00:00.000Z",
              author: "three",
              points: 100,
              num_comments: 6,
            },
          ],
        }),
      }),
    );

    const entries = await collectHnAlgolia(source);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.title)).toEqual(["Keep 1", "Keep 2"]);
  });

  it("applies the shared keyword filter before capping so excluded high-score HN titles do not steal slots", async () => {
    const filteredSource: SourceDefinition = {
      ...source,
      includeKeywords: ["ai", "mcp", "developer tool"],
      excludeKeywords: ["who is hiring", "hiring", "job board"],
      keywordFilterScope: "title",
      maxEntriesPerRun: 2,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          hits: [
            {
              title: "AI teams: Who is hiring?",
              url: "https://example.com/hiring",
              story_id: 10,
              objectID: "10",
              created_at: "2026-07-01T00:00:00.000Z",
              author: "jobs",
              points: 200,
              num_comments: 50,
            },
            {
              title: "Show HN: MCP testing harness for AI teams",
              url: "https://example.com/mcp-harness",
              story_id: 11,
              objectID: "11",
              created_at: "2026-07-01T01:00:00.000Z",
              author: "one",
              points: 180,
              num_comments: 40,
            },
            {
              title: "Building a developer tool for structured prompts",
              url: "https://example.com/dev-tool",
              story_id: 12,
              objectID: "12",
              created_at: "2026-07-01T02:00:00.000Z",
              author: "two",
              points: 170,
              num_comments: 30,
            },
            {
              title: "Would qualify but exceeds cap",
              url: "https://example.com/overflow",
              story_id: 13,
              objectID: "13",
              created_at: "2026-07-01T03:00:00.000Z",
              author: "three",
              points: 160,
              num_comments: 20,
            },
          ],
        }),
      }),
    );

    const entries = await collectHnAlgolia(filteredSource);

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.title)).toEqual([
      "Show HN: MCP testing harness for AI teams",
      "Building a developer tool for structured prompts",
    ]);
  });
});
