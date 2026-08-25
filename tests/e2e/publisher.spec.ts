import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { onRequestGet as localizeArticleMetadata } from "../../web/functions/e/[id].ts";
import { onRequestGet as localizeHomeMetadata } from "../../web/functions/index.ts";
import {
  summaryForLang,
  type SummaryDisplayEntry,
} from "../../web/src/lib/summary-display.ts";
import {
  SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
  boundedSocialDescription,
} from "../../web/src/lib/bounded-description.ts";
import { buildAdsTxt } from "../../web/src/lib/ads-txt.ts";
import { KNOWLEDGE_RSS_FEED } from "../../web/src/lib/feed-catalog.ts";
import {
  CATEGORY_META,
  type Category,
} from "../../web/src/lib/category-meta.ts";
import {
  isPublishableEntry,
  type PublicationEntry,
} from "../../web/src/lib/entry-publication.ts";
import { buildFeedDecisionDigest } from "../../web/src/lib/feed-decision-digest.ts";
import {
  OPML_HREF,
  OPML_MEDIA_TYPE,
  OPML_TITLE,
  publicFeedHtmlUrl,
  publicFeedXmlUrl,
  publicRssFeeds,
} from "../../web/src/lib/feed-catalog.ts";
import { isArxivEntry } from "../../web/src/lib/research-lane.ts";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "../../web/src/lib/detail-addressability.ts";
import { isDefaultMutedCategory } from "../../web/src/lib/category-visibility.ts";
import { isKnowledgeEligibleEntry } from "../../web/src/lib/knowledge-eligibility.ts";
import { ADSENSE_CLIENT_ID, SITE_URL } from "../../web/src/lib/site.ts";
import { normalizeTagKey } from "../../web/src/lib/tag-normalize.ts";
import { canonicalSourceUrl } from "../../web/src/lib/source-meta.ts";
import {
  HOME_PAGE_METADATA,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_PATH,
  SOCIAL_IMAGE_URL,
  SOCIAL_IMAGE_WIDTH,
  articleSocialImage,
} from "../../web/src/lib/social-metadata.ts";

const TIMELINE_ENTRY_LINK_SELECTOR =
  'main article.card:not([data-catvis="muted"]) h3.title > a[href^="/e/"]';

/**
 * issue #237 で Knowledge レーンから除外した記事の anchor。
 * live 在籍は保証されない (live index の cap が evergreen も evict する) ため、
 * live 枠を持っている間だけ live 面を検証する名前付きケースとして使う。
 */
const ISSUE_237_KNOWLEDGE_EXCLUSION_ANCHORS = [
  "bed450615ddfd03d",
  "7ce8f0655e5249f3",
  "7b3cb462c9d102ab",
  "52a59dad31dc17b8",
  "5abc0b85ffaee46f",
  "07df858350edbc9d",
  "37803898e498b24d",
  "1fe4d821705368ab",
  "4804d6346be88fc2",
] as const;

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  return errors;
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function localizedHeadValue(html: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (key === "title") {
    return html.match(
      new RegExp(`<title\\b(?=[^>]*data-meta-key="${escapedKey}")[^>]*>([\\s\\S]*?)<\\/title>`, "i"),
    )?.[1] ?? "";
  }
  const tag = html.match(
    new RegExp(`<meta\\b(?=[^>]*data-meta-key="${escapedKey}")[^>]*>`, "i"),
  )?.[0];
  return tag?.match(/\scontent="([^"]*)"/i)?.[1] ?? "";
}

function decodeHeadValue(value: string): string {
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const numeric = entity.match(/^&#(x)?([0-9a-f]+);$/i);
      if (numeric) {
        return String.fromCodePoint(
          Number.parseInt(numeric[2], numeric[1] ? 16 : 10),
        );
      }
      return (
        {
          "&amp;": "&",
          "&quot;": '"',
          "&apos;": "'",
          "&lt;": "<",
          "&gt;": ">",
        }[entity.toLowerCase()] ?? entity
      );
    },
  );
}

interface ParsedRssItem {
  category?: string | string[];
  description?: string;
  link?: string;
}

interface FeedArtifactEntry extends PublicationEntry {
  id: string;
  category: Category;
  evergreen?: boolean;
  importance: 1 | 2 | 3;
}

function rssItemDocuments(xml: string): ParsedRssItem[] {
  expect(XMLValidator.validate(xml)).toBe(true);
  const document = new XMLParser({
    parseTagValue: false,
  }).parse(xml) as {
    rss?: { channel?: { item?: ParsedRssItem | ParsedRssItem[] } };
  };
  const items = document.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function rssItemCategory(item: ParsedRssItem): string | null {
  if (Array.isArray(item.category)) return item.category[0] ?? null;
  return item.category ?? null;
}

const generatedEntryRouteCache = new Map<"page" | "archive", Map<string, string>>();

function generatedEntryRoutes(
  routeFamily: "page" | "archive",
): Map<string, string> {
  const cached = generatedEntryRouteCache.get(routeFamily);
  if (cached) return cached;
  const dist = path.resolve("web/dist");
  const routes = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (
        entry.isFile()
        && entry.name === "index.html"
      ) {
        const relative = path.relative(dist, absolute).split(path.sep).join("/");
        const route = relative === "index.html"
          ? "/"
          : `/${relative.slice(0, -"index.html".length)}`;
        const html = readFileSync(absolute, "utf8");
        for (const match of html.matchAll(/data-entry-id="([^"]+)"/g)) {
          if (!routes.has(match[1])) routes.set(match[1], route);
        }
      }
    }
  };
  walk(path.join(dist, routeFamily));
  generatedEntryRouteCache.set(routeFamily, routes);
  return routes;
}

test.describe("Publisher generated artifact", () => {
  test("renders generated Home and a current article detail", async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const homeResponse = await page.goto("/", { waitUntil: "domcontentloaded" });

    expect(homeResponse?.status()).toBeLessThan(400);
    await expect(page.locator("section.banner h1")).toHaveCount(1);
    await expect(page.locator("article.featured")).toBeVisible();

    const entryLink = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(entryLink).toBeVisible();
    const href = await entryLink.getAttribute("href");
    if (!href) throw new Error("generated Timeline entry is missing href");
    expect(href).toMatch(/^\/e\/[^/]+\/$/);

    const detailResponse = await page.goto(href, {
      waitUntil: "domcontentloaded",
    });
    expect(detailResponse?.status()).toBeLessThan(400);
    await expect(page.locator("article.entry-detail")).toBeVisible();
    await expect(page.locator("h1.ed-title")).toBeVisible();
    await expect(page.locator("article.entry-detail")).toHaveAttribute(
      "data-summary-state",
      /^(ready|pending)$/,
    );
    await expect(page.locator("body")).not.toContainText("近日中に AI が生成");
    expect(runtimeErrors).toEqual([]);
  });

  test("publishes complete localized Home discovery metadata and brand image", async ({
    page,
    request,
  }) => {
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);

    const uniqueSelectors = [
      'link[rel="canonical"]',
      'meta[name="description"]',
      'meta[property="og:type"]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[property="og:url"]',
      'meta[property="og:image"]',
      'meta[property="og:image:alt"]',
      'meta[name="twitter:card"]',
      'meta[name="twitter:title"]',
      'meta[name="twitter:description"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:alt"]',
    ];
    for (const selector of uniqueSelectors) {
      await expect(page.locator(selector), `${selector} is emitted exactly once`).toHaveCount(1);
    }

    await expect.poll(() => page.title()).toBe(HOME_PAGE_METADATA.titleJa);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      HOME_PAGE_METADATA.canonicalUrl,
    );
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.descriptionJa,
    );
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
      "content",
      "website",
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.socialUrlJa,
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      SOCIAL_IMAGE_URL,
    );
    await expect(page.locator('meta[property="og:image:type"]')).toHaveAttribute(
      "content",
      "image/png",
    );
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
      "content",
      String(SOCIAL_IMAGE_WIDTH),
    );
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute(
      "content",
      String(SOCIAL_IMAGE_HEIGHT),
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image",
    );

    const jsonLd = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
    ) as {
      name?: string;
      inLanguage?: string[];
      description?: Array<{ "@value"?: string; "@language"?: string }>;
    };
    expect(jsonLd.name).toBe("TECH Dashboard");
    expect(jsonLd.inLanguage).toEqual(["ja-JP", "en"]);
    expect(jsonLd.description).toEqual([
      { "@value": HOME_PAGE_METADATA.descriptionJa, "@language": "ja" },
      { "@value": HOME_PAGE_METADATA.descriptionEn, "@language": "en" },
    ]);

    const imageResponse = await request.get(SOCIAL_IMAGE_PATH);
    expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()["content-type"]).toContain("image/png");
    const image = await imageResponse.body();
    expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(image.readUInt32BE(16)).toBe(SOCIAL_IMAGE_WIDTH);
    expect(image.readUInt32BE(20)).toBe(SOCIAL_IMAGE_HEIGHT);

    await page.goto("/?lang=en", { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect.poll(() => page.title()).toBe(HOME_PAGE_METADATA.titleEn);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.descriptionEn,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.socialTitleEn,
    );
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.descriptionEn,
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.socialUrlEn,
    );
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute(
      "content",
      "en_US",
    );
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.socialTitleEn,
    );
    await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.descriptionEn,
    );
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.image.altEn,
    );
    await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute(
      "content",
      HOME_PAGE_METADATA.image.altEn,
    );
  });

  test("localizes actual built Home and article responses before client JavaScript", async () => {
    const homeStaticHtml = readFileSync("web/dist/index.html", "utf8");
    const homeResponse = await localizeHomeMetadata({
      request: new Request(`${SITE_URL}/?lang=en`),
      next: async () => new Response(homeStaticHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    });
    const homeHtml = await homeResponse.text();
    expect(homeResponse.status).toBe(200);
    expect(homeResponse.headers.get("content-language")).toBe("en");
    expect(homeHtml).toMatch(/<html\b[^>]*lang="en"[^>]*data-lang="en"/);
    expect(localizedHeadValue(homeHtml, "title")).toBe(HOME_PAGE_METADATA.titleEn);
    expect(localizedHeadValue(homeHtml, "description")).toBe(
      HOME_PAGE_METADATA.descriptionEn,
    );
    expect(localizedHeadValue(homeHtml, "og:url")).toBe(
      HOME_PAGE_METADATA.socialUrlEn.replaceAll("&", "&amp;"),
    );

    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<
        SummaryDisplayEntry
        & PublicationEntry
        & {
          id: string;
          archiveTier?: string;
          image?: { src?: string };
        }
      >;
    };
    const imageLess = index.entries.find(
      (entry) =>
        entry.archiveTier !== "cold"
        && entry.archiveTier !== "dropped"
        && isPublishableEntry(entry)
        && articleSocialImage(entry.image, "JA", "EN").url === SOCIAL_IMAGE_URL,
    );
    expect(imageLess, "fixture includes a built image-less article").toBeTruthy();
    const articleStaticHtml = readFileSync(
      path.join("web/dist/e", imageLess!.id, "index.html"),
      "utf8",
    );
    const articleResponse = await localizeArticleMetadata({
      request: new Request(`${SITE_URL}/e/${imageLess!.id}/?lang=en`),
      next: async () => new Response(articleStaticHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    });
    const articleHtml = await articleResponse.text();
    expect(articleResponse.status).toBe(200);
    expect(articleResponse.headers.get("content-language")).toBe("en");
    expect(articleHtml).toMatch(/<html\b[^>]*lang="en"[^>]*data-lang="en"/);
    expect(localizedHeadValue(articleHtml, "title")).toBeTruthy();
    expect(localizedHeadValue(articleHtml, "title")).not.toMatch(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    );
    expect(localizedHeadValue(articleHtml, "description")).not.toMatch(
      /AI 要約は準備中|AI summary pending|近日中/,
    );
    expect(localizedHeadValue(articleHtml, "og:url")).toBe(
      `${SITE_URL}/e/${imageLess!.id}/?lang=en`,
    );
    expect(articleHtml).toContain(`content="${SOCIAL_IMAGE_URL}"`);
  });

  test("keeps actual pending metadata source-grounded and ready metadata summary-backed", async ({
    page,
  }) => {
    const articleFixtures = readdirSync("web/dist/e", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const html = readFileSync(
          path.join("web/dist/e", entry.name, "index.html"),
          "utf8",
        );
        return { id: entry.name, html };
      });
    const pendingFixture = articleFixtures.find(({ html }) =>
      html.includes('data-summary-state="pending"')
    );
    const readyFixture = articleFixtures.find(({ html }) =>
      html.includes('data-summary-state="ready"')
    );

    expect(readyFixture, "fixture includes an actual ready article").toBeTruthy();
    if (!pendingFixture) {
      expect(
        pendingFixture,
        "a fully summarized corpus is valid; helper tests retain pending coverage",
      ).toBeUndefined();
      return;
    }

    const pendingPath = `/e/${pendingFixture.id}/`;
    await page.goto(pendingPath, { waitUntil: "domcontentloaded" });
    const visibleTitleJa = (
      await page.locator(".ed-title .i18n-ja .ed-title-text").textContent()
    )?.trim() ?? "";
    const visibleTitleEn = (
      await page.locator(".ed-title .i18n-en .ed-title-text").textContent()
    )?.trim() ?? "";
    expect(visibleTitleJa).toBeTruthy();
    expect(visibleTitleEn).toBeTruthy();

    const canonicalUrl = `${SITE_URL}${pendingPath}`;
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      canonicalUrl,
    );
    await expect.poll(() => page.title()).toContain(visibleTitleJa);
    for (const selector of [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) {
      await expect(page.locator(selector)).toHaveAttribute(
        "content",
        new RegExp(visibleTitleJa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
    const descriptionJa = await page.locator('meta[name="description"]').getAttribute("content");
    expect(descriptionJa).toContain("AI 要約は準備中です");
    expect(descriptionJa).toContain(Array.from(visibleTitleJa).slice(0, 32).join(""));
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      "content",
      descriptionJa!,
    );
    await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute(
      "content",
      descriptionJa!,
    );

    const structuredData = JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent() ?? "{}",
    ) as {
      headline?: string;
      description?: string;
      inLanguage?: string;
      author?: { name?: string; url?: string };
      articleSection?: string;
      mainEntityOfPage?: { "@id"?: string };
    };
    const structuredTitle = structuredData.inLanguage === "ja-JP"
      ? visibleTitleJa
      : visibleTitleEn;
    const structuredSource = structuredData.author?.name ?? "";
    const structuredCategory = structuredData.articleSection ?? "";
    expect(structuredSource).toBeTruthy();
    expect(structuredCategory).toBeTruthy();
    expect(structuredData.headline).toBe(structuredTitle);
    expect(structuredData.description).toMatch(
      structuredData.inLanguage === "ja-JP"
        ? /AI 要約は準備中です/
        : /AI summary pending/,
    );
    expect(structuredData.description).toContain(
      Array.from(structuredTitle).slice(0, 32).join(""),
    );
    expect(structuredData.description).toContain(structuredSource);
    expect(structuredData.description).toContain(structuredCategory);
    expect(structuredData.author?.name).toBeTruthy();
    expect(structuredData.author?.url).toMatch(/^https?:\/\//);
    expect(structuredData.mainEntityOfPage?.["@id"]).toBe(canonicalUrl);

    const edgeResponse = await localizeArticleMetadata({
      request: new Request(`${canonicalUrl}?lang=en`),
      next: async () => new Response(pendingFixture.html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    });
    const edgeHtml = await edgeResponse.text();
    expect(edgeResponse.status).toBe(200);
    expect(edgeResponse.headers.get("content-language")).toBe("en");
    expect(decodeHeadValue(localizedHeadValue(edgeHtml, "title"))).toContain(
      visibleTitleEn,
    );
    const edgeDescription = decodeHeadValue(
      localizedHeadValue(edgeHtml, "description"),
    );
    expect(edgeDescription).toContain("AI summary pending.");
    expect(edgeDescription).toContain(Array.from(visibleTitleEn).slice(0, 32).join(""));
    expect(edgeDescription).toContain(structuredSource);
    expect(edgeDescription).toContain(structuredCategory);
    expect(
      decodeHeadValue(localizedHeadValue(edgeHtml, "og:title")),
    ).toContain(visibleTitleEn);
    expect(
      decodeHeadValue(localizedHeadValue(edgeHtml, "twitter:title")),
    ).toContain(visibleTitleEn);
    expect(decodeHeadValue(localizedHeadValue(edgeHtml, "og:description"))).toBe(
      edgeDescription,
    );
    expect(
      decodeHeadValue(localizedHeadValue(edgeHtml, "twitter:description")),
    ).toBe(edgeDescription);

    await page.goto(`${pendingPath}?lang=en`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect.poll(() => page.title()).toContain(visibleTitleEn);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      edgeDescription,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      canonicalUrl,
    );
    const englishStructuredData = JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent() ?? "{}",
    );
    expect(englishStructuredData).toEqual(structuredData);

    const readyPath = `/e/${readyFixture!.id}/`;
    await page.goto(readyPath, { waitUntil: "domcontentloaded" });
    const readyDescriptionJa = await page.locator('meta[name="description"]').getAttribute("content");
    expect(readyDescriptionJa).toBeTruthy();
    expect(readyDescriptionJa).not.toMatch(/AI 要約は準備中|AI summary pending/);
    await page.goto(`${readyPath}?lang=en`, { waitUntil: "domcontentloaded" });
    const readyDescriptionEn = await page.locator('meta[name="description"]').getAttribute("content");
    expect(readyDescriptionEn).toBeTruthy();
    expect(readyDescriptionEn).not.toMatch(/AI 要約は準備中|AI summary pending/);
  });

  test("localizes every generated article response without HTML parser failures", async () => {
    const articleDirectories = readdirSync("web/dist/e", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(articleDirectories.length).toBeGreaterThan(0);

    const failures: Array<{ id: string; status: number }> = [];
    for (const id of articleDirectories) {
      const html = readFileSync(path.join("web/dist/e", id, "index.html"), "utf8");
      const response = await localizeArticleMetadata({
        request: new Request(`${SITE_URL}/e/${id}/?lang=en`),
        next: async () => new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      });
      if (response.status !== 200) failures.push({ id, status: response.status });
    }

    expect(failures).toEqual([]);
  });

  test("keeps source images and gives image-less articles complete localized metadata", async ({
    page,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<
        SummaryDisplayEntry
        & PublicationEntry
        & {
          id: string;
          archiveTier?: string;
          image?: { src?: string; width?: number; height?: number };
        }
      >;
    };
    const addressable = index.entries.filter(
      (entry) => isAddressableDetailEntry(entry),
    );
    const imageBacked = addressable.find(
      (entry) => articleSocialImage(entry.image, "JA", "EN").url !== SOCIAL_IMAGE_URL,
    );
    const imageLess = addressable.find(
      (entry) =>
        isPublishableEntry(entry)
        && articleSocialImage(entry.image, "JA", "EN").url === SOCIAL_IMAGE_URL,
    );
    expect(imageBacked, "fixture includes an addressable image-backed article").toBeTruthy();
    expect(imageLess, "fixture includes an addressable image-less article").toBeTruthy();

    await page.goto(`/e/${imageBacked!.id}/`, { waitUntil: "domcontentloaded" });
    const backedExpected = articleSocialImage(imageBacked!.image, "JA", "EN");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      backedExpected.url,
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
      "content",
      backedExpected.url,
    );
    expect(
      JSON.parse(
        (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
      ).image.url,
    ).toBe(backedExpected.url);

    await page.goto(`/e/${imageLess!.id}/`, { waitUntil: "domcontentloaded" });
    for (const selector of [
      'link[rel="canonical"]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[property="og:image"]',
      'meta[property="og:image:alt"]',
      'meta[name="twitter:title"]',
      'meta[name="twitter:description"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:alt"]',
    ]) {
      await expect(page.locator(selector), `${selector} is emitted exactly once`).toHaveCount(1);
    }
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      SOCIAL_IMAGE_URL,
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute(
      "content",
      SOCIAL_IMAGE_URL,
    );
    await expect(page.locator('meta[property="og:image:type"]')).toHaveAttribute(
      "content",
      "image/png",
    );
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
      "content",
      String(SOCIAL_IMAGE_WIDTH),
    );
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute(
      "content",
      String(SOCIAL_IMAGE_HEIGHT),
    );

    const description = page.locator('meta[name="description"]');
    const jaDescription = await description.getAttribute("data-meta-content-ja");
    const enDescription = await description.getAttribute("data-meta-content-en");
    expect(jaDescription).toBeTruthy();
    expect(enDescription).toBeTruthy();
    expect(jaDescription).not.toBe(enDescription);
    expect(`${jaDescription} ${enDescription}`).not.toMatch(
      /AI 要約は準備中|AI summary pending|近日中/,
    );
    expect(
      JSON.parse(
        (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
      ).image,
    ).toMatchObject({
      url: SOCIAL_IMAGE_URL,
      contentUrl: SOCIAL_IMAGE_URL,
      width: SOCIAL_IMAGE_WIDTH,
      height: SOCIAL_IMAGE_HEIGHT,
    });

    await page.goto(`/e/${imageLess!.id}/?lang=en`, {
      waitUntil: "domcontentloaded",
    });
    const title = page.locator("title");
    const enTitle = await title.getAttribute("data-meta-content-en");
    expect(enTitle).toBeTruthy();
    await expect.poll(() => page.title()).toBe(enTitle!);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      enDescription!,
    );
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      "content",
      enDescription!,
    );
    await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute(
      "content",
      enDescription!,
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      `${SITE_URL}/e/${imageLess!.id}/?lang=en`,
    );
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
      "content",
      /without a source image/,
    );
  });

  test("renders bounded JA and EN article descriptions from the shared helper", async ({
    page,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<
        SummaryDisplayEntry & {
          id: string;
          archiveTier?: string;
        }
      >;
    };
    const fixture = index.entries.find((entry) => {
      if (entry.archiveTier === "cold" || entry.archiveTier === "dropped") return false;
      const summaryJa = summaryForLang(entry, "ja");
      const summaryEn = summaryForLang(entry, "en");
      return Boolean(
        summaryJa
        && summaryEn
        && (
          Array.from(summaryJa).length > SOCIAL_DESCRIPTION_CHARACTER_LIMIT
          || Array.from(summaryEn).length > SOCIAL_DESCRIPTION_CHARACTER_LIMIT
        ),
      );
    });
    expect(fixture, "fixture includes a long addressable bilingual summary").toBeTruthy();

    const expectedJa = boundedSocialDescription(summaryForLang(fixture!, "ja"), "ja");
    const expectedEn = boundedSocialDescription(summaryForLang(fixture!, "en"), "en");
    for (const expected of [expectedJa, expectedEn]) {
      expect(Array.from(expected).length).toBeLessThanOrEqual(
        SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
      );
    }

    await page.goto(`/e/${fixture!.id}/`, { waitUntil: "domcontentloaded" });
    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute("content", expectedJa);
    await expect(description).toHaveAttribute("data-meta-content-ja", expectedJa);
    await expect(description).toHaveAttribute("data-meta-content-en", expectedEn);
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      "content",
      expectedJa,
    );
    await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute(
      "content",
      expectedJa,
    );

    await page.goto(`/e/${fixture!.id}/?lang=en`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      expectedEn,
    );
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      "content",
      expectedEn,
    );
    await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute(
      "content",
      expectedEn,
    );
  });

  test("announces detail and disclosure source links in both languages", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const internalEntry = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(internalEntry).toBeVisible();
    await expect(internalEntry).not.toHaveAttribute("target");
    await expect(internalEntry).not.toHaveAttribute("rel");
    await expect(internalEntry).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );
    const detailHref = await internalEntry.getAttribute("href");
    if (!detailHref) throw new Error("generated Timeline entry is missing href");

    const disclosure = page.locator(".featured-src.source-disclosure");
    const disclosureTrigger = disclosure.locator("[data-source-disclosure-trigger]");
    await expect(disclosureTrigger).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );
    await disclosureTrigger.click();
    const disclosureLink = disclosure.locator(".source-disclosure-link");
    await expect(disclosureLink).toHaveAttribute("target", "_blank");
    await expect(disclosureLink).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(disclosureLink).toHaveAccessibleName(
      /元記事で掲載元を確認.*新しいタブで開きます/,
    );
    await expect(disclosureLink.locator('[data-hint-lang="ja"]')).toBeVisible();
    await expect(disclosureLink.locator('[data-hint-lang="en"]')).toBeHidden();
    await expect(disclosureLink.locator('[data-external-link-hint]:visible')).toHaveCount(1);
    await expect(disclosureLink.locator(':scope > [aria-hidden="true"]')).toHaveCount(0);

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(disclosureLink).toHaveAccessibleName(
      /Verify at the original article.*opens in a new tab/,
    );
    await expect(disclosureLink.locator('[data-hint-lang="en"]')).toBeVisible();
    await expect(disclosureLink.locator('[data-hint-lang="ja"]')).toBeHidden();
    await expect(disclosureTrigger).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );

    await page.goto(detailHref, { waitUntil: "domcontentloaded" });
    await page.locator('.lang-btn[data-lang="ja"]').click();
    const sourceCta = page.locator(".ed-header-cta");
    await expect(sourceCta).toHaveAttribute("target", "_blank");
    await expect(sourceCta).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(sourceCta).toHaveAccessibleName(
      /元記事を読む.*新しいタブで開きます/,
    );
    await expect(sourceCta.locator('[data-hint-lang="ja"]')).toBeVisible();
    await expect(sourceCta.locator('[data-hint-lang="en"]')).toBeHidden();
    await expect(sourceCta.locator('[data-external-link-hint]:visible')).toHaveCount(1);
    await expect(sourceCta.locator(':scope > [aria-hidden="true"]')).toHaveCount(0);

    const copyAction = page.locator(".ed-share-btn[data-share-copy]");
    await expect(copyAction).not.toHaveAttribute("target");
    await expect(copyAction).not.toHaveAttribute("rel");
    await expect(copyAction).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(sourceCta).toHaveAccessibleName(
      /Read original article.*opens in a new tab/,
    );
    await expect(sourceCta.locator('[data-hint-lang="en"]')).toBeVisible();
    await expect(sourceCta.locator('[data-hint-lang="ja"]')).toBeHidden();
    await expect(copyAction).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );
  });

  test("publishes coherent generated metrics", async ({ request }) => {
    const response = await request.get("/metrics.json");
    expect(response.ok()).toBe(true);

    const metrics = (await response.json()) as Record<string, unknown>;
    expect(metrics.liveEntries).toEqual(expect.any(Number));
    expect(metrics.allTimeEntries).toEqual(expect.any(Number));
    expect(metrics.totalSourceCount).toEqual(expect.any(Number));
    expect(metrics.totalCategories).toEqual(expect.any(Number));
    expect(Number(metrics.liveEntries)).toBeGreaterThan(0);
    expect(Number(metrics.allTimeEntries)).toBeGreaterThanOrEqual(
      Number(metrics.liveEntries),
    );
    expect(Number(metrics.totalSourceCount)).toBeGreaterThan(0);
    expect(Number(metrics.totalCategories)).toBeGreaterThan(0);
    expect(Number(metrics.archiveEntries)).toBeGreaterThan(
      Number(metrics.archiveBrowsableEntries),
    );
    expect(Number.isFinite(Date.parse(String(metrics.generatedAt)))).toBe(true);
  });

  test("publishes crawler discovery endpoints", async ({ request }) => {
    const sitemapResponse = await request.get("/sitemap.xml");
    const sitemap = await sitemapResponse.text();
    expect(sitemapResponse.status()).toBe(200);
    expect(sitemapResponse.headers()["content-type"]).toMatch(/^(?:application|text)\/xml\b/);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(sitemap).toContain(`<loc>${SITE_URL}/</loc>`);

    const robotsResponse = await request.get("/robots.txt");
    const robots = await robotsResponse.text();
    expect(robotsResponse.status()).toBe(200);
    expect(robotsResponse.headers()["content-type"]).toContain("text/plain");
    expect(robots).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  test("publishes the exact public RSS bundle as OPML 2.0", async ({ request }) => {
    const [opmlResponse, homeResponse, aboutResponse, unknownResponse] =
      await Promise.all([
        request.get(OPML_HREF),
        request.get("/"),
        request.get("/about/"),
        request.get("/feeds-not-found.opml"),
      ]);
    const xml = await opmlResponse.text();
    const home = await homeResponse.text();
    const about = await aboutResponse.text();
    const builtHeaders = readFileSync("web/dist/_headers", "utf8");
    const expectedFeeds = publicRssFeeds();

    expect(opmlResponse.status()).toBe(200);
    expect(XMLValidator.validate(xml)).toBe(true);
    const document = new XMLParser({
      ignoreAttributes: false,
      parseAttributeValue: false,
      parseTagValue: false,
    }).parse(xml) as {
      opml?: {
        "@_version"?: string;
        head?: { title?: string };
        body?: {
          outline?:
            | Record<string, string>
            | Array<Record<string, string>>;
        };
      };
    };
    const parsedOutlines = document.opml?.body?.outline;
    const outlines = Array.isArray(parsedOutlines)
      ? parsedOutlines
      : parsedOutlines
        ? [parsedOutlines]
        : [];

    expect(document.opml?.["@_version"]).toBe("2.0");
    expect(document.opml?.head?.title).toBe(OPML_TITLE);
    expect(outlines).toEqual(
      expectedFeeds.map((feed) => ({
        "@_type": "rss",
        "@_text": feed.title,
        "@_title": feed.title,
        "@_xmlUrl": publicFeedXmlUrl(feed),
        "@_htmlUrl": publicFeedHtmlUrl(feed),
        "@_description": feed.description,
        "@_language": "ja",
        "@_version": "RSS",
      })),
    );
    expect(new Set(outlines.map((outline) => outline["@_xmlUrl"])).size).toBe(
      outlines.length,
    );
    expect(xml).not.toContain("/feed.json");
    expect(home).toMatch(
      new RegExp(
        `<link\\b(?=[^>]*\\brel="outline")(?=[^>]*\\btype="${OPML_MEDIA_TYPE}")(?=[^>]*\\bhref="${OPML_HREF.replace(".", "\\.")}")[^>]*>`,
      ),
    );
    expect(about).toContain(`href="${OPML_HREF}"`);
    expect(about).toContain("OPMLで一括購読");
    expect(about).toContain("Subscribe via OPML");
    expect(builtHeaders).toContain(
      "/feeds.opml\n  Content-Type: text/x-opml; charset=utf-8",
    );
    expect(unknownResponse.status()).toBe(404);
  });

  test("publishes the JSON Feed body and Pages delivery contract", async ({
    request,
  }) => {
    const [homeResponse, feedResponse, metricsResponse] = await Promise.all([
      request.get("/"),
      request.get("/feed.json"),
      request.get("/metrics.json"),
    ]);
    const home = await homeResponse.text();
    const feed = (await feedResponse.json()) as {
      version?: string;
      feed_url?: string;
      items?: Array<{
        id?: string;
        url?: string;
        summary?: string;
        content_text?: string;
        _source?: string;
        _importance?: number;
      }>;
    };
    const raw = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: FeedArtifactEntry[];
    };
    const expectedEntries = raw.entries.filter(isPublishableEntry).slice(0, 100);
    const feedItems = feed.items ?? [];
    const builtHeaders = readFileSync("web/dist/_headers", "utf8");

    expect(homeResponse.status()).toBe(200);
    expect(home).toMatch(
      /<link\b(?=[^>]*\brel="alternate")(?=[^>]*\btype="application\/feed\+json")(?=[^>]*\bhref="\/feed\.json")[^>]*>/,
    );
    expect(feedResponse.status()).toBe(200);
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    expect(feed.feed_url).toBe(`${SITE_URL}/feed.json`);
    expect(feedItems.length).toBeGreaterThan(0);
    expect(feedItems.length).toBeLessThanOrEqual(100);
    expect(feedItems.map((item) => item.url)).toEqual(
      expectedEntries.map((entry) => entry.url),
    );
    expect(feedItems.every((item) => Boolean(item.content_text?.trim()))).toBe(
      true,
    );
    for (const [index, item] of feedItems.entries()) {
      const entry = expectedEntries[index];
      if (!entry) throw new Error(`JSON Feed item ${index} has no source entry`);
      const digest = buildFeedDecisionDigest(entry);
      expect(item).toMatchObject({
        id: entry.id,
        url: entry.url,
        summary: digest.text,
        content_text: digest.text,
        _source: entry.source,
        _importance: entry.importance,
      });
    }
    expect(builtHeaders).toContain(
      "/feed.json\n  Content-Type: application/feed+json; charset=utf-8",
    );
    expect(metricsResponse.headers()["content-type"].split(";", 1)[0]).toBe(
      "application/json",
    );
  });

  test("publishes the canonical AdSense authorized seller record", async ({ request }) => {
    const response = await request.get("/ads.txt");
    const body = await response.text();

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"].split(";", 1)[0]).toBe("text/plain");
    expect(body).toBe(buildAdsTxt(ADSENSE_CLIENT_ID));
    expect(body.match(/\n/g)).toHaveLength(1);
  });

  test("keeps hot and warm details addressable while cold details stay month-only", async ({
    request,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<DetailAddressableEntry & { archiveTier?: string }>;
    };
    // Detail routes require both a hot/warm tier and a usable summary
    // (detail-addressability.ts): summary-pending shells are no longer built.
    const hot = index.entries.find(
      (entry) => entry.archiveTier === "hot" && isAddressableDetailEntry(entry),
    );
    const cold = index.entries.find((entry) => entry.archiveTier === "cold");
    const pendingLive = index.entries.find(
      (entry) =>
        entry.archiveTier !== "cold" &&
        entry.archiveTier !== "dropped" &&
        !isAddressableDetailEntry(entry),
    );
    const liveIds = new Set(index.entries.map((entry) => entry.id));
    const archiveIndex = JSON.parse(
      readFileSync("data/archive/_index.json", "utf8"),
    ) as { months: string[] };
    let warmOnly: { id: string } | undefined;
    for (const month of archiveIndex.months) {
      const archive = JSON.parse(
        readFileSync(`data/archive/${month}.json`, "utf8"),
      ) as { entries: Array<DetailAddressableEntry & { archiveTier?: string }> };
      warmOnly = archive.entries.find(
        (entry) =>
          entry.archiveTier === "warm" &&
          !liveIds.has(entry.id) &&
          isAddressableDetailEntry(entry),
      );
      if (warmOnly) break;
    }

    expect(hot, "fixture includes a hot detail").toBeTruthy();
    expect(warmOnly, "fixture includes a warm archive-only detail").toBeTruthy();
    expect(cold, "fixture includes a cold live-index row").toBeTruthy();

    const [hotResponse, warmResponse, coldResponse, sitemapResponse] = await Promise.all([
      request.get(`/e/${hot!.id}/`),
      request.get(`/e/${warmOnly!.id}/`),
      request.get(`/e/${cold!.id}/`),
      request.get("/sitemap.xml"),
    ]);
    const sitemap = await sitemapResponse.text();

    expect(hotResponse.status()).toBe(200);
    expect(warmResponse.status()).toBe(200);
    expect(coldResponse.status()).toBe(404);
    expect(sitemap).toContain(`<loc>${SITE_URL}/e/${hot!.id}/</loc>`);
    expect(sitemap).toContain(`<loc>${SITE_URL}/e/${warmOnly!.id}/</loc>`);
    expect(sitemap).not.toContain(`<loc>${SITE_URL}/e/${cold!.id}/</loc>`);

    // Summary-pending live entries must not ship a thin detail shell either
    // (AdSense low-value-content guard). A fully summarized corpus is valid.
    if (pendingLive) {
      const pendingResponse = await request.get(`/e/${pendingLive.id}/`);
      expect(pendingResponse.status()).toBe(404);
      expect(sitemap).not.toContain(`<loc>${SITE_URL}/e/${pendingLive.id}/</loc>`);
    }
  });

  test("routes and announces cold source links while hot and warm cards stay internal", async ({
    page,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string; url: string; archiveTier?: string; category: string }>;
    };
    const timelineRoutes = generatedEntryRoutes("page");
    const archiveRoutes = generatedEntryRoutes("archive");
    // Card-visibility assertions require lanes the reader can see: the
    // timeline hides default-muted categories (category-visibility.ts).
    const cold = index.entries
      .filter((entry) => entry.archiveTier === "cold" && !isDefaultMutedCategory(entry.category))
      .map((entry) => ({ entry, route: timelineRoutes.get(entry.id) }))
      .find(({ route }) => route);
    const hot = index.entries
      .filter((entry) =>
        entry.archiveTier === "hot"
        && isAddressableDetailEntry(entry)
        && !isDefaultMutedCategory(entry.category))
      .map((entry) => ({ entry, route: timelineRoutes.get(entry.id) }))
      .find(({ route }) => route);
    const archiveIndex = JSON.parse(
      readFileSync("data/archive/_index.json", "utf8"),
    ) as { months: string[] };
    let warm: {
      entry: { id: string; url: string; archiveTier?: string };
      route: string;
    } | undefined;
    for (const month of archiveIndex.months) {
      const archive = JSON.parse(
        readFileSync(`data/archive/${month}.json`, "utf8"),
      ) as { entries: Array<{ id: string; url: string; archiveTier?: string }> };
      const entry = archive.entries.find(
        (candidate) =>
          candidate.archiveTier === "warm" && isAddressableDetailEntry(candidate),
      );
      const route = entry ? archiveRoutes.get(entry.id) : undefined;
      if (entry && route) {
        warm = { entry, route };
        break;
      }
    }

    expect(cold, "fixture includes a cold card on a generated timeline page").toBeTruthy();
    expect(hot, "fixture includes a hot card on a generated timeline page").toBeTruthy();
    expect(warm, "fixture includes a warm card on a generated archive page").toBeTruthy();

    await page.goto(cold!.route!, { waitUntil: "domcontentloaded" });
    const coldCard = page.locator(`[data-entry-id="${cold!.entry.id}"]`);
    await expect(coldCard).toHaveAttribute("data-detail-destination", "source");
    const coldLink = coldCard.locator("h3.title > a");
    await expect(coldLink).toHaveAttribute("href", canonicalSourceUrl(cold!.entry.url));
    await expect(coldLink).toHaveAttribute("target", "_blank");
    await expect(coldLink).toHaveAttribute("rel", "noopener noreferrer nofollow");
    const coldAction = coldCard.locator("a.url");
    await expect(coldAction).toHaveAttribute("target", "_blank");
    await expect(coldAction).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(coldLink).toHaveAccessibleName(/新しいタブで開きます/);
    const jaHint = coldLink.locator(
      '[data-external-link-hint][data-hint-lang="ja"]',
    );
    const enHint = coldLink.locator(
      '[data-external-link-hint][data-hint-lang="en"]',
    );
    await expect(jaHint).toBeVisible();
    await expect(jaHint.locator('[aria-hidden="true"]')).toHaveText("↗");
    await expect(enHint).toBeHidden();
    await expect(page.locator(`a[href="/e/${cold!.entry.id}/"]`)).toHaveCount(0);

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(coldLink).toHaveAccessibleName(/opens in a new tab/);
    await expect(enHint).toBeVisible();
    await expect(jaHint).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(enHint).toBeVisible();
    await page.locator('.lang-btn[data-lang="ja"]').click();
    await expect(coldLink).toHaveAccessibleName(/新しいタブで開きます/);
    await expect(jaHint).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    await page.goto(hot!.route!, { waitUntil: "domcontentloaded" });
    const hotCard = page.locator(`[data-entry-id="${hot!.entry.id}"]`);
    await expect(hotCard).toHaveAttribute("data-detail-destination", "internal");
    const hotLink = hotCard.locator("h3.title > a");
    await expect(hotLink).toHaveAttribute(
      "href",
      `/e/${hot!.entry.id}/`,
    );
    await expect(hotLink).not.toHaveAttribute("target");
    await expect(hotLink).not.toHaveAttribute("rel");
    await expect(hotCard.locator("a.url")).not.toHaveAttribute("target");
    await expect(hotCard.locator("a.url")).not.toHaveAttribute("rel");
    await expect(hotLink.locator("[data-external-link-hint]")).toHaveCount(0);
    await expect(hotLink).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );

    await page.goto(warm!.route, { waitUntil: "domcontentloaded" });
    const warmCard = page.locator(`[data-entry-id="${warm!.entry.id}"]`);
    await expect(warmCard).toHaveAttribute("data-detail-destination", "internal");
    const warmLink = warmCard.locator("h3.title > a");
    await expect(warmLink).toHaveAttribute(
      "href",
      `/e/${warm!.entry.id}/`,
    );
    await expect(warmLink).not.toHaveAttribute("target");
    await expect(warmLink).not.toHaveAttribute("rel");
    await expect(warmCard.locator("a.url")).not.toHaveAttribute("target");
    await expect(warmCard.locator("a.url")).not.toHaveAttribute("rel");
    await expect(warmLink.locator("[data-external-link-hint]")).toHaveCount(0);
    await expect(warmLink).not.toHaveAccessibleName(
      /新しいタブで開きます|opens in a new tab/,
    );
  });

  test("links the archive index to a generated month", async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const archiveResponse = await page.goto("/archive/", {
      waitUntil: "domcontentloaded",
    });

    expect(archiveResponse?.status()).toBeLessThan(400);
    await expect(page.locator("#archive-heading")).toBeVisible();
    const populations = await page.evaluate(() => {
      const metricValue = (scope: string) =>
        Number(document.querySelector(`[data-metric-scope="${scope}"] strong`)?.textContent?.trim());
      return {
        browsable: metricValue("archive-browsable"),
        stored: metricValue("archive-stored"),
      };
    });
    expect(populations.stored).toBeGreaterThan(populations.browsable);
    const firstMonth = page.locator("a.month-card").first();
    await expect(firstMonth).toBeVisible();
    const href = await firstMonth.getAttribute("href");
    if (!href) throw new Error("generated archive month is missing href");
    expect(href).toMatch(/^\/archive\/\d{4}-\d{2}\/?$/);

    const monthResponse = await page.goto(href, {
      waitUntil: "domcontentloaded",
    });
    expect(monthResponse?.status()).toBeLessThan(400);
    await expect(page.locator("#archive-month-heading")).toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });

  test("keeps an unknown generated route as a real 404", async ({ page }) => {
    const pageErrors = collectPageErrors(page);
    const response = await page.goto("/e/0000000000000000/", {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBe(404);
    await expect(page.locator("#not-found-heading")).toBeVisible();
    await expect(page.locator("[data-recovery-action]")).toHaveCount(3);
    expect(pageErrors).toEqual([]);
  });

  test("publishes global and category-specific RSS routes", async ({ request }) => {
    const raw = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: FeedArtifactEntry[];
    };
    const expectedGlobalEntries = raw.entries.filter(isPublishableEntry).slice(0, 100);
    const globalResponse = await request.get("/rss.xml");
    const globalXml = await globalResponse.text();
    const globalItems = rssItemDocuments(globalXml);
    expect(globalResponse.status()).toBe(200);
    expect(globalResponse.headers()["content-type"]).toMatch(/^text\/xml(?:;|$)/);
    expect(globalItems.length).toBeGreaterThan(0);
    expect(globalItems.length).toBeLessThanOrEqual(100);
    expect(globalItems.map((item) => item.link)).toEqual(
      expectedGlobalEntries.map((entry) => entry.url),
    );
    expect(globalItems.map((item) => item.description)).toEqual(
      expectedGlobalEntries.map((entry) => buildFeedDecisionDigest(entry).text),
    );

    let categoryItemCount = 0;
    for (const category of CATEGORY_META) {
      const feedHref = `/rss/${category.slug}.xml`;
      const response = await request.get(feedHref);
      const xml = await response.text();
      const items = rssItemDocuments(xml);
      expect(response.status(), feedHref).toBe(200);
      expect(response.headers()["content-type"], feedHref).toMatch(
        /^text\/xml(?:;|$)/,
      );
      expect(items.length, feedHref).toBeLessThanOrEqual(100);
      for (const item of items) {
        expect(rssItemCategory(item), feedHref).toBe(category.slug);
        const entry = raw.entries.find((candidate) => candidate.url === item.link);
        if (!entry) throw new Error(`${feedHref} contains unknown item ${item.link}`);
        expect(item.description, feedHref).toBe(buildFeedDecisionDigest(entry).text);
      }
      categoryItemCount += items.length;
    }
    expect(categoryItemCount).toBeGreaterThan(0);

    const category = CATEGORY_META[0];
    if (!category) throw new Error("category metadata is empty");
    const categoryPageResponse = await request.get(`/c/${category.slug}/`);
    const categoryHtml = await categoryPageResponse.text();
    expect(categoryPageResponse.status()).toBe(200);
    expect(categoryHtml).toContain(`href="/rss/${category.slug}.xml"`);
    expect(categoryHtml).not.toContain("/rss.xml?category=");

    const unknownResponse = await request.get("/rss/not-a-category.xml");
    expect(unknownResponse.status()).toBe(404);
  });

  test("Research RSS matches the publishable HTML lane and excludes arXiv", async ({
    page,
    request,
  }) => {
    const raw = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: FeedArtifactEntry[];
    };
    const byId = new Map(raw.entries.map((entry) => [entry.id, entry]));
    const listingIds: string[] = [];
    const visitedCategoryPages = new Set<string>();
    let categoryHref = "/c/research/";

    while (true) {
      if (visitedCategoryPages.has(categoryHref)) {
        throw new Error(`Research pagination cycle detected at ${categoryHref}`);
      }
      visitedCategoryPages.add(categoryHref);
      const categoryResponse = await page.goto(categoryHref, {
        waitUntil: "domcontentloaded",
      });
      expect(categoryResponse?.status()).toBe(200);
      listingIds.push(
        ...await page
          .locator("article.card[data-entry-id]")
          .evaluateAll((cards) =>
            cards
              .map((card) => card.getAttribute("data-entry-id") ?? "")
              .filter(Boolean),
          ),
      );
      const nextLink = page.locator("nav.pager a[rel=next]");
      const nextHref = await nextLink.count() > 0
        ? await nextLink.getAttribute("href")
        : null;
      if (!nextHref) break;
      categoryHref = nextHref;
    }

    const expectedEntries = listingIds
      .map((id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error(`Research listing entry ${id} is absent from data/index.json`);
        return entry;
      })
      .filter(isPublishableEntry);
    const expectedUrls = expectedEntries.slice(0, 100).map((entry) => entry.url);
    expect(expectedUrls.length).toBeGreaterThan(0);
    expect(expectedEntries.filter(isArxivEntry)).toEqual([]);

    const feedResponse = await request.get("/rss/research.xml");
    const feedXml = await feedResponse.text();
    const feedUrls = rssItemDocuments(feedXml).map((item) => item.link ?? "");
    expect(feedResponse.status()).toBe(200);
    expect(feedUrls).toEqual(expectedUrls);
    expect(
      feedUrls
        .map((url) => raw.entries.find((entry) => entry.url === url))
        .filter((entry): entry is FeedArtifactEntry => entry !== undefined)
        .filter(isArxivEntry),
    ).toEqual([]);

  });

  test("arXiv RSS matches the publishable HTML lane and keeps Research separate", async ({
    page,
    request,
  }) => {
    const raw = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: FeedArtifactEntry[];
    };
    const byId = new Map(raw.entries.map((entry) => [entry.id, entry]));

    const pageResponse = await page.goto("/arxiv/", {
      waitUntil: "domcontentloaded",
    });
    expect(pageResponse?.status()).toBe(200);
    const laneIds = await page
      .locator('[data-paper-view-panel="cards"] article.card[data-entry-id]')
      .evaluateAll((cards) =>
        cards
          .map((card) => card.getAttribute("data-entry-id") ?? "")
          .filter(Boolean),
      );
    const expectedEntries = laneIds
      .map((id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error(`arXiv listing entry ${id} is absent from data/index.json`);
        return entry;
      })
      .filter(isPublishableEntry);
    expect(expectedEntries.every(isArxivEntry)).toBe(true);
    const expectedUrls = expectedEntries.slice(0, 100).map((entry) => entry.url);
    expect(expectedUrls.length).toBeGreaterThan(0);

    const [arxivResponse, researchResponse] = await Promise.all([
      request.get("/rss/arxiv.xml"),
      request.get("/rss/research.xml"),
    ]);
    const arxivXml = await arxivResponse.text();
    const researchXml = await researchResponse.text();
    const arxivItems = rssItemDocuments(arxivXml);
    const arxivUrls = arxivItems.map((item) => item.link ?? "");
    const researchUrls = rssItemDocuments(researchXml).map((item) => item.link ?? "");

    expect(arxivResponse.status()).toBe(200);
    expect(arxivResponse.headers()["content-type"]).toMatch(
      /^(?:application|text)\/xml(?:;|$)/,
    );
    expect(arxivUrls).toEqual(expectedUrls);
    expect(arxivItems.map((item) => item.description)).toEqual(
      expectedEntries
        .slice(0, 100)
        .map((entry) => buildFeedDecisionDigest(entry).text),
    );
    expect(arxivItems.length).toBeLessThanOrEqual(100);
    expect(
      arxivItems.every((item) => rssItemCategory(item) === "research"),
    ).toBe(true);
    expect(
      researchUrls
        .map((url) => raw.entries.find((entry) => entry.url === url))
        .filter((entry): entry is FeedArtifactEntry => entry !== undefined)
        .filter(isArxivEntry),
    ).toEqual([]);
    await expect(
      page.locator(
        'head link[rel="alternate"][type="application/rss+xml"][href="/rss/arxiv.xml"]',
      ),
    ).toHaveCount(1);
  });

  test("Knowledge RSS matches the publishable evergreen lane", async ({
    request,
  }) => {
    const raw = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: FeedArtifactEntry[];
    };
    const expectedEntries = raw.entries
      .filter(isKnowledgeEligibleEntry)
      .filter(isPublishableEntry);
    const expectedUrls = expectedEntries.slice(0, 100).map((entry) => entry.url);

    expect(expectedUrls.length).toBeGreaterThan(0);
    const response = await request.get("/rss/knowledge.xml");
    const xml = await response.text();
    const items = rssItemDocuments(xml);
    const feedUrls = items.map((item) => item.link ?? "");

    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(
      /^(?:application|text)\/xml(?:;|$)/,
    );
    expect(feedUrls).toEqual(expectedUrls);
    expect(items.map((item) => item.description)).toEqual(
      expectedEntries
        .slice(0, 100)
        .map((entry) => buildFeedDecisionDigest(entry).text),
    );
    expect(items.length).toBeLessThanOrEqual(100);
    expect(
      feedUrls
        .map((url) => raw.entries.find((entry) => entry.url === url))
        .filter((entry): entry is FeedArtifactEntry => entry !== undefined)
        .every((entry) => isKnowledgeEligibleEntry(entry) && isPublishableEntry(entry)),
    ).toBe(true);

    // stored exclusion (evergreen かつ Knowledge 不適格) は Knowledge feed に
    // 出さない。母集団は毎回のデータから導出するので、どの記事が live 枠を
    // 持っていても常に検証される。
    const storedExclusions = raw.entries.filter(
      (entry) =>
        (entry as { evergreen?: unknown }).evergreen === true
        && !isKnowledgeEligibleEntry(entry),
    );
    expect(storedExclusions.length).toBeGreaterThan(0);
    for (const entry of storedExclusions) {
      expect(feedUrls).not.toContain(entry.url);
    }

    // issue #237 の anchor は名前付きケースとして維持する。ただし live 在籍は
    // 前提にしない: live index の cap (PER_SOURCE_CAP / CATEGORY_CAPS /
    // INDEX_LIMIT) は evergreen も pickScore だけで永久 eviction するため、
    // 固定 ID が live に居ることを要求すると、Publisher の fail-closed 検証が
    // 「publish 停止 → commit 済みデータは古いまま → 新規生成では必ず落ちる」
    // という恒久デッドロックになる (PR #247 が unit test 側で修正した同じ罠)。
    // evict された記事は archive 側の保証 (tests/data-schema.test.ts の
    // evergreen ゲート) が引き続き担保する。
    for (const id of ISSUE_237_KNOWLEDGE_EXCLUSION_ANCHORS) {
      const entry = raw.entries.find((candidate) => candidate.id === id);
      if (!entry) continue;
      expect(feedUrls).not.toContain(entry.url);
      const detailResponse = await request.get(`/e/${id}/`);
      expect(detailResponse.status()).toBe(200);
    }

    const pageResponse = await request.get("/knowledge/");
    const pageHtml = await pageResponse.text();
    expect(pageResponse.status()).toBe(200);
    expect(pageHtml).toContain(`href="${KNOWLEDGE_RSS_FEED.href}"`);
    // title は feed-catalog を単一の真実の源とし、実体参照の表記揺れ
    // (&amp; と &#38; はどちらも &) に依存しない形で比較する。
    const knowledgeAlternate = pageHtml.match(
      new RegExp(
        `<link\\b(?=[^>]*rel="alternate")(?=[^>]*href="${KNOWLEDGE_RSS_FEED.href}")[^>]*>`,
        "i",
      ),
    )?.[0];
    expect(knowledgeAlternate).toBeDefined();
    expect(
      decodeHeadValue(knowledgeAlternate?.match(/\stitle="([^"]*)"/i)?.[1] ?? ""),
    ).toBe(KNOWLEDGE_RSS_FEED.title);
  });

  test("keeps legacy low-frequency tag URLs recoverable", async ({ request }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ tags?: string[] }>;
    };
    const counts = new Map<string, number>();
    for (const entry of index.entries) {
      for (const tag of new Set((entry.tags ?? []).map(normalizeTagKey).filter(Boolean))) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    const tag = [...counts.entries()].find(([, count]) => count >= 2 && count < 10)?.[0];
    expect(tag, "fixture includes a legacy low-frequency tag").toBeTruthy();
    const encodedTag = encodeURIComponent(tag!);
    const response = await request.get(`/t/${encodedTag}/`);
    const html = await response.text();

    expect(response.status()).toBe(200);
    expect(html).toContain(`content="0;url=/search/?q=${encodedTag}&amp;tag=${encodedTag}"`);
    expect(html).toContain(`href="/search/?q=${encodedTag}&amp;tag=${encodedTag}"`);
  });
});
