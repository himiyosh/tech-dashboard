import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("web clarity contracts", () => {
  it("requires every PageHero metric to explain its population and window", () => {
    const source = read("web/src/components/PageHero.astro");
    expect(source).toMatch(/\bdetail:\s*string;/);
    expect(source).toMatch(/\bdetailEn:\s*string;/);
    expect(source).toMatch(/\bscope:\s*string;/);
    expect(source).not.toMatch(/\bdetail\?:\s*string;/);
    expect(source).not.toMatch(/\bscope\?:\s*string;/);
  });

  it("labels collection recency without claiming publication recency", () => {
    for (const path of [
      "web/src/components/EntryCard.astro",
      "web/src/components/CompactRow.astro",
    ]) {
      const source = read(path);
      expect(source).toContain('data-recency-scope="collection"');
      expect(source).toContain("RECENT_COLLECTION_BADGE");
      expect(source).not.toMatch(/>\s*NEW\s*</);
    }
  });

  it("hydrates relative labels from machine-readable timestamps", () => {
    const pageHero = read("web/src/components/PageHero.astro");
    const portal = read("web/src/layouts/Portal.astro");
    const relativeTime = read("web/src/lib/relative-time.ts");

    expect(pageHero).toMatch(/\bdatetime\?:\s*string;/);
    expect(pageHero).toContain("data-relative-time");
    expect(portal).toContain("initializeRelativeTimes()");
    expect(relativeTime).toContain('querySelectorAll<HTMLElement>("[data-relative-time]")');
    expect(relativeTime).toContain('document.addEventListener("visibilitychange"');
  });

  it("keeps About run telemetry snapshot-consistent and bilingual", () => {
    const about = read("web/src/pages/about.astro");
    expect(about).not.toContain("data-metric=\"workerLastRunLabel\"");
    expect(about).toContain("data-about-run-label-ja");
    expect(about).toContain("data-about-run-label-en");
    expect(about).toContain('<span class="i18n-en" lang="en">No data</span>');
  });

  it("separates per-entry pending context from site-wide pipeline telemetry", () => {
    const entryCard = read("web/src/components/EntryCard.astro");
    const detail = read("web/src/pages/e/[id].astro");
    const sourceExcerpt = read("web/src/components/SourceExcerpt.astro");
    const portal = read("web/src/layouts/Portal.astro");

    expect(entryCard).toContain("全体の進行状況");
    expect(entryCard).toContain("Site-wide status");
    expect(sourceExcerpt).toContain('data-excerpt-scope="source"');
    expect(sourceExcerpt).toContain("AI 要約ではありません");
    expect(sourceExcerpt).toContain("Not an AI summary");
    expect(entryCard).toContain("sourceExcerptForEntry(entry)");
    expect(entryCard).toContain("<SourceExcerpt");
    expect(detail).toContain("sourceExcerptForEntry(entry, 320)");
    expect(detail).toContain("<SourceExcerpt");
    expect(portal).toContain('data-health-scope="site-wide-pipeline"');
  });

  it("validates direct singleton-tag recovery against the generated mapping", () => {
    const portal = read("web/src/layouts/Portal.astro");
    const endpoint = read("web/src/pages/tag-recovery.json.ts");
    const headers = read("web/public/_headers");

    expect(endpoint).toContain("SINGLETON_INDEXED_TAG_ENTRY_IDS");
    expect(portal).toContain("data-tag-recovery-version");
    expect(portal).toContain("tag-recovery.json?v=");
    expect(portal).toContain('cache: "no-store"');
    expect(portal).toContain("recoveryMap[tagIntent] !== directTagEntryId");
    expect(portal).toContain("if (directTagEntryId)");
    expect(headers).toContain("/tag-recovery.json");
    expect(headers).toContain("Cache-Control: no-store");
  });

  it("positions narrow Search from the visible header edge", () => {
    const portal = read("web/src/layouts/Portal.astro");
    const styles = read("web/src/styles/portal.css");

    expect(portal).toContain('window.matchMedia("(max-width: 980px)")');
    expect(portal).toContain('const headerBottom = searchHeader.getBoundingClientRect().bottom;');
    expect(portal).toContain('"--search-overlay-top"');
    expect(portal).toContain('window.addEventListener("resize", syncSearchOverlayPosition)');
    expect(portal).toContain('window.addEventListener("scroll", syncSearchOverlayPosition');
    expect(styles).toContain("top: var(--search-overlay-top, 89px);");
    expect(styles).toContain("top: var(--search-overlay-top, 77px);");
    expect(styles).toContain(
      "max-height: min(520px, calc(100dvh - var(--search-overlay-top, 89px) - 68px));",
    );
  });

  it("keeps curated Research and arXiv as distinct canonical destinations", () => {
    const categories = read("web/src/pages/categories.astro");

    expect(categories).toContain("ARXIV_ENTRIES");
    expect(categories).toContain("RESEARCH_ENTRIES");
    expect(categories).toContain('const CardElement = isResearch ? "article" : "a";');
    expect(categories).toContain('href="/c/research/"');
    expect(categories).toContain('href="/arxiv/"');
    expect(categories).toContain("data-entry-count={researchLaneCounts.curated}");
    expect(categories).toContain("data-entry-count={researchLaneCounts.arxiv}");
    expect(categories).toContain("curated: RESEARCH_ENTRIES.length");
    expect(categories).toContain("arxiv: ARXIV_ENTRIES.length");
    expect(categories).not.toMatch(/curated:\s*15\b|arxiv:\s*80\b/);
  });

  it("keeps mobile Top 3 compactness tied to intent-level geometry", () => {
    const smoke = read("tests/e2e/smoke.spec.ts");

    expect(smoke).not.toMatch(
      /maxRankHeight[\s\S]{0,160}mobile Top-3[\s\S]{0,160}toBeLessThanOrEqual\(\s*118\s*\)/,
    );
    for (const contract of [
      "Top 3 keeps exactly three cards",
      "Top 3 has no duplicated reason rows",
      "summary stays on one line",
      "summary has no vertical content overflow",
      "keeps content inside its panel",
      "cards ${index} and ${index + 1} do not overlap",
      "keeps a 44px article target",
      "centered Top 3 stays above the mobile tabbar",
      "desktop footer stays out of the mobile viewport",
      "Top 3 creates no page overflow",
    ]) {
      expect(smoke).toContain(contract);
    }
  });
});
