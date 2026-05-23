import { expect, test } from "@playwright/test";

test.describe("TECH Dashboard smoke", () => {
  test("home renders primary sections", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /TECH Dashboard/i })).toBeVisible();
    await expect(page.locator("section.banner h1.i18n-ja")).toBeVisible();
    await expect(page.locator("section.stats .stat")).toHaveCount(5);
    await expect(page.getByRole("heading", { name: /Timeline/i })).toBeVisible();
  });

  test("first internal article link opens detail page", async ({ page }) => {
    await page.goto("/");

    const firstEntryLink = page.locator('a[href^="/e/"]').first();
    await expect(firstEntryLink).toBeVisible();

    await firstEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    await expect(page.locator("article.entry-detail")).toBeVisible();
    await expect(page.locator("h1.ed-title")).toBeVisible();
    await expect(page.locator('a.ed-cta[target="_blank"]')).toBeVisible();
  });

  test("clicking featured article panel opens detail page", async ({ page }) => {
    await page.goto("/");

    const featured = page.locator("article.featured").first();
    await expect(featured).toBeVisible();

    await featured.click({ position: { x: 24, y: 72 } });
    await expect(page).toHaveURL(/\/e\/.+\/$/);
    await expect(page.locator("article.entry-detail")).toBeVisible();
  });

  test("clicking article card panel opens detail page", async ({ page }) => {
    await page.goto("/");

    const firstCard = page.locator("article.card").first();
    await expect(firstCard).toBeVisible();

    await firstCard.scrollIntoViewIfNeeded();
    await firstCard.click({ position: { x: 24, y: 72 } });
    await expect(page).toHaveURL(/\/e\/.+\/$/);
    await expect(page.locator("article.entry-detail")).toBeVisible();
  });

  test("language toggle changes html data-lang", async ({ page }) => {
    await page.goto("/");

    const jaBtn = page.locator('.lang-btn[data-lang="ja"]');
    const enBtn = page.locator('.lang-btn[data-lang="en"]');

    await expect(jaBtn).toHaveAttribute("aria-pressed", "true");

    await enBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(enBtn).toHaveAttribute("aria-pressed", "true");

    await jaBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "ja");
    await expect(jaBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("status page renders worker and source health", async ({ page }) => {
    await page.goto("/status/");

    await expect(page.getByRole("heading", { name: /Worker Health/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Source Health/i })).toBeVisible();
    await expect(page.locator('[data-source-filter="all"]')).toBeVisible();
    await expect(page.locator('[data-category-filter="all"]')).toBeVisible();
    await expect(page.locator(".source-item").first()).toBeVisible();
    await expect(page.getByText(/stale > \d+h/).first()).toBeVisible();
    await expect(page.locator(".source-latest-line").first()).toBeVisible();
  });

  test("status source filters only show matching rows", async ({ page }) => {
    await page.goto("/status/");

    const targetFilter = await page.locator("[data-source-filter]").evaluateAll((buttons) => {
      const candidates = buttons
        .map((button) => {
          const element = button as HTMLElement;
          return {
            value: element.dataset.sourceFilter ?? "all",
            count: Number(element.querySelector("span")?.textContent ?? "0"),
          };
        })
        .filter((candidate) => candidate.value !== "all" && candidate.count > 0);
      return candidates[0]?.value ?? "ok";
    });

    await page.locator(`[data-source-filter="${targetFilter}"]`).click();
    await expect(page.locator(`[data-source-filter="${targetFilter}"]`)).toHaveAttribute("aria-pressed", "true");

    const visibleStatuses = await page.locator("[data-source-status]").evaluateAll((items) =>
      items
        .filter((item) => !(item as HTMLElement).hidden)
        .map((item) => (item as HTMLElement).dataset.sourceStatus),
    );
    expect(visibleStatuses.length).toBeGreaterThan(0);
    expect(visibleStatuses.every((status) => status === targetFilter)).toBeTruthy();
  });

  test("sources route redirects to unified status page", async ({ page }) => {
    await page.goto("/sources/");

    await expect(page).toHaveURL(/\/status\/?$/);
    await expect(page.getByRole("heading", { name: /Source Health/i })).toBeVisible();
    await expect(page.locator(".source-item").first()).toBeVisible();
    await expect(page.getByText(/tier \d ·/).first()).toBeVisible();
  });

  test("status category filter only shows matching sources", async ({ page }) => {
    await page.goto("/status/");

    const targetCategory = await page.locator("[data-category-filter]").evaluateAll((buttons) => {
      const candidates = buttons
        .map((button) => {
          const element = button as HTMLElement;
          return {
            value: element.dataset.categoryFilter ?? "all",
            count: Number(element.querySelector("span")?.textContent ?? "0"),
          };
        })
        .filter((candidate) => candidate.value !== "all" && candidate.count > 0);
      return candidates[0]?.value ?? "copilot";
    });

    await page.locator(`[data-category-filter="${targetCategory}"]`).click();
    await expect(page.locator(`[data-category-filter="${targetCategory}"]`)).toHaveAttribute("aria-pressed", "true");

    const visibleCategories = await page.locator("[data-source-category]").evaluateAll((items) =>
      items
        .filter((item) => !(item as HTMLElement).hidden)
        .map((item) => (item as HTMLElement).dataset.sourceCategory),
    );
    expect(visibleCategories.length).toBeGreaterThan(0);
    expect(visibleCategories.every((category) => category === targetCategory)).toBeTruthy();
  });

  test("category trends match between sidebar and category cards", async ({ page }) => {
    await page.goto("/categories/");

    const trends = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll<HTMLAnchorElement>(".categories-main a.category-card[href^=\"/c/\"]"));
      return cards.map((cardElement) => {
        const href = cardElement.getAttribute("href") ?? "";
        const sidebarBars = Array.from(document.querySelectorAll(`.left a[href="${href}"] .spark i`))
          .map((barElement) => barElement.getAttribute("style"));
        const cardBars = Array.from(cardElement.querySelectorAll(".cat-trend .cat-bar i"))
          .map((barElement) => barElement.getAttribute("style"));
        return { href, sidebarBars, cardBars };
      });
    });

    expect(trends.length).toBeGreaterThan(0);
    for (const trend of trends) {
      expect(trend.sidebarBars).toHaveLength(30);
      expect(trend.cardBars).toEqual(trend.sidebarBars);
    }
  });

  test("metrics endpoint exposes auto-refresh counts", async ({ request }) => {
    const response = await request.get("/metrics.json");
    expect(response.ok()).toBeTruthy();

    const metrics = await response.json();
    expect(metrics.liveEntries).toBeGreaterThan(0);
    expect(metrics.allTimeEntries).toBeGreaterThanOrEqual(metrics.liveEntries);
    expect(metrics.totalSourceCount).toBeGreaterThan(0);
    expect(metrics.totalCategories).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(metrics.generatedAt))).toBeTruthy();
  });

  test("archive page links to monthly archive pages", async ({ page }) => {
    await page.goto("/archive/");

    await expect(page.locator("main h2", { hasText: "Archive" })).toBeVisible();
    const firstMonth = page.locator("a.month-card").first();
    await expect(firstMonth).toBeVisible();
    await firstMonth.click();
    await expect(page).toHaveURL(/\/archive\/\d{4}-\d{2}\/?$/);
    await expect(page.locator("main h2")).toBeVisible();
  });

  test("mobile tabbar links navigate and search trigger focuses input", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const tabbar = page.getByRole("navigation", { name: "Primary" });
    await expect(tabbar).toBeVisible();
    await expect(page.locator(".footer-bar")).toBeHidden();
    await expect(tabbar.getByRole("link", { name: "Timeline" })).toHaveClass(/active/);

    const tabbarBox = await tabbar.boundingBox();
    expect(tabbarBox, "mobile tabbar has a rendered box").not.toBeNull();
    expect(Math.round(tabbarBox!.x), "mobile tabbar starts at the viewport edge").toBe(0);
    expect(Math.round(tabbarBox!.width), "mobile tabbar spans the viewport width").toBe(390);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    const tabItems = tabbar.locator("a, button");
    await expect(tabItems).toHaveCount(5);
    const itemBoxes = await tabItems.evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }),
    );
    expect(itemBoxes[0].left, "first mobile tab item starts inside the padded bar").toBeGreaterThanOrEqual(7);
    expect(itemBoxes.at(-1)!.right, "last mobile tab item stays inside the padded bar").toBeLessThanOrEqual(383);
    for (const itemBox of itemBoxes) {
      expect(itemBox.width, `mobile tab item width: ${JSON.stringify(itemBox)}`).toBeGreaterThanOrEqual(44);
      expect(itemBox.width, `mobile tab item width: ${JSON.stringify(itemBox)}`).toBeLessThanOrEqual(90);
    }
    const timelineBox = await tabbar.getByRole("link", { name: "Timeline" }).boundingBox();
    expect(timelineBox, "Timeline tab has a visible centered button").not.toBeNull();
    const timelineCenter = timelineBox!.x + timelineBox!.width / 2;
    expect(Math.abs(timelineCenter - 195), "Timeline tab is centered in the 390px viewport").toBeLessThan(10);
    expect(timelineBox!.height, "Timeline tab is promoted above normal tabs").toBeGreaterThan(52);

    await tabbar.getByRole("link", { name: "Categories" }).click();
    await expect(page).toHaveURL(/\/categories\/?$/);
    await expect(page.locator("main h2", { hasText: "Categories" })).toBeVisible();

    await tabbar.getByRole("button", { name: "More" }).click();
    const moreNav = page.getByRole("navigation", { name: "More navigation" });
    await expect(moreNav).toBeVisible();
    await moreNav.getByRole("link", { name: /Archive/ }).click();
    await expect(page).toHaveURL(/\/archive\/?$/);
    await expect(tabbar.getByRole("button", { name: "More" })).toHaveClass(/active/);

    await tabbar.getByRole("link", { name: "Status" }).click();
    await expect(page).toHaveURL(/\/status\/?$/);
    await expect(page.getByRole("heading", { name: /Source Health/i })).toBeVisible();

    await tabbar.getByRole("button", { name: "More" }).click();
    await moreNav.getByRole("link", { name: /About/ }).click();
    await expect(page).toHaveURL(/\/about\/?$/);

    await page.goto("/");
    await tabbar.getByRole("button", { name: "Search" }).click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
  });

  test("mobile categories and archive expose quick links above the fold", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/categories");
    await expect(page.locator(".mobile-page-badge", { hasText: "Category map" })).toBeVisible();
    const categoryShortcuts = page.getByRole("navigation", { name: "Category shortcuts" });
    await expect(categoryShortcuts).toBeVisible();
    const firstCategoryShortcut = categoryShortcuts.getByRole("link").first();
    await expect(firstCategoryShortcut).toBeVisible();
    const categoryTop = await firstCategoryShortcut.evaluate((el) => el.getBoundingClientRect().top);
    expect(categoryTop, "category shortcuts appear in the first viewport").toBeLessThan(420);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect(page.locator(".categories-kpis > div:visible")).toHaveCount(3);

    await page.goto("/archive");
    await expect(page.locator(".mobile-page-badge", { hasText: "History map" })).toBeVisible();
    const monthShortcuts = page.getByRole("navigation", { name: "Recent archive months" });
    await expect(monthShortcuts).toBeVisible();
    const firstMonthShortcut = monthShortcuts.getByRole("link").first();
    await expect(firstMonthShortcut).toBeVisible();
    const monthTop = await firstMonthShortcut.evaluate((el) => el.getBoundingClientRect().top);
    expect(monthTop, "archive month shortcuts appear in the first viewport").toBeLessThan(420);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect(page.locator(".archive-kpis > div:visible")).toHaveCount(2);
    await expect(page.locator(".archive-spotlight")).toBeHidden();
  });

  test("broken entry thumbnails fall back to category artwork", async ({ page }) => {
    await page.goto("/");

    const cardThumb = page.locator(".card-thumb").filter({ has: page.locator("img") }).first();
    await expect(cardThumb).toBeVisible();
    await cardThumb.locator("img").evaluate((img) => img.dispatchEvent(new Event("error")));
    await expect(cardThumb).toHaveClass(/failed/);
    await expect(cardThumb.locator(".card-thumb-fallback")).toBeVisible();

    const featuredThumb = page.locator(".featured-thumb.has-image").first();
    if ((await featuredThumb.count()) > 0) {
      await featuredThumb.locator("img").evaluate((img) => img.dispatchEvent(new Event("error")));
      await expect(featuredThumb).toHaveClass(/failed/);
      await expect(featuredThumb.locator(".featured-thumb-fallback")).toBeVisible();
    }
  });

  test("pagefind search returns dashboard entries", async ({ page }) => {
    await page.goto("/");

    await page.keyboard.press("Control+K");
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await page.locator("#pagefind-search-input").fill("Copilot");
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit.is-active").first()).toBeVisible({ timeout: 10_000 });
  });

  test("entry titles never blank in either language mode (LL-029)", async ({ page }) => {
    await page.goto("/");

    // Sample a wide net across the first timeline page (12 entries) so the
    // assertion covers JA-source entries with no English title.
    const titles = await page.locator("article.card h3.title").evaluateAll((nodes) =>
      nodes.map((node) => {
        const ja = node.querySelector(".i18n-ja")?.textContent ?? "";
        const en = node.querySelector(".i18n-en")?.textContent ?? "";
        return { ja: ja.trim(), en: en.trim() };
      }),
    );

    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      // After LL-029 the title must be non-empty in both language slots,
      // even if the EN slot falls back to the JA original with a `JA` badge.
      expect(t.ja.length, `ja title blank: ${JSON.stringify(t)}`).toBeGreaterThan(0);
      expect(t.en.length, `en title blank: ${JSON.stringify(t)}`).toBeGreaterThan(0);
    }
  });
});
