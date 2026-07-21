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
});
