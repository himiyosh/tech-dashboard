import { describe, expect, it } from "vitest";
import { buildStatsPayload } from "../harness/publishers/stats-core.ts";
import { buildIncrementalStats } from "../worker/src/index.ts";

const GEN = "2026-06-23T00:00:00.000Z";

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
