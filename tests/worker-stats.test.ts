import { describe, expect, it } from "vitest";
import {
  buildStatsPayloadFromArtifacts,
  STATS_BUCKET_TIME_ZONE,
} from "../harness/publishers/stats-core.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  assertArchiveIndexBaseline,
  assertArchiveMonthBaseline,
  assertHistoryBaselinePair,
  parseArchiveIndexBaseline,
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

describe("archive and stats rebuild scope", () => {
  it("selects only new or changed index entries for archive writes", () => {
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

  it("inspects every indexed month plus incoming months on every rebuild", () => {
    const archiveIndex = {
      months: ["2026-03", "2026-06"],
      perMonth: { "2026-03": 10, "2026-06": 20 },
    };

    expect(selectArchiveInspectionMonths(archiveIndex, ["2026-07"])).toEqual([
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
      expect(parseArchiveIndexBaseline(null)).toBeNull();
    });

    it("rejects a present archive index with a falsy non-object payload", () => {
      for (const content of ["null", "false", "0"]) {
        expect(() => parseArchiveIndexBaseline({ content })).toThrow(
          "data/archive/_index.json: expected an object",
        );
      }
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

    it("rejects an archive index with inconsistent structural counts", () => {
      expect(() =>
        assertArchiveIndexBaseline({
          generatedAt: GEN,
          months: ["2026-06"],
          totalEntries: 41,
          perMonth: { "2026-06": 42 },
        }),
      ).toThrow("totalEntries 41 does not match perMonth total 42");

      expect(() =>
        assertArchiveIndexBaseline({
          generatedAt: GEN,
          months: ["2026-05"],
          totalEntries: 42,
          perMonth: { "2026-06": 42 },
        }),
      ).toThrow("months and perMonth keys must match");
    });

    it.each([
      [
        "month mismatch",
        { generatedAt: GEN, month: "2026-05", count: 1, entries: [entry("one", GEN)] },
        "month must equal 2026-06",
      ],
      [
        "negative count",
        { generatedAt: GEN, month: "2026-06", count: -1, entries: [] },
        "count must be a non-negative integer",
      ],
      [
        "count mismatch",
        { generatedAt: GEN, month: "2026-06", count: 500, entries: [] },
        "count 500 does not match entries length 0",
      ],
      [
        "index mismatch",
        { generatedAt: GEN, month: "2026-06", count: 1, entries: [entry("one", GEN)] },
        "archive index count 42 does not match month count 1",
      ],
    ])("rejects a malformed archive month baseline: %s", (_label, payload, message) => {
      expect(() =>
        assertArchiveMonthBaseline(
          "2026-06",
          { perMonth: { "2026-06": 42 } },
          { content: JSON.stringify(payload) },
        ),
      ).toThrow(message);
    });

    it("returns a validated archive month payload", () => {
      const payload = {
        generatedAt: GEN,
        month: "2026-06",
        count: 1,
        entries: [entry("one", GEN)],
      };

      expect(
        assertArchiveMonthBaseline(
          "2026-06",
          { perMonth: { "2026-06": 1 } },
          { content: JSON.stringify(payload) },
        ),
      ).toEqual(payload);
    });
  });

  it("rebuilds stats without carrying phantom baseline counts", () => {
    const live = entry("live", "2026-06-22T00:00:00.000Z");
    const archived = {
      ...entry("archive-only", "2026-05-20T00:00:00.000Z"),
      source: "archive-source",
    };

    const out = buildStatsPayloadFromArtifacts([live], [archived], GEN);

    expect(out.bucketTimeZone).toBe(STATS_BUCKET_TIME_ZONE);
    expect(out.totals.allTime).toBe(2);
    expect(out.bySource).toEqual([
      { source: "test-source", total: 1, last30d: 1 },
      { source: "archive-source", total: 1, last30d: 0 },
    ]);
    expect(out.bySource.some((bucket) => bucket.source === "phantom-source")).toBe(false);
  });

  it("uses the live entry when archive contains the same canonical URL", () => {
    const live = {
      ...entry("live", "2026-06-22T00:00:00.000Z", "research"),
      source: "live-source",
      url: "https://example.com/shared?utm_source=test",
    };
    const archived = {
      ...entry("archived", "2026-05-20T00:00:00.000Z"),
      source: "archive-source",
      url: "https://example.com/shared",
    };

    const out = buildStatsPayloadFromArtifacts([live], [archived], GEN);

    expect(out.totals.allTime).toBe(1);
    expect(out.bySource).toEqual([{ source: "live-source", total: 1, last30d: 1 }]);
    expect(out.byMonth).toEqual([
      { month: "2026-06", count: 1, byCategory: { research: 1 } },
    ]);
  });

  it("includes archive-only entries and dedupes copies across archive months", () => {
    const march = entry("shared-march", "2026-03-01T00:00:00.000Z");
    const june = {
      ...entry("shared-june", "2026-06-01T00:00:00.000Z"),
      url: march.url,
    };
    const archiveOnly = entry("archive-only", "2026-05-20T00:00:00.000Z");

    const out = buildStatsPayloadFromArtifacts([], [march, june, archiveOnly], GEN);

    expect(out.totals.allTime).toBe(2);
    expect(out.byMonth).toEqual([
      { month: "2026-03", count: 1, byCategory: { "tech-news": 1 } },
      { month: "2026-05", count: 1, byCategory: { "tech-news": 1 } },
    ]);
  });
});
