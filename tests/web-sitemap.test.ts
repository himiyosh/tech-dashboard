import { readFileSync } from "node:fs";
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
import {
  DETAIL_ROBOTS_INDEX,
  DETAIL_ROBOTS_NOINDEX,
  NON_INDEXABLE_SOURCE_TYPES,
  collectIndexableDetailEntries,
  detailRobotsContent,
  isIndexableDetailEntry,
} from "../web/src/lib/detail-indexability.ts";
import { hasRealBody } from "../web/src/lib/bodies.ts";
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
        { id: "live-legacy", publicationHold: false },
        { id: "hot", archiveTier: "hot" as const, publicationHold: false },
        { id: "cold", archiveTier: "cold" as const, publicationHold: false },
      ],
      [
        { id: "warm", archiveTier: "warm" as const, publicationHold: false },
        { id: "dropped", archiveTier: "dropped" as const, publicationHold: false },
        { id: "hot", archiveTier: "warm" as const, publicationHold: false },
        { id: "queued", archiveTier: "warm" as const, publicationHold: true },
      ],
    );

    // "queued" (publicationHold) and "cold" keep their routes: the gate and
    // the tier now decide index/noindex (detail-indexability.ts), never route
    // existence, so a card title always lands in-site. Only "dropped"
    // (removed content) stays routeless.
    expect(entries.map((entry) => entry.id)).toEqual([
      "live-legacy",
      "hot",
      "cold",
      "warm",
      "queued",
    ]);
    expect(isAddressableDetailEntry({ id: "hot", archiveTier: "hot" })).toBe(true);
    expect(isAddressableDetailEntry({ id: "warm", archiveTier: "warm" })).toBe(true);
    expect(isAddressableDetailEntry({ id: "cold", archiveTier: "cold" })).toBe(true);
    expect(isAddressableDetailEntry({ id: "dropped", archiveTier: "dropped" })).toBe(false);
    expect(isIndexableDetailEntry({ id: "cold", archiveTier: "cold" })).toBe(false);
  });

  it("summary-pending entries get no detail route (thin-page guard)", () => {
    const pendingPlaceholder = {
      id: "pending",
      archiveTier: "hot" as const,
      source: "cline-releases",
      title: "Cline Desktop v0.0.17",
      titleEn: "Cline Desktop v0.0.17",
      titleJa: "",
      summaryJa:
        "このエントリは cline-releases から収集した cline 領域の最新アップデートです。原題:「Cline Desktop v0.0.17」。AI による日本語要約は次回以降の Worker run で生成されます。",
      summaryEn: "cline update from Cline Releases. AI summary not yet available; a future Worker run will refresh this entry.",
    };
    const summarized = {
      ...pendingPlaceholder,
      id: "summarized",
      summaryJa: "Cline Desktop v0.0.17 は Customize ハブを統合し、カタログ導入直後の拡張が一覧に反映されるようになりました。",
      summaryEn: "Cline Desktop v0.0.17 unifies the Customize hub so catalog installs appear immediately.",
    };
    const emptySummaries = {
      ...pendingPlaceholder,
      id: "empty",
      summaryJa: "",
      summaryEn: "",
    };

    expect(isAddressableDetailEntry(pendingPlaceholder)).toBe(false);
    expect(isAddressableDetailEntry(emptySummaries)).toBe(false);
    expect(isAddressableDetailEntry(summarized)).toBe(true);
    // Cross-language fallback still counts: an EN-only real summary is substance.
    expect(
      isAddressableDetailEntry({
        ...emptySummaries,
        id: "en-only",
        summaryEn: "Adds a new MCP tool-call inspector to the desktop client.",
      }),
    ).toBe(true);
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
    // Cold rows keep an in-site (noindex) route; only "dropped" — removed
    // content — still sends the card to the source.
    expect(entryDestination({
      id: "cold",
      url: "https://example.com/cold",
      archiveTier: "cold",
    })).toEqual({
      href: "/e/cold/",
      external: false,
    });
    expect(entryDestination({
      id: "gone",
      url: "https://example.com/gone",
      archiveTier: "dropped",
    })).toEqual({
      href: "https://example.com/gone",
      external: true,
      target: "_blank",
      rel: "noopener noreferrer nofollow",
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

    // Addressable (route generated, reachable) and indexable (sitemap +
    // "index, follow") are separate decisions since the body-less detail
    // pages became noindex. The sitemap lists only the indexable subset.
    const expectedDetailUrls = new Set<string>();
    for (const entry of [...ALL_ENTRIES, ...ARCHIVE_WARM_ENTRIES]) {
      if (!isIndexableDetailEntry(entry)) continue;
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

  it("excludes cold IDs and body-less details while retaining bodied hot and warm details", () => {
    const urls = new Set(SITEMAP_DOCUMENT.urls);
    const liveIds = new Set(ALL_ENTRIES.map((entry) => entry.id));
    const coldEntries = ALL_ENTRIES.filter((entry) => entry.archiveTier === "cold");
    const indexableHot = ALL_ENTRIES.find(
      (entry) => entry.archiveTier === "hot" && isIndexableDetailEntry(entry),
    );
    const noindexHot = ALL_ENTRIES.find(
      (entry) =>
        entry.archiveTier === "hot"
        && isAddressableDetailEntry(entry)
        && !isIndexableDetailEntry(entry),
    );
    const indexableWarm = ARCHIVE_WARM_ENTRIES.find((entry) =>
      isIndexableDetailEntry(entry),
    );
    // Archive-only warm entries carry no generated body today, so this group
    // exists purely to prove body-less details stay out of the sitemap.
    const noindexArchiveOnlyWarm = ARCHIVE_WARM_ENTRIES.find(
      (entry) =>
        !liveIds.has(entry.id)
        && isAddressableDetailEntry(entry)
        && !isIndexableDetailEntry(entry),
    );

    expect(coldEntries.length).toBeGreaterThan(0);
    expect(indexableHot, "fixture includes a bodied hot entry").toBeTruthy();
    expect(noindexHot, "fixture includes a body-less hot entry").toBeTruthy();
    expect(indexableWarm, "fixture includes a bodied warm entry").toBeTruthy();
    expect(
      noindexArchiveOnlyWarm,
      "fixture includes a body-less archive-only warm entry",
    ).toBeTruthy();

    for (const entry of coldEntries) {
      expect(urls.has(canonical(`/e/${encodeURIComponent(entry.id)}/`))).toBe(false);
    }
    for (const entry of [indexableHot, indexableWarm]) {
      expect(urls.has(canonical(`/e/${encodeURIComponent(entry?.id ?? "")}/`))).toBe(true);
    }
    for (const entry of [noindexHot, noindexArchiveOnlyWarm]) {
      expect(urls.has(canonical(`/e/${encodeURIComponent(entry?.id ?? "")}/`))).toBe(false);
    }
  });

  it("lists a detail route only when data/bodies.json holds a real body", () => {
    const urls = new Set(SITEMAP_DOCUMENT.urls);
    const addressable = collectAddressableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES);
    const indexable = addressable.filter((entry) => isIndexableDetailEntry(entry));
    const notIndexable = addressable.filter((entry) => !isIndexableDetailEntry(entry));

    expect(indexable.length, "fixture has indexable details").toBeGreaterThan(0);
    expect(notIndexable.length, "fixture has non-indexable details").toBeGreaterThan(0);

    for (const entry of indexable) {
      expect(hasRealBody(entry)).toBe(true);
      // A real body is necessary but not sufficient: the release/changelog
      // lane is excluded regardless, so nothing from it may appear here.
      expect(NON_INDEXABLE_SOURCE_TYPES.has(String(entry.sourceType))).toBe(false);
      expect(urls.has(canonical(detailPath(entry.id)))).toBe(true);
      expect(detailRobotsContent(entry)).toBe(DETAIL_ROBOTS_INDEX);
    }
    for (const entry of notIndexable) {
      // Exactly three reasons are allowed to keep a page out of the index:
      // no real body yet, an excluded lane, or a publication-gate hold
      // (the route exists as noindex until the release drip frees it).
      // Anything else means the gate grew a rule nobody declared.
      const excludedLane = NON_INDEXABLE_SOURCE_TYPES.has(String(entry.sourceType));
      expect(
        !hasRealBody(entry) || excludedLane || entry.publicationHold === true,
        `${entry.id} is non-indexable for an undeclared reason`,
      ).toBe(true);
      expect(urls.has(canonical(detailPath(entry.id)))).toBe(false);
      expect(detailRobotsContent(entry)).toBe(DETAIL_ROBOTS_NOINDEX);
    }

    const sitemapDetailCount = SITEMAP_DOCUMENT.urls.filter((url) =>
      new URL(url).pathname.startsWith("/e/"),
    ).length;
    expect(sitemapDetailCount).toBe(
      collectIndexableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES).length,
    );
  });

  it("keeps release/changelog details out of the index even when they have a body", () => {
    // The version-note lane is where every near-duplicate cluster lives (18x
    // "Zed Editor v1.17.2", 16x "Ollama v0.33.0", ...), so it is excluded by
    // sourceType rather than by any body-quality heuristic. Guard both halves:
    // the lane never reaches the sitemap, and the exclusion is doing real work
    // on the actual corpus rather than passing vacuously.
    const urls = new Set(SITEMAP_DOCUMENT.urls);
    const addressable = collectAddressableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES);
    const releaseLane = addressable.filter((entry) =>
      NON_INDEXABLE_SOURCE_TYPES.has(String(entry.sourceType)),
    );

    expect(releaseLane.length, "corpus still carries release/changelog details")
      .toBeGreaterThan(0);
    const bodiedReleaseLane = releaseLane.filter((entry) => hasRealBody(entry));
    expect(
      bodiedReleaseLane.length,
      "exclusion is load-bearing: some release entries do have a real body",
    ).toBeGreaterThan(0);

    for (const entry of releaseLane) {
      expect(isIndexableDetailEntry(entry)).toBe(false);
      expect(detailRobotsContent(entry)).toBe(DETAIL_ROBOTS_NOINDEX);
      expect(urls.has(canonical(detailPath(entry.id)))).toBe(false);
    }

    // The route itself must stay reachable -- de-indexing must never 404.
    for (const entry of bodiedReleaseLane) {
      expect(isAddressableDetailEntry(entry)).toBe(true);
    }
  });

  it("treats a missing sourceType as indexable so the gate cannot empty the sitemap", () => {
    // Fail-open on the descriptive field is deliberate (see the module doc):
    // a caller forgetting to thread sourceType must not silently de-index the
    // whole site. The corpus-level tests above are what catch a real gap.
    const bodied = collectAddressableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES)
      .find(
        (entry) =>
          hasRealBody(entry)
          && !NON_INDEXABLE_SOURCE_TYPES.has(String(entry.sourceType))
          // A held entry is legitimately non-indexable, so it cannot probe the
          // missing-sourceType fail-open path.
          && entry.publicationHold !== true,
      );
    expect(bodied, "fixture has a bodied non-release released entry").toBeTruthy();
    const { sourceType: _dropped, ...withoutSourceType } = bodied as Record<string, unknown>;
    expect(isIndexableDetailEntry(withoutSourceType as never)).toBe(true);
  });

  it("emits the shared robots directive from the detail template", () => {
    // The route stays generated for every addressable entry (no inbound link
    // may 404); only the robots directive and the sitemap narrow. Pin both
    // halves at the source level so neither can silently drift.
    const detailSource = readFileSync(
      new URL("../web/src/pages/e/[id].astro", import.meta.url),
      "utf8",
    );
    expect(detailSource).toContain("const robotsContent = detailRobotsContent(entry);");
    expect(detailSource).toContain('<meta name="robots" content={robotsContent} />');
    expect(detailSource).toContain("collectAddressableDetailEntries(");
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
