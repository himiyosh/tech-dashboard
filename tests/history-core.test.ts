import { describe, expect, it } from "vitest";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  groupArchiveEntries,
  mergeArchiveEntries,
} from "../harness/publishers/archive-core.ts";
import { buildStatsPayload } from "../harness/publishers/stats-core.ts";
import type { NormalizedEntry } from "../harness/types.ts";

function fixtureEntry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "entry-1",
    source: "fixture-source",
    sourceType: "blog",
    url: "https://example.com/article",
    title: "Fixture article",
    titleJa: "Fixture article",
    titleEn: "Fixture article",
    summaryJa: "summary",
    summaryEn: "summary",
    lang: "en",
    publishedAt: "2026-04-15T00:00:00.000Z",
    collectedAt: "2026-04-15T01:00:00.000Z",
    tags: ["fixture"],
    category: "tech-news",
    importance: 1,
    ...overrides,
  };
}

describe("archive-core", () => {
  it("warm/cold を月別 archive に振り分け、hot/dropped を集計から分離する", () => {
    const warm = fixtureEntry({ id: "warm", archiveTier: "warm" });
    const cold = fixtureEntry({ id: "cold", archiveTier: "cold", publishedAt: "2026-03-01T00:00:00.000Z" });
    const hot = fixtureEntry({ id: "hot", archiveTier: "hot" });
    const dropped = fixtureEntry({ id: "dropped", archiveTier: "dropped" });

    const { byMonth, stats } = groupArchiveEntries([warm, cold, hot, dropped]);

    expect([...byMonth.keys()].sort()).toEqual(["2026-03", "2026-04"]);
    expect(stats).toEqual({
      monthsTouched: 2,
      entriesArchived: 2,
      entriesDropped: 1,
      entriesSkippedHot: 1,
    });
  });

  it("includeHot: true で hot tier も月別 archive に含める", () => {
    const warm = fixtureEntry({ id: "warm", archiveTier: "warm" });
    const hot = fixtureEntry({ id: "hot", archiveTier: "hot" });
    const dropped = fixtureEntry({ id: "dropped", archiveTier: "dropped" });

    const { byMonth, stats } = groupArchiveEntries([warm, hot, dropped], { includeHot: true });

    const apr = byMonth.get("2026-04") ?? [];
    expect(apr.map((e) => e.id).sort()).toEqual(["hot", "warm"]);
    expect(stats.entriesArchived).toBe(2);
    expect(stats.entriesDropped).toBe(1);
    expect(stats.entriesSkippedHot).toBe(0);
  });

  it("同じ canonical URL は incoming が勝ち、publishedAt 降順で並ぶ", () => {
    const older = fixtureEntry({ id: "same", title: "old", publishedAt: "2026-04-10T00:00:00.000Z" });
    const newer = fixtureEntry({ id: "newer", url: "https://example.com/newer", publishedAt: "2026-04-20T00:00:00.000Z" });
    const updated = fixtureEntry({ id: "same", title: "updated", publishedAt: "2026-04-12T00:00:00.000Z" });

    const merged = mergeArchiveEntries([older, newer], [updated]);

    expect(merged.map((entry) => entry.id)).toEqual(["newer", "same"]);
    expect(merged.find((entry) => entry.id === "same")?.title).toBe("updated");
  });

  it("同じ URL が別 source/id で入っても archive では 1 件にまとめる", () => {
    const existing = fixtureEntry({
      id: "arxiv-lg",
      source: "arxiv-cs-lg",
      url: "https://arxiv.org/abs/2605.15334?utm_source=feed",
      summaryJa: "既存の日本語要約",
      summaryEn: "Existing English summary",
      tags: ["lg"],
      collectedAt: "2026-05-18T21:00:00.000Z",
      publishedAt: "2026-05-18T04:00:00.000Z",
    });
    const incoming = fixtureEntry({
      id: "arxiv-ai",
      source: "arxiv-cs-ai",
      url: "https://arxiv.org/abs/2605.15334",
      summaryJa: "",
      summaryEn: "",
      tags: ["ai"],
      collectedAt: "2026-05-20T00:00:00.000Z",
      publishedAt: "2026-05-19T04:00:00.000Z",
    });

    const merged = mergeArchiveEntries([existing], [incoming]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "arxiv-ai",
      source: "arxiv-cs-ai",
      summaryJa: "既存の日本語要約",
      summaryEn: "Existing English summary",
    });
    expect(merged[0].tags.sort()).toEqual(["ai", "lg"]);
  });

  it("archive index は月降順と件数を保持する", () => {
    const generatedAt = "2026-05-10T00:00:00.000Z";
    const april = buildArchiveMonthFile("2026-04", [fixtureEntry({ id: "april" })], generatedAt);
    const march = buildArchiveMonthFile(
      "2026-03",
      [fixtureEntry({ id: "march-1" }), fixtureEntry({ id: "march-2" })],
      generatedAt,
    );

    const archiveIndex = buildArchiveIndexFile([march, april], generatedAt);

    expect(archiveIndex.months).toEqual(["2026-04", "2026-03"]);
    expect(archiveIndex.totalEntries).toBe(3);
    expect(archiveIndex.perMonth).toEqual({ "2026-04": 1, "2026-03": 2 });
  });

  it("archive month payload は一覧表示に不要な本文を保持しない", () => {
    const payload = buildArchiveMonthFile(
      "2026-04",
      [fixtureEntry({ bodyJa: "長い本文", bodyEn: "Long body" })],
      "2026-05-10T00:00:00.000Z",
    );

    expect(payload.entries[0].summaryJa).toBe("summary");
    expect(payload.entries[0].bodyJa).toBeUndefined();
    expect(payload.entries[0].bodyEn).toBeUndefined();
  });

  it("publishedAt が null の entry は collectedAt の月へ入れる", () => {
    const entry = fixtureEntry({
      id: "collected-fallback",
      archiveTier: "warm",
      publishedAt: null,
      collectedAt: "2026-02-28T23:30:00.000Z",
    });

    const { byMonth } = groupArchiveEntries([entry]);

    expect([...byMonth.keys()]).toEqual(["2026-02"]);
  });
});

describe("stats-core", () => {
  it("archive を含む entry 配列から日次・月次・source 集計を作る", () => {
    const generatedAt = "2026-05-10T00:00:00.000Z";
    const entries = [
      fixtureEntry({ id: "today", source: "alpha", category: "copilot", importance: 3, publishedAt: generatedAt }),
      fixtureEntry({ id: "week", source: "alpha", category: "claude", importance: 2, publishedAt: "2026-05-06T00:00:00.000Z" }),
      fixtureEntry({ id: "archive", source: "beta", category: "research", importance: 1, publishedAt: "2026-03-01T00:00:00.000Z" }),
    ];

    const stats = buildStatsPayload(entries, generatedAt);

    expect(stats.totals).toEqual({ allTime: 3, last30d: 2, last7d: 2, last24h: 1 });
    expect(stats.byMonth.map((bucket) => bucket.month)).toEqual(["2026-03", "2026-05"]);
    expect(stats.bySource[0]).toEqual({ source: "alpha", total: 2, last30d: 2 });
    expect(stats.byImportance).toEqual({ "1": 1, "2": 1, "3": 1 });
  });

  it("90 日より古い entry は byDay から外し、byMonth には残す", () => {
    const generatedAt = "2026-05-10T00:00:00.000Z";
    const old = fixtureEntry({ id: "old", publishedAt: "2026-01-01T00:00:00.000Z" });

    const stats = buildStatsPayload([old], generatedAt);

    expect(stats.byDay).toEqual([]);
    expect(stats.byMonth.map((bucket) => bucket.month)).toEqual(["2026-01"]);
    expect(stats.totals.allTime).toBe(1);
  });
});