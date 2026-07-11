import { describe, expect, it } from "vitest";
import {
  canonicalUrlKey,
  freshnessForSource,
  isDeterministicFallbackEntry,
  summarizeAuditSeverity,
} from "../.claude/skills/quality-audit/run.ts";
import type { SourceDefinition } from "../harness/types.ts";

const blogSource: SourceDefinition = {
  id: "example-blog",
  displayName: "Example Blog",
  category: "codex",
  sourceType: "blog",
  defaultLang: "en",
  autoTags: [],
  feedUrl: "https://example.com/feed.xml",
  collect: async () => [],
  tier: 1,
};

const releaseSource: SourceDefinition = {
  ...blogSource,
  id: "example-release",
  displayName: "Example Releases",
  sourceType: "release",
};

const communitySource: SourceDefinition = {
  ...blogSource,
  id: "example-community",
  displayName: "Example Community",
  sourceType: "community",
};

describe("quality-audit URL canonical key", () => {
  it("tracking query だけを取り除いて同一記事として扱う", () => {
    expect(canonicalUrlKey("https://example.com/posts/a?utm_source=newsletter&utm_medium=email")).toBe(
      "example.com/posts/a",
    );
    expect(canonicalUrlKey("https://example.com/posts/a?id=42&utm_source=newsletter")).toBe(
      "example.com/posts/a?id=42",
    );
  });

  it("YouTube watch URL は video id を保持する", () => {
    expect(canonicalUrlKey("https://www.youtube.com/watch?v=abc123&t=42s&utm_source=x")).toBe(
      "youtube.com/watch?v=abc123",
    );
    expect(canonicalUrlKey("https://m.youtube.com/watch?v=xyz789")).toBe("youtube.com/watch?v=xyz789");
  });

  it("異なる YouTube 動画を重複候補としてまとめない", () => {
    expect(canonicalUrlKey("https://www.youtube.com/watch?v=abc123")).not.toBe(
      canonicalUrlKey("https://www.youtube.com/watch?v=xyz789"),
    );
  });
});

describe("quality-audit freshness", () => {
  it("publishedAt が古くても collectedAt が新しければ stale 扱いしない", () => {
    const now = new Date("2026-05-10T12:00:00.000Z").getTime();
    const freshness = freshnessForSource(
      blogSource,
      [
        {
          publishedAt: "2026-04-01T00:00:00.000Z",
          collectedAt: "2026-05-10T10:00:00.000Z",
        },
      ],
      now,
    );

    expect(freshness.latestPublished).toBe("2026-04-01T00:00:00.000Z");
    expect(freshness.latestCollected).toBe("2026-05-10T10:00:00.000Z");
    expect(freshness.ageHrs).toBe(2);
    expect(freshness.status).toBe("✅ ok");
  });

  it("data 未出現 source は warning ではなく informational として扱う", () => {
    expect(freshnessForSource(blogSource, [], Date.now()).status).toBe("ℹ️ no listed entry");
  });

  it("source type 別 threshold で retained entry activity を判定する", () => {
    const now = new Date("2026-05-10T12:00:00.000Z").getTime();
    const entries = [
      {
        publishedAt: "2026-05-02T12:00:00.000Z",
        collectedAt: "2026-05-02T12:00:00.000Z",
      },
    ];

    expect(freshnessForSource(releaseSource, entries, now).status).toBe("✅ ok");
    expect(freshnessForSource(communitySource, entries, now).status).toBe("🟠 stale");
  });

  it("retained source with very old collectedAt is reported as inactive, not critical error", () => {
    const now = new Date("2026-05-10T12:00:00.000Z").getTime();
    const entries = [
      {
        publishedAt: "2026-03-01T12:00:00.000Z",
        collectedAt: "2026-03-01T12:00:00.000Z",
      },
    ];

    expect(freshnessForSource(blogSource, entries, now).status).toBe("🟠 inactive");
  });
});

describe("quality-audit severity summary", () => {
  it("groups multiple inactive retained sources into one warning when aggregate run is healthy", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 14,
        sourcesFailed: [],
      },
      freshnessRows: [{ status: "🟠 inactive" }, { status: "🟠 inactive" }, { status: "🟠 stale" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 0, warning: 1, minor: 0 });
  });

  it("treats all attempted sources failing as critical", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 0,
        sourcesFailed: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"],
      },
      freshnessRows: [],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it("treats an explicit all-failed list as critical when sourcesOk is missing", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 3,
        sourcesFailed: ["a", "b", "c"],
      },
      freshnessRows: [],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it("treats partial aggregate source failures as one warning", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 12,
        sourcesFailed: ["foo", "bar"],
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 0, warning: 1, minor: 0 });
  });

  it("rejects aggregate telemetry when sourcesFailed is omitted", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 11,
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it.each([
    [
      "sourcesAttempted",
      {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesOk: 14,
        sourcesFailed: [],
      },
    ],
    [
      "sourcesOk",
      {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesFailed: [],
      },
    ],
  ])("rejects aggregate telemetry when %s is missing", (_field, health) => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health,
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it("treats a stale aggregate run as critical", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T01:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 14,
        sourcesFailed: [],
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it("does not add severity for a current healthy aggregate run", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 14,
        sourcesFailed: [],
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 0, warning: 0, minor: 0 });
  });

  it("treats summarize-disabled runs as one warning", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        copilotOk: false,
        sourcesAttempted: 14,
        sourcesOk: 14,
        sourcesFailed: [],
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 0, warning: 1, minor: 0 });
  });

  it("rejects aggregate telemetry when copilotOk is missing", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "2026-05-10T10:00:00.000Z",
        sourcesAttempted: 14,
        sourcesOk: 14,
        sourcesFailed: [],
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it("treats health telemetry without lastRunAt as critical", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: { sourcesAttempted: 14, sourcesOk: 14, sourcesFailed: [] },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });

  it("treats invalid lastRunAt telemetry as critical", () => {
    expect(summarizeAuditSeverity({
      indexCount: 100,
      health: {
        lastRunAt: "not-a-date",
        copilotOk: true,
        sourcesAttempted: 14,
        sourcesOk: 14,
        sourcesFailed: [],
      },
      freshnessRows: [{ status: "✅ ok" }],
      emptyCategoryCount: 0,
      extraSourceCount: 0,
      summaryCoveragePct: 95,
      fallbackPct: 0,
      fallbackCount: 0,
      tagVariationCount: 0,
      dupCandidateCount: 0,
      nowMs: Date.parse("2026-05-10T12:00:00.000Z"),
    })).toEqual({ critical: 1, warning: 0, minor: 0 });
  });
});

describe("quality-audit fallback detection", () => {
  it("detects deterministic fallback summaries as quality debt", () => {
    expect(
      isDeterministicFallbackEntry({
        summaryJa: "このエントリは arxiv-cs-ai から収集した research 領域の最新アップデートです。",
        summaryEn: "AI summary not yet available.",
        bodyJa: "",
        bodyEn: "",
      }),
    ).toBe(true);
  });

  it("does not flag real bilingual summaries", () => {
    expect(
      isDeterministicFallbackEntry({
        summaryJa: "モデル評価手法の改善点を紹介しています。",
        summaryEn: "The article introduces improvements to model evaluation.",
        bodyJa: "本文",
        bodyEn: "Body",
      }),
    ).toBe(false);
  });
});
