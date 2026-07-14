import { describe, expect, it } from "vitest";
import {
  formatExactReactionCount,
  formatReactionCount,
} from "../web/src/lib/reactions-client.ts";

describe("reaction count formatting", () => {
  it("keeps small values exact and compacts large visible counts", () => {
    expect(formatReactionCount(0)).toBe("0");
    expect(formatReactionCount(999)).toBe("999");
    expect(formatReactionCount(1_000)).toBe("1K");
    expect(formatReactionCount(1_200)).toBe("1.2K");
    expect(formatReactionCount(999_999)).toBe("1M");
    expect(formatReactionCount(1_000_000)).toBe("1M");
    expect(formatReactionCount(Number.MAX_SAFE_INTEGER).length).toBeLessThanOrEqual(8);
  });

  it("keeps the localized exact count available to assistive technology", () => {
    expect(formatExactReactionCount(1_234, "ja")).toBe("1,234件");
    expect(formatExactReactionCount(1_234, "en")).toBe("1,234 likes");
  });

  it("normalizes invalid values without exposing unsafe count text", () => {
    expect(formatReactionCount(-1)).toBe("0");
    expect(formatReactionCount(Number.NaN)).toBe("0");
    expect(formatExactReactionCount(Number.POSITIVE_INFINITY, "en")).toBe("0 likes");
  });
});
