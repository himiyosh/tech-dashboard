import { describe, expect, it } from "vitest";
import { freshnessThresholdFor, sourceFreshnessStatus } from "../web/src/lib/freshness.ts";

describe("source freshness thresholds", () => {
  it("release / changelog sources use a longer freshness window", () => {
    expect(freshnessThresholdFor({ category: "local-llm", sourceType: "release" })).toEqual({
      staleHrs: 24 * 30,
      errorHrs: 24 * 120,
    });
  });

  it("community sources become stale earlier than release sources", () => {
    const now = new Date("2026-05-10T12:00:00.000Z").getTime();

    expect(
      sourceFreshnessStatus(
        { category: "research", sourceType: "community" },
        "2026-05-02T12:00:00.000Z",
        now,
      ).status,
    ).toBe("stale");

    expect(
      sourceFreshnessStatus(
        { category: "local-llm", sourceType: "release" },
        "2026-05-02T12:00:00.000Z",
        now,
      ).status,
    ).toBe("ok");
  });
});