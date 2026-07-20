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
});
