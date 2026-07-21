import { describe, expect, it } from "vitest";
import { normalizeKnownProductNames } from "../harness/pipeline/product-name.ts";
import type { NormalizedEntry } from "../harness/types.ts";

function entry(overrides: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return {
    id: "quick-entry",
    source: "aws-ml-blog",
    sourceType: "blog",
    url: "https://aws.amazon.com/blogs/machine-learning/example/",
    title: "Build agent workflows with Amazon Quick",
    titleJa: "Amazon QuickSightでエージェントを構築する",
    titleEn: "Build agent workflows with Amazon Quick",
    summaryJa: "Amazon QuickSightを活用する。",
    summaryEn: "Amazon QuickSight supports agent workflows.",
    lang: "en",
    publishedAt: "2026-07-20T00:00:00.000Z",
    collectedAt: "2026-07-20T01:00:00.000Z",
    tags: ["aws"],
    category: "agent-fw",
    importance: 2,
    archiveTier: "hot",
    ...overrides,
  };
}

describe("known product-name normalization", () => {
  it("keeps Amazon Quick distinct from Amazon Quick Sight", () => {
    const normalized = normalizeKnownProductNames(entry());
    expect(normalized.titleJa).toBe("Amazon Quickでエージェントを構築する");
    expect(normalized.summaryJa).toBe("Amazon Quickを活用する。");
    expect(normalized.summaryEn).toBe("Amazon Quick supports agent workflows.");
  });

  it("does not rewrite articles whose source title names Amazon Quick Sight", () => {
    const original = entry({
      title: "Build dashboards with Amazon Quick Sight",
      titleJa: "Amazon QuickSightでダッシュボードを構築する",
    });
    expect(normalizeKnownProductNames(original)).toBe(original);
  });

  it("repairs compact archive entries without requiring omitted summaries", () => {
    expect(normalizeKnownProductNames({
      source: "aws-ml-blog",
      title: "Build agent workflows with Amazon Quick",
      titleJa: "Amazon QuickSightでエージェントを構築する",
    })).toEqual({
      source: "aws-ml-blog",
      title: "Build agent workflows with Amazon Quick",
      titleJa: "Amazon Quickでエージェントを構築する",
    });
  });
});
