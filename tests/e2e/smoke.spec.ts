import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

const TIMELINE_ENTRY_LINK_SELECTOR = 'main article.card h3.title > a[href^="/e/"]';
const REACTION_MUTATION_URL_RE = /\/api\/reactions\/[a-f0-9]{16}$/;
const REACTION_VOTER_COOKIE_NAME = "__Host-techdb_reaction_voter";

function hasReactionIdentityCookie(headers: Record<string, string>): boolean {
  return (headers.cookie ?? "")
    .split(";")
    .some((cookie) => cookie.trim().startsWith(`${REACTION_VOTER_COOKIE_NAME}=`));
}

async function rejectMutationWithoutIdentity(route: Route): Promise<boolean> {
  expect(route.request().method(), "reaction mutation uses desired-state PUT").toBe("PUT");
  if (hasReactionIdentityCookie(route.request().headers())) return false;
  await route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      error: {
        code: "identity_required",
        message: "Anonymous voter identity is required",
      },
    }),
  });
  return true;
}

async function mockReactionIdentity(
  page: Page,
  onRequest: () => void = () => {},
): Promise<void> {
  await page.route("**/api/reactions/identity", async (route) => {
    expect(route.request().method(), "reaction identity bootstrap uses POST").toBe("POST");
    onRequest();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Set-Cookie":
          `${REACTION_VOTER_COOKIE_NAME}=11111111-1111-4111-8111-111111111111; Path=/; HttpOnly; Secure; SameSite=Lax`,
      },
      body: JSON.stringify({ identity: { ready: true } }),
    });
  });
}

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
    await page.locator(".top-rank-item .rank-source").first().evaluate((source) => {
      const fullLabel = "Microsoft Foundry Engineering and AI Platform Updates";
      const label = source.querySelector("[data-source-disclosure-label]");
      if (label) label.textContent = fullLabel;
      const full = source.querySelector("[data-source-disclosure-full]");
      if (full) full.textContent = fullLabel;
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    const desktopDensity = await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { y: rect.y, height: rect.height };
      };
      return {
        banner: box(".banner-inner"),
        main: box(".layout main"),
        topRank: box(".top-rank"),
        rankMeta: box(".top-rank-item .rank-meta"),
        rankSourceClipped: (() => {
          const label = document.querySelector<HTMLElement>(
            ".top-rank-item .rank-source [data-source-disclosure-label]",
          );
          return !!label
            && label.scrollWidth > label.clientWidth
            && getComputedStyle(label).textOverflow === "ellipsis";
        })(),
        visibleBottom: Math.min(
          window.innerHeight,
          document.querySelector(".footer-bar")?.getBoundingClientRect().top ?? window.innerHeight,
        ),
      };
    });
    expect(desktopDensity.banner?.height, "desktop hero stays decision-dense").toBeLessThanOrEqual(370);
    expect(desktopDensity.main?.y, "desktop decision area starts near the first viewport").toBeLessThanOrEqual(520);
    expect(desktopDensity.topRank?.y, "desktop ranked Top-3 begins within the first viewport").toBeLessThanOrEqual(900);
    expect(desktopDensity.rankMeta?.height, "desktop Top-3 metadata stays on one line").toBeLessThanOrEqual(28);
    expect(desktopDensity.rankSourceClipped, "long Top-3 source uses ellipsis").toBe(true);
    expect(
      (desktopDensity.topRank?.y ?? Number.POSITIVE_INFINITY) + (desktopDensity.topRank?.height ?? 0),
      "desktop ranked Top-3 stays above the fixed footer in the first viewport",
    ).toBeLessThanOrEqual(desktopDensity.visibleBottom - 8);
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
    const topFreshness = page.locator(".top-rank-item .rank-freshness").first();
    await expect(topFreshness.locator(".rank-freshness-short.i18n-ja")).toBeVisible();
    const freshnessA11yStyle = await topFreshness.locator(".visually-hidden").evaluate((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        clip: style.clip,
        height: box.height,
        position: style.position,
        width: box.width,
      };
    });
    expect(freshnessA11yStyle.position).toBe("absolute");
    expect(freshnessA11yStyle.width).toBeLessThanOrEqual(1.5);
    expect(freshnessA11yStyle.height).toBeLessThanOrEqual(1.5);
    expect(freshnessA11yStyle.clip).not.toBe("auto");
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
      const authorityBadge = document.querySelector("article.featured .featured-meta .badge[data-source-authority]") as HTMLElement | null;
      const importanceBadge = document.querySelector("article.featured .featured-meta [data-featured-importance]") as HTMLElement | null;
      return {
        featuredHref,
        topHrefs,
        featuredSource,
        topSources,
        duplicateFreshnessText,
        sourceType: authorityBadge?.dataset.sourceType ?? "",
        sourceAuthority: authorityBadge?.dataset.sourceAuthority ?? "",
        authorityClass: authorityBadge?.className ?? "",
        authorityText: authorityBadge?.innerText.trim() ?? "",
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
    expect(["official", "paper", "community", "news", "aggregator", "source"]).toContain(
      decisionLinks.sourceAuthority,
    );
    expect(decisionLinks.authorityClass).toContain("authority");
    expect(decisionLinks.authorityClass).toContain(decisionLinks.sourceAuthority);
    expect(decisionLinks.authorityText).toMatch(/公式|論文|コミュニティ|報道|集約|出典/);
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
    await expect(spotlightRationale.locator(".i18n-ja")).toContainText(/選定根拠:\s*\S+/);
    await expect(spotlightRationale.locator(".i18n-en")).toContainText(/Selection basis:\s*\S+/);
    const rankReasons = page.locator(".top-rank-item .rank-reason.i18n-ja");
    await expect(rankReasons).toHaveCount(3);
    for (const reason of await rankReasons.all()) {
      await expect(reason).toBeVisible();
      await expect(reason).not.toHaveText("");
    }

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

  test("home renders reader-facing category labels instead of internal slugs", async ({ page }) => {
    await page.goto("/");
    const labels = (await page.locator(".tb-cat, .b-cat").allTextContents())
      .map((label) => label.trim().toLowerCase())
      .filter(Boolean);

    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain("local-llm");
    expect(labels).not.toContain("agent-fw");
    expect(labels).not.toContain("tech-news");

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.reload();
      const rows = await page.locator(".board .b-row").evaluateAll((elements) =>
        elements.map((element) => {
          const category = element.querySelector<HTMLElement>(".b-cat");
          const tags = element.querySelector<HTMLElement>(".b-tags");
          const categoryRect = category?.getBoundingClientRect();
          const tagsRect = tags?.getBoundingClientRect();
          return {
            categoryRight: categoryRect?.right ?? 0,
            tagsLeft: tagsRect?.left ?? Number.POSITIVE_INFINITY,
            categoryTitle: category?.getAttribute("title") ?? "",
          };
        }),
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.categoryTitle).not.toBe("");
        expect(row.categoryRight).toBeLessThanOrEqual(row.tagsLeft + 0.5);
      }
    }
  });

  test("footer reports the actual summary queue backlog", async ({ page }) => {
    await page.goto("/");
    const footerRun = page.locator(".footer-run-link");
    const backlog = await footerRun.getAttribute("data-summary-queue-backlog");
    expect(backlog).toMatch(/^\d+$/);
    await expect(footerRun.locator(".mono")).toContainText(`summary queue ${backlog}`);
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
    const widths = [1181, 1180, 1100, 1050, 1000, 981, 980, 960, 901, 900, 768, 761, 760, 721, 720, 390];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await expect(page.locator(".top-rank")).toBeVisible();
      if (width >= 721) {
        await page.locator(".featured-src, .top-rank-item .rank-source").evaluateAll((sources) => {
          const fullLabel = "Microsoft Foundry Engineering and AI Platform Updates";
          for (const source of sources) {
            const label = source.querySelector("[data-source-disclosure-label]");
            if (label) label.textContent = fullLabel;
            const full = source.querySelector("[data-source-disclosure-full]");
            if (full) full.textContent = fullLabel;
          }
        });
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
      }

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
        const rankList = document.querySelector<HTMLElement>(".top-rank-list");
        const topRank = document.querySelector<HTMLElement>(".top-rank");
        const footer = document.querySelector<HTMLElement>(".footer-bar");
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
              kind: el.matches("article.featured .featured-freshness") ? "featured" : "rank",
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
        const featuredMeta = document.querySelector<HTMLElement>("article.featured .featured-meta");
        const featuredSource = document.querySelector<HTMLElement>(
          "article.featured .featured-src .source-disclosure-label",
        );
        const featuredThumbRect = featuredThumb?.getBoundingClientRect();
        const featuredBodyRect = featuredBody?.getBoundingClientRect();
        const featuredFreshnessRect = featuredFreshness?.getBoundingClientRect();
        const featuredMetaRect = featuredMeta?.getBoundingClientRect();
        const topRankRect = topRank?.getBoundingClientRect();
        const topRankStyle = topRank ? getComputedStyle(topRank) : null;
        const footerRect = footer?.getBoundingClientRect();
        const rankMetaHeights = items
          .map((item) => item.querySelector<HTMLElement>(".rank-meta")?.getBoundingClientRect().height ?? 0);
        const firstRankSource = items[0]?.querySelector<HTMLElement>(
          ".rank-source [data-source-disclosure-label]",
        );
        const rankMetaGeometry = items.map((item) => {
          const visibleRect = (element: HTMLElement | null) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            const styles = getComputedStyle(element);
            if (
              styles.display === "none"
              || styles.visibility === "hidden"
              || rect.width <= 0
              || rect.height <= 0
            ) {
              return null;
            }
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            };
          };
          const source = visibleRect(item.querySelector<HTMLElement>("[data-source-disclosure-trigger]"));
          const time = visibleRect(item.querySelector<HTMLElement>(".rank-time"));
          const freshness = visibleRect(item.querySelector<HTMLElement>(".rank-freshness"));
          const visible = [source, time, freshness].filter((rect) => rect !== null);
          const overlaps = visible.some((rect, index) =>
            visible.slice(index + 1).some((other) =>
              rect.left < other.right - 0.5
              && rect.right > other.left + 0.5
              && rect.top < other.bottom - 0.5
              && rect.bottom > other.top + 0.5
            )
          );
          return {
            overlaps,
            sourceWidth: source?.width ?? 0,
            sourceHeight: source?.height ?? 0,
            timeVisible: time !== null,
          };
        });

        return {
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          gridCols: layout ? getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
          rankGridCols: rankList ? getComputedStyle(rankList).gridTemplateColumns.split(" ").filter(Boolean).length : 0,
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
          featuredMetaHeight: featuredMetaRect?.height ?? 0,
          maxRankMetaHeight: rankMetaHeights.length > 0 ? Math.max(...rankMetaHeights) : 0,
          topRankWidth: topRankRect?.width ?? 0,
          topRankContentWidth:
            topRank && topRankStyle
              ? topRank.clientWidth - parseFloat(topRankStyle.paddingLeft) - parseFloat(topRankStyle.paddingRight)
              : 0,
          rankMetaOverlaps: rankMetaGeometry.some((entry) => entry.overlaps),
          minRankSourceTriggerWidth: rankMetaGeometry.length > 0
            ? Math.min(...rankMetaGeometry.map((entry) => entry.sourceWidth))
            : 0,
          minRankSourceTriggerHeight: rankMetaGeometry.length > 0
            ? Math.min(...rankMetaGeometry.map((entry) => entry.sourceHeight))
            : 0,
          rankTimeVisibleCount: rankMetaGeometry.filter((entry) => entry.timeVisible).length,
          topRankBottom: topRankRect?.bottom ?? Number.POSITIVE_INFINITY,
          visibleBottom: Math.min(window.innerHeight, footerRect?.top ?? window.innerHeight),
          featuredSourceClipped: !!featuredSource
            && featuredSource.scrollWidth > featuredSource.clientWidth
            && getComputedStyle(featuredSource).textOverflow === "ellipsis",
          rankSourceClipped: !!firstRankSource
            && firstRankSource.scrollWidth > firstRankSource.clientWidth
            && getComputedStyle(firstRankSource).textOverflow === "ellipsis",
        };
      });

      expect(metrics.noOverflow, `width ${width}: page should not overflow horizontally`).toBe(true);
      expect(metrics.rankCount, `width ${width}: top-3 should keep three cards`).toBe(3);
      expect(metrics.metaInMedalTrack, `width ${width}: rank meta must not collapse into medal track`).toBe(false);
      expect(metrics.freshness.length, `width ${width}: freshness badges should be visible`).toBeGreaterThan(0);
      for (const badge of metrics.freshness) {
        expect(badge.whiteSpace, `width ${width}: freshness should stay atomic`).toBe("nowrap");
        expect(badge.width, `width ${width}: freshness badge should keep readable width`).toBeGreaterThanOrEqual(
          badge.kind === "featured" || width <= 720 ? 70 : 28,
        );
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
      expect(
        metrics.minRankSourceTriggerWidth,
        `width ${width}: source disclosure should keep a 44px inline target`,
      ).toBeGreaterThanOrEqual(43.5);
      expect(
        metrics.minRankSourceTriggerHeight,
        `width ${width}: source disclosure should keep a 44px block target`,
      ).toBeGreaterThanOrEqual(43.5);
      if (width >= 721) {
        expect(metrics.rankGridCols, `width ${width}: Top-3 should use three compact columns`).toBe(3);
        expect(metrics.featuredMetaHeight, `width ${width}: Featured metadata should stay within two rows`).toBeLessThanOrEqual(50);
        expect(metrics.featuredSourceClipped, `width ${width}: long Featured source should use ellipsis`).toBe(true);
        expect(metrics.maxRankMetaHeight, `width ${width}: Top-3 metadata should stay on one line`).toBeLessThanOrEqual(28);
        expect(metrics.rankSourceClipped, `width ${width}: long Top-3 source should use ellipsis`).toBe(true);
        expect(metrics.rankMetaOverlaps, `width ${width}: Top-3 metadata controls must not overlap`).toBe(false);
        expect(
          metrics.rankTimeVisibleCount,
          `width ${width}: compact cards should omit only the redundant time label`,
        ).toBe(
          (width >= 761 && width <= 836) || (width >= 981 && width <= 1028)
            ? 0
            : metrics.rankCount,
        );
        if (width <= 900) {
          expect(metrics.topRankBottom, `width ${width}: tablet Top-3 should stay above the fixed footer`).toBeLessThanOrEqual(
            metrics.visibleBottom - 8,
          );
        }
      } else {
        expect(metrics.rankGridCols, `width ${width}: mobile Top-3 should remain a single column`).toBe(1);
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
    const sourceCta = page.locator('a.ed-header-cta[target="_blank"]');
    const copyAction = page.locator("button.ed-share-btn[data-share-copy]");
    const disclaimer = page.locator(".ed-disclaim");
    const hasProse = (await prose.count()) > 0;
    const hasDigest = (await digest.count()) > 0;
    const hasPending = (await pending.count()) > 0;
    expect([hasProse, hasDigest, hasPending].filter(Boolean)).toHaveLength(1);
    await expect(sourceCta).toHaveCount(1);
    await expect(sourceCta).toBeVisible();
    await expect(sourceCta.locator(".i18n-ja")).toHaveText("元記事を読む");
    await expect(sourceCta.locator("small")).not.toHaveText("");
    await expect(copyAction).toHaveCount(1);
    await expect(copyAction).toBeVisible();
    await expect(copyAction.locator(".i18n-ja")).toHaveText("タイトルと URL をコピー");
    await expect(
      page.locator(
        ".ed-freshness, .rail-freshness, .rail-cta, .ed-cta-row, .ed-summary-only-link, .ed-tldr-source",
      ),
    ).toHaveCount(0);
    await expect(page.locator('article.entry-detail a[target="_blank"]')).toHaveCount(1);

    if (hasProse) {
      await expect(prose.first()).toBeVisible();
      await expect(digest).toHaveCount(0);
      await expect(pending).toHaveCount(0);
    } else if (hasDigest) {
      await expect(digest.first()).toBeVisible();
      await expect(prose).toHaveCount(0);
      await expect(pending).toHaveCount(0);
    } else {
      await expect(pending.first()).toBeVisible();
      await expect(pending.first()).toContainText("Summary pending");
      await expect(prose).toHaveCount(0);
      await expect(digest).toHaveCount(0);
    }

    if (hasPending) {
      await expect(disclaimer).toHaveCount(0);
    } else {
      await expect(disclaimer).toBeVisible();
      await expect(disclaimer.locator(".i18n-ja")).toContainText("AI による自動生成");
      await expect(disclaimer.locator(".i18n-en")).toContainText("AI-generated");
    }
  });

  test("detail copy action writes the title and one URL", async ({ page, context }) => {
    await page.goto("/");
    const firstEntryLink = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(firstEntryLink).toBeVisible();
    await firstEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const copyAction = page.locator("button.ed-share-btn[data-share-copy]");
    const title = (await copyAction.getAttribute("data-title"))?.trim() ?? "";
    const url = (await copyAction.getAttribute("data-url"))?.trim() ?? "";
    expect(title).toBeTruthy();
    expect(url).toMatch(/^https?:\/\//);
    await expect(page.locator("#ed-toast")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#ed-toast")).toHaveAttribute("aria-atomic", "true");
    await copyAction.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${title}\n${url}`);
  });

  test("mobile detail gives the original article a clear full-width action", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const detailHref = await page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first().getAttribute("href");
    expect(detailHref, "home should link to at least one detail page").toBeTruthy();

    for (const width of [390, 621, 720]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(detailHref!);

      const actionStrip = page.locator(".ed-action-strip");
      const sourceCta = actionStrip.locator(".ed-header-cta");
      const copyAction = actionStrip.locator(".ed-share-btn[data-share-copy]");
      await expect(sourceCta).toHaveCount(1);
      await expect(copyAction).toHaveCount(1);
      await expect(sourceCta.locator("small")).toHaveText(/^[a-z0-9.-]+(?::\d+)?$/i);

      const geometry = await page.evaluate(() => {
        const strip = document.querySelector(".ed-action-strip")?.getBoundingClientRect();
        const source = document.querySelector(".ed-header-cta")?.getBoundingClientRect();
        const copy = document.querySelector(".ed-share-btn[data-share-copy]")?.getBoundingClientRect();
        return {
          stripWidth: strip?.width ?? 0,
          sourceWidth: source?.width ?? 0,
          sourceHeight: source?.height ?? 0,
          stripLeft: strip?.left ?? 0,
          stripRight: strip?.right ?? 0,
          copyWidth: copy?.width ?? 0,
          copyHeight: copy?.height ?? 0,
          copyLeft: copy?.left ?? 0,
          copyRight: copy?.right ?? 0,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(geometry.sourceWidth).toBeGreaterThanOrEqual(geometry.stripWidth - 1);
      expect(geometry.copyWidth).toBeGreaterThanOrEqual(geometry.stripWidth - 40);
      expect(geometry.copyWidth).toBeLessThan(geometry.stripWidth - 20);
      expect(geometry.copyLeft).toBeGreaterThan(geometry.stripLeft + 14);
      expect(geometry.copyRight).toBeLessThan(geometry.stripRight - 14);
      expect(geometry.sourceHeight).toBeGreaterThanOrEqual(52);
      expect(geometry.copyHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.overflow).toBeLessThanOrEqual(0);
      await expect(page.locator(".ed-freshness, .rail-freshness")).toHaveCount(0);
    }
  });

  test("pending detail keeps the source action available without collection freshness", async ({ page }) => {
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

    await expect(pending).toBeVisible();
    await expect(pending.locator(".i18n-ja").first()).toHaveText("AI 要約 準備待ち");
    await expect(pending.locator(".i18n-en").first()).toHaveText("Summary pending");
    await expect(pending).not.toContainText("近日中に AI が生成");
    await expect(page.locator(".ed-disclaim")).toHaveCount(0);
    await expect(page.locator(".ed-header-cta")).toHaveCount(1);
    await expect(page.locator(".ed-share-btn[data-share-copy]")).toHaveCount(1);
    await expect(page.locator(".ed-freshness, .rail-freshness")).toHaveCount(0);
    await expect(page.locator('article.entry-detail a[target="_blank"]')).toHaveCount(1);
    await expect(page.locator('article.entry-detail a[target="_blank"]').first()).toHaveAttribute(
      "href", /^(?!\/e\/).+/,
    );
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
      // Decorative tile text is generated by CSS so it does not pollute the
      // link's accessible name.
      const icon = ((await item.locator(".brand-tile").getAttribute("data-initial")) ?? "").trim();
      expect(icon.length, `category ${i} has a compact icon tile`).toBeGreaterThan(0);
      expect(icon.length, `category ${i} icon tile stays compact`).toBeLessThanOrEqual(3);
      const label = (await item.locator(".name-marquee").innerText()).trim();
      const entryCount = (await item.locator(".count").innerText()).trim().replace(/\s+/g, " ");
      await expect(item).not.toHaveAttribute("aria-label");
      await expect(item).toHaveAccessibleName(`${label} ${entryCount}`);
      labels.push(label);
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
    await page.setViewportSize({ width: 390, height: 844 });
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
    for (const button of [jaBtn, enBtn]) {
      const box = await button.boundingBox();
      expect(box, "language toggle has a rendered box").not.toBeNull();
      expect(box!.width, "language toggle meets the mobile target width").toBeGreaterThanOrEqual(44);
      expect(box!.height, "language toggle meets the mobile target height").toBeGreaterThanOrEqual(44);
    }
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
    if (!fallbackEntry) {
      // The generated corpus can validly be fully bilingual. The fallback
      // helper contract remains covered independently in web-data tests.
      expect(fallbackEntry, "a fully bilingual generated corpus is valid").toBeUndefined();
      return;
    }

    await page.goto(`/e/${fallbackEntry.name}/`);
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
    const authorityMeta = page.locator('meta[data-pagefind-filter="authority[content]"]');
    await expect(authorityMeta).toHaveCount(1);
    await expect(authorityMeta).toHaveAttribute(
      "content",
      /^(official|paper|community|news|aggregator|source)$/,
    );
    const authorityPill = page.locator("[data-source-authority]").first();
    await expect(authorityPill).toBeVisible();
    await expect(authorityPill).toContainText(/公式|論文|コミュニティ|報道|集約|出典/);
  });

  test("home keeps the decision path compact at tablet width", async ({ page }) => {
    const fullLabel = "Microsoft Foundry Engineering and AI Platform Updates";
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto("/");
    await expect(page.locator(".banner-right")).toBeHidden();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.locator(".featured-src").evaluate((source) => {
      const fullLabel = "Microsoft Foundry Engineering and AI Platform Updates";
      const label = source.querySelector("[data-source-disclosure-label]");
      if (label) label.textContent = fullLabel;
      const full = source.querySelector("[data-source-disclosure-full]");
      if (full) full.textContent = fullLabel;
    });

    const featuredDisclosure = page.locator(".featured-src.source-disclosure");
    const featuredTrigger = featuredDisclosure.locator("[data-source-disclosure-trigger]");
    const featuredTabletTarget = await featuredTrigger.boundingBox();
    expect(featuredTabletTarget, "tablet Featured source disclosure target should exist").not.toBeNull();
    expect(featuredTabletTarget!.width).toBeGreaterThanOrEqual(44);
    expect(featuredTabletTarget!.height).toBeGreaterThanOrEqual(44);
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
    await featuredTrigger.focus();
    await expect(featuredTrigger).toBeFocused();
    const focusStyle = await featuredTrigger.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        color: style.outlineColor,
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focusStyle.style).not.toBe("none");
    expect(focusStyle.width).toBeGreaterThanOrEqual(2);
    expect(focusStyle.color).not.toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Enter");
    await expect(featuredDisclosure).toHaveAttribute("open", "");
    await expect(featuredDisclosure.locator(".source-disclosure-panel")).toBeVisible();
    await expect(featuredDisclosure.locator("[data-source-disclosure-full]")).toHaveText(fullLabel);
    await page.keyboard.press("Enter");
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(featuredDisclosure).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");

    const rankedDisclosure = page.locator(".rank-source.source-disclosure").first();
    const rankedTrigger = rankedDisclosure.locator("[data-source-disclosure-trigger]");
    const rankedTabletTarget = await rankedTrigger.boundingBox();
    expect(rankedTabletTarget, "tablet ranked source disclosure target should exist").not.toBeNull();
    expect(rankedTabletTarget!.width).toBeGreaterThanOrEqual(44);
    expect(rankedTabletTarget!.height).toBeGreaterThanOrEqual(44);
    const rankedFullLabel = (
      await rankedDisclosure.locator("[data-source-disclosure-label]").textContent()
    )?.trim();
    expect(rankedFullLabel).toBeTruthy();
    await rankedTrigger.click();
    await expect(rankedDisclosure).toHaveAttribute("open", "");
    const rankedPanel = rankedDisclosure.locator(".source-disclosure-panel");
    await expect(rankedPanel).toBeVisible();
    await expect(rankedDisclosure.locator("[data-source-disclosure-full]")).toHaveText(
      rankedFullLabel ?? "",
    );
    const rankedPanelPosition = await rankedPanel.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return {
        centerX: rect.left + rect.width / 2,
        bottomGap: window.innerHeight - rect.bottom,
        viewportCenterX: window.innerWidth / 2,
      };
    });
    expect(
      Math.abs(rankedPanelPosition.centerX - rankedPanelPosition.viewportCenterX),
      "tablet ranked disclosure should stay horizontally viewport-centered",
    ).toBeLessThanOrEqual(1);
    expect(rankedPanelPosition.bottomGap, "tablet ranked disclosure should keep its viewport bottom offset")
      .toBeGreaterThanOrEqual(53);
    expect(rankedPanelPosition.bottomGap, "tablet ranked disclosure should keep its viewport bottom offset")
      .toBeLessThanOrEqual(55);
    await rankedTrigger.click();
    await expect(rankedDisclosure).not.toHaveAttribute("open", "");

    for (const lang of ["ja", "en"] as const) {
      await page.locator(`.lang-btn[data-lang="${lang}"]`).click();
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const metrics = await page.evaluate(() => {
        const banner = document.querySelector(".banner-inner")?.getBoundingClientRect();
        const main = document.querySelector(".layout main")?.getBoundingClientRect();
        const topRank = document.querySelector(".top-rank")?.getBoundingClientRect();
        const footer = document.querySelector(".footer-bar")?.getBoundingClientRect();
        const featuredMeta = document.querySelector(".featured-meta")?.getBoundingClientRect();
        const featuredSource = document.querySelector<HTMLElement>(
          ".featured-src .source-disclosure-label",
        );
        const sourceLabels = Array.from(
          document.querySelectorAll<HTMLDetailsElement>(".featured-src.source-disclosure, .rank-source.source-disclosure"),
        );
        return {
          bannerHeight: banner?.height ?? Number.POSITIVE_INFINITY,
          mainY: main?.y ?? Number.POSITIVE_INFINITY,
          topRankBottom: topRank?.bottom ?? Number.POSITIVE_INFINITY,
          visibleBottom: Math.min(window.innerHeight, footer?.top ?? window.innerHeight),
          footerHeight: footer?.height ?? Number.POSITIVE_INFINITY,
          featuredMetaHeight: featuredMeta?.height ?? Number.POSITIVE_INFINITY,
          featuredSourceClipped: !!featuredSource
            && featuredSource.scrollWidth > featuredSource.clientWidth
            && getComputedStyle(featuredSource).textOverflow === "ellipsis",
          sourceLabelsRecoverable: sourceLabels.length > 0
            && sourceLabels.every((root) => {
              const visible = root.querySelector("[data-source-disclosure-label]")?.textContent?.trim();
              const full = root.querySelector("[data-source-disclosure-full]")?.textContent?.trim();
              return root.getAttribute("title") === null && !!visible && visible === full;
            }),
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(metrics.bannerHeight).toBeLessThanOrEqual(320);
      expect(metrics.mainY).toBeLessThanOrEqual(500);
      expect(metrics.footerHeight, `${lang}: tablet footer stays on one line`).toBeLessThanOrEqual(36);
      expect(metrics.featuredMetaHeight, `${lang}: tablet Featured metadata stays within two rows`).toBeLessThanOrEqual(50);
      expect(metrics.featuredSourceClipped, `${lang}: long Featured source labels use ellipsis instead of adding rows`).toBe(true);
      expect(metrics.sourceLabelsRecoverable, `${lang}: truncated source labels expose their full value`).toBe(true);
      expect(metrics.topRankBottom, `${lang}: tablet ranked Top-3 keeps a safe gap above the fixed footer`).toBeLessThanOrEqual(
        metrics.visibleBottom - 8,
      );
      expect(metrics.overflow, `${lang}: page should not overflow horizontally`).toBeLessThanOrEqual(0);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileTarget = await featuredTrigger.boundingBox();
    expect(mobileTarget, "mobile source disclosure target should exist").not.toBeNull();
    expect(mobileTarget!.width, "mobile source disclosure target should be at least 44px wide").toBeGreaterThanOrEqual(44);
    expect(mobileTarget!.height, "mobile source disclosure target should be at least 44px high").toBeGreaterThanOrEqual(44);
    await featuredTrigger.click();
    await expect(featuredDisclosure).toHaveAttribute("open", "");
    await expect(featuredDisclosure.locator(".source-disclosure-panel")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await featuredTrigger.click();
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
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
    const contentStart = page.locator("#content-start");
    await expect(contentStart).toBeFocused();
    await expect(contentStart).not.toHaveAttribute("aria-label");
  });

  test("status page renders worker and source health", async ({ page }) => {
    await page.goto("/status/");

    await expect(page.locator(".page-hero #status-heading")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Worker Health/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Source Freshness/i })).toBeVisible();
    const workerHealthSection = page.locator(".status-hero");
    await expect(workerHealthSection).toHaveAttribute("aria-labelledby", "worker-health-heading");
    await expect(workerHealthSection).toHaveAttribute("aria-describedby", "worker-health-summary");
    await expect(page.locator("#worker-health-summary")).not.toBeEmpty();
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
    await expect(footerRunLink).toHaveAttribute("aria-label", /collection health: run (ok|warn|err).*summary queue \d+/i);
    const footerDot = footerRunLink.locator(".dot");
    await expect(footerDot).toHaveAttribute("data-run-tone", expectedTone);
    await expect(footerDot).toHaveClass(new RegExp(`\\bdot\\b.*\\b${expectedTone}\\b`));
    await expect(footerRunLink.locator(".mono")).toContainText(/last batch \d+\/\d+ src · summary queue \d+/);
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
    const attentionRows = page.locator("#attention-list .status-attention-list li");
    const attentionCount = await attentionRows.count();
    for (let index = 0; index < attentionCount; index++) {
      const row = attentionRows.nth(index);
      const status = await row.getAttribute("data-source-status");
      expect(status).toMatch(/^(error|stale)$/);
      const link = row.locator("a");
      const describedBy = await link.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      await expect(page.locator(`[id="${describedBy}"]`)).toContainText(status!);
    }

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

    const directoryFlow = await directory.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { position: getComputedStyle(element).position, top: rect.top };
    });
    expect(directoryFlow.position, "category directory remains in document flow").toBe("static");
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, 900);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    const directoryScrolledTop = await directory.evaluate((element) => element.getBoundingClientRect().top);
    expect(
      directoryScrolledTop,
      "category directory scrolls away instead of following the viewport",
    ).toBeLessThan(directoryFlow.top - 500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

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

  test("category-owned panels scroll normally while primary sidebar stays sticky", async ({ page }) => {
    for (const width of [1440, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/c/copilot/");

      const panel = page.locator(".category-side-panel");
      const sidebar = page.locator("aside.left");
      await expect(panel, `category panel visible at ${width}px`).toBeVisible();
      await expect(sidebar, `primary sidebar visible at ${width}px`).toBeVisible();

      const before = await page.evaluate(() => {
        const panel = document.querySelector(".category-side-panel") as HTMLElement;
        const sidebar = document.querySelector("aside.left") as HTMLElement;
        const panelStyle = getComputedStyle(panel);
        const sidebarStyle = getComputedStyle(sidebar);
        return {
          panelPosition: panelStyle.position,
          panelTop: panel.getBoundingClientRect().top,
          panelHeight: panel.getBoundingClientRect().height,
          sidebarPosition: sidebarStyle.position,
          sidebarStickyTop: Number.parseFloat(sidebarStyle.top),
        };
      });
      expect(before.panelPosition, `category panel is not sticky at ${width}px`).toBe("static");
      expect(before.panelHeight, `category panel keeps its intrinsic height at ${width}px`).toBeLessThan(
        1200,
      );
      expect(before.sidebarPosition, `primary sidebar remains sticky at ${width}px`).toBe("sticky");

      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
        window.scrollTo(0, 900);
      });
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);

      const after = await page.evaluate(() => {
        const panel = document.querySelector(".category-side-panel") as HTMLElement;
        const sidebar = document.querySelector("aside.left") as HTMLElement;
        return {
          panelTop: panel.getBoundingClientRect().top,
          sidebarTop: sidebar.getBoundingClientRect().top,
          hscroll: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(
        after.panelTop,
        `category panel leaves the viewport with its content at ${width}px`,
      ).toBeLessThan(before.panelTop - 500);
      expect(
        Math.abs(after.sidebarTop - before.sidebarStickyTop),
        `primary sidebar holds its sticky offset at ${width}px`,
      ).toBeLessThanOrEqual(2);
      expect(after.hscroll, `category detail has no horizontal overflow at ${width}px`).toBe(false);
    }
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
    const batchHeading = page.locator("[data-worker-batch-total]");
    const batchTotal = await batchHeading.getAttribute("data-worker-batch-total");
    expect(batchTotal).toBeTruthy();
    if (batchTotal !== "unknown") {
      await expect(batchHeading).toContainText(`${batchTotal} batch`);
      await page.goto("/status/");
      await expect(page.locator('[data-health-scope="latest-batch"] small')).toContainText(`/${batchTotal}`);
    } else {
      await expect(batchHeading).toContainText("multi-batch");
    }
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
    await desktopMenuButton.focus();
    const focusRing = await desktopMenuButton.evaluate((button) => {
      const style = getComputedStyle(button);
      return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(focusRing.style).not.toBe("none");
    expect(focusRing.width).toBeGreaterThanOrEqual(3);
    await desktopMenuButton.click();
    const menu = page.locator("#site-menu");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("open", "");
    expect(await menu.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
    await expect(desktopMenuButton).toHaveAttribute("aria-expanded", "true");
    // Primary explore shortcuts (Categories, arXiv, Knowledge) live in the
    // header switcher, never in the hamburger menu (LL-054 avoids duplicates).
    await expect(menu.getByRole("link", { name: /Categories/ })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: /Knowledge/ })).toHaveCount(0);
    await expect(menu.getByRole("link", { name: /Archive/ })).toBeVisible();
    await expect(menu.getByRole("link", { name: /About/ })).toBeVisible();
    await expect(menu.getByRole("button", { name: /Search/ })).toBeVisible();
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => {
          const dialog = document.querySelector("#site-menu");
          return Boolean(dialog?.contains(document.activeElement));
        }),
        `modal menu keeps focus on Tab step ${index + 1}`,
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(desktopMenuButton).toBeFocused();

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

  test("pagefind search returns category intent entries without implicit selection", async ({ page }) => {
    await page.goto("/");

    await page.locator("button[data-search-trigger]:visible").first().click();
    await expect(page.locator("#pagefind-search-input")).toBeFocused();
    await page.locator("#pagefind-search-input").pressSequentially("Copilot");
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-hit-type").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".search-results-heading")).toContainText("Results");
    await expect(page.locator(".search-hit-type").first()).toHaveText("CATEGORY");
    await expect(page.locator(".search-hit").first()).toHaveAttribute("href", "/c/copilot/");
    await expect(page.locator(".search-hit.is-active")).toHaveCount(0);
    await expect(page.locator("#pagefind-search-input")).not.toHaveAttribute("aria-activedescendant");
    await page.locator("#pagefind-search-input").press("ArrowDown");
    const firstHit = page.locator(".search-hit").first();
    await expect(firstHit).toHaveClass(/is-active/);
    await expect(page.locator("#pagefind-search-input")).toHaveAttribute(
      "aria-activedescendant",
      (await firstHit.getAttribute("id"))!,
    );

    await page.locator("#pagefind-search-input").fill("open source model");
    await expect(page.locator(".search-hit").first()).toHaveAttribute("href", "/c/local-llm/");
    await expect(page.locator(".search-hit-type").first()).toHaveText("CATEGORY");
    const categoryHrefs = await page.locator(".search-hit-category").evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    expect(categoryHrefs.some((href) => /\/page\/\d+\//.test(href))).toBe(false);
  });

  test("pagefind ranks article results by authority, importance, then recency", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"))
      .toBe(true);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      const result = (
        url: string,
        title: string,
        authority: string,
        importance: string,
        publishedDay: string,
      ) => ({
        data: async () => ({
          url,
          meta: { title },
          excerpt: `${title} explains agent operations.`,
          filters: { authority: [authority], importance: [importance], publishedDay: [publishedDay] },
        }),
      });
      pagefind.search = async () => ({
        results: [
          result("/categories/", "Agent categories", "source", "3", "2026-07-20"),
          result("/e/community-agent/", "Community agent guide", "community", "3", "2026-07-20"),
          result("/e/official-agent-old/", "Official high-importance reference", "official", "3", "2026-07-18"),
          result("/e/official-agent-new/", "Official low-importance update", "official", "1", "2026-07-20"),
        ],
      });
    });

    const opener = page.locator("button[data-search-trigger]:visible").first();
    await opener.click();
    const input = page.locator("#pagefind-search-input");
    await input.fill("agent");
    const hits = page.locator(".search-hit");
    await expect(hits).toHaveCount(4);
    expect(await hits.evaluateAll((items) => items.map((item) => item.getAttribute("aria-selected")))).toEqual([
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(await hits.locator(".search-hit-title").allTextContents()).toEqual([
      "Official high-importance reference",
      "Official low-importance update",
      "Community agent guide",
      "Agent categories",
    ]);
    await expect(hits.first().locator(".search-hit-meta")).toContainText("High importance");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/search\/\?q=agent$/);
  });

  test("pagefind progressively resolves exact articles beyond the first result batch", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"))
      .toBe(true);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      const approximate = Array.from({ length: 35 }, (_, index) => ({
        data: async () => ({
          url: `/t/unrelated-${index}/`,
          meta: { title: `Developer tools ${index}` },
          excerpt: "A nearby Pagefind match without the exact query.",
          filters: {},
        }),
      }));
      pagefind.search = async () => ({
        results: [
          ...approximate,
          {
            data: async () => ({
              url: "/e/exact-release/",
              meta: { title: "Exact release reference" },
              excerpt: "Exact release reference with stable provenance.",
              filters: {
                authority: ["official"],
                importance: ["3"],
                publishedDay: ["2026-07-20"],
              },
            }),
          },
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("release");
    await expect(page.locator(".search-hit-title")).toHaveText(["Exact release reference"]);
  });

  test("search route restores and synchronizes its shareable query", async ({ page }) => {
    await page.goto("/search/?q=Copilot");
    await expect(page.locator("#search-page-heading")).toHaveText(/Search/);
    const form = page.locator('header form.search[role="search"]');
    const input = form.locator('input[type="search"][name="q"]');
    await expect(form).toHaveAttribute("action", "/search/");
    await expect(form).toHaveAttribute("method", "get");
    await expect(input).toHaveValue("Copilot", { timeout: 10_000 });
    await expect(form).toHaveClass(/is-open/);
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });

    await input.fill("Claude");
    await expect(page).toHaveURL(/\/search\/\?q=Claude$/);
    await page.reload();
    await expect(input).toHaveValue("Claude", { timeout: 10_000 });
    await expect(form).toHaveClass(/is-open/);
  });

  test("search preserves typing that happens while Pagefind is loading", async ({ page }) => {
    await page.route("**/pagefind/pagefind.js", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.goto("/search/?q=MCP");
    const input = page.locator("#pagefind-search-input");
    await expect(input).toHaveValue("MCP");
    await input.fill("Copilot");
    await expect(page).toHaveURL(/\/search\/\?q=Copilot$/);
    await expect
      .poll(async () => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"))
      .toBe(true);
    await expect(input).toHaveValue("Copilot");
  });

  test("pagefind prioritizes category intent and hides internal category slugs", async ({ page }) => {
    await page.goto("/");
    await expect
      .poll(() => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"))
      .toBe(true);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      const result = (
        url: string,
        title: string,
        source: string,
        category: string,
      ) => ({
        data: async () => ({
          url,
          meta: { title },
          excerpt: `${title} gives a practical category overview.`,
          filters: {
            source: [source],
            category: [category],
            authority: ["official"],
            publishedDay: ["2026-07-20"],
          },
        }),
      });
      pagefind.search = async (query: string) => ({
        results: query === "benchmark"
          ? [
              result("/e/benchmark-article/", "Benchmark evaluation guide", "Lab", "research"),
              result("/c/research/", "Papers and Benchmarks", "", "research"),
            ]
          : [
              result("/e/local-model-article/", "Run a local model", "Ollama", "local-llm"),
              result("/c/local-llm/", "Local Models", "", "local-llm"),
            ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    const input = page.locator("#pagefind-search-input");
    await input.fill("local model");
    const hits = page.locator(".search-hit");
    await expect(hits).toHaveCount(2);
    await expect(hits.first()).toHaveAttribute("href", "/c/local-llm/");
    await expect(hits.nth(1).locator(".search-hit-meta")).toContainText("Local Models");
    await expect(hits.nth(1).locator(".search-hit-meta")).not.toContainText("local-llm");

    await input.fill("benchmark");
    await expect(hits).toHaveCount(2);
    await expect(hits.first()).toHaveAttribute("href", "/c/research/");
    await expect(hits.nth(1).locator(".search-hit-meta")).toContainText("Papers/Benchmarks");
    await expect(hits.nth(1).locator(".search-hit-meta")).not.toContainText("research");
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

  test("article detail explains source authority, importance denominator, and category standing", async ({ page }) => {
    await page.route("https://icons.duckduckgo.com/ip3/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#0f766e"/></svg>',
      });
    });
    await page.goto("/");
    const summarizedCard = page
      .locator("main article.card")
      .filter({ has: page.locator(".summary .s-text") })
      .first();
    const summarizedEntryLink = summarizedCard.locator('h3.title > a[href^="/e/"]');
    await expect(summarizedEntryLink).toBeVisible();
    await summarizedEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    const strip = page.locator(".ed-meta-strip");
    await expect(strip).toBeVisible();

    const bylineAuthority = page.locator(".ed-byline [data-source-authority]");
    await expect(bylineAuthority).toHaveCount(1);
    await expect(bylineAuthority).toBeVisible();
    await expect(bylineAuthority).toHaveAttribute(
      "data-source-type",
      /^(blog|release|changelog|paper|community)$/,
    );
    await expect(bylineAuthority).toContainText(
      /公式|論文|コミュニティ|報道|集約|出典/,
    );
    const bylineAuthorityBox = await bylineAuthority.boundingBox();
    expect(bylineAuthorityBox, "authority badge has visible geometry").not.toBeNull();
    expect(
      bylineAuthorityBox!.y,
      "authority is visible in the first viewport beside the source byline",
    ).toBeLessThan(720);
    const bylineFaviconBox = await page.locator(".ed-byline .ed-favicon").boundingBox();
    expect(bylineFaviconBox, "source favicon has visible geometry").not.toBeNull();
    expect(
      Math.max(bylineFaviconBox!.width, bylineFaviconBox!.height),
      "the 32px favicon endpoint is not upscaled beyond 16 CSS pixels",
    ).toBeLessThanOrEqual(16);

    const authorityPill = strip.locator("[data-source-authority]");
    await expect(authorityPill).toHaveCount(1);
    await expect(authorityPill).toHaveAttribute(
      "data-source-type",
      /^(blog|release|changelog|paper|community)$/,
    );
    await expect(authorityPill).toHaveAttribute(
      "aria-label",
      /^(Official|Paper|Community|News|Aggregator|Source) source \(.+\)( · registry tier \d+)?$/,
    );
    await expect(authorityPill).toHaveAttribute(
      "title",
      /^(Official|Paper|Community|News|Aggregator|Source) source \(.+\)( · registry tier \d+)?$/,
    );
    await expect(authorityPill.locator(".pill-authority-label")).toHaveCount(1);

    // Source average shows the last-30 denominator and explicit 1-3 scale.
    const srcAvg = strip.locator('li .v[aria-label*="last 30 listed entries"]');
    await expect(srcAvg).toHaveCount(1);
    await expect(srcAvg).toHaveAttribute("aria-label", /1=Info, 2=Medium, 3=High/);
    await expect(srcAvg).toContainText("/ 3");
    await expect(srcAvg).toContainText("1=Info · 2=Medium · 3=High");
    await expect(strip).toContainText(/件中、同等以上 \d+件/);
    const sourceCta = page.locator(".ed-header-cta");
    await expect(sourceCta).toHaveCount(1);
    await expect(sourceCta).toHaveAttribute("href", /^https?:\/\//);
    await expect(sourceCta.locator(".i18n-ja")).toHaveText("元記事を読む");
    await expect(sourceCta.locator("small")).not.toHaveText("");
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
    await page.setViewportSize({ width: 1440, height: 900 });

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

    // Every group exposes a source heading + at least one card. Cards keep one
    // uniform height, but only entries with a real image reserve a thumb slot.
    const allHeights: number[] = [];
    let imageCardCount = 0;
    let textOnlyCardCount = 0;
    for (let i = 0; i < groupCount; i++) {
      const group = groups.nth(i);
      await expect(group.locator("h2")).toBeVisible();
      const cards = group.locator(".kg-card");
      const cardCount = await cards.count();
      expect(cardCount, "each knowledge source group has at least one card").toBeGreaterThan(0);
      const structures = await cards.evaluateAll((nodes) =>
        nodes.map((card) => ({
          hasImageClass: card.classList.contains("has-image"),
          noImageClass: card.classList.contains("no-image"),
          hasThumb: card.querySelector(".kg-thumb") !== null,
        })),
      );
      for (const structure of structures) {
        if (structure.hasImageClass) imageCardCount++;
        if (structure.noImageClass) textOnlyCardCount++;
        expect(
          structure.hasImageClass || structure.noImageClass,
          `group ${i} card declares its media state`,
        ).toBe(true);
        expect(
          structure.hasThumb,
          `group ${i} thumbnail slot matches real image state`,
        ).toBe(structure.hasImageClass);
      }
      for (let c = 0; c < cardCount; c++) {
        const box = await cards.nth(c).boundingBox();
        if (box) allHeights.push(Math.round(box.height));
      }
    }
    // All knowledge cards must be the same height (uniform grid, image-agnostic).
    const uniqueHeights = [...new Set(allHeights)];
    expect(
      uniqueHeights,
      `all knowledge cards share one height, got ${JSON.stringify(uniqueHeights)}`,
    ).toEqual([152]);
    expect(imageCardCount, "Knowledge corpus includes real-image cards").toBeGreaterThan(0);
    expect(textOnlyCardCount, "Knowledge corpus includes text-only cards").toBeGreaterThan(0);

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

    const sourceLink = page.locator(".knowledge-source-list .knowledge-source-link").nth(1);
    const sourceHref = await sourceLink.getAttribute("href");
    expect(sourceHref, "Knowledge source link has a hash destination").toMatch(/^#kg-/);
    await sourceLink.click();
    await expect(page).toHaveURL(new RegExp(`${sourceHref}$`));
    const sourceTargetId = sourceHref!.slice(1);
    await expect
      .poll(() =>
        page.evaluate((targetId) => {
          const target = document.getElementById(targetId);
          const header = document.querySelector("header");
          if (!target || !header) return false;
          return target.getBoundingClientRect().top >= header.getBoundingClientRect().bottom + 8;
        }, sourceTargetId),
      )
      .toBe(true);
    const targetedGroup = page.locator(".knowledge-source-group").filter({
      has: page.locator(`[id="${sourceTargetId}"]`),
    });
    await expect(targetedGroup).toHaveCount(1);
    expect(
      await targetedGroup.evaluate((group) => getComputedStyle(group).boxShadow),
      "the selected Knowledge source group has a visible target state",
    ).not.toBe("none");

    await page.setViewportSize({ width: 768, height: 900 });
    const tabletCardHeights = await page.locator(".kg-card").evaluateAll((cards) => [
      ...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().height))),
    ]);
    expect(
      tabletCardHeights,
      `tablet Knowledge cards share one height, got ${JSON.stringify(tabletCardHeights)}`,
    ).toEqual([152]);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    // On mobile, Knowledge is a direct tab in the bottom tabbar (not in the
    // menu). Selecting it marks the Knowledge tab active, not the Menu trigger.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/knowledge/");
    const mobileCardGeometry = await page.locator(".kg-card").evaluateAll((cards) =>
      cards.map((card) => {
        const cardRect = card.getBoundingClientRect();
        const linkRect = (card.querySelector(".kg-card-link") as HTMLElement).getBoundingClientRect();
        const thumb = card.querySelector(".kg-thumb") as HTMLElement | null;
        const thumbRect = thumb?.getBoundingClientRect();
        const bodyRect = (card.querySelector(".kg-body") as HTMLElement).getBoundingClientRect();
        return {
          cardHeight: cardRect.height,
          hasThumb: thumbRect !== undefined,
          hasImageClass: card.classList.contains("has-image"),
          noImageClass: card.classList.contains("no-image"),
          thumbWidth: thumbRect?.width ?? 0,
          thumbHeight: thumbRect?.height ?? 0,
          centerDelta: thumbRect
            ? (thumbRect.top + thumbRect.bottom) / 2 - (cardRect.top + cardRect.bottom) / 2
            : 0,
          bodyOverlap: thumbRect ? thumbRect.right - bodyRect.left : 0,
          textWidthDelta: linkRect.width - bodyRect.width,
          textStartDelta: bodyRect.left - linkRect.left,
        };
      }),
    );
    expect(mobileCardGeometry.length, "mobile Knowledge cards are present").toBeGreaterThan(0);
    for (const geometry of mobileCardGeometry) {
      expect(geometry.cardHeight, "mobile Knowledge card keeps its uniform height").toBe(148);
      expect(geometry.hasThumb, "thumbnail slot matches real image state").toBe(
        geometry.hasImageClass,
      );
      if (geometry.hasThumb) {
        expect(
          Math.abs(geometry.thumbWidth - geometry.thumbHeight),
          "mobile thumbnail stays square",
        ).toBeLessThanOrEqual(1);
        expect(geometry.thumbWidth, "mobile thumbnail remains compact").toBeGreaterThanOrEqual(80);
        expect(
          geometry.thumbWidth,
          "mobile thumbnail does not become a full-height strip",
        ).toBeLessThanOrEqual(88);
        expect(
          Math.abs(geometry.centerDelta),
          "mobile thumbnail is vertically centered",
        ).toBeLessThanOrEqual(1);
        expect(
          geometry.bodyOverlap,
          "mobile thumbnail does not overlap card content",
        ).toBeLessThanOrEqual(0);
      } else {
        expect(geometry.noImageClass, "text-only card declares no-image state").toBe(true);
        expect(
          geometry.textWidthDelta,
          "text-only card body expands across the card",
        ).toBeLessThanOrEqual(2);
        expect(
          geometry.textStartDelta,
          "text-only card body starts at the card edge",
        ).toBeLessThanOrEqual(1);
      }
    }
    const imageCard = page.locator(".kg-card.has-image").first();
    await expect(imageCard, "image failure fixture remains available").toBeAttached();
    const imageHref = await imageCard.locator(".kg-card-link").getAttribute("href");
    expect(imageHref, "image card has a stable detail href").toBeTruthy();
    const stableImageCard = page.locator(".kg-card").filter({
      has: page.locator(`.kg-card-link[href="${imageHref}"]`),
    });
    const bodyWidthBefore = await stableImageCard.locator(".kg-body").evaluate((body) =>
      body.getBoundingClientRect().width,
    );
    await stableImageCard.locator(".kg-thumb img").dispatchEvent("error");
    await expect(stableImageCard).toHaveClass(/no-image/);
    await expect(stableImageCard.locator(".kg-thumb")).toHaveCount(0);
    const bodyWidthAfter = await stableImageCard.locator(".kg-body").evaluate((body) =>
      body.getBoundingClientRect().width,
    );
    expect(bodyWidthAfter, "failed image releases the thumbnail column").toBeGreaterThan(
      bodyWidthBefore,
    );
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

  test("Knowledge and detail likes hydrate, toggle idempotently, and roll back safely", async ({ page }) => {
    const stateById = new Map<string, { count: number; liked: boolean }>();
    const readBatches: string[][] = [];
    const mutations: Array<Record<string, unknown>> = [];
    const requestOrder: string[] = [];
    let identityRequests = 0;
    let failNextMutationStatus: 429 | 500 | "network" | undefined;
    let failNextMutationCode: "challenge_unavailable" | undefined;

    await page.addInitScript(() => {
      type ReactionTestWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        __TECHDB_REACTION_TURNSTILE_LABEL__?: string | null;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionTestWindow;
      const callbacks = new Map<string, (token: string) => void>();
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(callback) {
          callback();
        },
        render(container, options) {
          target.__TECHDB_REACTION_TURNSTILE_LABEL__ = container.getAttribute("aria-label");
          callbacks.set("reaction-test-widget", options.callback);
          return "reaction-test-widget";
        },
        execute(widgetId) {
          queueMicrotask(() => callbacks.get(widgetId)?.("test-turnstile-token"));
        },
        remove(widgetId) {
          callbacks.delete(widgetId);
        },
      };
    });

    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams
        .get("ids")
        ?.split(",")
        .filter(Boolean) ?? [];
      readBatches.push(ids);
      const reactions = ids.map((id) => {
        const snapshot = stateById.get(id) ?? { count: 7, liked: false };
        stateById.set(id, snapshot);
        return { id, ...snapshot };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reactions }),
      });
    });
    await mockReactionIdentity(page, () => {
      identityRequests += 1;
      requestOrder.push("identity");
    });
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      requestOrder.push("mutation");
      mutations.push(payload);
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (failNextMutationCode) {
        const code = failNextMutationCode;
        failNextMutationCode = undefined;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code,
              message: "Verification service unavailable",
            },
          }),
        });
        return;
      }
      if (failNextMutationStatus) {
        const status = failNextMutationStatus;
        failNextMutationStatus = undefined;
        if (status === "network") {
          await route.abort("failed");
          return;
        }
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: status === 429 ? "rate_limited" : "mutation_failed",
              message: status === 429 ? "Too many requests" : "Mutation failed",
            },
          }),
        });
        return;
      }

      const current = stateById.get(id) ?? { count: 0, liked: false };
      const liked = payload.liked === true;
      const next = {
        liked,
        count: Math.max(0, current.count + (current.liked === liked ? 0 : liked ? 1 : -1)),
      };
      stateById.set(id, next);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reaction: { id, ...next } }),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("[data-reaction-control]")).toHaveCount(0);
    await page.goto("/knowledge/");
    const cards = page.locator(".kg-card");
    const cardCount = await cards.count();
    expect(cardCount, "Knowledge exposes multiple likeable cards").toBeGreaterThan(1);
    const knowledgeExplainer = page.locator(".knowledge-reaction-note");
    await expect(knowledgeExplainer).toBeVisible();
    await expect(knowledgeExplainer.locator(".i18n-ja")).toContainText(
      "記事の保存・お気に入りではなく、Featured、Top 3、重要度、掲載順位には影響しません",
    );
    await expect(
      knowledgeExplainer.getByRole("link", { name: "仕組みとプライバシー" }),
    ).toBeVisible();
    await expect(page.locator("[data-reaction-button]:not(:disabled)")).toHaveCount(cardCount);
    const reactionLiveRegion = page.locator("#reaction-status-live");
    await expect(reactionLiveRegion).toHaveCount(1);
    await expect(reactionLiveRegion).toHaveAttribute("role", "status");
    await expect(reactionLiveRegion).toHaveAttribute("aria-live", "polite");
    await expect(reactionLiveRegion).toHaveAttribute("aria-atomic", "true");
    expect(readBatches.length, "count hydration uses bounded batches").toBe(
      Math.ceil(cardCount / 50),
    );
    expect(
      readBatches.every((batch) => batch.length > 0 && batch.length <= 50),
      "every count request stays within the API batch limit",
    ).toBe(true);

    const card = cards.first();
    const cardLink = card.locator(".kg-card-link");
    const detailHref = await cardLink.getAttribute("href");
    expect(detailHref, "Knowledge card links to an article detail").toBeTruthy();
    await expect(card.locator("a button")).toHaveCount(0);
    const control = card.locator("[data-reaction-control]");
    const button = control.locator("[data-reaction-button]");
    const count = control.locator("[data-reaction-count]");
    const cardTitleJa = (await card.locator(".kg-title .i18n-ja").innerText()).trim();
    const cardTitleEn = (await card.locator(".kg-title .i18n-en").innerText()).trim();
    const secondCard = cards.nth(1);
    const secondButton = secondCard.locator("[data-reaction-button]");
    const secondCardTitleJa = (
      await secondCard.locator(".kg-title .i18n-ja").innerText()
    ).trim();
    expect(secondCardTitleJa).not.toBe(cardTitleJa);
    await expect(button).toHaveAccessibleName(`いいね 記事: ${cardTitleJa} 7件`);
    await expect(secondButton).toHaveAccessibleName(`いいね 記事: ${secondCardTitleJa} 7件`);
    await expect(
      control.locator('.i18n-ja [data-reaction-article-prefix]'),
    ).toHaveAttribute("lang", "ja");
    await expect(
      control.locator('.i18n-en [data-reaction-article-prefix]'),
    ).toHaveAttribute("lang", "en");
    await expect(
      control.locator('.i18n-ja [data-reaction-article-title]'),
    ).toHaveAttribute(
      "lang",
      (await card.locator(".kg-title .i18n-ja").getAttribute("lang")) ?? "ja",
    );
    await expect(
      control.locator('.i18n-en [data-reaction-article-title]'),
    ).toHaveAttribute(
      "lang",
      (await card.locator(".kg-title .i18n-en").getAttribute("lang")) ?? "en",
    );
    const describedBy = (await button.getAttribute("aria-describedby"))?.split(/\s+/) ?? [];
    const contextId = describedBy.find((id) => id.endsWith("-context"));
    expect(contextId, "like button references its anonymous public reaction context").toBeTruthy();
    await expect(page.locator(`#${contextId}`)).toContainText(
      "匿名の公開いいねです。記事の保存・お気に入りではなく、Featured、Top 3、重要度、掲載順位には影響しません。",
    );
    await expect(control.locator("[data-reaction-visible-label] .i18n-ja")).toHaveText("いいね");
    await expect(control.locator("[data-reaction-visible-label] .i18n-en")).toBeHidden();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(count).toHaveText("7");
    const buttonBox = await button.boundingBox();
    expect(buttonBox?.width, "card like target is at least 44px wide").toBeGreaterThanOrEqual(44);
    expect(buttonBox?.height, "card like target is at least 44px high").toBeGreaterThanOrEqual(44);
    const readyCardInsets = await card.evaluate((node) => {
      const title = node.querySelector<HTMLElement>(".kg-title");
      const source = node.querySelector<HTMLElement>(".kg-src");
      return {
        title: title ? Number.parseFloat(getComputedStyle(title).paddingRight) : -1,
        source: source ? Number.parseFloat(getComputedStyle(source).paddingRight) : -1,
      };
    });
    expect(readyCardInsets, "a ready like control reserves its overlay width").toEqual({
      title: 70,
      source: 70,
    });
    await cardLink.focus();
    await expect(cardLink).toBeFocused();
    const cardLinkFocus = await cardLink.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
        offset: Number.parseFloat(style.outlineOffset),
      };
    });
    expect(cardLinkFocus.style, "Knowledge card links retain a solid keyboard focus indicator").toBe(
      "solid",
    );
    expect(cardLinkFocus.width, "Knowledge card focus ring is at least 2px wide").toBeGreaterThanOrEqual(
      2,
    );
    expect(cardLinkFocus.offset, "Knowledge card focus ring clears the card edge").toBeGreaterThanOrEqual(
      2,
    );
    await cardLink.hover();
    await expect
      .poll(() =>
        card.evaluate((node) => Math.round(new DOMMatrix(getComputedStyle(node).transform).m42)),
      )
      .toBe(-2);
    expect(
      await cardLink.evaluate((node) => getComputedStyle(node).transform),
      "the whole card moves as one interaction group",
    ).toBe("none");

    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(count).toHaveText("8");
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(control.locator("[data-reaction-status]")).toContainText("いいねしました。");
    expect(identityRequests, "identity is established once before the first mutation").toBe(1);
    expect(requestOrder.slice(0, 2)).toEqual(["identity", "mutation"]);
    expect(
      await page.evaluate(
        () =>
          (
            window as Window & {
              __TECHDB_REACTION_TURNSTILE_LABEL__?: string | null;
            }
          ).__TECHDB_REACTION_TURNSTILE_LABEL__,
      ),
      "Turnstile uses the active Japanese label",
    ).toBe("本人確認");

    await button.focus();
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(count).toHaveText("7");
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toBeFocused();

    failNextMutationStatus = 500;
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(count).toHaveText("8");
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(count).toHaveText("7");
    await expect(control.locator("[data-reaction-status]")).toContainText(
      "いいねを更新できませんでした。",
    );
    const reactionToast = page.locator("#reaction-error-toast");
    await expect(reactionToast).toBeVisible();
    await expect(reactionToast.locator("[data-reaction-toast-copy]")).toContainText(
      "いいねを更新できませんでした。",
    );
    await expect(reactionToast).not.toHaveAttribute("role", "status");
    await expect(reactionToast).not.toHaveAttribute("aria-live");
    await expect(reactionLiveRegion).toHaveText(
      "いいねを更新できませんでした。通信環境を確認して、もう一度お試しください。",
    );
    await expect(button).toBeFocused();
    await reactionToast.getByRole("button", { name: "通知を閉じる" }).click();
    await expect(reactionToast).toBeHidden();
    await expect(button).toBeFocused();

    failNextMutationStatus = 429;
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(count).toHaveText("7");
    await expect(control.locator("[data-reaction-status]")).toContainText(
      "操作が多すぎます。",
    );
    await expect(reactionToast).toBeVisible();
    await expect(reactionToast.locator("[data-reaction-toast-copy]")).toContainText(
      "操作が多すぎます。",
    );

    failNextMutationCode = "challenge_unavailable";
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(reactionToast.locator("[data-reaction-toast-copy]")).toContainText(
      "本人確認サービスを一時利用できません。",
    );

    expect(mutations.map((payload) => payload.liked)).toEqual([true, false, true, true, true]);
    expect(
      mutations.every(
        (payload) =>
          payload.turnstileToken === "test-turnstile-token" &&
          Object.keys(payload).sort().join(",") === "liked,turnstileToken",
      ),
      "each mutation carries only the desired state and one-time challenge token",
    ).toBe(true);

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(button).toHaveAccessibleName(`Like Article: ${cardTitleEn} 7 likes`);
    await expect(control.locator("[data-reaction-visible-label] .i18n-ja")).toBeHidden();
    await expect(control.locator("[data-reaction-visible-label] .i18n-en")).toHaveText("Like");
    await expect(control.locator("[data-reaction-status]")).toContainText(
      "The verification service is temporarily unavailable.",
    );
    await expect(reactionToast.locator("[data-reaction-toast-copy]")).toContainText(
      "The verification service is temporarily unavailable.",
    );
    await reactionToast.getByRole("button", { name: "Dismiss notification" }).click();

    await page.setViewportSize({ width: 768, height: 900 });
    await expect(knowledgeExplainer).toBeVisible();
    const tabletCardBox = await card.boundingBox();
    const tabletButtonBox = await button.boundingBox();
    expect(tabletCardBox?.height, "Knowledge card keeps its tablet height").toBeCloseTo(152, 1);
    expect(tabletButtonBox?.width, "tablet like target is at least 44px wide").toBeGreaterThanOrEqual(
      44,
    );
    expect(tabletButtonBox?.height, "tablet like target is at least 44px high").toBeGreaterThanOrEqual(
      44,
    );
    expect(
      tabletButtonBox && tabletCardBox
        ? tabletButtonBox.x >= tabletCardBox.x &&
            tabletButtonBox.x + tabletButtonBox.width <= tabletCardBox.x + tabletCardBox.width
        : false,
      "tablet like target stays within the Knowledge card",
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(knowledgeExplainer).toBeVisible();
    const cardBox = await card.boundingBox();
    const mobileButtonBox = await button.boundingBox();
    expect(cardBox?.height, "Knowledge card keeps its mobile height").toBeCloseTo(148, 1);
    expect(mobileButtonBox?.width, "mobile like target is at least 44px wide").toBeGreaterThanOrEqual(
      44,
    );
    expect(mobileButtonBox?.height, "mobile like target is at least 44px high").toBeGreaterThanOrEqual(
      44,
    );
    expect(
      mobileButtonBox && cardBox
        ? mobileButtonBox.x >= cardBox.x &&
            mobileButtonBox.x + mobileButtonBox.width <= cardBox.x + cardBox.width
        : false,
      "mobile like target stays within the Knowledge card",
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 375, height: 667 });
    await expect(knowledgeExplainer).toBeVisible();
    failNextMutationStatus = "network";
    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toBeFocused();
    await expect(reactionToast).toBeVisible();
    await expect(reactionToast.locator("[data-reaction-toast-copy]")).toContainText(
      "Check your connection",
    );
    expect(
      await page.evaluate(
        () =>
          (
            window as Window & {
              __TECHDB_REACTION_TURNSTILE_LABEL__?: string | null;
            }
          ).__TECHDB_REACTION_TURNSTILE_LABEL__,
      ),
      "Turnstile uses the active English label",
    ).toBe("Human verification");
    const [toastBox, tabbarBox] = await Promise.all([
      reactionToast.boundingBox(),
      page.locator(".mobile-tabbar").boundingBox(),
    ]);
    expect(toastBox, "reaction error toast has visible geometry").not.toBeNull();
    expect(tabbarBox, "mobile tabbar has visible geometry").not.toBeNull();
    expect(
      toastBox!.y + toastBox!.height,
      "reaction toast stays above the fixed mobile tabbar",
    ).toBeLessThanOrEqual(tabbarBox!.y + 1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await reactionToast.getByRole("button", { name: "Dismiss notification" }).click();

    await page.goto(detailHref!);
    const detailControl = page.locator(".ed-reaction-panel [data-reaction-control]");
    await expect(detailControl).toHaveCount(1);
    await expect(page.locator(".ed-action-strip [data-reaction-control]")).toHaveCount(0);
    await expect(page.locator(".ed-reaction-panel")).toBeVisible();
    const detailButton = detailControl.getByRole("button", { name: /Like/ });
    await expect(detailButton).toBeEnabled();
    await expect(detailButton).toHaveAttribute("aria-pressed", "false");
    await expect(detailControl.locator("[data-reaction-count]")).toHaveText("7");
    const detailButtonBox = await detailButton.boundingBox();
    expect(detailButtonBox?.width, "detail like target is at least 44px wide").toBeGreaterThanOrEqual(44);
    expect(detailButtonBox?.height, "detail like target is at least 44px high").toBeGreaterThanOrEqual(44);
    const reactionExplainer = page.locator("[data-reaction-explainer]");
    await expect(reactionExplainer).toBeVisible();
    await expect(reactionExplainer.locator("p > .i18n-en")).toContainText(
      "not saved articles or bookmarks",
    );
    const privacyLink = reactionExplainer.getByRole("link", {
      name: "How it works and privacy",
    });
    await expect(privacyLink).toHaveAttribute("href", "/about#reactions-privacy");
    const actionTargetHeights = await page.locator(".ed-action-strip a, .ed-action-strip button").evaluateAll(
      (nodes) =>
        nodes
          .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0)
          .map((node) => node.getBoundingClientRect().height),
    );
    expect(actionTargetHeights.length, "detail action strip exposes interactive targets").toBeGreaterThan(0);
    expect(
      actionTargetHeights.every((height) => height >= 44),
      `detail action targets stay at least 44px high: ${JSON.stringify(actionTargetHeights)}`,
    ).toBe(true);

    await privacyLink.click();
    await expect(page).toHaveURL(/\/about\/?#reactions-privacy$/);
    const privacyTarget = page.locator("#reactions-privacy");
    await expect(privacyTarget).toBeVisible();
    await expect
      .poll(async () => {
        const targetBox = await privacyTarget.boundingBox();
        const headerBox = await page.locator("header").boundingBox();
        return targetBox && headerBox ? targetBox.y - (headerBox.y + headerBox.height) : -1;
      })
      .toBeGreaterThanOrEqual(8);
    await expect(privacyTarget).toHaveCSS("border-color", /rgb/);
    await expect(page.locator('.page-hero-actions a[href="#reactions-privacy"]')).toHaveText(
      "Likes & privacy",
    );
  });

  test("a lost mutation response is reconciled as success from authoritative state", async ({
    page,
  }) => {
    const stateById = new Map<string, { count: number; liked: boolean }>();
    let targetId = "";
    let mutationApplied = false;
    let mutationRequests = 0;
    let reconciliationRequests = 0;

    await page.addInitScript(() => {
      type ReactionResponseLossWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionResponseLossWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-response-loss-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-response-loss-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });
    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams
        .get("ids")
        ?.split(",")
        .filter(Boolean) ?? [];
      if (mutationApplied && ids.length === 1 && ids[0] === targetId) {
        reconciliationRequests += 1;
      }
      const targetStillPending =
        mutationApplied &&
        ids.length === 1 &&
        ids[0] === targetId &&
        reconciliationRequests === 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.map((id) => ({
            id,
            ...(targetStillPending
              ? { count: 7, liked: false }
              : (stateById.get(id) ?? { count: 7, liked: false })),
          })),
        }),
      });
    });
    await mockReactionIdentity(page);
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      mutationRequests += 1;
      stateById.set(id, { count: 8, liked: true });
      mutationApplied = true;
      await route.abort("failed");
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    const button = control.locator("[data-reaction-button]");
    const count = control.locator("[data-reaction-count]");
    await expect(control).toHaveAttribute("data-state", "ready");
    targetId = (await control.getAttribute("data-entry-id")) ?? "";
    expect(targetId).toMatch(/^[a-f0-9]{16}$/);

    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(count).toHaveText("8");
    await expect(control.locator("[data-reaction-status]")).toHaveText("いいねしました。");
    await expect(page.locator("#reaction-status-live")).toHaveText("いいねしました。");
    await expect(page.locator("#reaction-error-toast")).toBeHidden();
    expect(mutationRequests).toBe(1);
    expect(reconciliationRequests).toBe(2);
  });

  test("a stale successful reconciliation cannot overwrite a newer like retry", async ({ page }) => {
    const stateById = new Map<string, { count: number; liked: boolean }>();
    let targetId = "";
    let mutationCount = 0;
    let releaseStaleRead!: () => void;
    let markStaleReadStarted!: () => void;
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const staleReadStarted = new Promise<void>((resolve) => {
      markStaleReadStarted = resolve;
    });

    await page.addInitScript(() => {
      type ReactionRaceWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionRaceWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-race-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-race-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });

    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams
        .get("ids")
        ?.split(",")
        .filter(Boolean) ?? [];
      if (
        targetId &&
        mutationCount === 1 &&
        ids.length === 1 &&
        ids[0] === targetId
      ) {
        markStaleReadStarted();
        await staleReadGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            reactions: [{ id: targetId, count: 7, liked: false }],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.map((id) => ({
            id,
            ...(stateById.get(id) ?? { count: 7, liked: false }),
          })),
        }),
      });
    });
    await mockReactionIdentity(page);
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      mutationCount += 1;
      if (mutationCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "mutation_failed", message: "Mutation failed" },
          }),
        });
        return;
      }

      const next = { count: 8, liked: true };
      stateById.set(id, next);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reaction: { id, ...next } }),
      });
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    const button = control.locator("[data-reaction-button]");
    const count = control.locator("[data-reaction-count]");
    await expect(control).toHaveAttribute("data-state", "ready");
    targetId = (await control.getAttribute("data-entry-id")) ?? "";
    expect(targetId).toMatch(/^[a-f0-9]{16}$/);

    await button.click();
    await staleReadStarted;
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(count).toHaveText("7");

    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(count).toHaveText("8");

    releaseStaleRead();
    await page.waitForTimeout(100);
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(count).toHaveText("8");
    await expect(page.locator("#reaction-error-toast")).toBeHidden();
    expect(mutationCount).toBe(2);
  });

  test("a stale successful reconciliation cannot revive controls after service shutdown", async ({
    page,
  }) => {
    let firstId = "";
    let secondId = "";
    let firstMutationFailed = false;
    let releaseStaleRead!: () => void;
    let markStaleReadStarted!: () => void;
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const staleReadStarted = new Promise<void>((resolve) => {
      markStaleReadStarted = resolve;
    });

    await page.addInitScript(() => {
      type ReactionShutdownWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionShutdownWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-shutdown-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-shutdown-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });

    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams
        .get("ids")
        ?.split(",")
        .filter(Boolean) ?? [];
      if (
        firstMutationFailed &&
        firstId &&
        ids.length === 1 &&
        ids[0] === firstId
      ) {
        markStaleReadStarted();
        await staleReadGate;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            reactions: [{ id: firstId, count: 8, liked: true }],
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.map((id) => ({ id, count: 7, liked: false })),
        }),
      });
    });
    await mockReactionIdentity(page);
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      if (id === firstId) {
        firstMutationFailed = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "mutation_failed", message: "Mutation failed" },
          }),
        });
        return;
      }

      expect(id).toBe(secondId);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "service_unavailable", message: "Unavailable" },
        }),
      });
    });

    await page.goto("/knowledge/");
    const controls = page.locator("[data-reaction-control]");
    expect(await controls.count()).toBeGreaterThanOrEqual(2);
    const firstControl = controls.nth(0);
    const secondControl = controls.nth(1);
    const firstButton = firstControl.locator("[data-reaction-button]");
    const secondButton = secondControl.locator("[data-reaction-button]");
    await expect(firstControl).toHaveAttribute("data-state", "ready");
    await expect(secondControl).toHaveAttribute("data-state", "ready");
    firstId = (await firstControl.getAttribute("data-entry-id")) ?? "";
    secondId = (await secondControl.getAttribute("data-entry-id")) ?? "";
    expect(firstId).toMatch(/^[a-f0-9]{16}$/);
    expect(secondId).toMatch(/^[a-f0-9]{16}$/);
    expect(secondId).not.toBe(firstId);

    await firstButton.click();
    await staleReadStarted;
    await expect(firstButton).toHaveAttribute("aria-busy", "false");

    await secondButton.click();
    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(page.locator(".knowledge-reaction-note")).toBeHidden();

    releaseStaleRead();
    await page.waitForTimeout(100);
    await expect(firstControl).toHaveAttribute("data-state", "unavailable");
    await expect(firstControl).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /いいね/ })).toHaveCount(0);
  });

  test("failed mutation reconciliation reports within one bounded deadline", async ({ page }) => {
    await page.addInitScript(() => {
      type ReactionDeadlineWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        __TECHDB_REACTION_RECONCILIATION_READS__?: number;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionDeadlineWindow;
      const nativeFetch = window.fetch.bind(window);
      let mutationAttempted = false;
      let turnstileCallback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.__TECHDB_REACTION_RECONCILIATION_READS__ = 0;
      target.turnstile = {
        ready(callback) {
          callback();
        },
        render(_container, options) {
          turnstileCallback = options.callback;
          return "reaction-deadline-widget";
        },
        execute() {
          queueMicrotask(() => turnstileCallback?.("reaction-deadline-token"));
        },
        remove() {
          turnstileCallback = undefined;
        },
      };
      window.fetch = async (input, init = {}) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        const url = new URL(requestUrl, window.location.origin);
        if (!url.pathname.startsWith("/api/reactions")) {
          return nativeFetch(input, init);
        }
        if (url.pathname === "/api/reactions/identity") {
          return new Response(JSON.stringify({ identity: { ready: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (init.method === "PUT") {
          mutationAttempted = true;
          throw new TypeError("mutation response lost");
        }

        const ids = url.searchParams.get("ids")?.split(",").filter(Boolean) ?? [];
        if (mutationAttempted && ids.length === 1) {
          target.__TECHDB_REACTION_RECONCILIATION_READS__ =
            (target.__TECHDB_REACTION_RECONCILIATION_READS__ ?? 0) + 1;
          return new Promise<Response>((_resolve, reject) => {
            const rejectAborted = () => reject(new DOMException("Aborted", "AbortError"));
            if (init.signal?.aborted) rejectAborted();
            else init.signal?.addEventListener("abort", rejectAborted, { once: true });
          });
        }
        return new Response(
          JSON.stringify({
            reactions: ids.map((id) => ({ id, count: 7, liked: false })),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      };
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    const button = control.locator("[data-reaction-button]");
    const toast = page.locator("#reaction-error-toast");
    await expect(control).toHaveAttribute("data-state", "ready");

    const startedAt = Date.now();
    await button.click();
    await expect(toast).toBeVisible({ timeout: 7_000 });
    expect(
      Date.now() - startedAt,
      "reconciliation uses one deadline instead of stacking request timeouts",
    ).toBeLessThan(6_500);
    await expect(control.locator("[data-reaction-status]")).toContainText(
      "いいねを更新できませんでした。",
    );
    const reads = await page.evaluate(
      () =>
        (
          window as Window & {
            __TECHDB_REACTION_RECONCILIATION_READS__?: number;
          }
        ).__TECHDB_REACTION_RECONCILIATION_READS__ ?? 0,
    );
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThanOrEqual(4);
  });

  test("large like counts stay compact without losing the exact accessible value", async ({ page }) => {
    await page.addInitScript(() => {
      (window as Window & { __TECHDB_REACTION_SITE_KEY__?: string })
        .__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
    });
    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.filter(Boolean).map((id) => ({
            id,
            liked: false,
            count: 999_999,
          })),
        }),
      });
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    await expect(control).toHaveAttribute("data-state", "ready");
    await expect(control.locator("[data-reaction-count]")).toHaveText("1M");
    await expect(control.locator("[data-reaction-count-exact]")).toHaveText("999,999件");
    await expect(control.getByRole("button")).toHaveAccessibleName(/999,999件/);

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(control.locator("[data-reaction-count]")).toHaveText("1M");
    await expect(control.locator("[data-reaction-count-exact]")).toHaveText("999,999 likes");
    await expect(control.getByRole("button")).toHaveAccessibleName(/999,999 likes/);
  });

  test("like controls fail closed without public configuration or API availability", async ({ page }) => {
    let apiRequests = 0;
    await page.route("**/api/reactions?*", async (route) => {
      apiRequests += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "service_not_configured", message: "Unavailable" },
        }),
      });
    });

    await page.goto("/knowledge/");
    const controls = page.locator("[data-reaction-control]");
    const controlCount = await controls.count();
    expect(controlCount, "Knowledge exposes reaction controls").toBeGreaterThan(0);
    const unavailableControl = controls.first();
    const unavailableButton = unavailableControl.locator("[data-reaction-button]");
    await expect(unavailableControl).toHaveAttribute("data-state", "unavailable");
    await expect(unavailableControl).toHaveAttribute("aria-hidden", "true");
    await expect(unavailableControl).toBeHidden();
    await expect(unavailableButton).toBeDisabled();
    await expect(page.getByRole("button", { name: /いいね/ })).toHaveCount(0);
    await expect(page.locator(".knowledge-reaction-note")).toBeHidden();
    expect(apiRequests, "missing public site key prevents API traffic").toBe(0);

    const unavailableCard = unavailableControl.locator("xpath=ancestor::article[1]");
    const unavailableCardInsets = await unavailableCard.evaluate((node) => {
      const title = node.querySelector<HTMLElement>(".kg-title");
      const source = node.querySelector<HTMLElement>(".kg-src");
      return {
        title: title ? Number.parseFloat(getComputedStyle(title).paddingRight) : -1,
        source: source ? Number.parseFloat(getComputedStyle(source).paddingRight) : -1,
      };
    });
    expect(
      unavailableCardInsets,
      "an unavailable optional control releases the card title and source width",
    ).toEqual({ title: 0, source: 0 });
    const unavailableHref = await unavailableCard.locator(".kg-card-link").getAttribute("href");
    expect(unavailableHref, "unavailable card still has its article destination").toBeTruthy();
    await unavailableCard.locator(".kg-card-link").click();
    await page.waitForURL((url) => url.pathname === unavailableHref);

    await page.addInitScript(() => {
      (window as Window & { __TECHDB_REACTION_SITE_KEY__?: string })
        .__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
    });
    await page.goto("/knowledge/");
    await expect
      .poll(() => apiRequests, { message: "configured controls attempt count hydration" })
      .toBeGreaterThan(0);
    await expect(page.locator("[data-reaction-button]:disabled")).toHaveCount(controlCount);
    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /いいね/ })).toHaveCount(0);
    await expect(page.locator(".knowledge-reaction-note")).toBeHidden();
    expect(apiRequests, "a permanent count failure stops later hydration batches").toBe(1);
  });

  test("permanent reaction service failures remove controls without blocking article navigation", async ({ page }) => {
    let identityRequests = 0;
    let mutationRequests = 0;
    await page.addInitScript(() => {
      type ReactionFailureWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionFailureWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-permanent-failure-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-permanent-failure-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });
    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.filter(Boolean).map((id) => ({ id, liked: false, count: 7 })),
        }),
      });
    });
    await mockReactionIdentity(page, () => {
      identityRequests += 1;
    });
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      mutationRequests += 1;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "service_unavailable", message: "Unavailable" },
        }),
      });
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    const button = control.locator("[data-reaction-button]");
    const card = control.locator("xpath=ancestor::article[1]");
    const cardLink = card.locator(".kg-card-link");
    await expect(control).toHaveAttribute("data-state", "ready");
    await button.focus();
    await button.click();

    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(page.locator(".knowledge-reaction-note")).toBeHidden();
    await expect(page.getByRole("button", { name: /いいね/ })).toHaveCount(0);
    await expect(cardLink).toBeFocused();
    expect(identityRequests).toBe(1);
    expect(mutationRequests).toBe(1);

    const detailHref = await cardLink.getAttribute("href");
    expect(detailHref, "the unavailable control releases the article link").toBeTruthy();
    await cardLink.click();
    await page.waitForURL((url) => url.pathname === detailHref);
  });

  test("reconciliation service failure restores focus to the affected article link", async ({
    page,
  }) => {
    let mutationFailed = false;
    let reconciliationRequests = 0;
    await page.addInitScript(() => {
      type ReactionFailureWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionFailureWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-reconciliation-failure-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-reconciliation-failure-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });
    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
      if (mutationFailed && ids.length === 1) {
        reconciliationRequests += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "service_unavailable", message: "Unavailable" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.filter(Boolean).map((id) => ({ id, liked: false, count: 7 })),
        }),
      });
    });
    await mockReactionIdentity(page);
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      mutationFailed = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "mutation_failed", message: "Mutation failed" },
        }),
      });
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    const button = control.locator("[data-reaction-button]");
    const card = control.locator("xpath=ancestor::article[1]");
    const cardLink = card.locator(".kg-card-link");
    await expect(control).toHaveAttribute("data-state", "ready");
    await button.focus();
    await button.click();

    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(cardLink).toBeFocused();
    const reactionToast = page.locator("#reaction-error-toast");
    await expect(reactionToast).toBeVisible();
    await expect(reactionToast.locator("[data-reaction-toast-copy]")).toContainText(
      "いいね機能を一時的に利用できません。",
    );
    expect(reconciliationRequests).toBe(1);
  });

  test("stale batched hydration cannot restore controls after a permanent service failure", async ({
    page,
  }) => {
    let batchRequests = 0;
    let delayedBatchCompleted = false;
    let releaseDelayedBatch!: () => void;
    let markDelayedBatchStarted!: () => void;
    const delayedBatchGate = new Promise<void>((resolve) => {
      releaseDelayedBatch = resolve;
    });
    const delayedBatchStarted = new Promise<void>((resolve) => {
      markDelayedBatchStarted = resolve;
    });

    await page.addInitScript(() => {
      type ReactionGenerationWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionGenerationWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-generation-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-generation-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });
    await page.route("**/api/reactions?*", async (route) => {
      const requestNumber = ++batchRequests;
      const ids = new URL(route.request().url()).searchParams
        .get("ids")
        ?.split(",")
        .filter(Boolean) ?? [];
      if (requestNumber === 2) {
        markDelayedBatchStarted();
        await delayedBatchGate;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.map((id) => ({ id, liked: false, count: 7 })),
        }),
      });
      if (requestNumber === 2) delayedBatchCompleted = true;
    });
    await mockReactionIdentity(page);
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "service_unavailable", message: "Unavailable" },
        }),
      });
    });

    await page.goto("/knowledge/");
    const controls = page.locator("[data-reaction-control]");
    const controlCount = await controls.count();
    expect(controlCount, "the corpus exercises more than one hydration batch").toBeGreaterThan(50);
    const firstControl = controls.first();
    const firstButton = firstControl.locator("[data-reaction-button]");
    await expect(firstControl).toHaveAttribute("data-state", "ready");
    await delayedBatchStarted;

    await firstButton.click();
    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(page.locator(".knowledge-reaction-note")).toBeHidden();

    releaseDelayedBatch();
    await expect
      .poll(() => delayedBatchCompleted, { message: "the stale hydration request completed" })
      .toBe(true);
    await page.waitForTimeout(100);
    await expect(
      page.locator('[data-reaction-control][data-state="unavailable"]'),
    ).toHaveCount(controlCount);
    await expect(page.locator('[data-reaction-control][data-state="ready"]')).toHaveCount(0);
    await expect(page.locator("[data-reaction-control]:visible")).toHaveCount(0);
    await expect(page.locator(".knowledge-reaction-note")).toBeHidden();
  });

  test("anonymous identity bootstrap is serialized across same-origin tabs", async ({ page, context }) => {
    let activeIdentityRequests = 0;
    let maxActiveIdentityRequests = 0;
    let identityRequests = 0;
    let mutationRequests = 0;
    const stateById = new Map<string, { count: number; liked: boolean }>();

    await context.addInitScript(() => {
      type ReactionLockWindow = Window & {
        __TECHDB_REACTION_SITE_KEY__?: string;
        turnstile?: {
          ready(callback: () => void): void;
          render(
            container: HTMLElement,
            options: { callback: (token: string) => void },
          ): string;
          execute(widgetId: string): void;
          remove(widgetId: string): void;
        };
      };
      const target = window as ReactionLockWindow;
      let callback: ((token: string) => void) | undefined;
      target.__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
      target.turnstile = {
        ready(readyCallback) {
          readyCallback();
        },
        render(_container, options) {
          callback = options.callback;
          return "reaction-lock-widget";
        },
        execute() {
          queueMicrotask(() => callback?.("reaction-lock-token"));
        },
        remove() {
          callback = undefined;
        },
      };
    });
    await context.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.filter(Boolean).map((id) => ({
            id,
            ...(stateById.get(id) ?? { count: 7, liked: false }),
          })),
        }),
      });
    });
    await context.route("**/api/reactions/identity", async (route) => {
      identityRequests += 1;
      activeIdentityRequests += 1;
      maxActiveIdentityRequests = Math.max(
        maxActiveIdentityRequests,
        activeIdentityRequests,
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
      activeIdentityRequests -= 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "Set-Cookie":
            `${REACTION_VOTER_COOKIE_NAME}=22222222-2222-4222-8222-222222222222; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
        body: JSON.stringify({ identity: { ready: true } }),
      });
    });
    await context.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      mutationRequests += 1;
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      const current = stateById.get(id) ?? { count: 7, liked: false };
      const next = current.liked ? current : { count: current.count + 1, liked: true };
      stateById.set(id, next);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reaction: { id, ...next } }),
      });
    });

    const secondPage = await context.newPage();
    await Promise.all([page.goto("/knowledge/"), secondPage.goto("/knowledge/")]);
    expect(
      await page.evaluate(() => "locks" in navigator),
      "Chromium exposes the Web Locks API used for same-origin identity serialization",
    ).toBe(true);
    const firstButton = page.locator("[data-reaction-button]").first();
    const secondButton = secondPage.locator("[data-reaction-button]").first();
    await expect(firstButton).toBeEnabled();
    await expect(secondButton).toBeEnabled();

    await Promise.all([firstButton.click(), secondButton.click()]);
    await expect(firstButton).toHaveAttribute("aria-busy", "false");
    await expect(secondButton).toHaveAttribute("aria-busy", "false");
    await expect(firstButton).toHaveAttribute("aria-pressed", "true");
    await expect(secondButton).toHaveAttribute("aria-pressed", "true");
    expect(identityRequests, "each tab confirms the shared cookie exactly once").toBe(2);
    expect(
      maxActiveIdentityRequests,
      "the Web Lock prevents concurrent identity bootstrap requests",
    ).toBe(1);
    expect(mutationRequests).toBe(2);
    await secondPage.close();
  });

  test("Turnstile script loading recovers on the next like attempt", async ({ page }) => {
    let scriptRequests = 0;
    let mutationRequests = 0;
    await page.addInitScript(() => {
      (window as Window & { __TECHDB_REACTION_SITE_KEY__?: string })
        .__TECHDB_REACTION_SITE_KEY__ = "1x00000000000000000000AA";
    });
    await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async (route) => {
      scriptRequests += 1;
      if (scriptRequests === 1) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: `
          (() => {
            let callback;
            window.turnstile = {
              ready(readyCallback) { readyCallback(); },
              render(_container, options) {
                callback = options.callback;
                return "retry-widget";
              },
              execute() { queueMicrotask(() => callback?.("retry-token")); },
              remove() {}
            };
          })();
        `,
      });
    });
    await page.route("**/api/reactions?*", async (route) => {
      const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          reactions: ids.filter(Boolean).map((id) => ({ id, liked: false, count: 7 })),
        }),
      });
    });
    await mockReactionIdentity(page);
    await page.route(REACTION_MUTATION_URL_RE, async (route) => {
      if (await rejectMutationWithoutIdentity(route)) return;
      mutationRequests += 1;
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reaction: { id, liked: true, count: 8 } }),
      });
    });

    await page.goto("/knowledge/");
    const control = page.locator("[data-reaction-control]").first();
    const button = control.locator("[data-reaction-button]");
    await expect(button).toBeEnabled();

    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(control.locator("[data-reaction-status]")).toContainText(
      "本人確認を完了できませんでした。",
    );
    await expect(page.locator("#reaction-error-toast")).toBeVisible();
    await expect(
      page.locator("#reaction-error-toast [data-reaction-toast-copy]"),
    ).toContainText("本人確認を完了できませんでした。");
    expect(scriptRequests).toBe(1);
    expect(mutationRequests).toBe(0);
    await expect(page.locator('script[data-techdb-turnstile-loader="true"]')).toHaveCount(0);

    await button.click();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(control.locator("[data-reaction-count]")).toHaveText("8");
    expect(scriptRequests).toBe(2);
    expect(mutationRequests).toBe(1);
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
