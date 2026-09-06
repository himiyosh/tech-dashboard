import { describe, expect, it } from "vitest";
import {
  RELAXED_QUERY_LIMIT,
  RELAXED_WINDOW_POINTS,
  relaxedCjkSearchQueries,
} from "../web/src/lib/search-relaxation.ts";

// Regression guard for the Japanese title-recall defect: Pagefind segments the
// query independently of the indexed content, so a long mixed-script title can
// return zero results for the very article that carries it.
const FAILING_TITLE = "VS Codeが世界中のビーチリゾートの窓に？ Webviewで海を映す拡張を作った";

describe("relaxedCjkSearchQueries", () => {
  it("keeps the leading window first, then windows inside the longest CJK runs", () => {
    const queries = relaxedCjkSearchQueries(FAILING_TITLE);
    expect(queries[0]).toBe([...FAILING_TITLE].slice(0, RELAXED_WINDOW_POINTS).join(""));
    expect(queries.length).toBeLessThanOrEqual(RELAXED_QUERY_LIMIT);
    // The measured recovery window for this title comes from the first run.
    expect(queries.some((query) => query.includes("ビーチリゾートの窓"))).toBe(true);
    expect(queries).toEqual([...new Set(queries)]);
    expect(queries).not.toContain(FAILING_TITLE);
  });

  it("is deterministic and respects the query limit", () => {
    expect(relaxedCjkSearchQueries(FAILING_TITLE)).toEqual(relaxedCjkSearchQueries(FAILING_TITLE));
    expect(relaxedCjkSearchQueries(FAILING_TITLE, 2)).toHaveLength(2);
    expect(relaxedCjkSearchQueries(FAILING_TITLE, 0)).toEqual([]);
    expect(relaxedCjkSearchQueries(FAILING_TITLE, -1)).toEqual([]);
  });

  it("returns nothing for queries that already AND correctly", () => {
    expect(relaxedCjkSearchQueries("")).toEqual([]);
    expect(relaxedCjkSearchQueries("   ")).toEqual([]);
    // Latin: space-separated terms are matched term by term.
    expect(relaxedCjkSearchQueries("Visual Studio Code remote development tunnels")).toEqual([]);
    // Short CJK: retrieved verbatim.
    expect(relaxedCjkSearchQueries("生成AIの活用事例")).toEqual([]);
  });

  it("never emits a window shorter than five code points", () => {
    for (const query of relaxedCjkSearchQueries("Rust 1.99リリース: 非同期の刷新と互換性メモ")) {
      expect([...query].length).toBeGreaterThanOrEqual(5);
    }
  });

  it("keeps katakana words whole across the prolonged sound mark", () => {
    const queries = relaxedCjkSearchQueries("Anthropic Claudeのエージェントコンピューター利用が一般提供に");
    expect(queries.some((query) => query.includes("コンピューター"))).toBe(true);
  });
});
