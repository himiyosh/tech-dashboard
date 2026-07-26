import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { SITE_URL } from "../../web/src/lib/site.ts";
import { normalizeTagKey } from "../../web/src/lib/tag-normalize.ts";
import { canonicalSourceUrl } from "../../web/src/lib/source-meta.ts";

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

  test("routes cold listing cards to source while hot and warm cards stay internal", async ({
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
    await expect(page.locator(`a[href="/e/${cold!.entry.id}/"]`)).toHaveCount(0);

    await page.goto(hot!.route!, { waitUntil: "domcontentloaded" });
    const hotCard = page.locator(`[data-entry-id="${hot!.entry.id}"]`);
    await expect(hotCard).toHaveAttribute("data-detail-destination", "internal");
    await expect(hotCard.locator("h3.title > a")).toHaveAttribute(
      "href",
      `/e/${hot!.entry.id}/`,
    );

    await page.goto(warm!.route, { waitUntil: "domcontentloaded" });
    const warmCard = page.locator(`[data-entry-id="${warm!.entry.id}"]`);
    await expect(warmCard).toHaveAttribute("data-detail-destination", "internal");
    await expect(warmCard.locator("h3.title > a")).toHaveAttribute(
      "href",
      `/e/${warm!.entry.id}/`,
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
