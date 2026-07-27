import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { onRequestGet as localizeArticleMetadata } from "../../web/functions/e/[id].ts";
import { onRequestGet as localizeHomeMetadata } from "../../web/functions/index.ts";
import { SITE_URL } from "../../web/src/lib/site.ts";
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
  'main article.card h3.title > a[href^="/e/"]';

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
      entries: Array<{
        id: string;
        archiveTier?: string;
        image?: { src?: string };
      }>;
    };
    const imageLess = index.entries.find(
      (entry) =>
        entry.archiveTier !== "cold"
        && entry.archiveTier !== "dropped"
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
      entries: Array<{
        id: string;
        archiveTier?: string;
        image?: { src?: string; width?: number; height?: number };
      }>;
    };
    const addressable = index.entries.filter(
      (entry) => entry.archiveTier !== "cold" && entry.archiveTier !== "dropped",
    );
    const imageBacked = addressable.find(
      (entry) => articleSocialImage(entry.image, "JA", "EN").url !== SOCIAL_IMAGE_URL,
    );
    const imageLess = addressable.find(
      (entry) => articleSocialImage(entry.image, "JA", "EN").url === SOCIAL_IMAGE_URL,
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

  test("keeps hot and warm details addressable while cold details stay month-only", async ({
    request,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string; archiveTier?: string }>;
    };
    const hot = index.entries.find((entry) => entry.archiveTier === "hot");
    const cold = index.entries.find((entry) => entry.archiveTier === "cold");
    const liveIds = new Set(index.entries.map((entry) => entry.id));
    const archiveIndex = JSON.parse(
      readFileSync("data/archive/_index.json", "utf8"),
    ) as { months: string[] };
    let warmOnly: { id: string } | undefined;
    for (const month of archiveIndex.months) {
      const archive = JSON.parse(
        readFileSync(`data/archive/${month}.json`, "utf8"),
      ) as { entries: Array<{ id: string; archiveTier?: string }> };
      warmOnly = archive.entries.find(
        (entry) => entry.archiveTier === "warm" && !liveIds.has(entry.id),
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
  });

  test("routes and announces cold source links while hot and warm cards stay internal", async ({
    page,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string; url: string; archiveTier?: string }>;
    };
    const timelineRoutes = generatedEntryRoutes("page");
    const archiveRoutes = generatedEntryRoutes("archive");
    const cold = index.entries
      .filter((entry) => entry.archiveTier === "cold")
      .map((entry) => ({ entry, route: timelineRoutes.get(entry.id) }))
      .find(({ route }) => route);
    const hot = index.entries
      .filter((entry) => entry.archiveTier === "hot")
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
      const entry = archive.entries.find((candidate) => candidate.archiveTier === "warm");
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
