import { describe, expect, it } from "vitest";
import { canonicalUrlKey, freshnessForSource, isDeterministicFallbackEntry } from "../.claude/skills/quality-audit/run.ts";
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
    expect(freshnessForSource(blogSource, [], Date.now()).status).toBe("ℹ️ no data");
  });

  it("source type 別 threshold で freshness を判定する", () => {
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
