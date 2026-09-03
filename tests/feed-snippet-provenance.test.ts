import { describe, expect, it } from "vitest";
import { restampEntryFromSource } from "../harness/pipeline/normalize.ts";
import { isSourceTextUnverifiable, sourceOwnedSnippet } from "../harness/pipeline/feed-snippet.ts";
import { REGISTRY } from "../harness/registry.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import { isKnowledgeEligibleEntry } from "../web/src/lib/knowledge-eligibility.ts";

// Regression guard for the 2026-09-03 publisher outage: the article excerpt
// lane replaced contentSnippet with article prose, the fail-closed gate
// re-derived the category from that prose (github-changelog: tech-news ->
// copilot) and every hourly publish failed. Source-owned fields are a
// collection-time contract on the feed text (feedSnippet).

const REFERENCE_AT = "2026-09-03T02:00:00.000Z";

function changelogEntry(overrides: Partial<NormalizedEntry>): NormalizedEntry {
  return {
    id: "abc123",
    source: "github-changelog",
    sourceType: "changelog",
    url: "https://github.blog/changelog/2026-09-02-set-an-expiration-date-for-individual-user-budgets/",
    title: "Set an expiration date for individual user budgets",
    titleJa: "",
    titleEn: "",
    summaryJa: "",
    summaryEn: "",
    lang: "en",
    publishedAt: "2026-09-02T18:00:00.000Z",
    collectedAt: "2026-09-02T19:00:00.000Z",
    tags: [],
    category: "tech-news",
    importance: 2,
    ...overrides,
  };
}

describe("sourceOwnedSnippet", () => {
  it("returns contentSnippet for feed-origin entries and feedSnippet for article-origin ones", () => {
    expect(sourceOwnedSnippet({ contentSnippet: "feed" })).toBe("feed");
    expect(sourceOwnedSnippet({ contentSnippet: "prose", excerptOrigin: "article", feedSnippet: "feed" })).toBe("feed");
    expect(sourceOwnedSnippet({ contentSnippet: "prose", excerptOrigin: "article" })).toBeUndefined();
    expect(sourceOwnedSnippet({ contentSnippet: "prose", excerptOrigin: "article", feedSnippet: "  " })).toBeUndefined();
    expect(sourceOwnedSnippet({ contentSnippet: "feed", excerptOrigin: "article-unavailable" })).toBe("feed");
  });
});

describe("restampEntryFromSource with an article excerpt", () => {
  const source = REGISTRY["github-changelog"]!;
  const feedText = "Administrators can now set an expiration date on individual user budgets.";
  const articleProse =
    "Organizations that manage GitHub Copilot spending can now set an expiration date on individual "
    + "user budgets. Copilot premium request budgets expire automatically at the chosen date.";

  it("keeps the category derived from the feed text, not the fetched prose", () => {
    const feedOnly = changelogEntry({ contentSnippet: feedText });
    const stampedFromFeed = restampEntryFromSource(feedOnly, source, REFERENCE_AT);

    const enriched = changelogEntry({
      contentSnippet: articleProse,
      excerptOrigin: "article",
      feedSnippet: feedText,
    });
    const stampedEnriched = restampEntryFromSource(enriched, source, REFERENCE_AT);

    expect(stampedEnriched.category).toBe(stampedFromFeed.category);
    expect(stampedEnriched.contentSnippet).toBe(articleProse);
    expect(stampedEnriched.feedSnippet).toBe(feedText);
  });

  it("would drift if the prose were treated as feed text (the failure mode being guarded)", () => {
    const naive = changelogEntry({ contentSnippet: articleProse });
    const stampedFromFeed = restampEntryFromSource(changelogEntry({ contentSnippet: feedText }), source, REFERENCE_AT);
    expect(restampEntryFromSource(naive, source, REFERENCE_AT).category).not.toBe(stampedFromFeed.category);
  });
});

describe("restampEntryFromSource for an article excerpt that predates feedSnippet", () => {
  const source = REGISTRY["github-changelog"]!;

  it("keeps the stored category and knowledge exclusion instead of re-deriving from the title", () => {
    const legacy = changelogEntry({
      category: "copilot",
      knowledgeEligible: false,
      contentSnippet: "Article prose without any product name in it.",
      excerptOrigin: "article",
    });
    expect(isSourceTextUnverifiable(legacy)).toBe(true);
    const stamped = restampEntryFromSource(legacy, source, REFERENCE_AT);
    expect(stamped.category).toBe("copilot");
    expect(stamped.knowledgeEligible).toBe(false);
    // Title-only derivation would have said tech-news: that is the drift being prevented.
    const titleOnly = restampEntryFromSource(changelogEntry({ category: "copilot" }), source, REFERENCE_AT);
    expect(titleOnly.category).toBe("tech-news");

    const notExcluded = restampEntryFromSource(
      changelogEntry({ category: "copilot", contentSnippet: "prose", excerptOrigin: "article" }),
      source,
      REFERENCE_AT,
    );
    expect(notExcluded.knowledgeEligible).toBeUndefined();
  });

  it("re-derives normally once feedSnippet is present", () => {
    const healed = changelogEntry({
      category: "copilot",
      contentSnippet: "Article prose.",
      excerptOrigin: "article",
      feedSnippet: "Administrators can now set an expiration date on individual user budgets.",
    });
    expect(isSourceTextUnverifiable(healed)).toBe(false);
    expect(restampEntryFromSource(healed, source, REFERENCE_AT).category).toBe("tech-news");
  });
});

describe("knowledge eligibility with an article excerpt", () => {
  it("respects the stored decision when the feed text is gone", () => {
    const base = { source: "google-cloud-blog", title: "Some article title", evergreen: true as const };
    expect(isKnowledgeEligibleEntry({ ...base, contentSnippet: "prose", excerptOrigin: "article", knowledgeEligible: false })).toBe(false);
    expect(isKnowledgeEligibleEntry({ ...base, contentSnippet: "prose", excerptOrigin: "article" })).toBe(true);
  });

  it("evaluates the feed text rather than the fetched prose", () => {
    const base = {
      source: "google-cloud-blog",
      title: "Announcing the general availability of a new feature",
      evergreen: true as const,
    };
    const fromFeed = isKnowledgeEligibleEntry({ ...base, contentSnippet: "Now generally available in all regions." });
    const enriched = isKnowledgeEligibleEntry({
      ...base,
      contentSnippet: "A step-by-step tutorial and best practices guide for the architecture.",
      excerptOrigin: "article",
      feedSnippet: "Now generally available in all regions.",
    });
    expect(enriched).toBe(fromFeed);
  });
});
