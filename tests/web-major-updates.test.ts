import { describe, expect, it } from "vitest";
import { buildArticleSharePayload } from "../web/src/lib/article-share.ts";
import type { NormalizedEntry } from "../web/src/lib/data.ts";
import { selectMajorUpdates } from "../web/src/lib/major-updates.ts";

const SNAPSHOT = "2026-09-25T06:00:00.000Z";

function entry(overrides: Partial<NormalizedEntry> = {}): NormalizedEntry {
  return {
    id: "opus-announcement",
    publicationHold: false,
    source: "anthropic-news",
    sourceType: "blog",
    url: "https://example.com/opus-announcement",
    title: "Introducing Claude Opus 5",
    titleJa: "Claude Opus 5 を発表",
    titleEn: "Introducing Claude Opus 5",
    summaryJa: "新しいモデルの提供と主な機能を発表しました。",
    summaryEn: "The new model is available with updated capabilities.",
    lang: "en",
    publishedAt: "2026-09-24T05:00:00.000Z",
    collectedAt: "2026-09-24T05:30:00.000Z",
    tags: ["model"],
    category: "claude",
    importance: 3,
    archiveTier: "hot",
    ...overrides,
  };
}

describe("major updates distribution policy", () => {
  it("requires a listed High update with a usable summary and reachable detail", () => {
    const eligible = entry();
    const candidates = [
      eligible,
      entry({ id: "medium", title: "Medium update", importance: 2 }),
      entry({ id: "held", url: "https://example.com/held", title: "Held but publicly listed", publicationHold: true }),
      entry({ id: "pending", title: "Pending update", summaryJa: "", summaryEn: "" }),
      entry({ id: "cold", title: "Cold update", archiveTier: "cold" }),
      entry({ id: "dropped", title: "Dropped update", archiveTier: "dropped" }),
      entry({ id: "future", title: "Future update", publishedAt: "2026-09-26T00:00:00.000Z" }),
      entry({ id: "invalid-date", title: "Invalid date", publishedAt: "not-a-date" }),
      entry({ id: "off-topic", url: "https://example.com/off-topic", title: "A new PlayStation gaming console is announced" }),
      entry({
        id: "routine-patch",
        sourceType: "release",
        title: "Cline CLI v3.0.12",
        titleJa: "Cline CLI v3.0.12",
        titleEn: "Cline CLI v3.0.12",
      }),
    ];

    expect(selectMajorUpdates(candidates, SNAPSHOT).map((item) => item.id))
      .toEqual(["held", eligible.id]);
    expect(() => selectMajorUpdates(candidates, "bad-clock")).toThrow(
      "Invalid major-updates snapshot time",
    );
  });

  it("sorts by source publication time and keeps only one high-confidence launch per topic", () => {
    const older = entry({ id: "older", url: "https://example.com/roadmap", title: "Engineering roadmap", publishedAt: "2026-09-22T00:00:00.000Z" });
    const anotherSource = entry({
      id: "same-launch",
      source: "techcrunch",
      url: "https://example.com/other-coverage",
      title: "Anthropic announces Claude Opus 5",
      publishedAt: "2026-09-23T08:00:00.000Z",
    });
    const newer = entry({ id: "newer", url: "https://example.com/platform-changes", title: "Platform API changes", publishedAt: "2026-09-24T22:00:00.000Z" });
    const offset = entry({ id: "offset", url: "https://example.com/region-rollout", title: "Region rollout", publishedAt: "2026-09-24T22:30:00+02:00" });
    const candidates = [older, anotherSource, entry(), offset, newer];

    expect(selectMajorUpdates(candidates, SNAPSHOT).map((candidate) => candidate.id))
      .toEqual(["newer", "offset", "opus-announcement", "older"]);
    expect(candidates[0]).toBe(older);
    expect(selectMajorUpdates([], SNAPSHOT)).toEqual([]);
  });

  it("does not emit duplicate canonical source URLs from multiple feeds", () => {
    const source = entry({ id: "newest", source: "openai-blog", title: "Latest official announcement" });
    const duplicate = entry({
      id: "older-copy",
      source: "techcrunch",
      title: "Related coverage without explicit launch words",
      url: `${source.url}?utm_source=newsletter`,
      publishedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(selectMajorUpdates([duplicate, source], SNAPSHOT).map((item) => item.id))
      .toEqual(["newest"]);
  });
});

describe("article share payload", () => {
  const input = {
    url: "https://techdb.studio344.net/e/opus-announcement/",
    target: "detail" as const,
    titleJa: "Claude Opus 5 を発表",
    titleEn: "Introducing Claude Opus 5",
  };

  it("shares the canonical article page with the active language", () => {
    expect(buildArticleSharePayload(input, "ja")).toEqual({
      title: input.titleJa,
      text: input.titleJa,
      url: input.url,
    });
    expect(buildArticleSharePayload(input, "en")).toEqual({
      title: input.titleEn,
      text: input.titleEn,
      url: `${input.url}?lang=en`,
    });
  });

  it("leaves a source URL's query intact and never adds this site's language state", () => {
    const source = "https://example.com/post?ref=source#details";
    expect(buildArticleSharePayload({ ...input, url: source, target: "source" }, "en").url)
      .toBe(source);
    expect(() => buildArticleSharePayload({ ...input, url: source }, "en"))
      .toThrow("canonical site");
    expect(() => buildArticleSharePayload({ ...input, url: "javascript:alert(1)" }, "ja"))
      .toThrow("HTTP(S)");
    expect(() => buildArticleSharePayload({ ...input, titleJa: " " }, "ja"))
      .toThrow("requires a title");
  });
});
