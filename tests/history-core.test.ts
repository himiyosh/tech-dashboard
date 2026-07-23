import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  groupArchiveEntries,
  mergeArchiveEntries,
  reconcileArchiveMonths,
  synchronizeArchiveTagsFromLive,
} from "../harness/publishers/archive-core.ts";
import { writeArchive } from "../harness/publishers/archive-builder.ts";
import {
  buildStatsPayload,
  statsDayCutoffKey,
  statsDayKey,
  statsMonthKey,
  STATS_BUCKET_TIME_ZONE,
} from "../harness/publishers/stats-core.ts";
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

  it("publishedAt 補正で月が変わった canonical entry は最終月だけに残す", () => {
    const oldMonth = fixtureEntry({
      id: "same-entry",
      title: "Original title",
      publishedAt: "2026-03-24T00:00:00.000Z",
      collectedAt: "2026-03-25T00:00:00.000Z",
      tags: ["original"],
    });

    const corrected = fixtureEntry({
      id: "same-entry",
      title: "Corrected title",
      publishedAt: "2026-07-20T19:23:10.000Z",
      collectedAt: "2026-07-21T00:00:00.000Z",
      tags: ["corrected"],
    });

    const reconciled = reconcileArchiveMonths([
      { month: "2026-03", entries: [oldMonth] },
      { month: "2026-07", entries: [corrected] },
    ]);

    expect(reconciled.has("2026-03")).toBe(false);
    expect(reconciled.get("2026-07")).toHaveLength(1);
    expect(reconciled.get("2026-07")?.[0]).toMatchObject({
      id: "same-entry",
      title: "Corrected title",
      tags: ["corrected", "original"],
    });
  });

  it("collection-time fallback より明示された公開日を優先する", () => {
    const explicit = fixtureEntry({
      id: "same-entry",
      title: "Authoritative date",
      publishedAt: "2026-04-02T00:00:00.000Z",
      collectedAt: "2026-04-03T00:00:00.000Z",
      tags: ["authoritative"],
    });
    const fallback = fixtureEntry({
      id: "same-entry",
      title: "Collection fallback",
      publishedAt: "2026-07-20T19:23:10.508Z",
      collectedAt: "2026-07-20T19:23:10.508Z",
      tags: ["fallback"],
    });

    const merged = mergeArchiveEntries([explicit], [fallback]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      title: "Authoritative date",
      publishedAt: "2026-04-02T00:00:00.000Z",
    });
    expect(merged[0].tags.sort()).toEqual(["authoritative", "fallback"]);
  });

  it("local archive writer moves corrected hot entries out of the stale month", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "techdb-archive-"));
    const archiveDir = join(dataDir, "archive");
    try {
      mkdirSync(archiveDir, { recursive: true });
      const existing = fixtureEntry({
        id: "moved-hot",
        url: "https://example.com/moved-hot",
        archiveTier: "hot",
        publishedAt: "2026-03-10T00:00:00.000Z",
        collectedAt: "2026-03-11T00:00:00.000Z",
      });
      const corrected = fixtureEntry({
        id: "moved-hot",
        url: "https://example.com/moved-hot",
        archiveTier: "hot",
        publishedAt: "2026-07-10T00:00:00.000Z",
        collectedAt: "2026-07-11T00:00:00.000Z",
      });
      writeFileSync(
        join(archiveDir, "2026-03.json"),
        JSON.stringify(
          buildArchiveMonthFile(
            "2026-03",
            [existing],
            "2026-03-11T00:00:00.000Z",
          ),
        ),
        { encoding: "utf8", flag: "wx" },
      );

      await writeArchive([corrected], dataDir);

      const march = JSON.parse(
        readFileSync(join(archiveDir, "2026-03.json"), "utf8"),
      ) as { entries: NormalizedEntry[] };
      const july = JSON.parse(
        readFileSync(join(archiveDir, "2026-07.json"), "utf8"),
      ) as { entries: NormalizedEntry[] };
      const index = JSON.parse(
        readFileSync(join(archiveDir, "_index.json"), "utf8"),
      ) as { months: string[]; totalEntries: number };
      expect(march.entries).toEqual([]);
      expect(july.entries.map((entry) => entry.id)).toEqual(["moved-hot"]);
      expect(index).toMatchObject({
        months: ["2026-07"],
        totalEntries: 1,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("archive merge の stale tag を final live taxonomy へ完全同期する", () => {
    const existing = fixtureEntry({
      id: "archive-id",
      url: "https://example.com/article?utm_source=archive",
      tags: ["agent", "obsolete"],
    });
    const incoming = fixtureEntry({
      id: "live-id",
      url: "https://example.com/article",
      tags: ["agent", "tutorial"],
    });

    const merged = mergeArchiveEntries([existing], [incoming]);
    expect(merged[0].tags).toEqual(["agent", "obsolete", "tutorial"]);

    const synchronized = synchronizeArchiveTagsFromLive(merged, [incoming]);

    expect(synchronized.changed).toBe(1);
    expect(synchronized.entries[0].tags).toEqual(["agent", "tutorial"]);
  });

  it("same canonical URL の全 archive copy を final live tags へ同期する", () => {
    const march = fixtureEntry({
      id: "shared-march",
      publishedAt: "2026-03-01T00:00:00.000Z",
      tags: ["agent", "obsolete"],
    });
    const june = fixtureEntry({
      id: "shared-june",
      publishedAt: "2026-06-01T00:00:00.000Z",
      tags: ["agent", "legacy"],
    });
    const live = fixtureEntry({
      id: "shared-live",
      publishedAt: "2026-06-01T00:00:00.000Z",
      tags: ["agent", "tutorial"],
    });

    const synchronized = synchronizeArchiveTagsFromLive([march, june], [live]);

    expect(synchronized.changed).toBe(2);
    expect(synchronized.entries.map((item) => item.tags)).toEqual([
      ["agent", "tutorial"],
      ["agent", "tutorial"],
    ]);
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

  it("archive index は空になった旧月を公開しない", () => {
    const generatedAt = "2026-05-10T00:00:00.000Z";
    const empty = buildArchiveMonthFile("2026-03", [], generatedAt);
    const april = buildArchiveMonthFile(
      "2026-04",
      [fixtureEntry({ id: "april" })],
      generatedAt,
    );

    expect(buildArchiveIndexFile([empty, april], generatedAt)).toMatchObject({
      months: ["2026-04"],
      totalEntries: 1,
      perMonth: { "2026-04": 1 },
    });
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
  it("JST midnight boundary keeps day and month buckets aligned", () => {
    expect(statsDayKey("2026-07-14T14:59:59.999Z")).toBe("2026-07-14");
    expect(statsDayKey("2026-07-14T15:00:00.000Z")).toBe("2026-07-15");
    expect(statsMonthKey("2026-07-31T14:59:59.999Z")).toBe("2026-07");
    expect(statsMonthKey("2026-07-31T15:00:00.000Z")).toBe("2026-08");

    const payload = buildStatsPayload(
      [
        fixtureEntry({ id: "before", publishedAt: "2026-07-14T14:59:59.999Z" }),
        fixtureEntry({ id: "after", publishedAt: "2026-07-14T15:00:00.000Z" }),
      ],
      "2026-07-15T00:00:00.000Z",
    );

    expect(payload.bucketTimeZone).toBe(STATS_BUCKET_TIME_ZONE);
    expect(payload.byDay.map(({ date, count }) => ({ date, count }))).toEqual([
      { date: "2026-07-14", count: 1 },
      { date: "2026-07-15", count: 1 },
    ]);
  });

  it("90-day retention keeps the complete JST cutoff day", () => {
    const generatedAt = "2026-07-15T10:01:00.000Z";
    expect(statsDayCutoffKey(generatedAt)).toBe("2026-04-16");

    const payload = buildStatsPayload(
      [
        fixtureEntry({ id: "before-exact-cutoff", publishedAt: "2026-04-16T09:00:00.000Z" }),
        fixtureEntry({ id: "after-exact-cutoff", publishedAt: "2026-04-16T11:00:00.000Z" }),
        fixtureEntry({ id: "previous-jst-day", publishedAt: "2026-04-15T14:59:59.999Z" }),
      ],
      generatedAt,
    );

    expect(payload.byDay.map(({ date, count }) => ({ date, count }))).toEqual([
      { date: "2026-04-16", count: 2 },
    ]);
  });

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