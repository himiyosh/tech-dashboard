import { describe, expect, it } from "vitest";
import {
  MAX_DETAIL_ROUTE_GROWTH_PER_RUN,
  assertPublisherImpactGrowth,
  buildPublisherImpactPlan,
  formatPublisherImpactMarkdown,
} from "../scripts/publisher-impact.ts";

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
  return new Map(Object.entries(values).map(([path, value]) => [path, json(value)]));
}

describe("Publisher incremental impact plan", () => {
  it("keeps an entry-only change scoped to that detail while declaring all affected aggregates", () => {
    const beforeEntry = entry("changed");
    const afterEntry = entry("changed", { summaryEn: "Updated usable summary." });
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
      baseRef: "a".repeat(40),
      beforeFiles,
      afterFiles,
      changedPaths: ["data/index.json"],
    });

    expect(plan.changedEntryIds).toEqual(["changed"]);
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
  });

  it("does not mark unrelated aggregate pages for a body-only change", () => {
    const base = files({
      "data/index.json": { entries: [entry("body-entry")] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });
    const after = files({
      "data/index.json": { entries: [entry("body-entry")] },
      "data/bodies.json": {
        bodies: { "body-entry": { bodyJa: "本文", bodyEn: "Body" } },
      },
      "data/stats.json": {},
      "data/archive/_index.json": {},
    });
    const plan = buildPublisherImpactPlan({
      baseRef: "b".repeat(40),
      beforeFiles: base,
      afterFiles: after,
      changedPaths: ["data/bodies.json"],
    });

    expect(plan.changedEntryIds).toEqual([]);
    expect(plan.changedBodyIds).toEqual(["body-entry"]);
    expect(plan.routeFamilies).toEqual(["detail-pages", "search-index"]);
    expect(plan.routeFamilies).not.toContain("category-pages");
    expect(plan.routeFamilies).not.toContain("archive");
    expect(plan.routeFamilies).not.toContain("home");
  });

  it("tracks archive month invalidation without unrelated IDs", () => {
    const unchanged = entry("unchanged");
    const oldWarm = entry("warm", { archiveTier: "warm", summaryEn: "Old summary." });
    const newWarm = entry("warm", { archiveTier: "warm", summaryEn: "New summary." });
    const beforeFiles = files({
      "data/index.json": { entries: [unchanged] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
      "data/archive/2026-08.json": { entries: [oldWarm] },
    });
    const afterFiles = files({
      "data/index.json": { entries: [unchanged] },
      "data/bodies.json": { bodies: {} },
      "data/stats.json": {},
      "data/archive/_index.json": {},
      "data/archive/2026-08.json": { entries: [newWarm] },
    });
    const plan = buildPublisherImpactPlan({
      baseRef: "c".repeat(40),
      beforeFiles,
      afterFiles,
      changedPaths: ["data/archive/2026-08.json"],
    });

    expect(plan.changedEntryIds).toEqual(["warm"]);
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
      version: 1 as const,
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
    };
    expect(() => assertPublisherImpactGrowth(plan)).toThrow(
      /route-family growth anomaly: detailRoutes/,
    );
  });

  it("formats a bounded workflow summary", () => {
    const text = formatPublisherImpactMarkdown({
      version: 1,
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
    });
    expect(text).toContain("Changed detail entries: 1");
    expect(text).toContain("Full static reconciliation required: yes");
    expect(text).toContain("Route growth: detail +1");
  });
});
