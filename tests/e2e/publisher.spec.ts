import { expect, test, type Page } from "@playwright/test";

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
});
