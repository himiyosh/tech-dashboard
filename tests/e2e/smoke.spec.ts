import { expect, test } from "@playwright/test";

test.describe("TECH Dashboard smoke", () => {
  test("home renders primary sections", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /TECH Dashboard/i })).toBeVisible();
    await expect(page.locator("section.banner h1.i18n-ja")).toBeVisible();
    await expect(page.locator(".dynamic-orbit")).toBeVisible();
    await expect(page.locator(".signal-node")).toHaveCount(4);
    await expect(page.locator(".tb-slide.is-active").first()).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator(".tb-slide:not(.is-active)").first()).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".tb-slide:not(.is-active)").first()).toHaveAttribute("tabindex", "-1");
    await expect(page.locator(".banner-fact")).toHaveCount(3);
    await expect(page.getByRole("link", { name: /今日の重要記事/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /検索/ })).toBeVisible();
    await expect(page.locator(".banner-quick-links").getByRole("link", { name: /カテゴリ/ })).toBeVisible();
    await expect(page.locator(".banner-quick-links").getByRole("link", { name: /arXiv/ })).toBeVisible();
    await expect(page.locator("section.stats")).toHaveCount(0);
    await expect(page.locator(".home-layout > aside.right")).toHaveCount(0);
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    await expect(page.locator("article.featured")).not.toContainText(/AI \u8981\u7d04\u672a\u751f\u6210|Summary pending|\u5f8c\u7d9a\u306e Worker run/);
    await expect(page.locator(".top-rank")).not.toContainText(/AI \u8981\u7d04\u672a\u751f\u6210|Summary pending|\u5f8c\u7d9a\u306e Worker run/);
    await expect(page.locator("#priority-heading")).toBeVisible();
    await expect(page.locator("#timeline-heading")).toBeVisible();
  });

  test("dynamic home motion stays responsive and honors reduced motion", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    const orbit = page.locator(".dynamic-orbit");
    await expect(orbit).toBeVisible();
    const orbitBox = await orbit.boundingBox();
    expect(orbitBox, "dynamic orbit has a desktop box").not.toBeNull();
    expect(orbitBox!.height, "dynamic orbit is visually substantial on desktop").toBeGreaterThan(180);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await expect(page.locator("[data-reveal].is-visible").first()).toBeVisible({ timeout: 5000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(orbit, "dynamic orbit is hidden on mobile to keep first-view dense").toBeHidden();
    const firstArticle = page.locator("article.featured").first();
    await expect(firstArticle).toHaveClass(/is-visible/, { timeout: 5000 });
    const firstArticleBox = await firstArticle.boundingBox();
    expect(firstArticleBox, "first article visible on mobile").not.toBeNull();
    expect(firstArticleBox!.y, "mobile first article remains near the first viewport").toBeLessThanOrEqual(360);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await expect(page.locator("[data-reveal]").first()).toBeVisible();
    await expect
      .poll(() => page.locator(".scan-beam").evaluate((el) => getComputedStyle(el).animationName))
      .toBe("none");
    await expect
      .poll(() => page.locator(".tb-live-dot").evaluate((el) => getComputedStyle(el).animationName))
      .toBe("none");
    if ((await page.locator(".ticker-track").count()) > 0) {
      await expect
        .poll(() => page.locator(".ticker-track").first().evaluate((el) => getComputedStyle(el).animationName))
        .toBe("none");
    }
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

  test("sidebar category labels stay single-line and marquee on hover", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");

    const copilotItem = page.locator('a.side-item[href="/c/copilot"]').first();
    const opencodeItem = page.locator('a.side-item[href="/c/opencode"]').first();
    const label = opencodeItem.locator(".name");
    const marquee = opencodeItem.locator(".name-marquee");

    await expect(copilotItem).toBeVisible();
    await expect(copilotItem.locator(".name-marquee")).toHaveText("Copilot");
    await expect(copilotItem.locator(".name")).toHaveAttribute("title", "Microsoft: GitHub Copilot");
    await expect(opencodeItem).toBeVisible();
    await expect(label).toHaveAttribute("title", "AI Coding Tools: OpenHands / OpenCode");
    await expect
      .poll(() => opencodeItem.evaluate((item) => item.hasAttribute("data-marquee")))
      .toBe(true);

    const labelMetrics = await label.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      const parsedLineHeight = Number.parseFloat(style.lineHeight);
      const parsedFontSize = Number.parseFloat(style.fontSize);
      const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : parsedFontSize * 1.4;
      return {
        whiteSpace: style.whiteSpace,
        height: rect.height,
        lineHeight,
        clientWidth: node.clientWidth,
      };
    });
    const marqueeScrollWidth = await marquee.evaluate((node) => node.scrollWidth);
    expect(labelMetrics.whiteSpace).toBe("nowrap");
    expect(marqueeScrollWidth, "label text should overflow within the narrow sidebar").toBeGreaterThan(
      labelMetrics.clientWidth,
    );
    expect(labelMetrics.height, "label should not wrap onto multiple lines").toBeLessThanOrEqual(
      labelMetrics.lineHeight + 2,
    );

    await opencodeItem.hover();
    await expect
      .poll(() => marquee.evaluate((node) => window.getComputedStyle(node).animationName))
      .toBe("side-label-marquee");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
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

    await expect(page.locator(".page-hero #status-heading")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Worker Health/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Source Health/i })).toBeVisible();
    await expect(page.getByText("Summary backlog").first()).toBeVisible();
    await expect(page.locator(".source-reason-line").first()).toBeVisible();
    await expect(page.locator('[data-source-filter="all"]')).toBeVisible();
    await expect(page.locator('[data-category-filter="all"]')).toBeVisible();
    await expect(page.locator(".source-item").first()).toBeVisible();
    await expect(page.getByText(/stale > \d+h/).first()).toBeVisible();
    await expect(page.locator(".source-latest-line").first()).toBeVisible();
  });

  test("section page heroes give page context on desktop and mobile", async ({ page }) => {
    const topLevelPaths = ["/categories/", "/status/", "/about/", "/archive/"];
    const paths = [...topLevelPaths, "/page/2/"];

    for (const path of topLevelPaths) {
      await page.goto(path);
      await expect(page.locator(".crumb-bar"), `${path} should not render breadcrumbs`).toHaveCount(0);
    }

    await page.goto("/categories/");
    const firstCategoryHref = await page.locator(".category-card").first().getAttribute("href");
    if (firstCategoryHref) paths.push(firstCategoryHref);

    await page.goto("/archive/");
    const firstMonthHref = await page.locator(".month-card").first().getAttribute("href");
    if (firstMonthHref) paths.push(firstMonthHref);

    await page.goto("/");
    const firstTag = page.locator('a[href^="/t/"]').first();
    if ((await firstTag.count()) > 0) {
      const firstTagHref = await firstTag.getAttribute("href");
      if (firstTagHref) paths.push(firstTagHref);
    }

    for (const path of paths) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      const hero = page.locator(".page-hero").first();
      await expect(hero).toBeVisible();
      const desktopBox = await hero.boundingBox();
      expect(desktopBox, `${path} desktop hero box`).not.toBeNull();
      expect(desktopBox!.height, `${path} desktop hero has page-banner presence`).toBeGreaterThan(120);
      const innerBox = await hero.locator(".page-hero-inner").boundingBox();
      expect(innerBox, `${path} desktop hero inner box`).not.toBeNull();
      expect(Math.round(innerBox!.width), `${path} desktop hero inner width`).toBe(1280);
      if (topLevelPaths.includes(path)) {
        await expect(hero, `${path} top-level hero class`).toHaveClass(/page-hero-top-level/);
        const metricBoxes = await hero.locator(".page-hero-metric").evaluateAll((items) =>
          items.map((item) => item.getBoundingClientRect().width),
        );
        expect(metricBoxes, `${path} top-level hero metric count`).toHaveLength(6);
        expect(Math.max(...metricBoxes) - Math.min(...metricBoxes), `${path} top-level metric widths match`).toBeLessThanOrEqual(1);
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(hero).toBeVisible();
      const mobileBox = await hero.boundingBox();
      expect(mobileBox, `${path} mobile hero box`).not.toBeNull();
      expect(mobileBox!.height, `${path} mobile hero stays compact`).toBeLessThan(310);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
  });

  test("categories page exposes compact category directory", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/categories/");

    const directory = page.locator("#category-directory");
    await expect(directory).toBeVisible();
    await expect(page.locator("#category-directory-heading")).toBeVisible();
    await expect(directory.locator("a.category-directory-item")).toHaveCount(14);
    await expect(directory.getByRole("link", { name: /Copilot/ })).toBeVisible();
    await expect(directory.getByRole("link", { name: /Papers/ })).toBeVisible();
    await expect(page.locator(".category-card")).toHaveCount(14);
    await expect(page.locator(".category-card").first()).toContainText("live");
    await expect(page.locator(".category-card").first()).not.toContainText("all time");

    const desktopBox = await directory.boundingBox();
    expect(desktopBox, "category directory desktop box").not.toBeNull();
    expect(desktopBox!.height, "category directory stays scannable on desktop").toBeLessThan(480);
    const desktopCardBoxes = await page.locator(".category-card").evaluateAll((cards) =>
      cards.map((card) => card.getBoundingClientRect().height),
    );
    expect(Math.max(...desktopCardBoxes), "category panels stay dense on desktop").toBeLessThan(220);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(directory).toBeVisible();
    const mobileBox = await directory.boundingBox();
    expect(mobileBox, "category directory mobile box").not.toBeNull();
    expect(mobileBox!.height, "category directory stays compact on mobile").toBeLessThan(540);
    const mobileCardBox = await page.locator(".category-card").first().boundingBox();
    expect(mobileCardBox, "mobile category card box").not.toBeNull();
    expect(mobileCardBox!.height, "category panels stay dense on mobile").toBeLessThan(230);
    const mobileTrendBox = await page.locator(".category-card .cat-trend").first().boundingBox();
    expect(mobileTrendBox, "mobile category card trend box").not.toBeNull();
    expect(mobileTrendBox!.height, "category card trend should stay readable on mobile").toBeGreaterThanOrEqual(54);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await directory.getByRole("link", { name: /Copilot/ }).click();
    await expect(page).toHaveURL(/\/c\/copilot\/?$/);
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

  test("category detail trend chart keeps readable height on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/c/tech-news/");

    const chart = page.locator(".trend .chart");
    await expect(chart).toBeVisible();
    const chartBox = await chart.boundingBox();
    expect(chartBox, "mobile category trend chart box").not.toBeNull();
    expect(chartBox!.height, "mobile trend chart should not look vertically crushed").toBeGreaterThanOrEqual(160);

    const trendBox = await page.locator(".trend").boundingBox();
    expect(trendBox, "mobile category trend panel").not.toBeNull();
    expect(trendBox!.width, "trend panel stays within mobile viewport").toBeLessThanOrEqual(390);

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
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

    await expect(page.locator(".crumb-bar")).toHaveCount(0);
    await expect(page.locator("#archive-heading")).toBeVisible();
    const firstMonth = page.locator("a.month-card").first();
    await expect(firstMonth).toBeVisible();
    await firstMonth.click();
    await expect(page).toHaveURL(/\/archive\/\d{4}-\d{2}\/?$/);
    await expect(page.locator("#archive-month-heading")).toBeVisible();
  });

  test("hamburger menu owns navigation and mobile tabbar stays compact", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await expect(page.locator("header .nav")).toHaveCount(0);
    await expect(page.locator("header .nav-shortcut", { hasText: "Categories" })).toBeVisible();
    const desktopMenuButton = page.locator("header .menu-trigger");
    await expect(desktopMenuButton).toBeVisible();
    await expect(desktopMenuButton).toHaveAttribute("aria-expanded", "false");
    await desktopMenuButton.click();
    const menu = page.locator("#site-menu");
    await expect(menu).toBeVisible();
    await expect(desktopMenuButton).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("link", { name: /Categories/ })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: /Archive/ })).toBeVisible();
    await expect(menu.getByRole("link", { name: /About/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: /Search/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const tabbar = page.getByRole("navigation", { name: "Primary" });
    await expect(tabbar).toBeVisible();
    await expect(page.locator(".footer-bar")).toBeHidden();
    await expect(page.locator("header .nav")).toHaveCount(0);
    await expect(page.locator("header .header-switcher")).toBeHidden();
    await expect(page.locator("header .nav-shortcut")).toHaveCount(2);
    await expect(page.locator("header .menu-trigger")).toBeHidden();
    await expect(tabbar.getByRole("link", { name: "Home" })).toHaveClass(/active/);
    await expect(tabbar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");

    const tabbarBox = await tabbar.boundingBox();
    expect(tabbarBox, "mobile tabbar has a rendered box").not.toBeNull();
    expect(Math.round(tabbarBox!.x), "mobile tabbar starts at the viewport edge").toBe(0);
    expect(Math.round(tabbarBox!.width), "mobile tabbar spans the viewport width").toBe(390);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    const tabItems = tabbar.locator("a, button");
    await expect(tabItems).toHaveCount(4);
    const itemBoxes = await tabItems.evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      }),
    );
    expect(itemBoxes[0].left, "first mobile tab item starts inside the padded bar").toBeGreaterThanOrEqual(7);
    expect(itemBoxes.at(-1)!.right, "last mobile tab item stays inside the padded bar").toBeLessThanOrEqual(383);
    for (const itemBox of itemBoxes) {
      // 4 items in (390 - 16px padding) ≈ 93-94px each
      expect(Math.round(itemBox.width), `mobile tab item width: ${JSON.stringify(itemBox)}`).toBeGreaterThanOrEqual(88);
      expect(Math.round(itemBox.width), `mobile tab item width too large: ${JSON.stringify(itemBox)}`).toBeLessThanOrEqual(130);
    }

    const openMobileMenu = async () => {
      await tabbar.getByRole("button", { name: /Menu/ }).click();
      await expect(menu).toBeVisible();
    };

    await tabbar.getByRole("link", { name: "Categories" }).click();
    await expect(page).toHaveURL(/\/categories\/?$/);
    await expect(page.locator("#categories-heading")).toBeVisible();
    await expect(tabbar.getByRole("link", { name: "Categories" })).toHaveClass(/active/);
    await expect(tabbar.getByRole("button", { name: /Menu/ })).not.toHaveClass(/active/);
    await openMobileMenu();
    await expect(menu.getByRole("link", { name: /Categories/ })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: /arXiv/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/categories/");
    await expect(page.locator("header .nav-shortcut", { hasText: "Categories" })).toHaveClass(/active/);
    await page.locator("header .menu-trigger").click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: /Categories/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await openMobileMenu();
    await menu.getByRole("link", { name: /Archive/ }).click();
    await expect(page).toHaveURL(/\/archive\/?$/);

    await openMobileMenu();
    await menu.getByRole("link", { name: /Status/ }).click();
    await expect(page).toHaveURL(/\/status\/?$/);
    await expect(page.getByRole("heading", { name: /Source Health/i })).toBeVisible();

    await openMobileMenu();
    await menu.getByRole("link", { name: /About/ }).click();
    await expect(page).toHaveURL(/\/about\/?$/);
    await expect(page.locator("#about-heading")).toBeVisible();

    await openMobileMenu();
    await menu.getByRole("button", { name: /Search/ }).click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await expect(page.locator("#pagefind-results")).toBeVisible();
  });

  test("mobile featured panel and thumbnails keep fallback layout", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await expect(page.locator("header .menu-trigger")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    const featured = page.locator("article.featured").first();
    await expect(featured).toBeVisible();
    const featuredThumb = featured.locator(".featured-thumb").first();
    const featuredBody = featured.locator(".featured-body").first();
    const [featuredBox, thumbBox, bodyBox] = await Promise.all([
      featured.boundingBox(),
      featuredThumb.boundingBox(),
      featuredBody.boundingBox(),
    ]);
    expect(featuredBox, "featured panel has a box").not.toBeNull();
    expect(thumbBox, "featured thumb has a box").not.toBeNull();
    expect(bodyBox, "featured body has a box").not.toBeNull();
    expect(Math.round(featuredBox!.width), "featured stays inside mobile content width").toBeLessThanOrEqual(390);
    expect(Math.round(featuredBox!.y), "first featured article appears without wasted top whitespace").toBeLessThanOrEqual(340);
    expect(Math.round(featuredBox!.height), "featured panel is not expanded by hidden fallback/image stacking").toBeLessThanOrEqual(260);
    expect(Math.round(thumbBox!.width), "featured thumb keeps compact mobile column").toBeLessThanOrEqual(110);
    expect(bodyBox!.x, "featured body sits to the right of the thumbnail").toBeGreaterThanOrEqual(thumbBox!.x + thumbBox!.width - 1);

    const featuredImage = featured.locator(".featured-thumb.has-image img").first();
    if ((await featuredImage.count()) > 0) {
      await featuredImage.evaluate((img) => img.dispatchEvent(new Event("error")));
      await expect(featuredThumb).toHaveClass(/failed/);
      await expect(featuredThumb.locator(".featured-thumb-fallback")).toBeVisible();
    }

    const cards = page.locator("article.card.has-thumb");
    await expect(cards.first()).toBeVisible();
    const [firstCardBox, secondCardBox, firstThumbBox, firstBodyBox] = await Promise.all([
      cards.nth(0).boundingBox(),
      cards.nth(1).boundingBox(),
      cards.nth(0).locator(".card-thumb").boundingBox(),
      cards.nth(0).locator(".card-body").boundingBox(),
    ]);
    const firstSummaryTextBox = await cards.nth(0).locator(".summary .s-text").first().boundingBox();
    expect(firstCardBox, "first mobile timeline card has a visible panel box").not.toBeNull();
    expect(secondCardBox, "second mobile timeline card has a visible panel box").not.toBeNull();
    expect(firstBodyBox, "mobile card body has a box").not.toBeNull();
    expect(firstSummaryTextBox, "mobile summary text has a readable box").not.toBeNull();
    expect(firstThumbBox, "regular mobile card thumbnail is hidden to keep text readable").toBeNull();
    expect(firstBodyBox!.width, "mobile card text keeps near-full card width to avoid awkward wrapping").toBeGreaterThanOrEqual(firstCardBox!.width - 28);
    expect(firstSummaryTextBox!.x, "mobile summary text starts at card body edge, not after the AI badge").toBeLessThanOrEqual(firstBodyBox!.x + 2);
    expect(firstSummaryTextBox!.width, "mobile summary text keeps full readable width").toBeGreaterThanOrEqual(firstBodyBox!.width - 2);
    expect(secondCardBox!.y - (firstCardBox!.y + firstCardBox!.height), "mobile cards have a visible gap between panels").toBeGreaterThanOrEqual(12);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    const desktopCardThumb = page.locator("article.card .card-thumb.has-image").first();
    if ((await desktopCardThumb.count()) > 0) {
      await expect(desktopCardThumb).toBeVisible();
      const cardImage = desktopCardThumb.locator("img").first();
      await cardImage.evaluate((img) => img.dispatchEvent(new Event("error")));
      await expect(desktopCardThumb).toHaveClass(/failed/);
      await expect(cardImage).toBeHidden();
      await expect(desktopCardThumb.locator("svg")).toBeVisible();
      await expect(desktopCardThumb.locator(".fallback-src-mark")).toBeVisible();
    }
  });

  test("pagefind search returns dashboard entries", async ({ page }) => {
    await page.goto("/");

    await page.locator("button[data-search-trigger]:visible").first().click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await page.locator("#pagefind-search-input").pressSequentially("Copilot");
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit-type").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-results-heading")).toContainText(/Results|closest/i);
    await expect(page.locator(".search-hit.is-active").first()).toBeVisible({ timeout: 10_000 });
  });

  test("pagefind search zero state gives next actions", async ({ page }) => {
    await page.goto("/");

    await page.locator("button[data-search-trigger]:visible").first().click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await page.locator("#pagefind-search-input").pressSequentially("🦄🦄🦄");

    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-empty")).toContainText("No results", { timeout: 10_000 });
    await expect(page.locator(".search-empty")).toContainText("Try a shorter keyword");
    await expect(page.locator(".search-empty a", { hasText: "Browse categories" })).toBeVisible();
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
