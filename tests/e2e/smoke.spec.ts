import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const TIMELINE_ENTRY_LINK_SELECTOR = 'main article.card h3.title > a[href^="/e/"]';

test.describe("TECH Dashboard smoke", () => {
  test("home renders primary sections", async ({ page }) => {
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 900 });

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
    await expect(page.locator(".signal-node.node-source")).toContainText(/active sources/i);
    await expect(page.locator(".banner-fact").filter({ hasText: "収録中ソース" })).toContainText(/registry sources with live entries/i);
    await expect(page.locator(".banner-fact").filter({ hasText: "Active registry sources" })).toContainText(/active registry sources/i);
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
    await expect(page.locator("article.featured [data-featured-importance]")).toBeVisible();
    await expect(page.locator("article.featured [data-featured-importance]")).toContainText(/重要度 (High|Medium|Info)/);
    await expect(page.locator("#priority-heading")).toBeVisible();
    await expect(page.locator("#timeline-heading")).toBeVisible();
    const order = await page.evaluate(() => {
      const featured = document.querySelector("article.featured") as HTMLElement | null;
      const topRank = document.querySelector(".top-rank") as HTMLElement | null;
      const digest = document.querySelector(".digest") as HTMLElement | null;
      if (!featured || !topRank || !digest) return null;
      return {
        featuredTop: featured.getBoundingClientRect().top,
        topRankTop: topRank.getBoundingClientRect().top,
        digestTop: digest.getBoundingClientRect().top,
      };
    });
    expect(order, "featured / top-3 / daily summary sections are present").not.toBeNull();
    expect(order!.featuredTop, "featured appears before top-3").toBeLessThan(order!.topRankTop);
    expect(order!.topRankTop, "top-3 appears before daily summary").toBeLessThan(order!.digestTop);

    const decisionLinks = await page.evaluate(() => {
      const featuredHref = (document.querySelector("article.featured .featured-title a") as HTMLAnchorElement | null)?.getAttribute("href");
      const topHrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".top-rank-list .top-rank-item .rank-title"))
        .map((a) => a.getAttribute("href"))
        .filter((href): href is string => !!href);
      const featuredSource = (document.querySelector<HTMLElement>("article.featured")?.dataset.source ?? "").trim();
      const topSources = Array.from(document.querySelectorAll<HTMLElement>(".top-rank-list .top-rank-item"))
        .map((item) => (item.dataset.source ?? "").trim())
        .filter(Boolean);
      const duplicateFreshnessText = Array.from(document.querySelectorAll<HTMLElement>(".top-rank-list .top-rank-item .rank-reason.i18n-ja"))
        .some((el) => /収集元 更新(?:OK|遅延)/.test(el.innerText));
      const sourceTypeBadge = document.querySelector("article.featured .featured-meta .badge[data-source-type]") as HTMLElement | null;
      const importanceBadge = document.querySelector("article.featured .featured-meta [data-featured-importance]") as HTMLElement | null;
      return {
        featuredHref,
        topHrefs,
        featuredSource,
        topSources,
        duplicateFreshnessText,
        sourceType: sourceTypeBadge?.dataset.sourceType ?? "",
        sourceTypeClass: sourceTypeBadge?.className ?? "",
        importanceTone: importanceBadge?.dataset.importanceTone ?? "",
        importanceLevel: importanceBadge?.dataset.importanceLevel ?? "",
        importanceClass: importanceBadge?.className ?? "",
      };
    });
    expect(decisionLinks.featuredHref, "featured item has an entry link").toBeTruthy();
    expect(decisionLinks.topHrefs.length, "top-3 keeps three entries with current data").toBe(3);
    expect(new Set(decisionLinks.topHrefs).size, "top-3 entries are distinct").toBe(3);
    expect(decisionLinks.featuredSource, "featured item exposes its raw source id").toBeTruthy();
    expect(decisionLinks.topSources.length, "top-3 items expose raw source ids").toBe(3);
    expect(
      decisionLinks.topHrefs.every((href) => href !== decisionLinks.featuredHref),
      "featured and top-3 should not overlap",
    ).toBe(true);
    expect(
      decisionLinks.topSources.every((source) => source !== decisionLinks.featuredSource),
      "top-3 should exclude the featured source stream, not only the featured entry id",
    ).toBe(true);
    expect(decisionLinks.duplicateFreshnessText, "rank reasons should not duplicate freshness badge wording").toBe(
      false,
    );
    if (decisionLinks.sourceType === "paper") {
      expect(decisionLinks.sourceTypeClass).toContain("paper");
    } else if (decisionLinks.sourceType === "release" || decisionLinks.sourceType === "changelog") {
      expect(decisionLinks.sourceTypeClass).toContain("release");
    } else {
      expect(decisionLinks.sourceTypeClass.includes("release") || decisionLinks.sourceTypeClass.includes("paper")).toBe(
        false,
      );
    }
    expect(["high", "medium", "normal"]).toContain(decisionLinks.importanceTone);
    const expectedTone = ({
      "3": "high",
      "2": "medium",
      "1": "normal",
    } as const)[decisionLinks.importanceLevel as "1" | "2" | "3"];
    expect(expectedTone, "featured importance level should map to an explicit tone").toBe(decisionLinks.importanceTone);
    expect(decisionLinks.importanceClass).toContain("importance-badge");
    expect(decisionLinks.importanceClass).toContain(expectedTone);
    await expect(page.locator(".featured-label .i18n-ja")).toContainText("Spotlight · 自動選定");
    await expect(page.locator(".featured-label .i18n-en")).toContainText("Spotlight · system-ranked");
    await expect(page.locator(".featured-label")).not.toContainText(/編集部選定|editor pick/i);
    await expect(page.locator(".top-rank-title .i18n-ja")).toContainText("Spotlightを除く優先度 Top 3");
    await expect(page.locator(".featured-freshness .i18n-ja")).toHaveText(/収集元 更新(?:OK|遅延)/);
    const spotlightRationale = page.locator(".featured-rationale");
    await expect(spotlightRationale).toBeVisible();
    await expect(spotlightRationale.locator(".i18n-ja")).toContainText(/注目する理由:\s*\S+/);
    await expect(spotlightRationale.locator(".i18n-en")).toContainText(/Why it matters:\s*\S+/);

    const featuredTrustOrder = await page.evaluate(() => {
      const title = document.querySelector<HTMLElement>("article.featured .featured-title");
      const meta = document.querySelector<HTMLElement>("article.featured .featured-meta");
      const summary = document.querySelector<HTMLElement>("article.featured .featured-summary:not([hidden])");
      if (!title || !meta || !summary) return null;
      const titleRect = title.getBoundingClientRect();
      const metaRect = meta.getBoundingClientRect();
      const summaryRect = summary.getBoundingClientRect();
      return {
        titleTop: titleRect.top,
        metaTop: metaRect.top,
        metaBottom: metaRect.bottom,
        summaryTop: summaryRect.top,
        viewportHeight: window.innerHeight,
      };
    });
    expect(featuredTrustOrder, "Spotlight title, trust metadata, and summary are rendered").not.toBeNull();
    expect(featuredTrustOrder!.titleTop).toBeLessThan(featuredTrustOrder!.metaTop);
    expect(featuredTrustOrder!.metaTop).toBeLessThan(featuredTrustOrder!.summaryTop);
    expect(featuredTrustOrder!.metaBottom, "Spotlight trust metadata stays inside the 900px fold").toBeLessThanOrEqual(featuredTrustOrder!.viewportHeight);
  });
  // Timeline right rail: constrains the main column at >=981px, stays hidden at
  // <=980px, never causes horizontal scroll, and must NOT leak onto lane pages.
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

  test("top-rank panel remains stable across rail breakpoint widths", async ({ page }) => {
    const widths = [1181, 1180, 1100, 1050, 1000, 981, 980, 960, 901, 900, 768, 390];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await expect(page.locator(".top-rank")).toBeVisible();

      const metrics = await page.evaluate(() => {
        const layout = document.querySelector(".layout");
        const rightRail = document.querySelector<HTMLElement>(".layout aside.right.home-right");
        const railRect = rightRail?.getBoundingClientRect();
        const rightRailVisible = !!rightRail
          && getComputedStyle(rightRail).display !== "none"
          && !!railRect
          && railRect.width > 0
          && railRect.height > 0;
        const rightRailCards = rightRail?.querySelectorAll(".side-card").length ?? 0;

        const items = Array.from(document.querySelectorAll<HTMLElement>(".top-rank-item"));
        const itemHeights = items.map((item) => item.getBoundingClientRect().height);
        const maxRankHeight = itemHeights.length > 0 ? Math.max(...itemHeights) : 0;
        const metaInMedalTrack = items.some((item) => {
          const medal = item.querySelector<HTMLElement>(".medal");
          const meta = item.querySelector<HTMLElement>(".rank-meta");
          if (!medal || !meta) return true;
          const medalRect = medal.getBoundingClientRect();
          const metaRect = meta.getBoundingClientRect();
          return metaRect.left < medalRect.right - 1 || metaRect.width <= medalRect.width + 8;
        });

        const freshness = Array.from(
          document.querySelectorAll<HTMLElement>(".top-rank-item .rank-freshness, article.featured .featured-freshness"),
        )
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const styles = getComputedStyle(el);
            return {
              width: rect.width,
              height: rect.height,
              whiteSpace: styles.whiteSpace,
              visible: rect.width > 0 && rect.height > 0 && styles.display !== "none",
            };
          })
          .filter((entry) => entry.visible);

        const featuredThumb = document.querySelector<HTMLElement>("article.featured .featured-thumb");
        const featuredBody = document.querySelector<HTMLElement>("article.featured .featured-body");
        const main = document.querySelector<HTMLElement>(".layout main");
        const featuredFreshness = document.querySelector<HTMLElement>("article.featured .featured-freshness");
        const featuredThumbRect = featuredThumb?.getBoundingClientRect();
        const featuredBodyRect = featuredBody?.getBoundingClientRect();
        const featuredFreshnessRect = featuredFreshness?.getBoundingClientRect();

        return {
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          gridCols: layout ? getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
          rightRailVisible,
          rightRailCards,
          rankCount: items.length,
          maxRankHeight,
          metaInMedalTrack,
          freshness,
          featuredThumbWidth: featuredThumbRect?.width ?? 0,
          featuredThumbHeight: featuredThumbRect?.height ?? 0,
          featuredBodyWidth: featuredBodyRect?.width ?? 0,
          mainWidth: main?.getBoundingClientRect().width ?? 0,
          featuredFreshnessWidth: featuredFreshnessRect?.width ?? 0,
          featuredFreshnessHeight: featuredFreshnessRect?.height ?? 0,
        };
      });

      expect(metrics.noOverflow, `width ${width}: page should not overflow horizontally`).toBe(true);
      expect(metrics.rankCount, `width ${width}: top-3 should keep three cards`).toBe(3);
      expect(metrics.metaInMedalTrack, `width ${width}: rank meta must not collapse into medal track`).toBe(false);
      expect(metrics.freshness.length, `width ${width}: freshness badges should be visible`).toBeGreaterThan(0);
      for (const badge of metrics.freshness) {
        expect(badge.whiteSpace, `width ${width}: freshness should stay atomic`).toBe("nowrap");
        expect(badge.width, `width ${width}: freshness badge should keep readable width`).toBeGreaterThanOrEqual(70);
        expect(badge.height, `width ${width}: freshness badge should stay one-line height`).toBeLessThanOrEqual(48);
      }

      if (width >= 981) {
        expect(metrics.rightRailVisible, `width ${width}: right rail should be visible and populated`).toBe(true);
        expect(metrics.rightRailCards, `width ${width}: right rail should have cards`).toBeGreaterThan(0);
      } else {
        expect(metrics.rightRailVisible, `width ${width}: right rail should be hidden`).toBe(false);
      }

      if (width <= 1180 && width >= 981) {
        expect(metrics.maxRankHeight, `width ${width}: top-rank item height should stay compact`).toBeLessThanOrEqual(180);
        expect(metrics.featuredThumbWidth, `width ${width}: featured thumb should keep width`).toBeGreaterThan(120);
        expect(metrics.featuredThumbHeight, `width ${width}: featured thumb should keep height`).toBeGreaterThan(95);
        expect(metrics.featuredBodyWidth, `width ${width}: featured body should keep readable width`).toBeGreaterThan(210);
        expect(metrics.featuredFreshnessWidth, `width ${width}: featured freshness should keep readable width`).toBeGreaterThanOrEqual(70);
        expect(metrics.featuredFreshnessHeight, `width ${width}: featured freshness should stay one-line height`).toBeLessThanOrEqual(48);
      }

      if (width === 900 || width === 768) {
        expect(metrics.maxRankHeight, `width ${width}: top-rank should not grow excessively`).toBeLessThanOrEqual(300);
      }
      if (width === 980) {
        expect(metrics.gridCols, "width 980: layout should use the existing two-column grid").toBe(2);
        expect(metrics.mainWidth, "width 980: main should expand after the rail is hidden").toBeGreaterThan(650);
      }
    }
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

    const firstEntryLink = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(firstEntryLink).toBeVisible();

    await firstEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    await expect(page.locator("article.entry-detail")).toBeVisible();
    await expect(page.locator("h1.ed-title")).toBeVisible();

    // Summary-first (LL-112/LL-125): feed-driven detail pages can validly land
    // in exactly one of three honest states: real prose, summary-only digest,
    // or pending-summary. The test must not assume the first internal article
    // link is already enriched.
    await expect(page.locator("body")).not.toContainText("近日中に AI が生成");
    const prose = page.locator(".ed-body-prose");
    const digest = page.locator(".ed-summary-only");
    const pending = page.locator(".ed-pending-summary");
    const footerCta = page.locator('a.ed-cta[target="_blank"]');
    const disclaimer = page.locator(".ed-disclaim");
    const hasProse = (await prose.count()) > 0;
    const hasDigest = (await digest.count()) > 0;
    const hasPending = (await pending.count()) > 0;
    expect([hasProse, hasDigest, hasPending].filter(Boolean)).toHaveLength(1);

    if (hasProse) {
      await expect(prose.first()).toBeVisible();
      await expect(digest).toHaveCount(0);
      await expect(pending).toHaveCount(0);
    } else if (hasDigest) {
      await expect(digest.first()).toBeVisible();
      await expect(prose).toHaveCount(0);
      await expect(pending).toHaveCount(0);
      await expect(
        page.locator('.ed-summary-only-link[target="_blank"]').first(),
      ).toBeVisible();
    } else {
      await expect(pending.first()).toBeVisible();
      await expect(pending.first()).toContainText("Summary pending");
      await expect(prose).toHaveCount(0);
      await expect(digest).toHaveCount(0);
    }

    if (hasPending) {
      await expect(footerCta).toHaveCount(0);
      await expect(disclaimer).toHaveCount(0);
      await expect(page.locator(".ed-header-cta, .rail-cta")).toHaveCount(0);
      await expect(page.locator('article.entry-detail a[target="_blank"]')).toHaveCount(1);
    } else {
      await expect(footerCta).toBeVisible();
      await expect(disclaimer).toBeVisible();
      await expect(disclaimer.locator(".i18n-ja")).toContainText("AI による自動生成");
      await expect(disclaimer.locator(".i18n-en")).toContainText("AI-generated");
    }
  });

  test("entry freshness badge links to matching status source row", async ({ page }) => {
    await page.goto("/");
    const firstEntryLink = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(firstEntryLink).toBeVisible();
    await firstEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    const freshnessLink = page.locator("a.ed-freshness").first();
    await expect(freshnessLink).toBeVisible();
    const href = await freshnessLink.getAttribute("href");
    expect(href, "detail freshness badge should target status source anchor").toMatch(/^\/status#source-/);
    await freshnessLink.click();
    await expect(page).toHaveURL(/\/status#source-/);

    const hash = href!.split("#")[1]!;
    await expect(page.locator(`#${hash}`)).toBeVisible();
  });

  test("entry freshness ok badge wording stays truthful", async ({ page }) => {
    await page.goto("/");
    const entryHrefs = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/e/"]'))
        .map((a) => a.getAttribute("href"))
        .filter((href): href is string => !!href);
      return Array.from(new Set(hrefs)).slice(0, 24);
    });

    let checked = false;
    for (const href of entryHrefs) {
      await page.goto(href);
      const okLink = page.locator("a.ed-freshness.ok").first();
      if ((await okLink.count()) === 0) continue;
      await expect(okLink).toBeVisible();
      const title = (await okLink.getAttribute("title")) ?? "";
      const aria = (await okLink.getAttribute("aria-label")) ?? "";
      expect(title).toContain("within");
      expect(title).toContain("freshness threshold");
      expect(title).not.toContain("stale >");
      expect(aria).toContain("within");
      expect(aria).toContain("freshness threshold");
      expect(aria).not.toContain("stale >");
      checked = true;
      break;
    }

    expect(checked, "at least one recent entry should expose an .ed-freshness.ok link").toBe(true);
  });

  test("pending detail keeps summary pending separate from collection freshness", async ({ page }) => {
    await page.goto("/");
    const pendingCards = page.locator("article.card").filter({ has: page.locator(".summary-state") });
    const pendingCount = await pendingCards.count();
    if (pendingCount === 0) {
      expect(pendingCount, "fully summarized homepage data is a valid state").toBe(0);
      return;
    }

    const pendingCard = pendingCards.first();
    await expect(pendingCard, "pending homepage cards must still render as a valid state").toBeVisible();
    const detailHref = await pendingCard.locator('a[href^="/e/"]').first().getAttribute("href");
    expect(detailHref, "pending card should expose an internal detail link").toBeTruthy();

    await page.goto(detailHref!);
    const pending = page.locator(".ed-pending-summary");
    const freshness = page.locator(".ed-freshness[data-freshness-scope='collection']").first();

    await expect(pending).toBeVisible();
    await expect(pending.locator(".i18n-ja").first()).toHaveText("AI 要約 準備待ち");
    await expect(pending.locator(".i18n-en").first()).toHaveText("Summary pending");
    await expect(pending).not.toContainText("近日中に AI が生成");
    await expect(page.locator(".ed-header-cta, .ed-cta-row, .rail-cta, .ed-disclaim")).toHaveCount(0);
    await expect(page.locator('article.entry-detail a[target="_blank"]')).toHaveCount(1);
    await expect(page.locator('article.entry-detail a[target="_blank"]').first()).toHaveAttribute(
      "href", /^(?!\/e\/).+/,
    );
    await expect(freshness).toBeVisible();
    await expect(freshness).toHaveAttribute("data-freshness-scope", "collection");
    const title = (await freshness.getAttribute("title")) ?? "";
    const aria = (await freshness.getAttribute("aria-label")) ?? "";
    expect(title).toContain("source collection freshness");
    expect(aria).toContain("収集鮮度");
    expect(aria).not.toContain("summary");
    await expect(freshness.locator(".i18n-ja")).toHaveText(/収集元 更新(?:OK|遅延)/);
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

  test("detail TLDR body follows the active language, not just the heading", async ({ page }) => {
    await page.goto("/");
    const detailHrefs = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/e/"]'))
        .map((a) => a.getAttribute("href"))
        .filter((href): href is string => !!href);
      return Array.from(new Set(hrefs)).slice(0, 40);
    });

    let matched = false;
    for (const href of detailHrefs) {
      await page.goto(href);
      const tldr = page.locator(".ed-tldr");
      if ((await tldr.count()) === 0 || (await page.locator(".ed-pending-summary").count()) > 0) continue;
      const jaBody = page.locator(".ed-tldr .ed-tldr-body.i18n-ja").first();
      const enBody = page.locator(".ed-tldr .ed-tldr-body.i18n-en").first();
      const enText = ((await enBody.textContent()) ?? "").trim();
      if (!/[A-Za-z]{3}/.test(enText)) continue;

      await expect(jaBody).toBeVisible();
      await expect(enBody).toBeHidden();

      const enBtn = page.locator('.lang-btn[data-lang="en"]');
      await enBtn.click();
      await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
      await expect(jaBody).toBeHidden();
      await expect(enBody).toBeVisible();
      await expect(enBody).toContainText(/[A-Za-z]{3}/);
      matched = true;
      break;
    }

    expect(matched, "at least one enriched detail page should expose a direct English TLDR body").toBe(true);
  });

  test("detail English TLDR labels a Japanese-language fallback", async ({ page }) => {
    const fallbackEntry = readdirSync("web/dist/e", { withFileTypes: true }).find((entry) =>
      entry.isDirectory()
      && readFileSync(`web/dist/e/${entry.name}/index.html`, "utf8")
        .includes('data-en-summary-fallback="ja"'),
    );
    expect(fallbackEntry, "built details include an English-view Japanese summary fallback").toBeTruthy();

    await page.goto(`/e/${fallbackEntry!.name}/`);
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(page.locator(".ed-tldr-title.i18n-en")).toHaveText("Japanese-language summary");
    const fallbackBody = page.locator(".ed-tldr-body.i18n-en");
    await expect(fallbackBody).toBeVisible();
    await expect(fallbackBody.locator('[lang="ja"]')).not.toHaveText("");
  });

  test("detail page exposes one explicit Pagefind title instead of concatenating language variants", async ({ page }) => {
    await page.goto("/");
    const detailHref = await page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first().getAttribute("href");
    expect(detailHref, "home should link to at least one detail page").toBeTruthy();
    await page.goto(detailHref!);

    const pagefindTitle = page.locator('meta[data-pagefind-meta="title[content]"]');
    await expect(pagefindTitle).toHaveCount(1);
    const indexedTitle = ((await pagefindTitle.getAttribute("content")) ?? "").trim();
    const visibleJaTitle = ((await page.locator(".ed-title .i18n-ja").textContent()) ?? "").trim();
    expect(indexedTitle).toBeTruthy();
    expect(indexedTitle).toBe(visibleJaTitle);
  });

  test("skip link is keyboard visible and focuses content start", async ({ page }) => {
    await page.goto("/");
    const skip = page.locator(".skip-link");
    await page.keyboard.press("Tab");
    await expect(skip).toBeFocused();
    const transitionDuration = await skip.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(transitionDuration, "skip link should not animate into view").not.toContain("0.2s");
    const top = await skip.evaluate((el) => Number.parseFloat(getComputedStyle(el).top));
    expect(top, "skip link should be fully visible immediately on focus").toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Enter");
    await expect(page.locator("#content-start")).toBeFocused();
  });

  test("status page renders worker and source health", async ({ page }) => {
    await page.goto("/status/");

    await expect(page.locator(".page-hero #status-heading")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Worker Health/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Source Freshness/i })).toBeVisible();
    await expect(page.getByText("Summary entries pending").first()).toBeVisible();
    const collectionMetric = page.locator('[data-health-scope="latest-batch"]');
    await expect(collectionMetric).toContainText(/\d+\/\d+/);
    await expect(page.locator('[data-health-scope="collection-run"]')).toHaveCount(1);
    await expect(page.locator('[data-health-domain="summary-queue"]')).toHaveCount(3);
    await expect(page.locator('[data-health-scope="summary-throughput"]')).toHaveCount(1);
    await expect(page.locator('[data-health-scope="summary-backlog"]')).toHaveCount(1);
    await expect(page.locator('[data-health-scope="summary-eta"]')).toHaveCount(1);
    await expect(page.locator('[data-health-scope="published-artifact"]')).toHaveCount(1);
    await expect(collectionMetric.locator("small")).toHaveText(/batch \d+\/\d+ · \d+ registry sources/);
    await expect(page.locator('[data-health-scope="summary-throughput"] strong')).toHaveAttribute(
      "title",
      /new ai summaries added in this collection run.*backlog is tracked separately/i,
    );
    await expect(page.locator(".source-reason-line").first()).toBeVisible();
    await expect(page.locator('[data-source-filter="all"]')).toBeVisible();
    await expect(page.locator('[data-category-filter="all"]')).toBeVisible();
    await expect(page.locator(".source-item").first()).toBeVisible();
    await expect(page.getByText(/stale > \d+h/).first()).toBeVisible();
    await expect(page.locator(".source-latest-line").first()).toBeVisible();

    // Hero and footer must share the same run-status semantics (LL-126):
    // stale last-run pages must never say "Run ERR" in hero and "run ok" in footer.
    const heroCount = await page.locator(".page-hero .page-count").first().innerText();
    const runMatch = heroCount.match(/Run\s+(OK|WARN|ERR)/);
    expect(runMatch, `status hero count should include run status, got: ${heroCount}`).not.toBeNull();
    expect(heroCount, "status hero should label freshness semantics explicitly").toContain("Fresh sources");
    const expectedTone = runMatch![1]!.toLowerCase();
    await expect(page.locator(".footer-bar .footer-inner")).toContainText(`run ${expectedTone}`);
    const footerRunLink = page.getByRole("link", { name: /Collection health:/ });
    await expect(footerRunLink).toHaveAttribute("href", "/status");
    await expect(footerRunLink).toHaveAttribute("aria-label", /collection health: run (ok|warn|err).*\d+ pending/i);
    const footerDot = footerRunLink.locator(".dot");
    await expect(footerDot).toHaveAttribute("data-run-tone", expectedTone);
    await expect(footerDot).toHaveClass(new RegExp(`\\bdot\\b.*\\b${expectedTone}\\b`));
    await expect(footerRunLink.locator(".mono")).toContainText(/last batch \d+\/\d+ src · \d+ pending/);
    await expect(page.locator(".footer-bar .item.mono")).toHaveCount(0);
    await expect(page.locator(".page-hero-copy .i18n-ja")).toContainText("Latest source batch");
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator(".page-hero-copy .i18n-en")).toBeVisible();
    await expect(page.locator(".page-hero-copy .i18n-en")).toContainText("Summary queue ETA");
    await expect(page.locator(".summary-ready-copy .i18n-ja")).toContainText("要約準備済み");
    await expect(page.locator(".summary-ready-copy .i18n-en")).toContainText("summary-ready");
  });

  test("status attention action targets visible main content on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/status/");

    const action = page.locator('.page-hero-actions a[href="#source-health-list"]');
    await expect(action).toHaveCount(1);
    await action.evaluate((link: HTMLAnchorElement) => link.click());
    await expect(page).toHaveURL(/\/status\/?#source-health-list$/);

    const target = page.locator("#source-health-list");
    await expect(target).toBeVisible();
    expect(await target.evaluate((element) => element.closest("aside") === null)).toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("status error rows with collected entries remain truthful", async ({ page }) => {
    await page.goto("/status/");
    const offenders = await page.locator(".source-item.source-row-error").evaluateAll((rows) =>
      rows
        .map((row) => {
          const count = Number((row.querySelector(".source-time-block strong") as HTMLElement | null)?.innerText ?? "0");
          const reason = ((row.querySelector(".source-reason-line") as HTMLElement | null)?.innerText ?? "").toLowerCase();
          const latest = ((row.querySelector(".source-time-block span") as HTMLElement | null)?.innerText ?? "").toLowerCase();
          return { count, reason, latest };
        })
        .filter(
          (row) =>
            row.count > 0 &&
            (row.reason.includes("inside the freshness threshold") ||
              row.reason.includes("no live entry yet") ||
              row.latest === "no data"),
        ),
    );
    expect(offenders, "data-bearing error rows should show threshold-exceeded context, not no-data/inside-threshold").toEqual([]);
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
    await expect(page.getByRole("heading", { name: /Source Freshness/i })).toBeVisible();
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

  test("research category keeps trend KPIs compact on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/c/research/");

    const chart = page.locator(".trend .chart");
    const kpis = page.locator(".trend .trend-kpis > span");
    await expect(page.locator(".trend .trend-kpis")).toBeVisible();
    await expect(kpis.nth(0)).toBeVisible();
    await expect(kpis.nth(1)).toBeVisible();
    await expect(kpis.nth(2)).toBeHidden();
    await expect(kpis.nth(3)).toBeHidden();
    await expect(chart).toBeHidden();
    await expect(page.locator(".trend .x-axis")).toBeHidden();
    await expect(page.locator(".trend .legend")).toBeHidden();
    const firstArticle = page.locator("article.card").first();
    await expect(firstArticle).toBeVisible();
    const articleBox = await firstArticle.boundingBox();
    expect(articleBox, "first research article has a box").not.toBeNull();
    expect(articleBox!.y, "first research article approaches the first viewport").toBeLessThanOrEqual(780);

    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("About states the pending-summary publishing contract honestly", async ({ page }) => {
    await page.goto("/about/");
    const assumption = page.locator(".trust-assumption");
    const sharing = page.locator(".sharing-checklist");
    const assumptionJa = assumption.locator("p .i18n-ja");
    const assumptionEn = assumption.locator("p .i18n-en");
    const sharingJa = sharing.locator("p").first().locator(".i18n-ja");
    const sharingEn = sharing.locator("p").first().locator(".i18n-en");
    await expect(assumptionJa).toContainText("要約は読む優先度を判断するための補助");
    await expect(assumptionEn).toContainText("Summaries support triage");
    await expect(assumptionJa).toContainText("共有前に原文を確認");
    await expect(assumptionEn).toContainText("Confirm the original source before sharing");
    await expect(assumptionJa).toContainText("要約待ちや翻訳表示にはラベル");
    await expect(assumptionEn).toContainText("Pending and translated states are labeled");
    await expect(sharing).toContainText("Public listing and detail pages may include newly collected entries");
    await expect(sharing).toContainText("Spotlight, Ranked Top 3");
    await expect(sharing).toContainText("RSS, and JSON Feed");
    await expect(sharingJa).toContainText("要約はトリアージの補助");
    await expect(sharingEn).toContainText("Summaries support triage");
    await expect(sharingJa).toContainText("共有前に原文を確認");
    await expect(sharingEn).toContainText("confirm the original source before sharing");
  });

  test("Research copy distinguishes selected research from paper-only arXiv browsing", async ({ page }) => {
    await page.goto("/c/research/");
    const callout = page.locator(".research-split-callout");
    await expect(callout).toContainText("選定した論文・レポート");
    await expect(callout).toContainText("arXiv レーンでは論文だけ");
    await expect(callout.getByRole("link", { name: "arXiv Papers" })).toBeVisible();
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

  test("navigation highlights sections without marking ancestor links as the current page", async ({ page }) => {
    await page.goto("/categories/");
    const categoriesShortcut = page.locator('header .nav-shortcut[href="/categories"]');
    await expect(categoriesShortcut).toHaveClass(/active/);
    await expect(categoriesShortcut).toHaveAttribute("aria-current", "page");
    await expect(page.locator('aside.left a.side-item[href="/"]')).not.toHaveClass(/active/);
    await expect(page.locator('aside.left a.side-item[href="/"]')).not.toHaveAttribute("aria-current");

    await page.goto("/c/copilot/");
    await expect(categoriesShortcut).toHaveClass(/active/);
    await expect(categoriesShortcut).not.toHaveAttribute("aria-current");
    const copilotSidebarLink = page.locator('aside.left a.side-item[href="/c/copilot"]');
    await expect(copilotSidebarLink).toHaveClass(/active/);
    await expect(copilotSidebarLink).toHaveAttribute("aria-current", "page");
    await expect(page.locator('.mobile-tabbar a[href="/categories"]')).toHaveClass(/active/);
    await expect(page.locator('.mobile-tabbar a[href="/categories"]')).not.toHaveAttribute("aria-current");

    await page.goto("/archive/");
    await page.locator("header .menu-trigger").click();
    const archiveMenuLink = page.locator('#site-menu a[href="/archive"]');
    await expect(archiveMenuLink).toHaveClass(/active/);
    await expect(archiveMenuLink).toHaveAttribute("aria-current", "page");
    await archiveMenuLink.click();
    const firstMonthHref = await page.locator("a.month-card").first().getAttribute("href");
    expect(firstMonthHref).toBeTruthy();
    await page.goto(firstMonthHref!);
    await page.locator("header .menu-trigger").click();
    await expect(archiveMenuLink).toHaveClass(/active/);
    await expect(archiveMenuLink).not.toHaveAttribute("aria-current");
    await expect(page.locator('aside.left a.side-item[href="/"]')).not.toHaveClass(/active/);

    await page.goto("/");
    const firstTagHref = await page.locator('a[href^="/t/"]').first().getAttribute("href");
    expect(firstTagHref).toBeTruthy();
    await page.goto(firstTagHref!);
    const timelineSidebarLink = page.locator('aside.left a.side-item[href="/"]');
    await expect(timelineSidebarLink).toHaveClass(/active/);
    await expect(timelineSidebarLink).not.toHaveAttribute("aria-current");
  });

  test("search close control only enters the focus order while search is open", async ({ page }) => {
    await page.goto("/");
    const closeSearch = page.getByRole("button", { name: "Close search", includeHidden: true });
    await expect(closeSearch).toBeHidden();
    await expect(closeSearch).toHaveAttribute("hidden", "");

    const shortcutOpener = page.locator('header .nav-shortcut[href="/categories"]');
    await shortcutOpener.focus();
    await expect(shortcutOpener).toBeFocused();
    await page.keyboard.press("/");
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await expect(closeSearch).toBeVisible();
    await expect(closeSearch).not.toHaveAttribute("hidden");

    await page.keyboard.press("Escape");
    await expect(closeSearch).toBeHidden();
    await expect(closeSearch).toHaveAttribute("hidden", "");
    await expect(shortcutOpener).toBeFocused();
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
    const tabbarOrder = await page.evaluate(() => {
      const tabbarNode = document.querySelector(".mobile-tabbar");
      const contentStart = document.querySelector("#content-start");
      const footer = document.querySelector(".footer-bar");
      return {
        beforeContent: Boolean(
          tabbarNode &&
            contentStart &&
            tabbarNode.compareDocumentPosition(contentStart) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
        beforeFooter: Boolean(
          tabbarNode &&
            footer &&
            tabbarNode.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      };
    });
    expect(tabbarOrder).toEqual({ beforeContent: true, beforeFooter: true });

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
    await expect(page.getByRole("heading", { name: /Source Freshness/i })).toBeVisible();
    const mobileMenuTrigger = tabbar.getByRole("button", { name: /Menu/ });
    await expect(mobileMenuTrigger).toHaveClass(/active/);
    await expect(mobileMenuTrigger).not.toHaveAttribute("aria-current");

    await openMobileMenu();
    await expect(menu.getByRole("link", { name: /Status/ })).toHaveAttribute("aria-current", "page");
    await menu.getByRole("link", { name: /About/ }).click();
    await expect(page).toHaveURL(/\/about\/?$/);
    await expect(page.locator("#about-heading")).toBeVisible();

    await openMobileMenu();
    await menu.getByRole("button", { name: /Search/ }).click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await expect(page.locator("#pagefind-results")).toBeVisible();
    const mobileLayering = await page.evaluate(() => {
      const search = document.querySelector<HTMLElement>(".search.is-open");
      const header = document.querySelector<HTMLElement>("header");
      return {
        searchZ: Number.parseInt(search ? getComputedStyle(search).zIndex : "0", 10),
        headerZ: Number.parseInt(header ? getComputedStyle(header).zIndex : "0", 10),
      };
    });
    expect(mobileLayering.searchZ, "mobile search stays above the header layer").toBeGreaterThan(mobileLayering.headerZ);
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
    const { featuredBox, thumbBox, bodyBox } = await featured.evaluate((node) => {
      const rect = (element: Element | null) => {
        if (!element || element.getClientRects().length === 0) return null;
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        featuredBox: rect(node),
        thumbBox: rect(node.querySelector(".featured-thumb")),
        bodyBox: rect(node.querySelector(".featured-body")),
      };
    });
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
    expect(await cards.count(), "mobile timeline provides cards for spacing checks").toBeGreaterThanOrEqual(2);
    const cardMetrics = await cards.evaluateAll((nodes) => {
      const rect = (element: Element | null) => {
        if (!element || element.getClientRects().length === 0) return null;
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return nodes.slice(0, 2).map((node) => ({
        panel: rect(node),
        thumb: rect(node.querySelector(".card-thumb")),
        body: rect(node.querySelector(".card-body")),
      }));
    });
    expect(cardMetrics.length, "mobile timeline provides two cards for spacing checks").toBeGreaterThanOrEqual(2);
    const firstCardBox = cardMetrics[0]!.panel;
    const secondCardBox = cardMetrics[1]!.panel;
    const firstThumbBox = cardMetrics[0]!.thumb;
    const firstBodyBox = cardMetrics[0]!.body;
    expect(firstCardBox, "first mobile timeline card has a visible panel box").not.toBeNull();
    expect(secondCardBox, "second mobile timeline card has a visible panel box").not.toBeNull();
    expect(firstBodyBox, "mobile card body has a box").not.toBeNull();
    expect(firstThumbBox, "regular mobile card thumbnail is hidden to keep text readable").toBeNull();
    expect(firstBodyBox!.width, "mobile card text keeps near-full card width to avoid awkward wrapping").toBeGreaterThanOrEqual(firstCardBox!.width - 28);
    expect(secondCardBox!.y - (firstCardBox!.y + firstCardBox!.height), "mobile cards have a visible gap between panels").toBeGreaterThanOrEqual(12);

    const pendingCard = cards.filter({ has: page.locator(".summary-state") }).first();
    const pendingCount = await cards.filter({ has: page.locator(".summary-state") }).count();
    if (pendingCount > 0) {
      await expect(pendingCard, "pending card is a valid state in mobile timeline").toBeVisible();
      await expect(pendingCard.locator(".summary .s-text")).toHaveCount(0);
    }

    const summaryCard = cards.filter({ has: page.locator(".summary .s-text") }).first();
    const summaryCount = await cards.filter({ has: page.locator(".summary .s-text") }).count();
    expect(summaryCount + pendingCount, "mobile timeline should expose at least one honest card state").toBeGreaterThan(0);
    if (summaryCount > 0) {
      await expect(summaryCard, "summary layout checks target a card that actually has summary text").toBeVisible();
      const { summaryBodyBox, summaryTextBox } = await summaryCard.evaluate((node) => {
        const rect = (element: Element | null) => {
          if (!element || element.getClientRects().length === 0) return null;
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return {
          summaryBodyBox: rect(node.querySelector(".card-body")),
          summaryTextBox: rect(node.querySelector(".summary .s-text")),
        };
      });
      expect(summaryBodyBox, "summary card body has a box").not.toBeNull();
      expect(summaryTextBox, "summary text has a readable box").not.toBeNull();
      expect(summaryTextBox!.x, "mobile summary text starts at card body edge, not after the AI badge").toBeLessThanOrEqual(summaryBodyBox!.x + 2);
      expect(summaryTextBox!.width, "mobile summary text keeps full readable width").toBeGreaterThanOrEqual(summaryBodyBox!.width - 2);
    }

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
      await expect(desktopCardThumb.locator(".fallback-src-mark")).toHaveText("NO PREVIEW");
    }
  });

  test("EntryCard category badges use display labels and stay contained", async ({ page }) => {
    const categorySurfaces = [
      ["cursor", "AI Editors"],
      ["tech-news", "News/Policy"],
      ["agent-fw", "Agent Frameworks"],
      ["local-llm", "Local Models"],
      ["opencode", "OpenHands/OpenCode"],
      ["research", "Papers/Benchmarks"],
    ] as const;

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/c/cursor/");
    await expect(page.locator("#category-heading")).toContainText("AI Editors");

    const zedCard = page.locator("article.card").filter({ hasText: "Zed Editor Releases" }).first();
    await expect(zedCard).toBeVisible();
    const zedBadge = zedCard.locator(".badge.cat");
    await expect(zedBadge).toHaveText("AI Editors");
    await expect(zedBadge).toHaveAttribute("title", "AI Editors");
    await expect(zedBadge).toHaveAttribute("aria-label", "Category: AI Editors");

    await page.setViewportSize({ width: 980, height: 844 });
    for (const [slug, displayLabel] of categorySurfaces) {
      await page.goto(`/c/${slug}/`);
      const badges = page.locator("article.card .badge.cat");
      await expect(badges.first()).toHaveText(displayLabel);
      const badgeTexts = (await badges.allInnerTexts()).map((text) => text.trim().toLowerCase());
      expect(badgeTexts, `${slug} category should use display metadata`).not.toContain(slug);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
  });

  test("decision surfaces expose semantic publication times", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("article.card .meta time[datetime]").first()).toBeVisible();
    await expect(page.locator("article.card .card-insight time[datetime]").first()).toBeVisible();
    await expect(page.locator("article.featured .featured-meta time[datetime]").first()).toBeVisible();
    await expect(page.locator(".top-rank-item time.rank-time[datetime]").first()).toBeVisible();

    const detailHref = await page.locator("article.card h3.title a").first().getAttribute("href");
    expect(detailHref).toBeTruthy();
    await page.goto(detailHref!);
    const detailTime = page.locator(".ed-byline time.ed-published[datetime]");
    await expect(detailTime).toBeVisible();
    await expect(detailTime.locator(".mono")).not.toHaveText("");
    await expect(detailTime.locator(".ed-rel")).not.toHaveText("");
  });

  test("pagefind search returns dashboard entries", async ({ page }) => {
    await page.goto("/");

    await page.locator("button[data-search-trigger]:visible").first().click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await page.locator("#pagefind-search-input").pressSequentially("Copilot");
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit-type").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-results-heading")).toContainText("Results");
    await expect(page.locator(".search-hit-type").first()).toHaveText("ARTICLE");
    await expect(page.locator(".search-hit.is-active").first()).toBeVisible({ timeout: 10_000 });
  });

  test("pagefind exact-result filtering ignores Unicode diacritics", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"))
      .toBe(true);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = async () => ({
        results: [
          {
            data: async () => ({
              url: "/e/cafe-result/",
              meta: { title: "Café agent patterns" },
              excerpt: "A result whose exact text contains a Unicode diacritic.",
            }),
          },
          {
            data: async () => ({
              url: "/e/unrelated-result/",
              meta: { title: "Coffee agent patterns" },
              excerpt: "A fuzzy Pagefind result that must not pass exact filtering.",
            }),
          },
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("cafe");
    await expect(page.locator(".search-hit")).toHaveCount(1);
    await expect(page.locator(".search-hit-title")).toHaveText("Café agent patterns");
    await expect(page.getByText("Coffee agent patterns")).toHaveCount(0);
  });

  test("pagefind search zero state gives next actions", async ({ page }) => {
    await page.goto("/");

    await page.locator("button[data-search-trigger]:visible").first().click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await page.locator("#pagefind-search-input").pressSequentially("zzzxqv987654nomatch");

    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-empty")).toContainText("No results", { timeout: 10_000 });
    await expect(page.locator(".search-empty")).toContainText("Try a shorter keyword");
    await expect(page.locator(".search-empty a", { hasText: "Browse categories" })).toBeVisible();
    await expect(page.locator(".search-empty a", { hasText: "Check sources" })).toBeVisible();
    await expect(page.locator(".search-empty a", { hasText: "Browse by month" })).toBeVisible();
    await expect(page.locator(".search-hit")).toHaveCount(0);
  });

  test("closing search invalidates a delayed Pagefind response", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"))
      .toBe(true);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = () => new Promise((resolve) => {
        (window as any).__resolveDelayedPagefind = () => resolve({
          results: [{
            data: async () => ({
              url: "/e/delayed-result/",
              meta: { title: "Delayed result must stay closed" },
              excerpt: "A deliberately delayed Pagefind result.",
            }),
          }],
        });
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    const input = page.locator("#pagefind-search-input");
    const panel = page.locator("#pagefind-results");
    const search = page.locator("header .search");
    await input.fill("delayed");
    await expect(panel).toContainText("Searching for", { timeout: 5_000 });

    await input.press("Escape");
    await expect(search).not.toHaveClass(/is-open/);
    await expect(panel).toBeHidden();
    await expect(input).not.toBeFocused();

    await page.evaluate(() => (window as any).__resolveDelayedPagefind());
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));

    await expect(search).not.toHaveClass(/is-open/);
    await expect(panel).toBeHidden();
    await expect(panel).toBeEmpty();
    await expect(input).not.toBeFocused();
    await expect(page.getByText("Delayed result must stay closed")).toHaveCount(0);
  });

  test("mobile search close clears state and releases focus", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    await page.locator(".mobile-tabbar").getByRole("button", { name: /Menu/ }).click();
    await page.locator("#site-menu").getByRole("button", { name: /Search/ }).click();

    const search = page.locator("header .search");
    const input = page.locator("#pagefind-search-input");
    const close = page.getByRole("button", { name: "Close search" });
    await expect(search).toHaveClass(/is-open/);
    await expect(input).toBeFocused();
    await expect(close).toBeVisible();

    const [searchBox, closeBox] = await Promise.all([search.boundingBox(), close.boundingBox()]);
    expect(searchBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(searchBox!.height, "mobile search outer control should be at least 48px tall").toBeGreaterThanOrEqual(48);
    expect(closeBox!.width, "mobile close target should be at least 44px wide").toBeGreaterThanOrEqual(44);
    expect(closeBox!.height, "mobile close target should be at least 44px tall").toBeGreaterThanOrEqual(44);

    await input.fill("Copilot");
    await expect(page.locator("#pagefind-results")).toBeVisible();
    await close.click();
    await expect(input).toHaveValue("");
    await expect(input).not.toBeFocused();
    await expect(page.locator("#pagefind-results")).toBeHidden();
    await expect(search).not.toHaveClass(/is-open/);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    const desktopSearch = page.locator("header .search");
    const desktopInput = page.locator("#pagefind-search-input");
    await desktopInput.focus();
    await expect(desktopSearch).toHaveClass(/is-open/);
    const desktopBox = await desktopSearch.boundingBox();
    expect(desktopBox).not.toBeNull();
    expect(desktopBox!.height, "desktop search outer control should be at least 44px tall").toBeGreaterThanOrEqual(44);
  });

  test("closing search restores focus to the trigger that opened it", async ({ page }) => {
    await page.goto("/");
    const search = page.locator("header .search");
    const input = page.locator("#pagefind-search-input");
    const trigger = page.locator("button[data-search-trigger]:visible").first();
    await expect(trigger).toBeVisible();

    // Close button restores focus to the opener.
    await trigger.click();
    await expect(search).toHaveClass(/is-open/);
    await expect(input).toBeFocused();
    await page.getByRole("button", { name: "Close search" }).click();
    await expect(search).not.toHaveClass(/is-open/);
    await expect(trigger).toBeFocused();

    // Escape from the input restores focus to the same opener.
    await trigger.click();
    await expect(search).toHaveClass(/is-open/);
    await expect(input).toBeFocused();
    await input.press("Escape");
    await expect(search).not.toHaveClass(/is-open/);
    await expect(trigger).toBeFocused();

    // Keyboard shortcuts can open search when no element owns focus. Closing
    // must still return focus to an equivalent visible navigation control.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await page.keyboard.press("/");
    await expect(input).toBeFocused();
    await page.getByRole("button", { name: "Close search" }).click();
    const fallbackFocus = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        menuTrigger: Boolean(el?.hasAttribute("data-menu-trigger")),
        visible: Boolean(el?.isConnected && el.getClientRects().length > 0),
      };
    });
    expect(fallbackFocus).toEqual({ menuTrigger: true, visible: true });
  });

  test("mobile Menu -> Search close returns focus to a visible menu trigger", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const search = page.locator("header .search");
    const input = page.locator("#pagefind-search-input");

    await page.locator(".mobile-tabbar button[data-menu-trigger]").click();
    const menu = page.locator("#site-menu");
    await expect(menu).toBeVisible();
    await menu.locator("button[data-search-trigger]").click();
    await expect(search).toHaveClass(/is-open/);
    await expect(input).toBeFocused();

    // Opening search closed the menu, hiding the in-menu opener. Escape must fall
    // back to a visible menu trigger, never dropping focus onto <body>.
    await input.press("Escape");
    await expect(search).not.toHaveClass(/is-open/);
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      return {
        hasMenuTrigger: el.hasAttribute("data-menu-trigger"),
        visible: el.isConnected && el.getClientRects().length > 0,
      };
    });
    expect(active).not.toBeNull();
    expect(active!.hasMenuTrigger, "focus should land on a menu trigger").toBe(true);
    expect(active!.visible, "the restored focus target must be visible").toBe(true);
  });

  test("status attention list is reachable on mobile without a huge scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/status/");

    const mobileList = page.locator("#attention-list-mobile");
    await expect(mobileList).toBeVisible();
    const box = await mobileList.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y, "attention list must not be buried thousands of px down").toBeLessThan(2600);

    // Either actionable rows OR an explicit empty state — both are valid.
    const rows = mobileList.locator(".status-attention-list li a[href^='#']");
    const rowCount = await rows.count();
    if (rowCount > 0) {
      await expect(rows.first()).toBeVisible();
      const rowBox = await rows.first().boundingBox();
      expect(rowBox).not.toBeNull();
      expect(rowBox!.y, "first attention row should be quickly reachable").toBeLessThan(2800);
    } else {
      await expect(mobileList.locator("p")).toBeVisible();
    }

    // Desktop right-rail copy is hidden at mobile width (no duplicated visible list).
    await expect(page.locator("#attention-list")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("home and about run-state match the shared footer run tone (LL-126)", async ({ page }) => {
    await page.goto("/");
    const footerTone = await page
      .locator(".footer-bar .dot[data-run-tone]")
      .first()
      .getAttribute("data-run-tone");
    expect(footerTone).toMatch(/^(ok|warn|err)$/);
    const heroTone = await page
      .locator(".banner-run-state[data-run-tone]")
      .first()
      .getAttribute("data-run-tone");
    expect(heroTone, "Home hero run tone must equal the shared footer tone").toBe(footerTone);

    await page.goto("/about/");
    const aboutFooterTone = await page
      .locator(".footer-bar .dot[data-run-tone]")
      .first()
      .getAttribute("data-run-tone");
    const aboutTone = await page
      .locator(".about-dl dd[data-run-tone]")
      .first()
      .getAttribute("data-run-tone");
    expect(aboutTone).toMatch(/^(ok|warn|err)$/);
    expect(aboutTone, "About run tone must equal the shared footer tone").toBe(aboutFooterTone);
  });

  test("article detail explains source tier and source-average denominator", async ({ page }) => {
    await page.goto("/");
    const firstEntryLink = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(firstEntryLink).toBeVisible();
    await firstEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    const strip = page.locator(".ed-meta-strip");
    await expect(strip).toBeVisible();

    // Tier pill renders only for sources with a known tier; when present it must
    // carry an explanatory accessible label plus a localized visible label.
    const tierPill = strip.locator(".pill[aria-label]");
    if ((await tierPill.count()) > 0) {
      await expect(tierPill.first()).toHaveAttribute("aria-label", /Tier \d source: /);
      await expect(tierPill.first()).toHaveAttribute("title", /Tier \d source: /);
      await expect(tierPill.first().locator(".pill-tier-label")).toHaveCount(1);
    }

    // Source average shows its denominator (/ 3) visibly and describes it in a11y text.
    const srcAvg = strip.locator('li .v[aria-label*="out of 3"]');
    await expect(srcAvg).toHaveCount(1);
    await expect(srcAvg).toHaveAttribute("aria-label", /out of 3/);
    await expect(srcAvg).toContainText("/ 3");
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
