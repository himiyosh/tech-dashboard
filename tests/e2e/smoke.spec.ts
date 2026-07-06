import { expect, test } from "@playwright/test";

test.describe("TECH Dashboard smoke", () => {
  test("home renders primary sections", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: /TECH Dashboard/i })).toBeVisible();
    await expect(page.locator("section.banner h1.i18n-ja")).toBeVisible();
    await expect(page.locator(".dynamic-orbit")).toBeVisible();
    await expect(page.locator(".signal-node")).toHaveCount(4);
    await expect(page.locator(".tb-slide.is-active").first()).toHaveAttribute("aria-hidden", "false");
    // Inactive ticker slides must be hidden from AT and unfocusable (LL-078).
    // When the current JST day has only one published entry there are no
    // inactive slides yet (data-freshness dependent, LL-082) — a valid state,
    // so only assert the hidden semantics when inactive slides actually exist.
    const inactiveSlides = page.locator(".tb-slide:not(.is-active)");
    if ((await inactiveSlides.count()) > 0) {
      await expect(inactiveSlides.first()).toHaveAttribute("aria-hidden", "true");
      await expect(inactiveSlides.first()).toHaveAttribute("tabindex", "-1");
    }
    await expect(page.locator(".banner-fact")).toHaveCount(3);
    await expect(page.getByRole("link", { name: /今日の重要記事/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /検索/ })).toBeVisible();
    await expect(page.locator(".banner-quick-links").getByRole("link", { name: /カテゴリ/ })).toBeVisible();
    await expect(page.locator(".banner-quick-links").getByRole("link", { name: /arXiv/ })).toBeVisible();
    await expect(page.locator("section.stats")).toHaveCount(0);
    // Timeline right rail: the home page is now a 3-column .layout with a right
    // insight rail so article cards don't sprawl full-width (間延び fix, LL-122).
    // The rail is visible at the desktop test viewport with its three cards.
    const homeRail = page.locator(".layout aside.right.home-right");
    await expect(homeRail).toBeVisible();
    await expect(homeRail.locator(".home-side-metrics")).toBeVisible();
    await expect(homeRail.locator(".home-source-list")).toBeVisible();
    await expect(homeRail.locator(".tag-cloud")).toBeVisible();
    // The old 2-column home-layout class must be gone (single canvas width source).
    await expect(page.locator(".home-layout")).toHaveCount(0);
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    await expect(page.locator("article.featured")).not.toContainText(/AI \u8981\u7d04\u672a\u751f\u6210|Summary pending|\u5f8c\u7d9a\u306e Worker run/);
    await expect(page.locator(".top-rank")).not.toContainText(/AI \u8981\u7d04\u672a\u751f\u6210|Summary pending|\u5f8c\u7d9a\u306e Worker run/);
    await expect(page.locator("#priority-heading")).toBeVisible();
    await expect(page.locator("#timeline-heading")).toBeVisible();
  });

  // Timeline right rail: constrains the main column on desktop, hides on mobile,
  // never causes horizontal scroll, and must NOT leak onto lane pages (R-023).
  test("timeline right rail constrains layout and stays responsive", async ({ page }) => {
    // Desktop: rail visible and taking real width, main column constrained, 3 grid tracks.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const rail = page.locator(".layout aside.right.home-right");
    await expect(rail).toBeVisible();
    const desktop = await page.evaluate(() => {
      const layout = document.querySelector(".layout");
      const right = document.querySelector(".layout aside.right");
      const main = document.querySelector(".layout main");
      const cols = layout ? getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length : 0;
      return {
        cols,
        railW: right ? Math.round(right.getBoundingClientRect().width) : 0,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
        noScroll: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(desktop.cols).toBe(3);
    expect(desktop.railW).toBeGreaterThanOrEqual(200);
    // 2-col home would give main ~990px; the rail must constrain it well below that.
    expect(desktop.mainW).toBeLessThan(850);
    expect(desktop.noScroll).toBe(true);

    // Mobile: rail hidden, no horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(rail).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    // Lane page (R-023): no Timeline right rail, left lane-rail present instead.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/arxiv");
    await expect(page.locator(".layout aside.right")).toHaveCount(0);
    await expect(page.locator(".layout aside.lane-rail")).toBeVisible();
  });

  // Regression guard for the pending-summary display fix (LL-074/LL-087):
  // newly collected articles are listed even before their AI summary is ready,
  // BUT cards must never show deterministic boilerplate, and must never render
  // an empty summary region (the cross-language fallback must surface the real
  // other-language summary or an explicit "generating" state).
  test("timeline cards show a summary or a pending state, never boilerplate", async ({ page }) => {
    await page.goto("/");
    // No deterministic placeholder text leaks into any visible card.
    await expect(page.locator("#timeline")).not.toContainText(/このエントリは|AI 要約未生成|後続の Worker run/);
    const cards = page.locator("#timeline article.card");
    const count = await cards.count();
    expect(count, "timeline has cards").toBeGreaterThan(0);
    // Every card carries real summary text OR an explicit pending state — no
    // empty summary area (which the JA view showed before the fallback fix).
    for (let i = 0; i < Math.min(count, 30); i++) {
      const card = cards.nth(i);
      const hasSummary = (await card.locator(".summary-stack .summary .s-text").count()) > 0;
      const hasPending = (await card.locator(".summary-state").count()) > 0;
      expect(hasSummary || hasPending, `card ${i} has summary or pending state`).toBe(true);
    }
  });

  // (archive-backed daily activity), not the publishable-live fallback. When
  // index.astro forgot to pass the `stats` prop the chart silently collapsed to
  // single-digit bars and looked like collection had stopped (see LL).
  test("home Last 7 days chart reflects stats.byDay activity", async ({ page }) => {
    await page.goto("/");
    const bars = page.locator(".digest .spark .bars .bar .n");
    await expect(bars).toHaveCount(7);
    const counts = (await bars.allInnerTexts()).map((t) => Number(t.trim()));
    // Past days routinely have 30-120 articles in stats.byDay; the broken
    // fallback maxed out at single digits. A max over 20 proves stats wins.
    const max = Math.max(...counts);
    expect(max, `7-day bar counts were ${counts.join(",")}`).toBeGreaterThan(20);
  });

  test("featured hero and top-3 are not low-signal release builds", async ({ page }) => {
    await page.goto("/");
    // A nightly / pre-release / RC / staging / per-commit CI build must never
    // occupy the Featured hero or Top-3 decision slots, so a fast-releasing
    // source (e.g. Zed nightly) cannot dominate the prominent area.
    const lowSignal = /nightly|collab-(?:staging|production)|[-_.](?:pre|rc|alpha|beta)\d*\b|\(#\d+\)\s*$/i;

    const featuredTitle = (await page.locator(".featured .featured-title").first().innerText()).trim();
    expect(featuredTitle.length, "featured hero has a title").toBeGreaterThan(0);
    expect(lowSignal.test(featuredTitle), `featured was low-signal: ${featuredTitle}`).toBe(false);

    const topTitles = await page.locator(".top-rank-list .top-rank-item a").allInnerTexts();
    expect(topTitles.length, "top-3 list rendered").toBeGreaterThan(0);
    for (const t of topTitles) {
      expect(lowSignal.test(t.trim()), `top-3 entry was low-signal: ${t.trim()}`).toBe(false);
    }
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

    // Summary-first (LL-112): the false "本文は近日中に AI が生成して差し替わります"
    // promise must be gone (body generation was removed; the promise never
    // resolved). The body region must instead show real prose OR the honest
    // AI-summary digest with a read-original link.
    await expect(page.locator("body")).not.toContainText("近日中に AI が生成");
    const hasProse = await page.locator(".ed-body-prose").count();
    const hasDigest = await page.locator(".ed-summary-only").count();
    expect(hasProse + hasDigest).toBeGreaterThan(0);
    if (hasDigest > 0) {
      await expect(
        page.locator('.ed-summary-only-link[target="_blank"]').first(),
      ).toBeVisible();
    }
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

  test("sidebar categories are alphabetical with compact icon tiles (no scattered group order)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    const items = page.locator("aside.left a.side-item[href^='/c/']");
    const count = await items.count();
    expect(count, "sidebar lists every category").toBe(14);

    const labels: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      // Each category tile shows an emoji icon (non-ASCII glyph), not a 2-letter code.
      const icon = (await item.locator(".brand-tile").innerText()).trim();
      expect(icon.length, `category ${i} has a compact icon tile`).toBeGreaterThan(0);
      expect(icon.length, `category ${i} icon tile stays compact`).toBeLessThanOrEqual(3);
      labels.push((await item.locator(".name-marquee").innerText()).trim());
    }
    // Labels are in case-insensitive A→Z order.
    const sorted = [...labels].sort((a, b) => a.localeCompare(b));
    expect(labels, `sidebar order should be alphabetical: ${labels.join(", ")}`).toEqual(sorted);

    // The categories directory is alphabetical too.
    await page.goto("/categories/");
    const dirNames = await page
      .locator("#category-directory .category-directory-name")
      .allInnerTexts();
    const dirSorted = [...dirNames].sort((a, b) => a.localeCompare(b));
    expect(dirNames, "category directory should be alphabetical").toEqual(dirSorted);
    // Directory items carry emoji icons.
    await expect(page.locator("#category-directory .category-directory-icon").first()).toBeVisible();
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
    expect(chartBox!.height, "mobile trend chart should not look vertically crushed").toBeGreaterThanOrEqual(148);
    expect(chartBox!.height, "mobile trend chart should stay compact").toBeLessThanOrEqual(156);

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
    await expect(page.locator("header .nav-shortcut", { hasText: "arXiv" })).toBeVisible();
    await expect(page.locator("header .nav-shortcut", { hasText: "Knowledge" })).toBeVisible();
    const desktopMenuButton = page.locator("header .menu-trigger");
    await expect(desktopMenuButton).toBeVisible();
    await expect(desktopMenuButton).toHaveAttribute("aria-expanded", "false");
    await desktopMenuButton.click();
    const menu = page.locator("#site-menu");
    await expect(menu).toBeVisible();
    await expect(desktopMenuButton).toHaveAttribute("aria-expanded", "true");
    // Primary explore shortcuts (Categories, arXiv, Knowledge) live in the
    // header switcher, never in the hamburger menu (LL-054 avoids duplicates).
    await expect(menu.getByRole("link", { name: /Categories/ })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: /Knowledge/ })).toHaveCount(0);
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
    await expect(page.locator("header .nav-shortcut")).toHaveCount(3);
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
      // 5 items in (390 - 16px padding) ≈ 74-75px each
      expect(Math.round(itemBox.width), `mobile tab item width: ${JSON.stringify(itemBox)}`).toBeGreaterThanOrEqual(66);
      expect(Math.round(itemBox.width), `mobile tab item width too large: ${JSON.stringify(itemBox)}`).toBeLessThanOrEqual(120);
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

  test("lane pages use a LEFT rail like Timeline, not a right one (LL-095)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of ["/arxiv/", "/knowledge/"]) {
      await page.goto(path);
      // Lane pages must NOT show the Timeline category sidebar (aside.left).
      await expect(page.locator(".layout aside.left")).toHaveCount(0);
      await expect(page.locator(".layout.lane-layout")).toBeVisible();
      // The lane rail (code meaning / tags / sources + identity) is present and
      // on the LEFT — same navigation side as Timeline/Categories.
      const rail = page.locator(".layout aside.lane-rail");
      await expect(rail).toBeVisible();
      await expect(page.locator(".layout aside.right")).toHaveCount(0);
      const sides = await page.evaluate(() => {
        const r = document.querySelector(".lane-rail") as HTMLElement;
        const m = document.querySelector(".layout main") as HTMLElement;
        return { railLeft: r.getBoundingClientRect().left, mainLeft: m.getBoundingClientRect().left };
      });
      expect(sides.railLeft, `${path} rail is left of main`).toBeLessThan(sides.mainLeft);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
  });

  test("lane pages never collapse into a 3-column timeline grid (LL-091)", async ({ page }) => {
    // The timeline .layout has responsive media queries (a 200px sidebar and a
    // 3-col :has(aside.right) rule for 901-1180px) that previously bled into
    // .lane-layout, adding a phantom empty left column at mid widths. Lane
    // pages must stay 2-col (>=981px) or 1-col (<=980px), never 3-col, and
    // never show aside.left, at any width.
    for (const path of ["/knowledge/", "/arxiv/"]) {
      for (const width of [1280, 1180, 1100, 1000, 981, 980, 901, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(path);
        const info = await page.evaluate(() => {
          const layout = document.querySelector(".layout") as HTMLElement | null;
          const cols = layout ? getComputedStyle(layout).gridTemplateColumns : "";
          return {
            colCount: cols ? cols.split(/\s+/).filter(Boolean).length : 0,
            hasLeft: !!document.querySelector(".layout aside.left"),
            hscroll: document.documentElement.scrollWidth > window.innerWidth,
          };
        });
        expect(info.hasLeft, `${path} @${width} must not show Timeline sidebar`).toBe(false);
        expect(info.colCount, `${path} @${width} column count`).toBeLessThanOrEqual(2);
        expect(info.hscroll, `${path} @${width} horizontal scroll`).toBe(false);
      }
    }
  });

  test("knowledge lane is a primary explore shortcut and groups by source", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    // Knowledge is a primary explore destination: it lives in the header
    // switcher (alongside Categories and arXiv), not in the hamburger menu
    // (LL-054 keeps direct shortcuts out of the menu to avoid duplicates).
    await page.goto("/");
    const knowledgeShortcut = page.locator("header .nav-shortcut", { hasText: "Knowledge" });
    await expect(knowledgeShortcut).toBeVisible();
    await knowledgeShortcut.click();
    await expect(page).toHaveURL(/\/knowledge\/?$/);
    // On the Knowledge page the header shortcut is active and the menu does
    // not own the current page.
    await expect(page.locator("header .nav-shortcut.knowledge")).toHaveClass(/active/);

    // Lane pages must NOT show the Timeline category sidebar (aside.left).
    await expect(page.locator(".layout aside.left")).toHaveCount(0);
    await expect(page.locator(".layout.lane-layout")).toBeVisible();

    // Page renders its hero and at least one source group, separate from news.
    await expect(page.locator("#knowledge-heading")).toBeVisible();
    const groups = page.locator(".knowledge-source-group");
    await expect(groups.first()).toBeVisible();
    const groupCount = await groups.count();
    expect(groupCount, "knowledge page shows source groups").toBeGreaterThan(0);

    // Every group exposes a source heading + at least one card. All cards use
    // the SAME uniform layout & height whether or not they have an image
    // (LL-096): every card has a .kg-thumb slot, and all cards share one height.
    const allHeights: number[] = [];
    for (let i = 0; i < groupCount; i++) {
      const group = groups.nth(i);
      await expect(group.locator("h2")).toBeVisible();
      const cards = group.locator(".kg-card");
      const cardCount = await cards.count();
      expect(cardCount, "each knowledge source group has at least one card").toBeGreaterThan(0);
      // Every card has exactly one thumbnail slot (image or subtle placeholder).
      expect(
        await group.locator(".kg-card .kg-thumb").count(),
        `group ${i} every card has a thumb slot`,
      ).toBe(cardCount);
      for (let c = 0; c < cardCount; c++) {
        const box = await cards.nth(c).boundingBox();
        if (box) allHeights.push(Math.round(box.height));
      }
    }
    // All knowledge cards must be the same height (uniform grid, image-agnostic).
    const uniqueHeights = [...new Set(allHeights)];
    expect(
      uniqueHeights.length,
      `all knowledge cards share one height, got ${JSON.stringify(uniqueHeights)}`,
    ).toBe(1);

    // Lane rail "Sources" nav is alphabetical (A->Z by label) with favicon icons,
    // matching the rest of the site's category/source lists (LL-103).
    const sourceLabels = await page
      .locator(".knowledge-source-list .knowledge-source-link strong")
      .allInnerTexts();
    expect(sourceLabels.length, "knowledge sources nav has entries").toBeGreaterThan(1);
    const sortedLabels = [...sourceLabels].sort((a, b) => a.localeCompare(b));
    expect(sourceLabels, `knowledge sources should be alphabetical: ${sourceLabels.join(", ")}`).toEqual(
      sortedLabels,
    );
    expect(
      await page.locator(".knowledge-source-list .kg-src-favicon").count(),
      "each knowledge source has a favicon icon",
    ).toBe(sourceLabels.length);

    // On mobile, Knowledge is a direct tab in the bottom tabbar (not in the
    // menu). Selecting it marks the Knowledge tab active, not the Menu trigger.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/knowledge/");
    const tabbar = page.getByRole("navigation", { name: "Primary" });
    await expect(tabbar.getByRole("link", { name: /Knowledge/ })).toHaveClass(/active/);
    await expect(tabbar.getByRole("button", { name: /Menu/ })).not.toHaveClass(/active/);
    // Knowledge must not also appear inside the hamburger menu (no duplicate).
    await tabbar.getByRole("button", { name: /Menu/ }).click();
    await expect(page.locator("#site-menu").getByRole("link", { name: /Knowledge/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("glossary is a menu destination with working search filter", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    // Glossary is a SECONDARY destination: it lives in the hamburger menu
    // (#site-menu navItems), not in the header explore switcher (R-015).
    await page.goto("/");
    await expect(page.locator("header .nav-shortcut", { hasText: "Glossary" })).toHaveCount(0);
    await page.locator("header .menu-trigger").click();
    const menuLink = page.locator("#site-menu").getByRole("link", { name: /Glossary/ });
    await expect(menuLink).toBeVisible();
    await menuLink.click();
    await expect(page).toHaveURL(/\/glossary\/?$/);

    // Lane page must NOT show the Timeline category sidebar (aside.left).
    await expect(page.locator(".layout aside.left")).toHaveCount(0);
    await expect(page.locator(".layout.lane-layout")).toBeVisible();

    // Hero + term cards + category groups render.
    await expect(page.locator("#glossary-heading")).toBeVisible();
    const cards = page.locator("[data-gl-term]");
    const totalCards = await cards.count();
    expect(totalCards, "glossary renders term cards").toBeGreaterThan(20);
    const groups = page.locator("[data-gl-group]");
    expect(await groups.count(), "glossary groups terms by category").toBeGreaterThan(1);

    // Decorative hero illustration + a category icon tile on every card.
    await expect(page.locator(".gl-hero-art")).toBeVisible();
    expect(
      await page.locator('[data-view-panel="category"] .gl-card .gl-icon').count(),
      "every category-view card has an icon tile",
    ).toBeGreaterThan(20);

    // Both view panels exist in the DOM but only the active one is RENDERED.
    // (Regression guard: a class-level `display` must not defeat [hidden], or
    // both panels show at once and the toggle becomes a no-op.)
    const renderedCards = () =>
      cards.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length);
    const catTerms = await page.locator('[data-view-panel="category"] [data-gl-term]').count();
    expect(await renderedCards(), "only the category panel renders by default").toBe(catTerms);

    // A-Z 目次: an alphabetical index bar with jump links.
    const azLinks = page.locator(".gl-az a[data-az-letter]");
    expect(await azLinks.count(), "A-Z index exposes jump links").toBeGreaterThan(5);

    // Toggle to A-Z view: category panel hides, alphabetical panel shows, and
    // the rendered card count stays at one panel's worth (not doubled).
    await page.locator('[data-view-btn="alpha"]').click();
    await expect(page.locator('[data-view-panel="alpha"]')).toBeVisible();
    await expect(page.locator('[data-view-panel="category"]')).toBeHidden();
    expect(await renderedCards(), "only the alpha panel renders after toggle").toBe(catTerms);

    // Clicking an A-Z letter scrolls its letter section into view.
    const firstLetter = await azLinks.first().getAttribute("data-az-letter");
    await azLinks.first().click();
    await expect(page.locator(`#gl-az-${firstLetter}`)).toBeVisible();

    // Search filters down to matching terms (visually, not just by attribute).
    const search = page.locator("#glossary-search");
    await search.fill("harness");
    await expect.poll(renderedCards).toBeLessThan(catTerms);
    await expect.poll(renderedCards).toBeGreaterThan(0);

    // No matches shows an explicit empty state.
    await search.fill("zzzznotarealterm");
    await expect(page.locator("[data-gl-empty]")).toBeVisible();
    await search.fill("");
    await expect(page.locator("[data-gl-empty]")).toBeHidden();

    // No horizontal scroll on desktop.
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth,
    )).toBe(true);

    // On mobile, glossary is menu-owned: the Menu trigger is active and the
    // Glossary link is reachable from the hamburger menu. No horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/glossary/");
    const tabbar = page.getByRole("navigation", { name: "Primary" });
    await expect(tabbar.getByRole("button", { name: /Menu/ })).toHaveClass(/active/);
    await tabbar.getByRole("button", { name: /Menu/ }).click();
    await expect(page.locator("#site-menu").getByRole("link", { name: /Glossary/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });
});

