import { describe, expect, it } from "vitest";
import { buildStatsPayload } from "../harness/publishers/stats-core.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  assertArchiveMonthBaseline,
  assertHistoryBaselinePair,
  buildIncrementalStats,
  hasArchiveTagChanges,
  parseBaselineJson,
  selectArchiveInspectionMonths,
  selectArchiveUpdateEntries,
} from "../worker/src/index.ts";

const GEN = "2026-06-23T00:00:00.000Z";

function entry(id: string, publishedAt: string, category = "tech-news"): NormalizedEntry {
  return {
    id,
    source: "test-source",
    sourceType: "blog",
    url: "https://example.com/" + id,
    title: "Title " + id,
    titleJa: "Title " + id,
    titleEn: "Title " + id,
    summaryJa: "日本語要約 " + id,
    summaryEn: "English summary " + id,
    bodyJa: "",
    bodyEn: "",
    lang: "en",
    publishedAt,
    collectedAt: "2026-06-23T00:00:00.000Z",
    tags: ["test"],
    category,
    importance: 2,
    archiveTier: "hot",
    halfLife: "news",
  } as NormalizedEntry;
}

describe("archive incremental scope (LL-152)", () => {
  it("selects only new or changed index entries for archive reads", () => {
    const unchanged = entry("unchanged", "2026-06-20T00:00:00.000Z");
    const changed = entry("changed", "2026-06-21T00:00:00.000Z");
    const next = [
      { ...unchanged },
      { ...changed, summaryEn: "Updated English summary" },
      entry("new", "2026-06-22T00:00:00.000Z"),
    ];

    expect(selectArchiveUpdateEntries({ entries: [unchanged, changed] }, next).map((item) => item.id)).toEqual([
      "changed",
      "new",
    ]);
    expect(selectArchiveUpdateEntries(null, [unchanged]).map((item) => item.id)).toEqual(["unchanged"]);
  });

  it("inspects every indexed month only when final live tags changed", () => {
    const unchanged = entry("shared", "2026-06-20T00:00:00.000Z");
    const summaryOnly = { ...unchanged, summaryEn: "Updated English summary" };
    const tagChange = { ...unchanged, tags: ["test", "agent"] };
    const archiveIndex = {
      months: ["2026-03", "2026-06"],
      perMonth: { "2026-03": 10, "2026-06": 20 },
    };

    expect(hasArchiveTagChanges({ entries: [unchanged] }, [summaryOnly])).toBe(false);
    expect(hasArchiveTagChanges({ entries: [unchanged] }, [tagChange])).toBe(true);
    expect(hasArchiveTagChanges({ entries: [unchanged] }, [
      unchanged,
      entry("new", "2026-07-01T00:00:00.000Z"),
    ])).toBe(false);
    expect(selectArchiveInspectionMonths(archiveIndex, ["2026-07"], false)).toEqual(["2026-07"]);
    expect(selectArchiveInspectionMonths(archiveIndex, ["2026-07"], true)).toEqual([
      "2026-03",
      "2026-06",
      "2026-07",
    ]);
  });

  describe("archive baseline publish guards", () => {
    it("throws when a fetched archive index, stats file, or month is invalid JSON", () => {
      for (const path of [
        "data/archive/_index.json",
        "data/stats.json",
        "data/archive/2026-06.json",
      ]) {
        expect(() => parseBaselineJson(path, { content: "{broken" })).toThrow(
          `refusing to publish with invalid baseline ${path}`,
        );
      }
    });

    it("allows an absent baseline artifact to bootstrap", () => {
      expect(parseBaselineJson("data/stats.json", null)).toBeNull();
    });

    it("throws when the archive index exists without stats", () => {
      expect(() => assertHistoryBaselinePair({ content: "{}" }, null)).toThrow(
        "history baseline pair is incomplete; data/stats.json is missing",
      );
    });

    it("throws when stats exist without the archive index", () => {
      expect(() => assertHistoryBaselinePair(null, { content: "{}" })).toThrow(
        "history baseline pair is incomplete; data/archive/_index.json is missing",
      );
    });

    it("allows both history baseline files to exist or both to be missing", () => {
      expect(() => assertHistoryBaselinePair({ content: "{}" }, { content: "{}" })).not.toThrow();
      expect(() => assertHistoryBaselinePair(null, null)).not.toThrow();
    });

    it("throws when the archive index records entries for a missing touched month", () => {
      expect(() =>
        assertArchiveMonthBaseline(
          "2026-06",
          { perMonth: { "2026-06": 42 } },
          null,
        ),
      ).toThrow("archive index records 42 entries for 2026-06");
    });

    it("allows a genuinely new touched month to start without a file", () => {
      expect(() =>
        assertArchiveMonthBaseline(
          "2026-07",
          { perMonth: { "2026-06": 42 } },
          null,
        ),
      ).not.toThrow();
    });
  });

  it("removes exhausted touched days and prunes stale baseline days", () => {
    const removed = [
      entry("day-a", "2026-06-01T00:00:00.000Z"),
      entry("day-b", "2026-06-01T00:00:00.000Z"),
    ];
    const existing = buildStatsPayload(removed, GEN);
    existing.byDay.push({ date: "2026-01-01", count: 1, byCategory: { "tech-news": 1 } });

    const out = buildIncrementalStats({
      existing,
      removed,
      added: [],
      liveCount: 0,
      generatedAt: GEN,
    });

    expect(out.byDay.some((day) => day.date === "2026-06-01")).toBe(false);
    expect(out.byDay.some((day) => day.date === "2026-01-01")).toBe(false);
  });

  it("replaces touched-month stats without re-adding untouched live entries", () => {
    const oldJune = [
      entry("june-a", "2026-06-01T00:00:00.000Z"),
      entry("june-b", "2026-06-02T00:00:00.000Z"),
    ];
    const untouchedMay = entry("may", "2026-05-20T00:00:00.000Z");
    const existing = buildStatsPayload([...oldJune, untouchedMay], GEN);
    const newJune = [
      { ...oldJune[0]!, category: "research" as const },
      oldJune[1]!,
      entry("june-new", "2026-06-03T00:00:00.000Z"),
    ];

    const out = buildIncrementalStats({
      existing,
      removed: oldJune,
      added: newJune,
      liveCount: 4,
      generatedAt: GEN,
    });

    expect(out.totals.allTime).toBe(4);
    expect(out.byMonth.find((month) => month.month === "2026-05")?.count).toBe(1);
    expect(out.byMonth.find((month) => month.month === "2026-06")?.count).toBe(3);
    expect(out.byMonth.find((month) => month.month === "2026-06")?.byCategory.research).toBe(1);
  });

  it("dedupes both sides of a cross-month stats delta by canonical URL", () => {
    const march = entry("shared-march", "2026-03-01T00:00:00.000Z");
    const june = {
      ...entry("shared-june", "2026-06-01T00:00:00.000Z"),
      url: march.url,
    };
    const existing = buildStatsPayload([june], GEN);
    const newMarch = { ...march, category: "research" as const };
    const newJune = { ...june, category: "research" as const };

    const out = buildIncrementalStats({
      existing,
      removed: [march, june],
      added: [newMarch, newJune],
      liveCount: 1,
      generatedAt: GEN,
    });

    expect(out.totals.allTime).toBe(1);
    expect(out.byMonth.find((month) => month.month === "2026-06")?.count).toBe(1);
    expect(out.byMonth.find((month) => month.month === "2026-06")?.byCategory.research).toBe(1);
    expect(out.byMonth.find((month) => month.month === "2026-06")?.byCategory["tech-news"]).toBeUndefined();
  });
});

describe("buildIncrementalStats totals clamp (LL-110)", () => {
  it("clamps a drifted allTime up to >= liveCount and >= last30d", () => {
    // Simulate the production drift: incremental allTime fell BELOW the live
    // entry count (allTime=1312 < live=1662) while last30d drifted high (3047).
    // This is exactly what turned CI red on data/stats.json.
    const empty = buildStatsPayload([], GEN);
    const drifted = {
      ...empty,
      totals: { allTime: 1312, last30d: 3047, last7d: 957, last24h: 829 },
    };

    const out = buildIncrementalStats({
      existing: drifted,
      removed: [],
      added: [],
      liveCount: 1662,
      generatedAt: GEN,
    });

    // The data-schema invariants must hold after clamping.
    expect(out.totals.allTime).toBeGreaterThanOrEqual(1662); // >= liveCount
    expect(out.totals.allTime).toBeGreaterThanOrEqual(out.totals.last30d);
    expect(out.totals.last30d).toBeGreaterThanOrEqual(out.totals.last7d);
    expect(out.totals.last7d).toBeGreaterThanOrEqual(out.totals.last24h);
    expect(out.totals.last24h).toBeGreaterThanOrEqual(0);
    // allTime should become max(1312, last30d=3047, liveCount=1662) = 3047.
    expect(out.totals.allTime).toBe(3047);
  });

  it("enforces allTime >= liveCount even when all rolling counters are tiny", () => {
    const empty = buildStatsPayload([], GEN);
    const drifted = {
      ...empty,
      totals: { allTime: 5, last30d: 4, last7d: 3, last24h: 2 },
    };

    const out = buildIncrementalStats({
      existing: drifted,
      removed: [],
      added: [],
      liveCount: 1700,
      generatedAt: GEN,
    });

    expect(out.totals.allTime).toBe(1700); // clamped up to liveCount
    expect(out.totals.allTime).toBeGreaterThanOrEqual(out.totals.last30d);
  });

  it("repairs a non-monotonic rolling chain (last7d < last24h)", () => {
    const empty = buildStatsPayload([], GEN);
    const drifted = {
      ...empty,
      totals: { allTime: 9000, last30d: 50, last7d: 10, last24h: 40 },
    };

    const out = buildIncrementalStats({
      existing: drifted,
      removed: [],
      added: [],
      liveCount: 100,
      generatedAt: GEN,
    });

    expect(out.totals.last7d).toBeGreaterThanOrEqual(out.totals.last24h);
    expect(out.totals.last30d).toBeGreaterThanOrEqual(out.totals.last7d);
    expect(out.totals.allTime).toBeGreaterThanOrEqual(out.totals.last30d);
  });
});
