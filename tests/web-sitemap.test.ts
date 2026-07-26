import { XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import {
  ALL_ENTRIES,
  CATEGORY_META,
  SINGLETON_TAG_ENTRY_IDS,
  STATIC_TAG_PAGE_TAGS,
} from "../web/src/lib/data.ts";
import {
  ARCHIVE_MONTHS,
  ARCHIVE_WARM_ENTRIES,
} from "../web/src/lib/archive.ts";
import {
  collectAddressableDetailEntries,
  isAddressableDetailEntry,
} from "../web/src/lib/detail-addressability.ts";
import { entryDestination } from "../web/src/lib/entry-destination.ts";
import {
  archiveMonthPath,
  categoryPath,
  detailPath,
  paginationPageNumbers,
  tagPath,
  timelinePagePath,
  totalPageCount,
} from "../web/src/lib/route-inventory.ts";
import { SITE_URL } from "../web/src/lib/site.ts";
import {
  SITEMAP_DOCUMENT,
  SITEMAP_MAX_BYTES,
  SITEMAP_MAX_URLS,
  SITEMAP_STATIC_PATHS,
  collectSitemapPaths,
  serializeSitemap,
} from "../web/src/lib/sitemap.ts";
import { GET as getRobots } from "../web/src/pages/robots.txt.ts";
import { GET as getSitemap } from "../web/src/pages/sitemap.xml.ts";

function canonical(path: string): string {
  return new URL(path, `${SITE_URL}/`).href;
}

describe("sitemap", () => {
  it("shares a JSON-free detail addressability policy", () => {
    const entries = collectAddressableDetailEntries(
      [
        { id: "live-legacy" },
        { id: "hot", archiveTier: "hot" as const },
        { id: "cold", archiveTier: "cold" as const },
      ],
      [
        { id: "warm", archiveTier: "warm" as const },
        { id: "dropped", archiveTier: "dropped" as const },
        { id: "hot", archiveTier: "warm" as const },
      ],
    );

    expect(entries.map((entry) => entry.id)).toEqual(["live-legacy", "hot", "warm"]);
    expect(isAddressableDetailEntry({ id: "hot", archiveTier: "hot" })).toBe(true);
    expect(isAddressableDetailEntry({ id: "warm", archiveTier: "warm" })).toBe(true);
    expect(isAddressableDetailEntry({ id: "cold", archiveTier: "cold" })).toBe(false);
    expect(isAddressableDetailEntry({ id: "dropped", archiveTier: "dropped" })).toBe(false);
  });

  it("shares destination and pagination builders at their boundary conditions", () => {
    expect(entryDestination({
      id: "warm",
      url: "https://example.com/warm",
      archiveTier: "warm",
    })).toEqual({
      href: "/e/warm/",
      external: false,
    });
    expect(entryDestination({
      id: "cold",
      url: "https://example.com/cold",
      archiveTier: "cold",
    })).toEqual({
      href: "https://example.com/cold",
      external: true,
      target: "_blank",
      rel: "noopener nofollow",
    });
    expect(totalPageCount(0, 20)).toBe(1);
    expect(paginationPageNumbers(20, 20)).toEqual([]);
    expect(paginationPageNumbers(21, 20)).toEqual([2]);
    expect(paginationPageNumbers(41, 20)).toEqual([2, 3]);
    expect(timelinePagePath(2)).toBe("/page/2/");
    expect(categoryPath("ai", 3)).toBe("/c/ai/page/3/");
    expect(tagPath("C++", 2)).toBe("/t/C%2B%2B/page/2/");
  });

  it("publishes well-formed, unique canonical URLs within protocol limits", async () => {
    const response = (await getSitemap({} as never)) as Response;
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/xml");
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toBe(SITEMAP_DOCUMENT.xml);
    expect(SITEMAP_DOCUMENT.urlCount).toBe(new Set(SITEMAP_DOCUMENT.urls).size);
    expect(SITEMAP_DOCUMENT.urlCount).toBeLessThanOrEqual(SITEMAP_MAX_URLS);
    expect(SITEMAP_MAX_BYTES).toBe(50_000_000);
    expect(SITEMAP_DOCUMENT.byteLength).toBeLessThanOrEqual(SITEMAP_MAX_BYTES);
    expect(SITEMAP_DOCUMENT.byteLength).toBe(new TextEncoder().encode(xml).byteLength);
    expect(xml).not.toContain("<lastmod>");

    for (const value of SITEMAP_DOCUMENT.urls) {
      const url = new URL(value);
      expect(url.origin).toBe(SITE_URL);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  });

  it("covers generated route families without redirect, recovery, or cold details", () => {
    const urls = new Set(SITEMAP_DOCUMENT.urls);

    for (const path of SITEMAP_STATIC_PATHS) expect(urls.has(canonical(path))).toBe(true);
    for (const category of CATEGORY_META) {
      expect(urls.has(canonical(categoryPath(category.slug)))).toBe(true);
    }
    for (const tag of STATIC_TAG_PAGE_TAGS) {
      expect(urls.has(canonical(tagPath(tag)))).toBe(true);
    }
    for (const month of ARCHIVE_MONTHS) {
      expect(urls.has(canonical(archiveMonthPath(month)))).toBe(true);
    }

    const expectedDetailUrls = new Set<string>();
    for (const entry of [...ALL_ENTRIES, ...ARCHIVE_WARM_ENTRIES]) {
      if (entry.archiveTier === "cold" || entry.archiveTier === "dropped") continue;
      expectedDetailUrls.add(canonical(detailPath(entry.id)));
    }
    const actualDetailUrls = new Set(
      SITEMAP_DOCUMENT.urls.filter((url) => new URL(url).pathname.startsWith("/e/")),
    );
    expect(actualDetailUrls).toEqual(expectedDetailUrls);

    for (const tag of Object.keys(SINGLETON_TAG_ENTRY_IDS)) {
      expect(urls.has(canonical(tagPath(tag)))).toBe(false);
    }
    expect(urls.has(canonical("/sources/"))).toBe(false);
    expect(urls.has(canonical("/sample/article/"))).toBe(false);
    expect(collectSitemapPaths().some((path) => path.includes("?"))).toBe(false);
  });

  it("excludes current cold IDs while retaining representative hot and warm details", () => {
    const urls = new Set(SITEMAP_DOCUMENT.urls);
    const coldEntries = ALL_ENTRIES.filter((entry) => entry.archiveTier === "cold");
    const hotEntry = ALL_ENTRIES.find((entry) => entry.archiveTier === "hot");
    const liveIds = new Set(ALL_ENTRIES.map((entry) => entry.id));
    const warmEntry = ARCHIVE_WARM_ENTRIES.find((entry) => !liveIds.has(entry.id))
      ?? ARCHIVE_WARM_ENTRIES[0];

    expect(coldEntries.length).toBeGreaterThan(0);
    expect(hotEntry, "fixture includes an addressable hot entry").toBeTruthy();
    expect(warmEntry, "fixture includes an addressable warm entry").toBeTruthy();
    for (const entry of coldEntries) {
      expect(urls.has(canonical(`/e/${encodeURIComponent(entry.id)}/`))).toBe(false);
    }
    expect(urls.has(canonical(`/e/${encodeURIComponent(hotEntry!.id)}/`))).toBe(true);
    expect(urls.has(canonical(`/e/${encodeURIComponent(warmEntry!.id)}/`))).toBe(true);
  });

  it("escapes XML, removes duplicates, and fails closed on invalid or oversized output", () => {
    const escaped = serializeSitemap(["/r&d/", "/r&d/"]);
    expect(escaped.urlCount).toBe(1);
    expect(escaped.xml).toContain(`<loc>${SITE_URL}/r&amp;d/</loc>`);

    expect(() => serializeSitemap(["https://example.com/"])).toThrow(/root-relative/);
    expect(() => serializeSitemap(["//example.com/"])).toThrow(/root-relative/);
    expect(() => serializeSitemap(["/search/?q=agent"])).toThrow(/query-free/);
    expect(() => serializeSitemap(["/", "/about/"], { maxUrls: 1 })).toThrow(
      /URL limit exceeded/,
    );
    expect(() => serializeSitemap(["/"], { maxBytes: 10 })).toThrow(
      /byte limit exceeded/,
    );
  });

  it("advertises the canonical sitemap from robots.txt", async () => {
    const response = (await getRobots({} as never)) as Response;
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
    expect(body).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
    expect(body).not.toContain("ads.txt");
  });
});
