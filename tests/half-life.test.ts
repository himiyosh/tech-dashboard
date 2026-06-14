import { describe, expect, it } from "vitest";
import { decideTier } from "../harness/half-life.ts";

/**
 * Evergreen accumulation policy (R-022, user direction 2026-06-15):
 * best-practice / knowledge entries stay individually addressable ("warm")
 * after their Hot window and are never folded into the monthly /archive
 * aggregate ("cold") or dropped.
 */
describe("decideTier evergreen accumulation", () => {
  const NOW = new Date("2026-06-15T00:00:00.000Z");
  const daysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 86_400_000).toISOString();

  it("fresh evergreen entry is still hot during the hot window", () => {
    // architecture hot window = 60 days
    const tier = decideTier(
      { publishedAt: daysAgo(10), halfLife: "architecture", evergreen: true },
      NOW,
    );
    expect(tier).toBe("hot");
  });

  it("evergreen entry past the hot window accumulates as warm (never cold)", () => {
    // 200 days: past architecture hot(60) and into the warm/cold band.
    const tier = decideTier(
      { publishedAt: daysAgo(200), halfLife: "architecture", evergreen: true },
      NOW,
    );
    expect(tier).toBe("warm");
  });

  it("evergreen entry far past the cold threshold is still warm (never dropped)", () => {
    // 5000 days far exceeds architecture cold(3650).
    const tier = decideTier(
      { publishedAt: daysAgo(5000), halfLife: "architecture", evergreen: true },
      NOW,
    );
    expect(tier).toBe("warm");
  });

  it("evergreen never produces cold or dropped at any age", () => {
    for (const age of [0, 59, 60, 365, 1825, 3650, 99999]) {
      const tier = decideTier(
        { publishedAt: daysAgo(age), halfLife: "news", evergreen: true },
        NOW,
      );
      expect(tier === "hot" || tier === "warm", `age=${age} -> ${tier}`).toBe(true);
    }
  });

  it("non-evergreen entries still decay to cold then dropped (regression guard)", () => {
    // news: hot 14, warm 90, cold 730
    expect(decideTier({ publishedAt: daysAgo(5), halfLife: "news" }, NOW)).toBe("hot");
    expect(decideTier({ publishedAt: daysAgo(30), halfLife: "news" }, NOW)).toBe("warm");
    expect(decideTier({ publishedAt: daysAgo(200), halfLife: "news" }, NOW)).toBe("cold");
    expect(decideTier({ publishedAt: daysAgo(1000), halfLife: "news" }, NOW)).toBe("dropped");
  });
});
