import { describe, expect, it } from "vitest";

import { sourceExcerptForEntry } from "../web/src/lib/source-excerpt.ts";

describe("sourceExcerptForEntry", () => {
  it("keeps source context while removing markup, feed suffixes, and HTML entities", () => {
    expect(sourceExcerptForEntry({
      title: "Agent workflow update",
      contentSnippet:
        "<p>Agents &amp; tools now share one workflow.</p> The post Agent workflow update appeared first on Example Blog.",
    })).toBe("Agents & tools now share one workflow.");
  });

  it("does not present a title echo as a source excerpt", () => {
    expect(sourceExcerptForEntry({
      title: "How We Contain Claude",
      titleEn: "How We Contain Claude",
      contentSnippet: "How We Contain Claude",
    })).toBe("");
  });

  it("clamps long excerpts without inventing an AI summary", () => {
    const excerpt = sourceExcerptForEntry({
      title: "Long source context",
      contentSnippet: Array.from({ length: 80 }, () => "context").join(" "),
    }, 100);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(101);
  });
});
