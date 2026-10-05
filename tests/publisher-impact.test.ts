import { describe, expect, it } from "vitest";
import {
  PUBLISHER_DATA_PATH_RE,
  MAX_DETAIL_ROUTE_GROWTH_PER_RUN,
  assertPublisherImpactGrowth,
  buildPublisherImpactPlan,
  formatPublisherImpactMarkdown,
} from "../scripts/publisher-impact.ts";
import {
  parsePublicationApprovalManifest,
  type PublicationApprovalManifest,
} from "../web/src/lib/publication-gate.ts";
import { BODY_SHARD_PATHS, serializeBodyShards, splitBodyShards } from "../web/src/lib/body-shards.ts";
import { bodyShardDigests } from "../web/src/lib/body-shard-integrity.ts";

const HEX = {
  changed: "00000000000000c1",
  body: "00000000000000b1",
  removed: "00000000000000d1",
  unchanged: "00000000000000u1".replace("u", "a"),
  warm: "00000000000000e1",
  fresh: "00000000000000f1",
} as const;

/**
 * The gate is data-driven, so the fixture manifest is too: every id the older
 * assertions expect to stay addressable is baselined, and `fresh` is left out
 * so a brand-new entry proves the planner withholds it.
 */
function manifest(
  overrides: Partial<PublicationApprovalManifest> = {},
): PublicationApprovalManifest {
  return parsePublicationApprovalManifest({
    version: 1,
    dailyReleaseLimit: 12,
    baseline: {
      capturedAt: "2026-08-11T00:00:00Z",
      ids: [HEX.changed, HEX.body, HEX.removed, HEX.unchanged, HEX.warm],
    },
    approvals: [],
    ...overrides,
  });
}

function entry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: "official-blog",
    sourceType: "blog",
    url: `https://example.com/${id}`,
    title: `Entry ${id}`,
    titleJa: `記事 ${id}`,
    titleEn: `Entry ${id}`,
    summaryJa: `記事 ${id} の有効な日本語要約です。`,
    summaryEn: `A usable English summary for entry ${id}.`,
    lang: "en",
    publishedAt: "2026-08-12T00:00:00.000Z",
    collectedAt: "2026-08-12T00:10:00.000Z",
    tags: ["agent"],
    category: "agent-fw",
    importance: 2,
    archiveTier: "hot",
    ...overrides,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function files(values: Record<string, unknown>): Map<string, string | null> {
  return new Map(Object.entries(values).map(([path, value]) => {
    if (/^data\/bodies(?:-[0-3])?\.json$/.test(path)
      && value && typeof value === "object" && "bodies" in value) {
      const bodies = (value as { bodies: Record<string, unknown> }).bodies;
      return [path, json({
        generatedAt: "2026-08-12T00:00:00.000Z",
        count: Object.keys(bodies).length,
        ...value,
      })];
    }
    return [path, json(value)];
  }));
}

describe("Publisher incremental impact plan", () => {
  it("allows only versioned monthly update artifacts and declares both public route families", () => {
    for (const path of BODY_SHARD_PATHS) expect(PUBLISHER_DATA_PATH_RE.test(path)).toBe(true);
    expect(PUBLISHER_DATA_PATH_RE.test("data/bodies-4.json")).toBe(false);
    expect(PUBLISHER_DATA_PATH_RE.test("data/bodies-0/../secret.json")).toBe(false);
    expect(PUBLISHER_DATA_PATH_RE.test("data/updates/_index.json")).toBe(true);
    expect(PUBLISHER_DATA_PATH_RE.test("data/updates/2026-10.json")).toBe(true);
    expect(PUBLISHER_DATA_PATH_RE.test("data/updates/../secrets.json")).toBe(false);
    const beforeFiles = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [] },
      "data/updates/_index.json": { schemaVersion: 1 },
    });
    const afterFiles = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [] },
      "data/updates/_index.json": { schemaVersion: 1 },
      "data/updates/2026-10.json": { events: [] },
    });
    const impact = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "a".repeat(40),
      beforeFiles,
      afterFiles,
      changedPaths: ["data/updates/_index.json", "data/updates/2026-10.json"],
    });
    expect(impact.routeFamilies).toEqual(expect.arrayContaining(["major-rss", "update-json"]));
    expect(impact.changedEntryIds).toEqual([]);
  });
  it("keeps an entry-only change scoped to that detail while declaring all affected aggregates", () => {
    const beforeEntry = entry("00000000000000c1");
    const afterEntry = entry("00000000000000c1", { summaryEn: "Updated usable summary." });
    const beforeFiles = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [beforeEntry] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });
    const afterFiles = files({
      "data/index.json": { generatedAt: "2026-08-12T01:00:00Z", entries: [afterEntry] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });

    const plan = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "a".repeat(40),
      beforeFiles,
      afterFiles,
      changedPaths: ["data/index.json"],
    });

    expect(plan.changedEntryIds).toEqual(["00000000000000c1"]);
    expect(plan.changedBodyIds).toEqual([]);
    expect(plan.affectedCategories).toEqual(["agent-fw"]);
    expect(plan.affectedTags).toEqual(["agent"]);
    expect(plan.routeFamilies).toEqual(expect.arrayContaining([
      "detail-pages",
      "home",
      "timeline-pagination",
      "category-pages",
      "tag-pages-and-recovery",
      "feeds",
      "sitemap",
      "search-index",
    ]));
    expect(plan.requiresFullStaticReconciliation).toBe(true);
    expect(plan.incremental).toMatchObject({
      detailMode: "global",
      searchMode: "global",
      shadowSafe: false,
    });
    expect(plan.incremental.blockers).toEqual(expect.arrayContaining([
      "detail-pages-embed-global-entry-and-health-state",
      "pagefind-requires-global-reconciliation",
    ]));
  });

  it("does not mark unrelated aggregate pages for a body-only change", () => {
    const base = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [entry("00000000000000b1")] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });
    const after = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [entry("00000000000000b1")] },
      "data/bodies.json": {
        bodies: { "00000000000000b1": { bodyJa: "本文", bodyEn: "Body" } },
      },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });
    const plan = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "b".repeat(40),
      beforeFiles: base,
      afterFiles: after,
      changedPaths: ["data/bodies.json"],
    });

    expect(plan.changedEntryIds).toEqual([]);
    expect(plan.changedBodyIds).toEqual(["00000000000000b1"]);
    // A body change now moves the sitemap too: gaining or losing a body flips
    // the entry between indexable and noindex, so sitemap.xml must rebuild.
    expect(plan.routeFamilies).toEqual(["detail-pages", "search-index", "sitemap"]);
    expect(plan.routeFamilies).not.toContain("category-pages");
    expect(plan.routeFamilies).not.toContain("archive");
    expect(plan.routeFamilies).not.toContain("home");
    expect(plan.incremental).toEqual({
      detailMode: "exact",
      detailUpsertIds: ["00000000000000b1"],
      detailTombstoneIds: [],
      detailPaths: ["/e/00000000000000b1/"],
      searchMode: "delta",
      searchDeltaIds: ["00000000000000b1"],
      shadowSafe: true,
      blockers: [],
    });
  });

  it("treats a lossless legacy-to-shard commit as a full reconciliation, not 1,000 changed articles", () => {
    const record = { bodyJa: "実際の本文。", bodyEn: "A real article." };
    const legacy = {
      generatedAt: "2026-08-12T00:00:00.000Z",
      count: 1,
      bodies: { [HEX.body]: record },
    };
    const parts = splitBodyShards(legacy);
    const before = files({
      "data/index.json": { generatedAt: legacy.generatedAt, entries: [entry(HEX.body)] },
      "data/bodies.json": legacy,
    });
    const after = files({
      "data/index.json": { generatedAt: legacy.generatedAt, entries: [entry(HEX.body)] },
      "data/bodies.json": legacy,
      ...Object.fromEntries(BODY_SHARD_PATHS.map((path, index) => [path, parts[index]])),
    });
    const plan = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "b".repeat(40),
      beforeFiles: before,
      afterFiles: after,
      changedPaths: BODY_SHARD_PATHS,
    });
    expect(plan.changedBodyIds).toEqual([]);
    expect(plan.incremental.shadowSafe).toBe(false);
    expect(plan.incremental.blockers).toContain("body-storage-migration-requires-full-reconciliation");
    expect(plan.fullReconciliationReasons).toContain("body-storage-migration-requires-full-reconciliation");
  });

  it("rejects missing or mixed shards when the index declares sharded storage", () => {
    const baseline = {
      generatedAt: "2026-08-12T00:00:00.000Z",
      count: 1,
      bodies: {
        [HEX.body]: { bodyJa: "実際の本文。", bodyEn: "A real article." },
      },
    };
    const shards = serializeBodyShards(baseline);
    const modeIndex = {
      generatedAt: baseline.generatedAt,
      entries: [entry(HEX.body)],
      health: {
        bodyStorageMode: "shards-v1",
        bodyShardDigests: bodyShardDigests(shards.map((file) => file.content)),
      },
    };
    const before = files({ "data/index.json": modeIndex, "data/bodies.json": baseline });
    expect(() => buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "c".repeat(40),
      beforeFiles: before,
      afterFiles: before,
      changedPaths: [],
    })).toThrow(/body shards required by the index/);

    const mixed = new Map(before);
    for (const file of shards) mixed.set(file.path, file.content);
    mixed.set(shards[0]!.path, `${shards[0]!.content}\n`);
    expect(() => buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "c".repeat(40),
      beforeFiles: files({ "data/index.json": { entries: [entry(HEX.body)] }, "data/bodies.json": baseline }),
      afterFiles: mixed,
      changedPaths: BODY_SHARD_PATHS,
    })).toThrow(/body shard digest mismatch/);
  });

  it("tracks an individual shard write as an exact body/search delta", () => {
    const baseline = {
      generatedAt: "2026-08-12T00:00:00.000Z",
      count: 0,
      bodies: {},
    };
    const next = {
      ...baseline,
      count: 1,
      bodies: { [HEX.body]: { bodyJa: "実際の本文。", bodyEn: "A real article." } },
    };
    const before = files(Object.fromEntries(
      BODY_SHARD_PATHS.map((path, index) => [path, splitBodyShards(baseline)[index]]),
    ));
    const after = files(Object.fromEntries(
      BODY_SHARD_PATHS.map((path, index) => [path, splitBodyShards(next)[index]]),
    ));
    before.set("data/index.json", json({ generatedAt: baseline.generatedAt, entries: [entry(HEX.body)] }));
    after.set("data/index.json", json({ generatedAt: baseline.generatedAt, entries: [entry(HEX.body)] }));
    const changedPath = BODY_SHARD_PATHS.find((_path, index) =>
      splitBodyShards(next)[index]?.count === 1);
    expect(changedPath).toBeDefined();
    const plan = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "c".repeat(40),
      beforeFiles: before,
      afterFiles: after,
      changedPaths: [changedPath!],
    });
    expect(plan.changedBodyIds).toEqual([HEX.body]);
    expect(plan.incremental).toMatchObject({
      detailMode: "exact",
      searchMode: "delta",
      searchDeltaIds: [HEX.body],
      shadowSafe: true,
    });
    expect(() => buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "c".repeat(40),
      beforeFiles: before,
      afterFiles: new Map([[changedPath!, after.get(changedPath!)!]]),
      changedPaths: [changedPath!],
    })).toThrow(/incomplete body shard set/);
  });

  it("emits a tombstone when an addressable detail leaves the final snapshot", () => {
    const removed = entry("00000000000000d1", { archiveTier: "warm" });
    const before = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [removed] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });
    const after = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });

    const plan = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "f".repeat(40),
      beforeFiles: before,
      afterFiles: after,
      changedPaths: ["data/index.json"],
    });

    expect(plan.incremental.detailTombstoneIds).toEqual(["00000000000000d1"]);
    expect(plan.incremental.detailUpsertIds).toEqual([]);
    expect(plan.incremental.detailPaths).toEqual(["/e/00000000000000d1/"]);
    expect(plan.incremental.shadowSafe).toBe(false);
  });

  it("tracks archive month invalidation without unrelated IDs", () => {
    const unchanged = entry("00000000000000a1");
    const oldWarm = entry("00000000000000e1", { archiveTier: "warm", summaryEn: "Old summary." });
    const newWarm = entry("00000000000000e1", { archiveTier: "warm", summaryEn: "New summary." });
    const beforeFiles = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [unchanged] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
      "data/archive/2026-08.json": { entries: [oldWarm] },
    });
    const afterFiles = files({
      "data/index.json": { generatedAt: "2026-08-12T00:00:00Z", entries: [unchanged] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
      "data/archive/2026-08.json": { entries: [newWarm] },
    });
    const plan = buildPublisherImpactPlan({
      approvalManifest: manifest(),
      baseRef: "c".repeat(40),
      beforeFiles,
      afterFiles,
      changedPaths: ["data/archive/2026-08.json"],
    });

    expect(plan.changedEntryIds).toEqual(["00000000000000e1"]);
    expect(plan.changedEntryIds).not.toContain("unchanged");
    expect(plan.changedArchiveMonths).toEqual(["2026-08"]);
    expect(plan.routeFamilies).toEqual(expect.arrayContaining([
      "archive",
      "detail-pages",
      "sitemap",
      "search-index",
    ]));
  });

  it("fails closed on a per-run detail route growth anomaly", () => {
    const plan = {
      version: 2 as const,
      baseRef: "d".repeat(40),
      changedDataPaths: ["data/index.json"],
      changedEntryIds: [],
      changedBodyIds: [],
      changedArchiveMonths: [],
      affectedCategories: [],
      affectedTags: [],
      routeFamilies: [],
      requiresFullStaticReconciliation: true,
      fullReconciliationReasons: [],
      before: { detailRoutes: 1, tagBaseRoutes: 1, archiveMonths: 1 },
      after: {
        detailRoutes: 2 + MAX_DETAIL_ROUTE_GROWTH_PER_RUN,
        tagBaseRoutes: 1,
        archiveMonths: 1,
      },
      growth: {
        detailRoutes: 1 + MAX_DETAIL_ROUTE_GROWTH_PER_RUN,
        tagBaseRoutes: 0,
        archiveMonths: 0,
      },
      incremental: {
        detailMode: "none" as const,
        detailUpsertIds: [],
        detailTombstoneIds: [],
        detailPaths: [],
        searchMode: "none" as const,
        searchDeltaIds: [],
        shadowSafe: false,
        blockers: [],
      },
    };
    expect(() => assertPublisherImpactGrowth(plan)).toThrow(
      /route-family growth anomaly: detailRoutes/,
    );
  });

  it("formats a bounded workflow summary", () => {
    const text = formatPublisherImpactMarkdown({
      version: 2,
      baseRef: "e".repeat(40),
      changedDataPaths: ["data/index.json"],
      changedEntryIds: ["entry-1"],
      changedBodyIds: [],
      changedArchiveMonths: [],
      affectedCategories: ["copilot"],
      affectedTags: ["agent"],
      routeFamilies: ["home"],
      requiresFullStaticReconciliation: true,
      fullReconciliationReasons: ["index-health-and-snapshot-are-imported-by-the-static-shell"],
      before: { detailRoutes: 10, tagBaseRoutes: 2, archiveMonths: 1 },
      after: { detailRoutes: 11, tagBaseRoutes: 2, archiveMonths: 1 },
      growth: { detailRoutes: 1, tagBaseRoutes: 0, archiveMonths: 0 },
      incremental: {
        detailMode: "global",
        detailUpsertIds: ["entry-1"],
        detailTombstoneIds: [],
        detailPaths: ["/e/entry-1/"],
        searchMode: "global",
        searchDeltaIds: [],
        shadowSafe: false,
        blockers: ["pagefind-requires-global-reconciliation"],
      },
    });
    expect(text).toContain("Changed detail entries: 1");
    expect(text).toContain("Full static reconciliation required: yes");
    expect(text).toContain("Route growth: detail +1");
    expect(text).toContain("Incremental detail mode: global (1 paths)");
    expect(text).toContain("Shadow-safe slice: no");
  });
});
