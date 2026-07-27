import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  effectiveTitleLanguage,
  summaryForLangWithFallback,
  type SummaryDisplayEntry,
} from "../../web/src/lib/summary-display.ts";
import {
  PRIVACY_CONSENT_STORAGE_KEY,
  parsePrivacyConsent,
  privacyConsentState,
} from "../../web/src/lib/privacy-consent.ts";
import { normalizeTagKey } from "../../web/src/lib/tag-normalize.ts";

const TIMELINE_ENTRY_LINK_SELECTOR = 'main article.card h3.title > a[href^="/e/"]';
const REACTION_MUTATION_URL_RE = /\/api\/reactions\/[a-f0-9]{16}$/;
type SummaryFixtureEntry = SummaryDisplayEntry & {
  id: string;
  lang?: "ja" | "en";
};
const REACTION_VOTER_COOKIE_NAME = "__Host-techdb_reaction_voter";
const MOBILE_FIRST_DECISION_MAX_Y = 340;
const LAYOUT_SUBPIXEL_EPSILON_PX = 0.01;
const PRODUCTION_ORIGIN = "https://techdb.studio344.net";

interface PrivacyPromptProbeOptions {
  storedValue: string | null;
  failStorageRead?: boolean;
  measureLayoutShift?: boolean;
}

async function routeProductionHostToPreview(
  page: Page,
  baseURL: string,
): Promise<void> {
  await page.route(`${PRODUCTION_ORIGIN}/**`, async (route) => {
    const source = new URL(route.request().url());
    const target = new URL(`${source.pathname}${source.search}`, baseURL);
    const response = await route.fetch({ url: target.href });
    await route.fulfill({ response });
  });
}

async function installPrivacyPromptProbe(
  page: Page,
  options: PrivacyPromptProbeOptions,
): Promise<void> {
  await page.addInitScript(
    ({ storedValue, failStorageRead, measureLayoutShift, storageKey }) => {
      window.localStorage.clear();
      if (storedValue !== null) {
        window.localStorage.setItem(storageKey, storedValue);
      }
      if (failStorageRead) {
        const getItem = Storage.prototype.getItem;
        Object.defineProperty(Storage.prototype, "getItem", {
          configurable: true,
          value(this: Storage, key: string) {
            if (key === storageKey) throw new Error("storage unavailable");
            return getItem.call(this, key);
          },
        });
      }

      const state = window as typeof window & {
        __privacyPromptFirstLayout?: {
          display: string;
          height: number;
          hidden: boolean;
          inert: boolean;
          rootState: string;
        };
        __privacyConsentCls?: number;
        __privacyConsentClsObserver?: PerformanceObserver;
      };
      let promptCaptureScheduled = false;
      const capturePrompt = () => {
        if (state.__privacyPromptFirstLayout || promptCaptureScheduled) return;
        const prompt = document.querySelector<HTMLElement>(".privacy-consent-prompt");
        if (!prompt?.querySelector("[data-consent-choice]")) return;
        promptCaptureScheduled = true;
        requestAnimationFrame(() => {
          const currentPrompt =
            document.querySelector<HTMLElement>(".privacy-consent-prompt");
          if (!currentPrompt) return;
          const rect = currentPrompt.getBoundingClientRect();
          state.__privacyPromptFirstLayout = {
            display: getComputedStyle(currentPrompt).display,
            height: rect.height,
            hidden: currentPrompt.hidden,
            inert: currentPrompt.hasAttribute("inert"),
            rootState:
              document.documentElement.dataset.privacyConsentPrompt ?? "",
          };
          promptObserver.disconnect();
        });
      };
      const promptObserver = new MutationObserver(capturePrompt);
      promptObserver.observe(document, {
        childList: true,
        subtree: true,
      });
      capturePrompt();

      if (measureLayoutShift && "PerformanceObserver" in window) {
        state.__privacyConsentCls = 0;
        const layoutShiftObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const shift = entry as PerformanceEntry & {
              hadRecentInput?: boolean;
              value?: number;
            };
            if (!shift.hadRecentInput && typeof shift.value === "number") {
              state.__privacyConsentCls =
                (state.__privacyConsentCls ?? 0) + shift.value;
            }
          }
        });
        layoutShiftObserver.observe({
          type: "layout-shift",
          buffered: true,
        } as PerformanceObserverInit);
        state.__privacyConsentClsObserver = layoutShiftObserver;
      }
    },
    {
      ...options,
      storageKey: PRIVACY_CONSENT_STORAGE_KEY,
    },
  );
}

async function collectStablePrivacyLayout(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    let previous = "";
    let stableFrames = 0;
    for (let frame = 0; frame < 20 && stableFrames < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const rect = (selector: string) => {
        const box = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        return box
          ? [box.x, box.y, box.width, box.height].map((value) => value.toFixed(2))
          : [];
      };
      const current = JSON.stringify({
        prompt: rect(".privacy-consent-prompt"),
        banner: rect(".banner"),
        ticker: rect(".ticker-bar"),
        layout: rect(".layout"),
      });
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
    }

    const state = window as typeof window & {
      __privacyPromptFirstLayout?: {
        display: string;
        height: number;
        hidden: boolean;
        inert: boolean;
        rootState: string;
      };
      __privacyConsentCls?: number;
      __privacyConsentClsObserver?: PerformanceObserver;
    };
    const observer = state.__privacyConsentClsObserver;
    if (observer) {
      for (const entry of observer.takeRecords()) {
        const shift = entry as PerformanceEntry & {
          hadRecentInput?: boolean;
          value?: number;
        };
        if (!shift.hadRecentInput && typeof shift.value === "number") {
          state.__privacyConsentCls = (state.__privacyConsentCls ?? 0) + shift.value;
        }
      }
      observer.disconnect();
    }
    const prompt = document.querySelector<HTMLElement>(".privacy-consent-prompt");
    const promptBox = prompt?.getBoundingClientRect();
    return {
      stable: stableFrames >= 3,
      cls:
        typeof state.__privacyConsentCls === "number"
          ? Number(state.__privacyConsentCls.toFixed(6))
          : null,
      firstLayout: state.__privacyPromptFirstLayout ?? null,
      promptVisible: Boolean(
        promptBox &&
          promptBox.width > 0 &&
          promptBox.height > 0 &&
          getComputedStyle(prompt).visibility !== "hidden",
      ),
      promptHidden: prompt?.hidden ?? true,
      promptInert: prompt?.hasAttribute("inert") ?? true,
      rootState:
        document.documentElement.dataset.privacyConsentPrompt ?? "",
      advertisingState:
        document.documentElement.dataset.advertisingConsent ?? "",
      overflow:
        document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

async function expectMobileFirstDecisionNearViewport(page: Page): Promise<void> {
  const featured = page.locator("article.featured").first();
  await expect(featured).toHaveClass(/is-visible/, { timeout: 5000 });
  await expect
    .poll(async () => Math.round((await featured.boundingBox())?.y ?? Number.POSITIVE_INFINITY), {
      message: "mobile first decision item remains near the first viewport",
    })
    .toBeLessThanOrEqual(MOBILE_FIRST_DECISION_MAX_Y);
}

async function expectPagefindReady(page: Page): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => typeof (window as any).__pagefind?.search === "function"),
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function expectResponsivePageHero(
  page: Page,
  path: string,
  topLevel = false,
): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
  const hero = page.locator(".page-hero").first();
  await expect(hero).toBeVisible();
  if (topLevel) {
    await expect(
      page.locator(".crumb-bar"),
      `${path} should not render breadcrumbs`,
    ).toHaveCount(0);
  }
  const desktopBox = await hero.boundingBox();
  expect(desktopBox, `${path} desktop hero box`).not.toBeNull();
  expect(
    desktopBox!.height,
    `${path} desktop hero has page-banner presence`,
  ).toBeGreaterThan(120);
  const innerBox = await hero.locator(".page-hero-inner").boundingBox();
  expect(innerBox, `${path} desktop hero inner box`).not.toBeNull();
  expect(Math.round(innerBox!.width), `${path} desktop hero inner width`).toBe(1280);
  if (topLevel) {
    await expect(hero, `${path} top-level hero class`).toHaveClass(
      /page-hero-top-level/,
    );
    const metricBoxes = await hero.locator(".page-hero-metric").evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().width)
    );
    expect(metricBoxes, `${path} top-level hero metric count`).toHaveLength(6);
    expect(
      Math.max(...metricBoxes) - Math.min(...metricBoxes),
      `${path} top-level metric widths match`,
    ).toBeLessThanOrEqual(1);
    const metricScopes = await hero.locator(".page-hero-metric").evaluateAll((items) =>
      items.map((item) => ({
        scope: item.getAttribute("data-metric-scope") ?? "",
        describedBy: item.getAttribute("aria-describedby") ?? "",
        detail:
          item.querySelector(".page-hero-metric-detail")?.textContent?.trim() ??
          "",
      }))
    );
    expect(
      metricScopes.every(
        (metric) =>
          metric.scope.length > 0 &&
          metric.describedBy.length > 0 &&
          metric.detail.length > 0,
      ),
      `${path} metrics expose a population or time-window definition`,
    ).toBe(true);
  }
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    )
    .toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      ),
  );
  await expect(hero).toBeVisible();
  const mobileBox = await hero.boundingBox();
  expect(mobileBox, `${path} mobile hero box`).not.toBeNull();
  expect(mobileBox!.height, `${path} mobile hero stays compact`).toBeLessThan(310);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    )
    .toBe(true);
}

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

async function routeReactionConfig(page: Page, body: unknown, status = 200): Promise<void> {
  await page.route("**/api/reactions/config", async (route) => {
    expect(route.request().method(), "reaction config health check uses GET").toBe("GET");
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

function reactionConfigCard(page: Page) {
  return page.locator('[data-health-scope="reaction-config"]');
}

test.describe("TECH Dashboard smoke", () => {
  test("unknown routes return a branded 404 with recovery paths", async ({ page }) => {
    const unknownRoutes = [
      "/e/0000000000000000/",
      "/c/does-not-exist/",
      "/t/nonexistenttagzz/",
    ];

    for (const route of unknownRoutes) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} returns HTTP 404`).toBe(404);
      await expect(page.locator("#not-found-heading")).toContainText("ページが見つかりません");
      await expect(page.locator("section.banner h1")).toHaveCount(0);
      await expect(page.locator("main.not-found-page")).toBeVisible();
      expect(await page.locator("main.not-found-page").getAttribute("aria-labelledby")).toBeNull();
      await expect(page.locator(".not-found-actions")).toHaveAttribute(
        "aria-labelledby",
        "not-found-recovery-heading",
      );
      await expect(page.locator("[data-recovery-action]")).toHaveCount(3);
      await expect(page.locator("[data-recovery-action='search']")).toHaveAttribute("href", "/search");
      await expect(page.locator("[data-recovery-action='archive']")).toHaveAttribute("href", "/archive");
      await expect(page.locator("[data-recovery-action='home']")).toHaveAttribute("href", "/");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }

    await page.locator(".lang-btn[data-lang='en']").click();
    await expect(page.locator("#not-found-heading .i18n-en")).toBeVisible();
    await expect(page.locator("#not-found-heading .i18n-en")).toHaveText("Page not found");
    await expect(page.locator("#not-found-recovery-heading .i18n-en")).toHaveText("Choose where to continue");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("header .menu-trigger")).toBeHidden();
    await expect(page.locator(".mobile-tabbar")).toBeVisible();
    const mobileMetrics = await page.evaluate(() => {
      const actions = [...document.querySelectorAll<HTMLElement>("[data-recovery-action]")];
      const panel = document.querySelector<HTMLElement>(".not-found-panel");
      return {
        actionHeights: actions.map((action) => action.getBoundingClientRect().height),
        panelWidth: panel?.getBoundingClientRect().width ?? 0,
        viewportWidth: window.innerWidth,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(mobileMetrics.actionHeights).toHaveLength(3);
    expect(mobileMetrics.actionHeights.every((height) => height >= 44)).toBe(true);
    expect(mobileMetrics.panelWidth).toBeLessThanOrEqual(mobileMetrics.viewportWidth - 32);
    expect(mobileMetrics.overflow).toBeLessThanOrEqual(0);
  });

  test("home renders primary sections", async ({ page }) => {
    await page.goto("/");
    await page.setViewportSize({ width: 1440, height: 900 });

    await expect(page.getByRole("link", { name: /TECH Dashboard/i })).toBeVisible();
    await expect(page.locator("section.banner h1")).toHaveCount(1);
    await expect(page.locator("section.banner h1 > .i18n-ja")).toBeVisible();
    await expect(page.locator(".dynamic-orbit")).toBeVisible();
    await expect(page.locator(".signal-node")).toHaveCount(4);
    await expect(page.locator(".tb-slide.is-active").first()).toHaveAttribute("aria-hidden", "false");
    await expect(page.locator(".fallback-src-mark")).toHaveCount(0);
    const featuredHref = await page.locator("article.featured .featured-title a").getAttribute("href");
    const tickerHrefs = await page.locator(".ticker-bar .tb-slide").evaluateAll((slides) =>
      slides.map((slide) => slide.getAttribute("href")),
    );
    expect(featuredHref, "Featured exposes an article destination").toBeTruthy();
    expect(tickerHrefs, "Ticker does not repeat the Featured article").not.toContain(featuredHref);
    const tickerSourceCounts = await page.locator(".ticker-bar .tb-slide").evaluateAll((slides) => {
      const countBy = (attribute: string) => slides.reduce<Record<string, number>>((counts, slide) => {
        const key = slide.getAttribute(attribute) ?? "";
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {});
      return {
        sources: countBy("data-source-id"),
        platforms: countBy("data-source-platform"),
      };
    });
    expect(Math.max(0, ...Object.values(tickerSourceCounts.sources))).toBeLessThanOrEqual(2);
    expect(Math.max(0, ...Object.values(tickerSourceCounts.platforms))).toBeLessThanOrEqual(2);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /公式発表.*コミュニティ記事.*毎時 1 バッチ.*約 6 時間周期/,
    );
    await expect(page.locator(".banner .tagline.tagline-full.i18n-ja")).toContainText(/毎時 1 バッチ.*約 6 時間周期/);
    // Inactive ticker slides must be hidden from AT and unfocusable (LL-078).
    // When the current JST day has only one published entry there are no
    // inactive slides yet (data-freshness dependent, LL-082) — a valid state,
    // so only assert the hidden semantics when inactive slides actually exist.
    const inactiveSlides = page.locator(".tb-slide:not(.is-active)");
    if ((await inactiveSlides.count()) > 0) {
      await expect(inactiveSlides.first()).toHaveAttribute("aria-hidden", "true");
      await expect(inactiveSlides.first()).toHaveAttribute("tabindex", "-1");
    }
    await expect(page.locator(".tb-slide[data-summary-state='pending']")).toHaveCount(0);
    const tickerMetaWithTags = page.locator(".tb-meta").filter({ has: page.locator(".tb-tag") });
    if ((await tickerMetaWithTags.count()) > 0) {
      expect(
        await tickerMetaWithTags.first().locator(".tb-sep").count(),
        "ticker metadata separates category and compact type badges",
      ).toBeGreaterThan(0);
    }
    await expect(page.locator(".banner-fact")).toHaveCount(3);
    await expect(page.locator(".signal-node.node-source")).toContainText(/sources with live entries/i);
    await expect(page.locator(".banner-fact").filter({ hasText: "収録中ソース" })).toContainText(/registry sources with live entries/i);
    await expect(page.locator(".banner-fact").filter({ hasText: "Active registry sources" })).toContainText(/active registry sources/i);
    await expect(
      page.locator(".banner-fact").filter({ hasText: "更新頻度" }).locator(":scope > .i18n-ja"),
    ).toContainText(/毎時 1 バッチ収集.*最新 index/);
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
    // Timeline right rail uses ranked lists so dense data remains scannable.
    const homeRail = page.locator(".layout aside.right.home-right");
    await expect(homeRail).toBeVisible();
    await expect(homeRail.locator(".home-side-metrics")).toBeVisible();
    await expect(homeRail.locator('[data-rail-ranking="sources"]')).toBeVisible();
    await expect(homeRail.locator('[data-rail-ranking="topics"]')).toBeVisible();
    await expect(homeRail.locator(".home-ranked-list")).toHaveCount(2);
    await expect(homeRail.locator(".home-ranked-row").first()).toBeVisible();
    await expect(homeRail.locator(".home-ranked-meter").first()).toBeVisible();
    const activityScope = homeRail.locator("[data-activity-scope='listed-entries']");
    await expect(activityScope).toBeVisible();
    await expect(activityScope.locator(".i18n-ja")).toContainText("表示中一覧");
    await expect(activityScope.locator(".i18n-en")).toContainText(/listed view/i);
    const rankingScope = homeRail.locator("[data-ranking-scope='first-200-listed-entries']");
    await expect(rankingScope).toBeVisible();
    await expect(rankingScope.locator(".i18n-ja")).toHaveText("表示中一覧の先頭200件");
    await expect(rankingScope.locator(".i18n-en")).toHaveText("First 200 listed entries");
    // The old 2-column home-layout class must be gone (single canvas width source).
    await expect(page.locator(".home-layout")).toHaveCount(0);
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    await expect(page.locator("article.featured")).not.toContainText(/AI \u8981\u7d04\u672a\u751f\u6210|Summary pending|\u5f8c\u7d9a\u306e Worker run/);
    await expect(page.locator(".top-rank")).not.toContainText(/AI \u8981\u7d04\u672a\u751f\u6210|Summary pending|\u5f8c\u7d9a\u306e Worker run/);
    await expect(page.locator("article.featured [data-featured-importance]")).toBeVisible();
    await expect(page.locator("article.featured [data-featured-importance]")).toContainText(/重要度 (High|Medium|Info)/);
    const decisionFreshness = page.locator(
      ".top-rank-item .rank-freshness, article.featured .featured-freshness",
    );
    await expect(page.locator(
      ".top-rank-item .rank-freshness:not(.stale), article.featured .featured-freshness:not(.stale)",
    )).toHaveCount(0);
    await expect(page.locator("article.featured")).not.toContainText(
      /収集元 更新OK|Source feed current/,
    );
    await expect(page.locator(".top-rank")).not.toContainText(
      /収集元 更新OK|Source feed current/,
    );
    for (let index = 0; index < await decisionFreshness.count(); index++) {
      const warning = decisionFreshness.nth(index);
      await expect(warning).toHaveClass(/stale/);
      await expect(warning).toContainText(/収集元 更新遅延|Source feed stale/);
    }
    await expect(page.locator("#priority-heading")).toBeVisible();
    await expect(page.locator("#timeline-heading")).toBeVisible();
    const timelineArxivJa = page.locator('#timeline-heading .count .i18n-ja a[href="/arxiv"]');
    const timelineArxivEn = page.locator('#timeline-heading .count .i18n-en a[href="/arxiv"]');
    await expect(timelineArxivJa).toHaveText(/\d+ arXiv 論文は専用ページ/);
    await expect(timelineArxivEn).toHaveText(/\d+ arXiv papers on a separate page/);
    await expect(page.locator("#timeline-heading")).not.toContainText(/arXiv moved/);
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
      const topHrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>(".top-rank-list .top-rank-item .rank-content-link"))
        .map((a) => a.getAttribute("href"))
        .filter((href): href is string => !!href);
      const featuredSource = (document.querySelector<HTMLElement>("article.featured")?.dataset.source ?? "").trim();
      const topSources = Array.from(document.querySelectorAll<HTMLElement>(".top-rank-list .top-rank-item"))
        .map((item) => (item.dataset.source ?? "").trim())
        .filter(Boolean);
      const authorityBadge = document.querySelector("article.featured .featured-meta .badge[data-source-authority]") as HTMLElement | null;
      const importanceBadge = document.querySelector("article.featured .featured-meta [data-featured-importance]") as HTMLElement | null;
      return {
        featuredHref,
        topHrefs,
        featuredSource,
        topSources,
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
    await expect(page.locator(".featured-label .i18n-ja")).toContainText(
      "Spotlight · 要約済みの優先候補",
    );
    await expect(page.locator(".featured-label .i18n-en")).toContainText(
      "Spotlight · summary-ready priority pick",
    );
    await expect(page.locator(".featured-label")).not.toContainText(/編集部選定|editor pick/i);
    await expect(page.locator(".top-rank-title .i18n-ja")).toContainText("次に見る Top 3");
    await expect(page.locator(".top-rank-title .i18n-en")).toContainText(
      "Next 3 to review",
    );
    await expect(page.locator(".featured-freshness:not(.stale)")).toHaveCount(0);
    await expect(page.locator(".featured-label")).not.toContainText(
      /優先度トップ|top priority update|選定根拠|Selection basis|公式|Official|重要度|importance/i,
    );
    await expect(page.locator(".top-rank-sub .i18n-ja")).toContainText(
      "同じ source の重複を抑制",
    );
    await expect(page.locator(".top-rank-sub .i18n-en")).toContainText(
      "repeated sources limited",
    );
    await expect(page.locator("#today-priority")).toHaveAttribute(
      "data-decision-eligibility",
      "summary-ready",
    );
    await expect(page.locator(".top-rank-item .rank-reason")).toHaveCount(0);
    const rankedSummaries = await page.locator(".top-rank-item .rank-summary").evaluateAll((nodes) =>
      nodes.map((node) => {
        const ja = node.querySelector<HTMLElement>(".i18n-ja");
        const en = node.querySelector<HTMLElement>(".i18n-en");
        return {
          ja: ja?.textContent?.trim() ?? "",
          en: en?.textContent?.trim() ?? "",
          jaLang: ja?.lang ?? "",
          enLang: en?.lang ?? "",
        };
      }),
    );
    expect(rankedSummaries, "Top 3 gives every article one bilingual decision summary").toHaveLength(3);
    for (const summary of rankedSummaries) {
      expect(summary.ja.length, "Top 3 Japanese summary is useful decision content").toBeGreaterThan(10);
      expect(summary.en.length, "Top 3 English summary is useful decision content").toBeGreaterThan(10);
      expect(["ja", "en"]).toContain(summary.jaLang);
      expect(["ja", "en"]).toContain(summary.enLang);
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

  test("relative timestamps refresh from machine-readable datetimes at view time", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const sixHoursAgo = new Date(Date.now() - 365 * 60_000).toISOString();
    const refreshNode = async (selector: string) => {
      const node = page.locator(selector).first();
      await expect(node).toHaveAttribute("data-relative-time");
      await node.evaluate((element, datetime) => {
        (element as HTMLElement).dataset.datetime = datetime;
        document.dispatchEvent(new Event("techdb:refresh-relative-time"));
      }, sixHoursAgo);
      return node;
    };

    await page.goto("/status/");
    await page.locator("section.status-hero[data-live-run-health]").evaluate((hero, datetime) => {
      (hero as HTMLElement).dataset.runLastAt = datetime;
      const footer = document.querySelector<HTMLElement>("a.footer-run-link[data-live-run-health]");
      if (footer) footer.dataset.runLastAt = datetime;
      document.dispatchEvent(new Event("techdb:refresh-relative-time"));
    }, sixHoursAgo);
    await expect(
      await refreshNode("[data-health-scope='collection-run'] strong[data-relative-time]"),
    ).toHaveText("6h ago");
    const statusHero = page.locator("section.status-hero[data-live-run-health]");
    await expect(statusHero).toHaveAttribute("data-run-state", "late");
    await expect(page.locator("[data-metric-scope='run-status'] strong")).toHaveText("DELAYED");
    await expect(page.locator("[data-health-scope='summary-queue']")).toHaveAttribute(
      "data-summary-queue-state",
      "waiting-for-run",
    );
    await expect(page.locator("[data-summary-mode-label-ja]")).toHaveText("収集再開待ち");
    await expect(await refreshNode("time.footer-run-time[data-relative-time]")).toHaveText("run 6h ago");
    await expect(page.locator("[data-footer-run-label]")).toHaveText("run delayed");

    await page.goto("/");
    await page.locator("a.footer-run-link[data-live-run-health]").evaluate((footer, datetime) => {
      (footer as HTMLElement).dataset.runLastAt = datetime;
      document.dispatchEvent(new Event("techdb:refresh-relative-time"));
    }, sixHoursAgo);
    await expect(
      await refreshNode("article.featured .featured-meta time[data-relative-time]"),
    ).toHaveText("6h ago");
    await expect(page.locator("[data-cadence-state]")).toHaveAttribute("data-cadence-state", "late");
    await expect(page.locator("[data-banner-run-state]")).toBeVisible();
    await expect(page.locator("[data-banner-run-label-ja]")).toHaveText("DELAYED");
    const pendingCards = page.locator(".summary-state[data-summary-queue-state]");
    if ((await pendingCards.count()) > 0) {
      await expect(pendingCards.first()).toHaveAttribute("data-summary-queue-state", "waiting-for-run");
      await expect(pendingCards.first().locator("[data-summary-queue-detail-ja]")).toHaveText("収集再開待ち");
    }

    await page.goto("/arxiv/");
    await expect(
      await refreshNode("[data-metric-scope='arxiv-snapshot'] [data-relative-time]"),
    ).toHaveText("6h ago");
    const compactRowLabels = await page.locator("a.row[aria-label]").evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("aria-label") ?? ""),
    );
    expect(compactRowLabels.every((label) => !/\d+(?:m|h|d|w|mo|y) ago/.test(label))).toBe(true);

    await page.goto("/about/");
    await page.locator("a.footer-run-link[data-live-run-health]").evaluate((footer, datetime) => {
      (footer as HTMLElement).dataset.runLastAt = datetime;
      document.dispatchEvent(new Event("techdb:refresh-relative-time"));
    }, sixHoursAgo);
    await expect(page.locator("[data-about-run-state]")).toHaveAttribute("data-run-tone", "err");
    await expect(page.locator("[data-about-run-label-ja]")).toHaveText("定期収集が遅延");
    await expect(page.locator("[data-about-run-state]")).toHaveAttribute("aria-label", "収集状況: 定期収集が遅延");
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
      const board = page.locator(".ticker-panel");
      const boardRows = board.locator(".board .b-row");
      if (await boardRows.count() === 0) {
        await expect(board.locator(".empty[data-empty-reason]")).toBeVisible();
        continue;
      }
      const rows = await boardRows.evaluateAll((elements) =>
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
      for (const row of rows) {
        expect(row.categoryTitle).not.toBe("");
        expect(row.categoryRight).toBeLessThanOrEqual(row.tagsLeft + 0.5);
      }
    }
  });

  test("footer reports the actual summary and body queue backlogs", async ({ page }) => {
    await page.goto("/");
    const footerRun = page.locator(".footer-run-link");
    const runDetail = await footerRun.getAttribute("data-run-detail");
    const backlog = await footerRun.getAttribute("data-summary-queue-backlog");
    const bodyMode = await footerRun.getAttribute("data-body-queue-mode");
    const bodyState = await footerRun.getAttribute("data-body-queue-state");
    const bodyBacklog = await footerRun.getAttribute("data-body-queue-backlog");
    expect(runDetail).toBeTruthy();
    expect(backlog).toMatch(/^\d+$/);
    expect(bodyMode).toMatch(/^(enabled|disabled|missing-binding|error|unknown)$/);
    expect(bodyState).toMatch(
      /^(active|clear|waiting-for-run|paused|unavailable|error|unknown)$/,
    );
    expect(bodyBacklog).toMatch(/^(unknown|\d+)$/);
    await expect(footerRun.locator(".mono")).not.toContainText(runDetail!);
    await expect(footerRun.locator(".mono")).toContainText(
      new RegExp(`batch \\d+/\\d+ · sources \\d+/\\d+ · summary ${backlog}`),
    );
    if (bodyState === "active") {
      await expect(footerRun.locator(".footer-body-queue")).toContainText(
        `body ${bodyBacklog} pending`,
      );
      await expect(footerRun).toHaveAttribute(
        "title",
        /AI explainer body queue (about|estimate pending)/i,
      );
    } else if (bodyState === "clear") {
      await expect(footerRun.locator(".footer-body-queue")).toHaveText("body ready");
      await expect(footerRun).toHaveAttribute("title", /AI explainer body queue clear/i);
    } else if (bodyState === "waiting-for-run") {
      const displayedBacklog = bodyBacklog === "unknown" ? "?" : bodyBacklog;
      await expect(footerRun.locator(".footer-body-queue")).toHaveText(
        `body ${displayedBacklog} waiting`,
      );
      await expect(footerRun).toHaveAttribute(
        "title",
        /AI explainer body queue waiting for a successful run/i,
      );
    } else if (bodyState === "paused") {
      await expect(footerRun.locator(".footer-body-queue")).toHaveText("body paused");
    } else {
      await expect(footerRun.locator(".footer-body-queue")).toHaveText("body unavailable");
    }
    await expect(footerRun).not.toHaveAttribute("aria-label");
    await expect(footerRun).toHaveAccessibleName(/run .*batch .*sources .*summary .*body/i);
  });

  test("pending cards share the summary queue state and suppress stale ETAs", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const footerRun = page.locator(".footer-run-link");
    const queueMode = await footerRun.getAttribute("data-summary-queue-mode");
    const queueState = await footerRun.getAttribute("data-summary-queue-state");
    expect(queueMode).toMatch(/^(enabled|disabled|missing-binding|error|unknown)$/);
    expect(queueState).toMatch(
      /^(active|clear|waiting-for-run|paused|unavailable|error|unknown)$/,
    );

    const pendingCards = page.locator('article.card[data-summary-state="pending"]');
    if ((await pendingCards.count()) === 0) return;

    const pendingState = pendingCards.first().locator(".summary-state");
    await expect(pendingState).toHaveAttribute("data-summary-queue-mode", queueMode!);
    await expect(pendingState).toHaveAttribute("data-summary-queue-state", queueState!);
    const expectedBadge = {
      active: "AI要約 準備待ち",
      clear: "AI要約 次回待ち",
      "waiting-for-run": "AI要約 再開待ち",
      paused: "AI要約 停止中",
      unavailable: "AI要約 利用不可",
      error: "AI要約 要確認",
      unknown: "AI要約 確認中",
    } as const;
    await expect(pendingState.locator(".summary-pending-badge .i18n-ja")).toHaveText(
      expectedBadge[queueState as keyof typeof expectedBadge],
    );
    if (queueState === "active") {
      await expect(pendingState.locator(".summary-pending-meta.i18n-ja")).toContainText(
        "全体の要約処理は稼働中",
      );
      await expect(pendingState).not.toContainText(/現在値で約|AI summary queued/i);
    } else if (queueState === "waiting-for-run") {
      await expect(pendingState.locator(".summary-pending-meta.i18n-ja")).toContainText(
        "収集再開待ち",
      );
      await expect(pendingState).not.toContainText(/解消目安|drain estimate/i);
    }

    const statusLink = pendingState.locator(".summary-pending-meta a").first();
    const statusLinkBox = await statusLink.boundingBox();
    expect(statusLinkBox, "pending recovery link should be measurable").not.toBeNull();
    expect(statusLinkBox!.height).toBeGreaterThanOrEqual(44);
    expect(statusLinkBox!.width).toBeGreaterThanOrEqual(44);
  });

  // Timeline rails release progressively: no rails through tablet, the category
  // rail alone on small desktop, then both rails once the main column stays useful.
  test("timeline right rail constrains layout and stays responsive", async ({ page }) => {
    // Wide desktop: use the expanded canvas while keeping both rails useful.
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto("/");
    const settleLayout = () =>
      page.evaluate(
        () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        ),
      );
    const rail = page.locator(".layout aside.right.home-right");
    await expect(rail).toBeVisible();
    await expect(rail.locator(":scope > .side-card > h3.right-title")).toHaveCount(3);
    await expect(rail.locator(":scope > .side-card > div.right-title")).toHaveCount(0);
    await expect(rail.locator("h3.right-title small")).toHaveCount(2);
    await expect(rail.locator("h3.right-title small").first()).toHaveText("entries");
    const rankedLinks = rail.locator("a.home-ranked-row");
    for (let index = 0; index < await rankedLinks.count(); index += 1) {
      await expect(rankedLinks.nth(index)).not.toHaveAttribute("aria-label");
      await expect(rankedLinks.nth(index)).toHaveAccessibleName(/entries/);
    }
    const desktop = await page.evaluate(() => {
      const layout = document.querySelector(".layout");
      const right = document.querySelector(".layout aside.right");
      const main = document.querySelector(".layout main");
      const alignedSurfaces = [
        ".header-inner",
        ".banner-inner",
        ".layout",
        ".footer-inner",
      ].map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        const rect = element?.getBoundingClientRect();
        return rect ? { selector, left: rect.left, right: rect.right, width: rect.width } : null;
      });
      const cols = layout ? getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length : 0;
      return {
        cols,
        layoutW: layout ? Math.round(layout.getBoundingClientRect().width) : 0,
        railW: right ? Math.round(right.getBoundingClientRect().width) : 0,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
        noScroll: document.documentElement.scrollWidth <= window.innerWidth,
        alignedSurfaces,
      };
    });
    expect(desktop.cols).toBe(3);
    expect(desktop.layoutW, "wide canvas should use the expanded 1680px limit").toBeGreaterThanOrEqual(1670);
    expect(desktop.railW).toBeGreaterThanOrEqual(200);
    expect(desktop.mainW, "expanded canvas should keep the article column useful").toBeGreaterThan(1000);
    expect(desktop.noScroll).toBe(true);
    expect(desktop.alignedSurfaces.every(Boolean), "all wide-canvas surfaces should exist").toBe(true);
    const [headerSurface, ...alignedSurfaces] = desktop.alignedSurfaces;
    expect(headerSurface?.width, "wide header should use the shared content width").toBeGreaterThanOrEqual(1670);
    for (const surface of alignedSurfaces) {
      expect(
        Math.abs((surface?.left ?? 0) - (headerSurface?.left ?? 0)),
        `${surface?.selector} aligns with the header`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((surface?.right ?? 0) - (headerSurface?.right ?? 0)),
        `${surface?.selector} aligns with the header`,
      ).toBeLessThanOrEqual(1);
    }
    const sourceLabelMetrics = await rail.locator(".home-source-row .home-ranked-label").evaluateAll(
      (labels) =>
        labels.map((label) => ({
          whiteSpace: getComputedStyle(label).whiteSpace,
          clientWidth: label.clientWidth,
          scrollWidth: label.scrollWidth,
        })),
    );
    expect(sourceLabelMetrics.length).toBeGreaterThan(0);
    expect(sourceLabelMetrics.every((metric) => metric.whiteSpace === "normal")).toBe(true);
    expect(
      sourceLabelMetrics.every((metric) => metric.scrollWidth <= metric.clientWidth + 1),
      "source names should wrap without hidden clipping",
    ).toBe(true);

    const rankedGeometry = await page.locator(".home-ranked-row").evaluateAll((rows) =>
      rows.map((row) => {
        const rect = (selector: string) => {
          const box = row.querySelector(selector)?.getBoundingClientRect();
          return box ? { left: box.left, right: box.right } : null;
        };
        const rowBox = row.getBoundingClientRect();
        return {
          rowLeft: rowBox.left,
          rowRight: rowBox.right,
          rank: rect(".home-rank-number"),
          copy: rect(".home-ranked-copy"),
          count: rect(".home-ranked-count"),
          meter: rect(".home-ranked-meter"),
        };
      }),
    );
    expect(rankedGeometry.length).toBeGreaterThan(0);
    for (const row of rankedGeometry) {
      expect(row.rank?.left).toBeGreaterThanOrEqual(row.rowLeft - 1);
      expect(row.copy?.left).toBeGreaterThanOrEqual((row.rank?.right ?? 0) - 1);
      expect(row.count?.left).toBeGreaterThanOrEqual((row.copy?.right ?? 0) - 1);
      expect(row.count?.right).toBeLessThanOrEqual(row.rowRight + 1);
      expect(row.meter?.left).toBeGreaterThanOrEqual((row.copy?.left ?? 0) - 1);
      expect(row.meter?.right).toBeLessThanOrEqual((row.count?.right ?? 0) + 1);
    }

    // The compact right rail returns once all three columns retain useful width.
    for (const width of [1181, 1280, 1359]) {
      await page.setViewportSize({ width, height: 900 });
      await settleLayout();
      await expect(rail, `${width}px shows the compact right rail`).toBeVisible();
      const compact = await page.locator(".layout").evaluate((layout) => ({
        cols: getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length,
        noScroll: document.documentElement.scrollWidth <= window.innerWidth,
      }));
      expect(compact.cols, `${width}px keeps the three-column hierarchy`).toBe(3);
      expect(compact.noScroll, `${width}px keeps the page within the viewport`).toBe(true);
    }

    await page.setViewportSize({ width: 1180, height: 900 });
    await settleLayout();
    await expect(rail).toBeHidden();
    const collapsedCols = await page.locator(".layout").evaluate((layout) =>
      getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length,
    );
    expect(collapsedCols).toBe(2);

    // Mobile: rail hidden, no horizontal scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await settleLayout();
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

  test("low desktop height keeps timeline and status rails in normal flow", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });

    for (const path of ["/", "/status/"]) {
      await page.goto(path);
      const left = page.locator(".layout > aside.left");
      const right = page.locator(
        path === "/" ? ".layout > aside.right.home-right" : ".layout > aside.right.status-insights",
      );
      await expect(left, `${path} left rail is visible`).toBeVisible();
      await expect(right, `${path} right rail is visible`).toBeVisible();
      await expect
        .poll(() => left.evaluate((element) => getComputedStyle(element).position))
        .toBe("static");
      await expect
        .poll(() => right.evaluate((element) => getComputedStyle(element).position))
        .toBe("static");

      const before = await page.evaluate(() => ({
        leftTop: document.querySelector(".layout > aside.left")?.getBoundingClientRect().top ?? 0,
        rightTop: document.querySelector(".layout > aside.right")?.getBoundingClientRect().top ?? 0,
      }));
      await page.evaluate(() => window.scrollTo(0, 320));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
      const after = await page.evaluate(() => ({
        leftTop: document.querySelector(".layout > aside.left")?.getBoundingClientRect().top ?? 0,
        rightTop: document.querySelector(".layout > aside.right")?.getBoundingClientRect().top ?? 0,
        noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      }));
      expect(after.leftTop, `${path} left rail scrolls with content`).toBeLessThan(before.leftTop - 150);
      expect(after.rightTop, `${path} right rail scrolls with content`).toBeLessThan(before.rightTop - 150);
      expect(after.noOverflow, `${path} has no horizontal overflow`).toBe(true);
    }
  });

  test("mid-width banner copy uses the available horizontal space", async ({ page }) => {
    for (const width of [901, 1000, 1100]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/");
      await expect(page.locator(".banner-copy")).toBeVisible();

      const metrics = await page.evaluate(() => {
        const inner = document.querySelector<HTMLElement>(".banner-inner");
        const copy = document.querySelector<HTMLElement>(".banner-copy");
        const right = document.querySelector<HTMLElement>(".banner-right");
        const actions = document.querySelector<HTMLElement>(".banner-actions");
        const quickLinks = document.querySelector<HTMLElement>(".banner-quick-links");
        if (!inner || !copy || !right || !actions || !quickLinks) return null;
        const innerStyle = getComputedStyle(inner);
        const copyStyle = getComputedStyle(copy);
        const innerContentWidth =
          inner.clientWidth - parseFloat(innerStyle.paddingLeft) - parseFloat(innerStyle.paddingRight);
        const copyRect = copy.getBoundingClientRect();
        return {
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          innerContentWidth,
          copyWidth: copyRect.width,
          copyMaxWidth: copyStyle.maxWidth,
          copyGridColumns: copyStyle.gridTemplateColumns.split(" ").filter(Boolean).length,
          rightVisible: getComputedStyle(right).display !== "none",
          actionsRight: actions.getBoundingClientRect().right,
          quickLinksRight: quickLinks.getBoundingClientRect().right,
          copyRight: copyRect.right,
        };
      });

      expect(metrics, `width ${width}: banner metrics should be available`).not.toBeNull();
      expect(metrics?.noOverflow, `width ${width}: banner should not cause horizontal overflow`).toBe(true);
      expect(metrics?.rightVisible, `width ${width}: decorative banner rail should stay hidden`).toBe(false);
      expect(metrics?.copyMaxWidth, `width ${width}: banner copy should release the desktop width cap`).toBe("none");
      expect(metrics?.copyGridColumns, `width ${width}: banner copy should use its compact two-column layout`).toBe(2);
      expect(metrics?.copyWidth, `width ${width}: banner copy should fill its content track`).toBeGreaterThanOrEqual(
        (metrics?.innerContentWidth ?? 0) - 1,
      );
      expect(metrics?.actionsRight, `width ${width}: banner actions should remain inside the copy area`).toBeLessThanOrEqual(
        (metrics?.copyRight ?? 0) + 1,
      );
      expect(
        metrics?.quickLinksRight,
        `width ${width}: banner quick links should remain inside the copy area`,
      ).toBeLessThanOrEqual((metrics?.copyRight ?? 0) + 1);
    }
  });

  test("home hero keeps mobile breathing room and desktop density", async ({ page }) => {
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await expect(page.locator(".banner .tagline-compact.i18n-ja")).toBeVisible();
      await expect(page.locator(".banner .tagline-full.i18n-ja")).toBeHidden();
      await expectMobileFirstDecisionNearViewport(page);

      const mobile = await page.evaluate(() => {
        const inner = document.querySelector<HTMLElement>(".banner-inner");
        const compact = document.querySelector<HTMLElement>(".banner .tagline-compact.i18n-ja");
        const featured = document.querySelector<HTMLElement>("article.featured");
        if (!inner || !compact || !featured) return null;
        const innerStyle = getComputedStyle(inner);
        const compactRect = compact.getBoundingClientRect();
        return {
          paddingTop: parseFloat(innerStyle.paddingTop),
          paddingBottom: parseFloat(innerStyle.paddingBottom),
          taglineHeight: compactRect.height,
          taglineClipped: compact.scrollHeight > compact.clientHeight + 1,
          featuredY: featured.getBoundingClientRect().y,
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });

      expect(mobile, `width ${width}: mobile hero metrics should be available`).not.toBeNull();
      expect(mobile?.paddingTop, `width ${width}: mobile hero keeps breathing room above`).toBeGreaterThanOrEqual(10);
      expect(mobile?.paddingBottom, `width ${width}: mobile hero keeps breathing room below`).toBeGreaterThanOrEqual(9);
      expect(mobile?.taglineHeight, `width ${width}: compact mobile tagline stays on one line`).toBeLessThanOrEqual(18);
      expect(mobile?.taglineClipped, `width ${width}: compact mobile tagline remains complete`).toBe(false);
      expect(mobile?.featuredY, `width ${width}: first decision stays near the first viewport`).toBeLessThanOrEqual(
        MOBILE_FIRST_DECISION_MAX_Y,
      );
      expect(mobile?.noOverflow, `width ${width}: mobile hero does not create horizontal overflow`).toBe(true);
    }

    for (const width of [1101, 1239, 1240, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator(".banner-right")).toBeVisible();

      const desktop = await page.evaluate(() => {
        const rect = (element: Element | null) => {
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return {
            x: box.x,
            width: box.width,
            height: box.height,
            right: box.right,
          };
        };
        const banner = rect(document.querySelector(".banner"));
        const copy = rect(document.querySelector(".banner-copy"));
        const right = rect(document.querySelector(".banner-right"));
        const orbit = rect(document.querySelector(".dynamic-orbit"));
        const facts = rect(document.querySelector(".banner-facts"));
        const orbitElement = document.querySelector<HTMLElement>(".dynamic-orbit");
        const factCards = Array.from(document.querySelectorAll(".banner-fact")).map((fact) => rect(fact));
        return {
          banner,
          copy,
          right,
          orbit,
          orbitVisible: orbitElement ? getComputedStyle(orbitElement).display !== "none" : false,
          facts,
          factCards,
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });

      expect(desktop.banner?.height, `width ${width}: desktop hero avoids excessive vertical whitespace`).toBeLessThanOrEqual(
        260,
      );
      expect(desktop.right?.width, `width ${width}: desktop information rail stays bounded`).toBeLessThanOrEqual(621);
      expect(desktop.right?.width, `width ${width}: desktop information rail does not dominate the hero copy`).toBeLessThanOrEqual(
        (desktop.copy?.width ?? 0) + 1,
      );
      expect(desktop.copy?.right, `width ${width}: hero copy does not overlap the information rail`).toBeLessThanOrEqual(
        (desktop.right?.x ?? 0) - 8,
      );
      if (width < 1240) {
        expect(desktop.orbitVisible, `width ${width}: narrow desktop prioritizes facts over decoration`).toBe(false);
        expect(desktop.facts?.width, `width ${width}: facts use the full information rail`).toBeGreaterThanOrEqual(
          (desktop.right?.width ?? 0) - 1,
        );
      } else {
        expect(desktop.orbitVisible, `width ${width}: wide desktop keeps the orbit`).toBe(true);
        expect(desktop.orbit?.height, `width ${width}: desktop orbit remains visually substantial`).toBeGreaterThanOrEqual(
          200,
        );
        expect(desktop.orbit?.width, `width ${width}: orbit labels retain usable space`).toBeGreaterThanOrEqual(231);
        expect(desktop.orbit?.right, `width ${width}: orbit and facts remain distinct columns`).toBeLessThanOrEqual(
          (desktop.facts?.x ?? 0) - 6,
        );
      }
      for (const card of desktop.factCards) {
        expect(card?.x, `width ${width}: fact card stays inside the information rail`).toBeGreaterThanOrEqual(
          desktop.facts?.x ?? Number.POSITIVE_INFINITY,
        );
        expect(card?.right, `width ${width}: fact card stays inside the information rail`).toBeLessThanOrEqual(
          desktop.facts?.right ?? 0,
        );
      }
      expect(desktop.noOverflow, `width ${width}: desktop hero does not create horizontal overflow`).toBe(true);
    }
  });

  test("mid-width header keeps every control readable without clipping", async ({ page }) => {
    const widths = [721, 768, 901, 981, 1000, 1100];
    await page.setViewportSize({ width: widths[0]!, height: 900 });
    await page.goto("/");
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(
        () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        ),
      );

      const metrics = await page.evaluate(() => {
        const rect = (element: Element | null) => {
          if (!element || element.getClientRects().length === 0) return null;
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width, height: box.height };
        };
        const switcher = document.querySelector<HTMLElement>("header .header-switcher");
        const menuTrigger = document.querySelector<HTMLElement>("header .menu-trigger");
        const search = document.querySelector<HTMLElement>("header .search");
        const shortcuts = Array.from(document.querySelectorAll<HTMLElement>("header .nav-shortcut"));
        const shortcutLabels = Array.from(
          document.querySelectorAll<HTMLElement>("header .nav-shortcut span:not(.nav-icon)"),
        );
        const languageButtons = Array.from(document.querySelectorAll<HTMLElement>("header .lang-btn"));
        return {
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          switcher: rect(switcher),
          menuTrigger: rect(menuTrigger),
          search: rect(search),
          shortcutBoxes: shortcuts.map((shortcut) => rect(shortcut)),
          shortcutLabels: shortcutLabels.map((label) => ({
            text: label.textContent?.trim() ?? "",
            visible: getComputedStyle(label).display !== "none",
            fullyVisible: label.scrollWidth <= label.clientWidth,
          })),
          languageButtons: languageButtons.map((button) => ({
            box: rect(button),
            text: button.textContent?.trim() ?? "",
            fullyVisible: button.scrollWidth <= button.clientWidth,
          })),
          headerControls: Array.from(
            document.querySelectorAll<HTMLElement>(
              "header .logo, header .header-switcher, header .search, header .lang-toggle, header .menu-trigger",
            ),
          )
            .map((control) => rect(control))
            .filter((box): box is NonNullable<typeof box> => box !== null),
        };
      });

      expect(metrics.noOverflow, `${width}px header does not overflow the viewport`).toBe(true);
      expect(metrics.switcher, `${width}px header switcher remains visible`).not.toBeNull();
      expect(metrics.shortcutLabels.map((label) => label.text)).toEqual(["Categories", "arXiv", "Knowledge"]);
      if (width <= 980) {
        expect(
          metrics.shortcutLabels.every((label) => label.visible && label.fullyVisible),
          `${width}px shortcuts keep readable destination names`,
        ).toBe(true);
        expect(metrics.search, `${width}px search yields to labeled navigation`).toBeNull();
      } else {
        expect(
          metrics.shortcutLabels.every((label) => label.visible && label.fullyVisible),
          `${width}px shortcuts restore readable labels without clipping`,
        ).toBe(true);
        expect(metrics.search, `${width}px header search remains visible`).not.toBeNull();
      }
      for (const box of metrics.shortcutBoxes) {
        expect(box, `${width}px shortcut has a rendered box`).not.toBeNull();
        expect(box!.width, `${width}px shortcut keeps a 44px target width`).toBeGreaterThanOrEqual(44);
        expect(box!.height, `${width}px shortcut keeps a 44px target height`).toBeGreaterThanOrEqual(44);
      }
      expect(metrics.languageButtons, `${width}px language toggle keeps both buttons`).toHaveLength(2);
      expect(metrics.menuTrigger, `${width}px menu trigger remains visible`).not.toBeNull();
      expect(metrics.menuTrigger!.width, `${width}px menu trigger keeps a 44px touch width`).toBeGreaterThanOrEqual(44);
      expect(metrics.menuTrigger!.height, `${width}px menu trigger keeps a 44px touch height`).toBeGreaterThanOrEqual(44);
      expect(
        metrics.languageButtons.map((button) => button.text),
        `${width}px language labels remain intact`,
      ).toEqual(["JA", "EN"]);
      for (const button of metrics.languageButtons) {
        expect(button.box, `${width}px ${button.text} button has a rendered box`).not.toBeNull();
        expect(button.box!.width, `${width}px ${button.text} button is not flex-shrunk`).toBeGreaterThanOrEqual(34);
        if (width <= 980) {
          expect(button.box!.width, `${width}px ${button.text} keeps a 44px touch width`).toBeGreaterThanOrEqual(44);
          expect(button.box!.height, `${width}px ${button.text} keeps a 44px touch height`).toBeGreaterThanOrEqual(44);
        }
        expect(button.fullyVisible, `${width}px ${button.text} label is not clipped`).toBe(true);
      }
      for (let index = 1; index < metrics.headerControls.length; index += 1) {
        expect(
          metrics.headerControls[index]!.left,
          `${width}px header controls do not overlap`,
        ).toBeGreaterThanOrEqual(metrics.headerControls[index - 1]!.right - 1);
      }
      expect(
        metrics.headerControls.at(-1)!.right,
        `${width}px final header control stays inside the viewport`,
      ).toBeLessThanOrEqual(width);

      if (width === 768) {
        await page.locator("header .menu-trigger").click();
        await page.locator("#site-menu [data-search-trigger]").click();
        const tabletSearch = page.locator("header .search.is-open");
        await expect(tabletSearch).toBeVisible();
        await expect(page.locator("#pagefind-search-input")).toBeFocused();
        const searchBox = await tabletSearch.boundingBox();
        expect(searchBox, "tablet search opens as a viewport overlay").not.toBeNull();
        expect(searchBox!.x).toBeGreaterThanOrEqual(12);
        expect(searchBox!.x + searchBox!.width).toBeLessThanOrEqual(width - 12);
        const searchInput = page.locator("#pagefind-search-input");
        const inputBox = await searchInput.boundingBox();
        expect(inputBox, "tablet search input has a rendered box").not.toBeNull();
        expect(inputBox!.height, "tablet search input keeps a 44px touch height").toBeGreaterThanOrEqual(44);
        await searchInput.fill("Copilot");
        const searchClose = tabletSearch.locator(".search-close");
        await expect(searchClose).toBeVisible();
        const closeBox = await searchClose.boundingBox();
        expect(closeBox, "tablet search close has a rendered box").not.toBeNull();
        expect(closeBox!.width, "tablet search close keeps a 44px touch width").toBeGreaterThanOrEqual(44);
        expect(closeBox!.height, "tablet search close keeps a 44px touch height").toBeGreaterThanOrEqual(44);
        await page.keyboard.press("Escape");
        await expect(tabletSearch).toBeHidden();
      }
    }
  });

  test("mid-width ticker gives tags and headline separate rows", async ({ page }) => {
    for (const width of [961, 981, 1000, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator(".ticker-bar .tb-slide.is-active")).toBeVisible();

      const metrics = await page.evaluate(() => {
        const slide = document.querySelector<HTMLElement>(".ticker-bar .tb-slide.is-active");
        const meta = slide?.querySelector<HTMLElement>(".tb-meta");
        const title = Array.from(slide?.querySelectorAll<HTMLElement>(".tb-title") ?? []).find(
          (candidate) => getComputedStyle(candidate).display !== "none",
        );
        const stage = document.querySelector<HTMLElement>(".ticker-bar .tb-stage");
        if (!slide || !meta || !title || !stage) return null;
        const slideBox = slide.getBoundingClientRect();
        const metaBox = meta.getBoundingClientRect();
        const titleBox = title.getBoundingClientRect();
        const stageBox = stage.getBoundingClientRect();
        return {
          noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
          slideHeight: slideBox.height,
          metaBottom: metaBox.bottom,
          titleTop: titleBox.top,
          titleWidth: titleBox.width,
          stageWidth: stageBox.width,
        };
      });

      expect(metrics, `${width}px ticker geometry should be available`).not.toBeNull();
      expect(metrics?.noOverflow, `${width}px ticker should not cause horizontal overflow`).toBe(true);
      expect(metrics?.slideHeight, `${width}px ticker keeps a compact two-row stage`).toBeLessThanOrEqual(44);
      expect(metrics?.metaBottom, `${width}px ticker metadata stays above the headline`).toBeLessThanOrEqual(
        metrics?.titleTop ?? 0,
      );
      expect(metrics?.titleWidth, `${width}px headline uses the full ticker stage width`).toBeGreaterThanOrEqual(
        (metrics?.stageWidth ?? 0) - 1,
      );
    }
  });

  test("top-rank panel remains stable across rail breakpoint widths", async ({ page }) => {
    const widths = [
      1440,
      1366,
      1360,
      1359,
      1280,
      1279,
      1241,
      1240,
      1239,
      1181,
      1180,
      1101,
      1100,
      1029,
      1028,
      1000,
      981,
      980,
      901,
      900,
      837,
      836,
      768,
      761,
      760,
      721,
      720,
      390,
    ];
    let originalRankSummary = "";
    for (const [index, width] of widths.entries()) {
      await page.setViewportSize({ width, height: 844 });
      const crossedIntoMobile = width <= 720 && (widths[index - 1] ?? width) > 720;
      if (index === 0 || crossedIntoMobile) {
        await page.goto("/");
        if (width >= 721) {
          originalRankSummary = await page.locator(".top-rank-item .rank-summary .i18n-ja").first().textContent() ?? "";
        }
      }
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
        await page.locator(".top-rank-item .rank-summary .i18n-ja").first().evaluate(
          (summary, text) => {
            summary.textContent = text;
          },
          width >= 1280
            ? "AI開発の判断材料を短時間で比較できるよう、記事固有の要点と影響範囲を簡潔に整理した要約です。"
            : originalRankSummary,
        );
      }
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );

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
        const bannerInner = document.querySelector<HTMLElement>(".banner-inner");
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
              stale: el.classList.contains("stale"),
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
        const bannerInnerRect = bannerInner?.getBoundingClientRect();
        const footerRect = footer?.getBoundingClientRect();
        const footerRunDetail = footer?.querySelector<HTMLElement>(".footer-run-link .mono");
        const footerStack = footer?.querySelector<HTMLElement>(".footer-stack");
        const footerBodyQueue = footer?.querySelector<HTMLElement>(".footer-body-queue");
        const rankMetaHeights = items
          .map((item) => item.querySelector<HTMLElement>(".rank-meta")?.getBoundingClientRect().height ?? 0);
        const rankSummaryWidths = items
          .map((item) => item.querySelector<HTMLElement>(".rank-summary")?.getBoundingClientRect().width ?? 0);
        const rankSummaryHeights = items
          .map((item) => item.querySelector<HTMLElement>(".rank-summary")?.getBoundingClientRect().height ?? 0);
        const rankContentHeights = items
          .map((item) => item.querySelector<HTMLElement>(".rank-content-link")?.getBoundingClientRect().height ?? 0);
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
          minRankSummaryWidth: rankSummaryWidths.length > 0 ? Math.min(...rankSummaryWidths) : 0,
          maxRankSummaryHeight: rankSummaryHeights.length > 0 ? Math.max(...rankSummaryHeights) : 0,
          minRankContentHeight: rankContentHeights.length > 0 ? Math.min(...rankContentHeights) : 0,
          topRankWidth: topRankRect?.width ?? 0,
          bannerHeight: bannerInnerRect?.height ?? Number.POSITIVE_INFINITY,
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
          rankReasonCount: document.querySelectorAll(".top-rank-item .rank-reason").length,
          topRankBottom: topRankRect?.bottom ?? Number.POSITIVE_INFINITY,
          visibleBottom: Math.min(window.innerHeight, footerRect?.top ?? window.innerHeight),
          footerHeight: footerRect?.height ?? Number.POSITIVE_INFINITY,
          footerRunTextOverflow: footerRunDetail
            ? getComputedStyle(footerRunDetail).textOverflow
            : "",
          footerStackVisible: !!footerStack && getComputedStyle(footerStack).display !== "none",
          footerBodyQueueVisible:
            !!footerBodyQueue && getComputedStyle(footerBodyQueue).display !== "none",
          featuredSourceSafe: !!featuredSource
            && (
              featuredSource.scrollWidth <= featuredSource.clientWidth + 1
              || getComputedStyle(featuredSource).textOverflow === "ellipsis"
            ),
          rankSourceClipped: !!firstRankSource
            && firstRankSource.scrollWidth > firstRankSource.clientWidth
            && getComputedStyle(firstRankSource).textOverflow === "ellipsis",
        };
      });

      expect(metrics.noOverflow, `width ${width}: page should not overflow horizontally`).toBe(true);
      expect(metrics.rankCount, `width ${width}: top-3 should keep three cards`).toBe(3);
      expect(metrics.rankReasonCount, `width ${width}: Top-3 should not repeat generic rationale rows`).toBe(0);
      expect(metrics.metaInMedalTrack, `width ${width}: rank meta must not collapse into medal track`).toBe(false);
      expect(
        metrics.minRankContentHeight,
        `width ${width}: title and summary should form one 44px decision target`,
      ).toBeGreaterThanOrEqual(43.5);
      for (const badge of metrics.freshness) {
        expect(badge.stale, `width ${width}: only warning freshness badges should render`).toBe(true);
        expect(badge.whiteSpace, `width ${width}: freshness should stay atomic`).toBe("nowrap");
        expect(badge.width, `width ${width}: freshness badge should keep readable width`).toBeGreaterThanOrEqual(
          badge.kind === "featured" || width <= 720 ? 70 : 28,
        );
        expect(badge.height, `width ${width}: freshness badge should stay one-line height`).toBeLessThanOrEqual(48);
      }

      expect(metrics.bannerHeight, `width ${width}: banner should not stack into an oversized panel`).toBeLessThanOrEqual(
        320,
      );

      if (width >= 1181) {
        expect(metrics.rightRailVisible, `width ${width}: right rail should be visible and populated`).toBe(true);
        expect(metrics.rightRailCards, `width ${width}: right rail should have cards`).toBeGreaterThan(0);
      } else {
        expect(metrics.rightRailVisible, `width ${width}: right rail should be hidden`).toBe(false);
      }

      if (width <= 1359 && width >= 1181) {
        expect(metrics.gridCols, `width ${width}: compact desktop should keep both supporting rails`).toBe(3);
        expect(metrics.maxRankHeight, `width ${width}: top-rank item height should stay compact`).toBeLessThanOrEqual(180);
        expect(metrics.featuredBodyWidth, `width ${width}: featured body should remain readable`).toBeGreaterThan(300);
      }

      if (width <= 1180 && width >= 901) {
        expect(metrics.gridCols, `width ${width}: small desktop should keep only the category rail`).toBe(2);
        expect(metrics.maxRankHeight, `width ${width}: top-rank item height should stay compact`).toBeLessThanOrEqual(180);
        expect(metrics.featuredThumbWidth, `width ${width}: featured thumb should keep width`).toBeGreaterThan(120);
        expect(metrics.featuredThumbHeight, `width ${width}: featured thumb should keep height`).toBeGreaterThan(95);
        expect(metrics.featuredBodyWidth, `width ${width}: featured body should keep readable width`).toBeGreaterThan(350);
        expect(
          metrics.minRankSummaryWidth,
          `width ${width}: Top-3 summaries should remain useful before the right rail returns`,
        ).toBeGreaterThanOrEqual(180);
        if (metrics.featuredFreshnessWidth > 0) {
          expect(metrics.featuredFreshnessWidth, `width ${width}: featured freshness should keep readable width`).toBeGreaterThanOrEqual(70);
          expect(metrics.featuredFreshnessHeight, `width ${width}: featured freshness should stay one-line height`).toBeLessThanOrEqual(48);
        }
      }

      if (width === 900 || width === 768) {
        expect(metrics.maxRankHeight, `width ${width}: top-rank should not grow excessively`).toBeLessThanOrEqual(300);
      }
      if (width >= 721 && width <= 900) {
        expect(metrics.gridCols, `width ${width}: tablet layout should release the category rail`).toBe(1);
        expect(metrics.mainWidth, `width ${width}: tablet main content should use the available width`).toBeGreaterThanOrEqual(
          width - 72,
        );
        expect(
          metrics.minRankSummaryWidth,
          `width ${width}: Top-3 summaries should remain useful at tablet widths`,
        ).toBeGreaterThanOrEqual(150);
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
        expect(
          metrics.featuredSourceSafe,
          `width ${width}: long Featured source should fit or use recoverable ellipsis`,
        ).toBe(true);
        expect(metrics.maxRankMetaHeight, `width ${width}: Top-3 metadata should stay on one line`).toBeLessThanOrEqual(28);
        expect(metrics.rankSourceClipped, `width ${width}: long Top-3 source should use ellipsis`).toBe(true);
        expect(metrics.rankMetaOverlaps, `width ${width}: Top-3 metadata controls must not overlap`).toBe(false);
        expect(
          metrics.rankTimeVisibleCount,
          `width ${width}: compact cards should omit only the redundant time label`,
        ).toBe(
          width >= 761 && width <= 836
            ? 0
            : metrics.rankCount,
        );
        expect(metrics.topRankBottom, `width ${width}: Top-3 should stay above the fixed footer`).toBeLessThanOrEqual(
          metrics.visibleBottom - 8,
        );
        expect(metrics.footerHeight, `width ${width}: footer should stay on one line`).toBeLessThanOrEqual(36);
        if (width <= 1239) {
          expect(metrics.footerStackVisible, `width ${width}: compact footer should hide the build stack`).toBe(false);
          expect(metrics.footerBodyQueueVisible, `width ${width}: compact footer should defer body queue detail`).toBe(false);
        } else {
          expect(metrics.footerStackVisible, `width ${width}: wide footer should restore the build stack`).toBe(true);
          expect(metrics.footerBodyQueueVisible, `width ${width}: wide footer should restore body queue detail`).toBe(true);
        }
        if (width <= 980) {
          expect(metrics.footerRunTextOverflow, `width ${width}: footer run detail should truncate safely`).toBe("ellipsis");
        }
      } else {
        expect(metrics.rankGridCols, `width ${width}: mobile Top-3 should remain a single column`).toBe(1);
        expect(metrics.maxRankHeight, `width ${width}: mobile Top-3 cards stay compact`).toBeLessThanOrEqual(118);
        expect(metrics.maxRankMetaHeight, `width ${width}: mobile Top-3 metadata stays on one row`).toBeLessThanOrEqual(28);
        expect(metrics.rankMetaOverlaps, `width ${width}: mobile Top-3 metadata controls must not overlap`).toBe(false);
      }
      if (width === 980) {
        expect(metrics.gridCols, "width 980: layout should keep the readable category rail").toBe(2);
        expect(metrics.mainWidth, "width 980: main should retain useful reading width").toBeGreaterThan(650);
      }
      if (width >= 1181) {
        expect(metrics.gridCols, `width ${width}: wide desktop should restore both rails`).toBe(3);
      }
      if (width >= 1280) {
        expect(
          metrics.minRankSummaryWidth,
          `width ${width}: Top-3 summaries should remain useful on wide layouts`,
        ).toBeGreaterThanOrEqual(180);
        expect(
          metrics.maxRankSummaryHeight,
          `width ${width}: wide desktop should show up to two summary lines`,
        ).toBeGreaterThan(20);
        expect(
          metrics.maxRankSummaryHeight,
          `width ${width}: wide desktop summaries should remain clamped`,
        ).toBeLessThanOrEqual(38);
      } else {
        expect(
          metrics.maxRankSummaryHeight,
          `width ${width}: narrower layouts should keep summaries to one line`,
        ).toBeLessThanOrEqual(20);
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
      if (hasPending) {
        await expect(card).toHaveAttribute("data-summary-state", "pending");
        await expect(card).not.toHaveClass(/\bimportant\b/);
        await expect(card.locator(".badge.hot, .badge.new, .card-insight")).toHaveCount(0);
      }
    }
  });

  test("home uses system fonts without render-blocking external font requests", async ({ page }) => {
    const viewports = [
      { width: 390, height: 844 },
      { width: 768, height: 900 },
      { width: 1280, height: 900 },
    ];

    await page.setViewportSize(viewports[0]);
    await page.goto("/");
    await expect(page.locator('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]')).toHaveCount(0);

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        return new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
      });

      const metrics = await page.evaluate(() => {
        return {
          bodyFontFamily: getComputedStyle(document.body).fontFamily,
          horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });

      expect(metrics.bodyFontFamily, `${viewport.width}px uses the local system stack`).not.toMatch(/Inter|Noto Sans JP/);
      expect(metrics.bodyFontFamily, `${viewport.width}px keeps a cross-platform sans-serif fallback`).toMatch(
        /Arial|system-ui|Hiragino Sans|Yu Gothic UI|Meiryo|sans-serif/,
      );
      expect(metrics.horizontalOverflow, `${viewport.width}px keeps the page inside the viewport`).toBeLessThanOrEqual(0);
    }

    const fontResources = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)),
    );
    expect(fontResources, "Home does not fetch Google Fonts at runtime").toEqual([]);
  });

  // (archive-backed daily activity), not the publishable-live fallback. When
  // index.astro forgot to pass the `stats` prop the chart silently collapsed to
  // single-digit bars and looked like collection had stopped (see LL).
  test("home Last 7 days chart reflects stats.byDay activity", async ({ page }) => {
    await page.goto("/");
    const digest = page.locator(".digest");
    const bars = page.locator(".digest .spark .bars .bar .n");
    await expect(bars).toHaveCount(7);
    await expect(digest.locator(".kpi").first().locator(".k.i18n-ja")).toHaveText("本日ここまで");
    await expect(digest.locator(".kpi").first().locator(".k.i18n-en")).toHaveText("Today so far");
    await expect(digest.locator(".kpi .delta")).toHaveCount(0);
    await expect(digest).not.toContainText(/[+-]\d+%/);
    const counts = (await bars.allInnerTexts()).map((t) => Number(t.trim()));
    const todayValue = Number(
      (await digest.locator(".kpi").first().locator(".v").innerText()).trim(),
    );
    expect(todayValue, "current JST KPI and final chart bar use one live count").toBe(
      counts[counts.length - 1],
    );
    const metricsResponse = await page.request.get("/metrics.json");
    expect(metricsResponse.ok(), "metrics endpoint remains available").toBeTruthy();
    const metrics = await metricsResponse.json() as { todayEntries: number };
    expect(metrics.todayEntries, "metrics and Daily Summary share the current JST count").toBe(
      todayValue,
    );
    // Past days routinely have 30-120 articles in stats.byDay; the broken
    // fallback maxed out at single digits. A max over 20 proves stats wins.
    const max = Math.max(...counts);
    expect(max, `7-day bar counts were ${counts.join(",")}`).toBeGreaterThan(20);
    const dayScope = await digest.getAttribute("data-day-scope");
    expect(dayScope).toMatch(/^(today|latest)$/);
    await expect(digest.locator(".title h2.i18n-ja")).toHaveText(
      dayScope === "today" ? "今日の更新" : "直近の更新",
    );
    await expect(digest.locator(".ticker-panel .panel-title > .i18n-en")).toHaveText(
      dayScope === "today" ? "Today's top stories" : "Latest top stories",
    );
    const digestDate = digest.locator(".digest-date");
    const currentDate = digest.locator(".kpi-date");
    await expect(digestDate).toHaveAttribute("data-date-scope", "article");
    await expect(digestDate).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/);
    await expect(digestDate.locator(":scope > .i18n-ja")).toContainText(/\d{4}年\d+月\d+日/);
    await expect(digestDate.locator(":scope > .i18n-en")).toContainText(/[A-Z][a-z]+ \d{1,2}, \d{4}/);
    await expect(currentDate).toHaveAttribute("data-date-scope", "current");
    await expect(currentDate).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/);
    await expect(currentDate.locator(":scope > .i18n-ja")).toContainText(
      /\d+(?:月|\/)\d+(?:日)?/,
    );
    await expect(currentDate.locator(":scope > .i18n-en")).toContainText(/[A-Z][a-z]+ \d{1,2}/);
    const researchLane = digest.locator(".cat-list .cat-link").filter({
      has: page.locator(".name", { hasText: "Research + arXiv" }),
    });
    const researchLaneCount = await researchLane.count();
    expect(researchLaneCount, "Research can appear at most once in the top category slice").toBeLessThanOrEqual(1);
    if (researchLaneCount === 1) {
      await expect(researchLane).toHaveAttribute("href", "/categories/");
    }
    await expect(digest.locator(".retention-note .i18n-en")).toContainText(
      "Research includes arXiv",
    );
    await expect(digest.locator(".retention-note .i18n-en")).toContainText(
      "Retention may shrink past counts",
    );
    const boardItems = digest.locator(".ticker-panel [data-summary-state]");
    const emptyState = digest.locator(".ticker-panel [data-empty-reason]");
    if (await boardItems.count()) {
      await expect(emptyState).toHaveCount(0);
      for (const item of await boardItems.all()) {
        await expect(item).toHaveAttribute("data-summary-state", "ready");
      }
      const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
        entries: Array<{
          id: string;
          source: string;
          sourceType: string;
          url: string;
        }>;
      };
      const arxivIds = new Set(
        index.entries
          .filter((entry) => (
            entry.source.startsWith("arxiv-")
            || entry.sourceType === "paper"
              && /(?:^|\.)arxiv\.org$/i.test(new URL(entry.url).hostname)
          ))
          .map((entry) => entry.id),
      );
      const boardHrefs = await boardItems.locator('a[href^="/e/"]').evaluateAll((links) => (
        links.map((link) => link.getAttribute("href") ?? "")
      ));
      expect(
        boardHrefs.every((href) => {
          const id = href.split("/").filter(Boolean).at(-1);
          return !id || !arxivIds.has(id);
        }),
        `decision board must stay in the main Timeline lane: ${boardHrefs.join(",")}`,
      ).toBeTruthy();
    } else {
      await expect(emptyState).toBeVisible();
      await expect(emptyState).toHaveAttribute("data-empty-reason", /^(summary-pending|no-entries)$/);
    }
    const ticker = page.locator(".ticker-bar");
    if (await ticker.count()) {
      const tickerDayScope = await ticker.getAttribute("data-day-scope");
      expect(tickerDayScope).toMatch(/^(today|latest)$/);
      await expect(ticker.locator(".tb-label")).toContainText(
        tickerDayScope === "today" ? "TODAY" : "LATEST",
      );
      await expect(ticker.locator(".tb-live-dot")).toHaveCount(0);
    }
  });

  test("Daily Summary keeps a compact two-column overview across viewports", async ({ page }) => {
    const viewports = [
      { width: 1440, height: 900 },
      { width: 768, height: 900 },
      { width: 390, height: 844 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const digest = page.locator("[data-daily-summary]");
      await expect(digest).toBeVisible();
      const timelineCardsBeforeDigest = await digest.evaluate((element) => (
        Array.from(document.querySelectorAll("main article.card"))
          .filter((card) => Boolean(card.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))
          .length
      ));
      expect(
        timelineCardsBeforeDigest,
        `${viewport.width}px shows three Timeline decisions before the digest`,
      ).toBe(3);

      const metrics = await digest.evaluate((element) => {
        const spark = element.querySelector<HTMLElement>(".spark");
        const categories = element.querySelector<HTMLElement>(".cats");
        const bars = element.querySelector<HTMLElement>(".spark .bars");
        const categoryList = element.querySelector<HTMLElement>(".cat-list");
        if (!spark || !categories || !bars || !categoryList) {
          throw new Error("Daily Summary overview panels are incomplete");
        }
        return {
          digestHeight: element.getBoundingClientRect().height,
          sparkHeight: spark.getBoundingClientRect().height,
          categoryHeight: categories.getBoundingClientRect().height,
          barsHeight: bars.getBoundingClientRect().height,
          categoryColumns: getComputedStyle(categoryList).gridTemplateColumns
            .split(" ")
            .filter(Boolean).length,
          clippedCategoryLabels: Array.from(
            categoryList.querySelectorAll<HTMLElement>(".cat-link .name"),
          )
            .filter((label) => label.scrollWidth > label.clientWidth + 1)
            .map((label) => label.textContent?.trim() ?? ""),
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });

      expect(metrics.sparkHeight, `${viewport.width}px chart panel stays compact`).toBeLessThanOrEqual(180);
      expect(metrics.categoryHeight, `${viewport.width}px category panel stays compact`).toBeLessThanOrEqual(180);
      expect(metrics.barsHeight, `${viewport.width}px bar area has a bounded height`).toBeLessThanOrEqual(66);
      expect(metrics.categoryColumns, `${viewport.width}px category overview uses two columns`).toBe(2);
      expect(
        metrics.clippedCategoryLabels,
        `${viewport.width}px category labels remain readable`,
      ).toEqual([]);
      expect(metrics.pageOverflow, `${viewport.width}px has no horizontal overflow`).toBeLessThanOrEqual(0);
      if (viewport.width <= 390) {
        expect(metrics.digestHeight, "mobile Daily Summary is materially shorter than the old 1309px layout")
          .toBeLessThanOrEqual(1150);
      }
    }
  });

  test("Daily Summary bars reveal once and reduced motion shows them immediately", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const digest = page.locator("[data-daily-summary]");
    const firstFill = digest.locator(".spark .fill").first();

    await expect(digest).toHaveAttribute("data-chart-state", "idle");
    await expect.poll(async () => firstFill.evaluate((element) => (
      Number(getComputedStyle(element).opacity)
    ))).toBeLessThan(0.5);

    await digest.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(digest).toHaveAttribute("data-chart-state", "visible");
    await expect.poll(async () => firstFill.evaluate((element) => (
      Number(getComputedStyle(element).opacity)
    ))).toBeGreaterThan(0.95);
    await expect(firstFill).toHaveCSS("animation-name", "digest-bar-rise");
    const boardPulseIterations = await digest.locator(".ticker-panel .panel-title .panel-sub")
      .evaluate((element) => getComputedStyle(element, "::before").animationIterationCount);
    expect(boardPulseIterations, "the static top-stories snapshot does not blink forever").toBe("1");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    const reducedDigest = page.locator("[data-daily-summary]");
    const reducedFill = reducedDigest.locator(".spark .fill").first();
    await expect(reducedDigest).toHaveAttribute("data-chart-state", "visible");
    await expect.poll(async () => reducedFill.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        animationName: styles.animationName,
        transform: styles.transform,
        opacity: Number(styles.opacity),
      };
    })).toEqual({
      animationName: "none",
      transform: "none",
      opacity: 1,
    });
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

    const topTitles = await page.locator(".top-rank-list .top-rank-item .rank-title").allInnerTexts();
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
    await expectMobileFirstDecisionNearViewport(page);
    const firstArticleBox = await firstArticle.boundingBox();
    expect(firstArticleBox, "first article visible on mobile").not.toBeNull();
    expect(Math.round(firstArticleBox!.y), "mobile first article remains near the first viewport").toBeLessThanOrEqual(
      MOBILE_FIRST_DECISION_MAX_Y,
    );
    const mobileTargets = await page.locator(".banner-cta, .tb-ctrl, .tb-slide.is-active").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(mobileTargets.length, "mobile hero and ticker expose actionable controls").toBeGreaterThan(0);
    for (const target of mobileTargets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload();
    const tabletTickerTargets = await page.locator(".tb-ctrl, .tb-slide.is-active").evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    expect(tabletTickerTargets.length, "tablet ticker exposes actionable controls").toBeGreaterThan(0);
    for (const target of tabletTickerTargets) {
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
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
    if ((await page.locator(".tb-live-dot").count()) > 0) {
      await expect
        .poll(() => page.locator(".tb-live-dot").evaluate((el) => getComputedStyle(el).animationName))
        .toBe("none");
    }
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
    const bodyState = await page.locator("article.entry-detail").getAttribute("data-body-state");
    const summaryState = await page.locator("article.entry-detail").getAttribute("data-summary-state");
    expect(bodyState).toMatch(/^(ready|queued|summary-only)$/);
    expect(summaryState).toMatch(/^(ready|pending)$/);

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
    await expect(sourceCta.locator(".ed-header-cta-copy > .i18n-ja")).toHaveText("元記事を読む");
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
    const adjacentHrefs = await page.locator(".ed-pn-card").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter(Boolean),
    );
    const relatedHrefs = await page.locator(".ed-rel-card").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href")).filter(Boolean),
    );
    for (const adjacentHref of adjacentHrefs) {
      expect(
        relatedHrefs,
        "previous/next articles are not repeated in related cards",
      ).not.toContain(adjacentHref);
    }

    if (hasProse) {
      expect(bodyState).toBe("ready");
      expect(summaryState).toBe("ready");
      await expect(prose.first()).toBeVisible();
      await expect(digest).toHaveCount(0);
      await expect(pending).toHaveCount(0);
    } else if (hasDigest) {
      expect(summaryState).toBe("ready");
      await expect(digest.first()).toBeVisible();
      if (bodyState === "queued") {
        await expect(digest.locator(".ed-summary-only-head .i18n-ja")).toHaveText(
          "AI解説本文を Queue に投入済み",
        );
        await expect(digest.locator(".ed-summary-only-note .i18n-ja")).toContainText(
          "完了時刻は確約せず",
        );
      } else {
        expect(bodyState).toBe("summary-only");
        await expect(digest.locator(".ed-summary-only-head .i18n-ja")).toHaveText(
          "本文は元記事で確認",
        );
        await expect(digest.locator(".ed-summary-only-note .i18n-ja")).toContainText(
          "このページには AI 要約のみを収録",
        );
      }
      await expect(prose).toHaveCount(0);
      await expect(pending).toHaveCount(0);
      const digestFooterGeometry = await page.evaluate(() => {
        const note = document.querySelector<HTMLElement>(".ed-summary-only-note");
        const footer = document.querySelector<HTMLElement>(".footer-bar");
        if (!note || !footer) return null;
        const noteRect = note.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        return {
          footerPosition: getComputedStyle(footer).position,
          overlaps:
            noteRect.bottom > footerRect.top &&
            noteRect.top < footerRect.bottom &&
            footerRect.width > 0 &&
            footerRect.height > 0,
        };
      });
      expect(digestFooterGeometry).not.toBeNull();
      expect(digestFooterGeometry!.footerPosition).toBe("static");
      expect(digestFooterGeometry!.overlaps).toBe(false);
    } else {
      expect(bodyState).toBe("summary-only");
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

  test("desktop summary-only detail keeps its note clear of the footer", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: SummaryFixtureEntry[];
    };
    const bodyFile = JSON.parse(readFileSync("data/bodies.json", "utf8")) as {
      bodies: Record<string, unknown>;
    };
    const summaryOnlyEntry = index.entries.find(
      (entry) =>
        !bodyFile.bodies[entry.id] &&
        Boolean(
          summaryForLangWithFallback(entry, "ja").text ||
            summaryForLangWithFallback(entry, "en").text,
        ),
    );
    expect(summaryOnlyEntry, "live summary-only article fixture").toBeTruthy();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/e/${summaryOnlyEntry!.id}/`);
    const note = page.locator(".ed-summary-only-note");
    const footer = page.locator(".footer-bar");
    await expect(note).toBeVisible();
    await note.scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => {
      const noteElement = document.querySelector<HTMLElement>(".ed-summary-only-note");
      const footerElement = document.querySelector<HTMLElement>(".footer-bar");
      if (!noteElement || !footerElement) return null;
      const noteRect = noteElement.getBoundingClientRect();
      const footerRect = footerElement.getBoundingClientRect();
      return {
        footerPosition: getComputedStyle(footerElement).position,
        overlaps:
          noteRect.bottom > footerRect.top &&
          noteRect.top < footerRect.bottom &&
          footerRect.width > 0 &&
          footerRect.height > 0,
      };
    });
    expect(geometry).toEqual({ footerPosition: "static", overlaps: false });
  });

  test("article body provenance and supporting copy follow the active language", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string }>;
    };
    const bodyFile = JSON.parse(readFileSync("data/bodies.json", "utf8")) as {
      bodies: Record<string, { bodyJa?: string; bodyEn?: string }>;
    };
    const liveIds = new Set(index.entries.map((entry) => entry.id));
    const bodyEntryId = Object.entries(bodyFile.bodies).find(([id, body]) => {
      const jaParagraphs = (body.bodyJa ?? "").split(/\n{2,}/).filter(Boolean);
      const enParagraphs = (body.bodyEn ?? "").split(/\n{2,}/).filter(Boolean);
      return liveIds.has(id) && jaParagraphs.length >= 3 && enParagraphs.length >= 3;
    })?.[0];
    expect(bodyEntryId, "live article with bilingual long-form body fixture").toBeTruthy();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/e/${bodyEntryId}/`);

    const bodyOrigin = page.locator(".ed-body-origin");
    await expect(bodyOrigin).toBeVisible();
    await expect(bodyOrigin).toHaveAttribute(
      "data-body-source",
      "summary-and-collection-metadata",
    );
    await expect(bodyOrigin.locator(":scope > .i18n-ja")).toContainText(
      "要約と収集メタデータ",
    );
    await expect(page.locator("#toc-list-ja")).toBeVisible();
    await expect(page.locator("#toc-list-en")).toBeHidden();
    await expect(page.locator(".reading-card .rail-title > .i18n-ja")).toBeVisible();
    await expect(page.locator(".ed-pn")).toHaveAccessibleName("同カテゴリの前後の記事");
    await expect(page.locator("#ed-fab")).toHaveAccessibleName("トップに戻る");

    await page.getByRole("button", { name: "英語表示に切り替え" }).click();
    await expect(bodyOrigin.locator(":scope > .i18n-en")).toBeVisible();
    await expect(bodyOrigin.locator(":scope > .i18n-en")).toContainText(
      "summaries and collected metadata",
    );
    await expect(page.locator("#toc-list-ja")).toBeHidden();
    await expect(page.locator("#toc-list-en")).toBeVisible();
    await expect(page.locator(".reading-card .rail-title > .i18n-en")).toContainText(
      "Before reading",
    );
    await expect(
      page.locator(".ed-meta-strip .k > .i18n-en").filter({ hasText: "Source" }).first(),
    ).toBeVisible();
    await expect(page.locator(".ed-pn")).toHaveAccessibleName(
      "Adjacent articles in this category",
    );
    await expect(page.locator("#ed-fab")).toHaveAccessibleName("Back to top");

    await page.locator("#p-en-2").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      window.scrollTo({
        top: window.scrollY + rect.top - window.innerHeight * 0.35,
        behavior: "auto",
      });
    });
    await expect
      .poll(() => page.locator('#toc-list-en a[data-toc-target="p-en-2"].active').count())
      .toBe(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(bodyOrigin).toBeVisible();
    const mobileGeometry = await page.evaluate(() => {
      const rect = document.querySelector(".ed-body-origin")?.getBoundingClientRect();
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        origin: rect ? { left: rect.left, right: rect.right, width: rect.width } : null,
      };
    });
    expect(mobileGeometry.scrollWidth).toBeLessThanOrEqual(mobileGeometry.innerWidth + 1);
    expect(mobileGeometry.origin).not.toBeNull();
    expect(mobileGeometry.origin?.left ?? -1).toBeGreaterThanOrEqual(0);
    expect(mobileGeometry.origin?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      mobileGeometry.innerWidth + 1,
    );
  });

  test("detail copy action writes the title and one URL", async ({ page, context }) => {
    await page.goto("/");
    const firstEntryLink = page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first();
    await expect(firstEntryLink).toBeVisible();
    await firstEntryLink.click();
    await expect(page).toHaveURL(/\/e\/.+\/$/);

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const copyAction = page.locator("button.ed-share-btn[data-share-copy]");
    await expect(copyAction).toHaveAccessibleName("タイトルと URL をコピー");
    const titleJa = (await copyAction.getAttribute("data-title-ja"))?.trim() ?? "";
    const titleEn = (await copyAction.getAttribute("data-title-en"))?.trim() ?? "";
    const url = (await copyAction.getAttribute("data-url"))?.trim() ?? "";
    expect(titleJa).toBeTruthy();
    expect(titleEn).toBeTruthy();
    expect(url).toBe(`https://techdb.studio344.net${new URL(page.url()).pathname}`);
    await expect(page.locator('meta[property="article:modified_time"]')).toHaveCount(0);
    const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(jsonLd.join("\n")).not.toContain('"dateModified"');
    await expect(page.locator("#ed-toast")).toHaveAttribute("aria-live", "polite");
    await expect(page.locator("#ed-toast")).toHaveAttribute("aria-atomic", "true");
    await copyAction.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${titleJa}\n${url}`);

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(copyAction).toHaveAccessibleName("Copy title + URL");
    await copyAction.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`${titleEn}\n${url}?lang=en`);
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

      if (width === 390) {
        await page.evaluate(() => window.scrollTo({ top: 900, behavior: "auto" }));
        const fab = page.locator("#ed-fab");
        await expect(fab).toHaveClass(/show/);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const fab = document.querySelector<HTMLElement>("#ed-fab");
              const tabbar = document.querySelector<HTMLElement>(".mobile-tabbar");
              if (!fab || !tabbar) return Number.NEGATIVE_INFINITY;
              return tabbar.getBoundingClientRect().top - fab.getBoundingClientRect().bottom;
            }),
          )
          .toBeGreaterThanOrEqual(8);
        const fixedGeometry = await page.evaluate(() => {
          const fab = document.querySelector<HTMLElement>("#ed-fab");
          const tabbar = document.querySelector<HTMLElement>(".mobile-tabbar");
          if (!fab || !tabbar) return null;
          const fabRect = fab.getBoundingClientRect();
          const tabbarRect = tabbar.getBoundingClientRect();
          const hit = document.elementFromPoint(
            fabRect.left + fabRect.width / 2,
            fabRect.top + fabRect.height / 2,
          );
          return {
            fab: {
              top: fabRect.top,
              right: fabRect.right,
              bottom: fabRect.bottom,
              left: fabRect.left,
              width: fabRect.width,
              height: fabRect.height,
            },
            tabbarTop: tabbarRect.top,
            hitIsFab: hit === fab || fab.contains(hit),
          };
        });
        expect(fixedGeometry).not.toBeNull();
        expect(fixedGeometry!.fab.width).toBeGreaterThanOrEqual(44);
        expect(fixedGeometry!.fab.height).toBeGreaterThanOrEqual(44);
        expect(fixedGeometry!.fab.bottom).toBeLessThanOrEqual(
          fixedGeometry!.tabbarTop - 8,
        );
        expect(fixedGeometry!.hitIsFab).toBe(true);
      }
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
    const cardExcerpt = pendingCard.locator("[data-source-excerpt]");
    const cardExcerptText = (await cardExcerpt.count()) > 0
      ? (await cardExcerpt.locator("blockquote").textContent())?.trim() ?? ""
      : "";
    if (cardExcerptText) {
      await expect(cardExcerpt).toHaveAttribute("data-excerpt-scope", "source");
      await expect(cardExcerpt).toContainText("AI 要約ではありません");
    }
    const detailHref = await pendingCard.locator('a[href^="/e/"]').first().getAttribute("href");
    expect(detailHref, "pending card should expose an internal detail link").toBeTruthy();

    await page.goto(detailHref!);
    const pending = page.locator(".ed-pending-summary");

    await expect(pending).toBeVisible();
    await expect(pending.locator(".i18n-ja").first()).toHaveText("AI 要約 準備待ち");
    await expect(pending.locator(".i18n-en").first()).toHaveText("Summary pending");
    await expect(pending).not.toContainText("近日中に AI が生成");
    if (cardExcerptText) {
      const detailExcerpt = pending.locator("[data-source-excerpt]");
      await expect(detailExcerpt).toBeVisible();
      await expect(detailExcerpt).toHaveAttribute("data-excerpt-scope", "source");
      await expect(detailExcerpt.locator("blockquote")).toContainText(
        cardExcerptText.replace(/…$/u, ""),
      );
    }
    await expect(page.locator(".ed-disclaim")).toHaveCount(0);
    await expect(page.locator(".ed-header-cta")).toHaveCount(1);
    await expect(page.locator(".ed-share-btn[data-share-copy]")).toHaveCount(1);
    await expect(page.locator(".ed-freshness, .rail-freshness")).toHaveCount(0);
    await expect(page.locator('article.entry-detail a[target="_blank"]')).toHaveCount(1);
    await expect(page.locator('article.entry-detail a[target="_blank"]').first()).toHaveAttribute(
      "href", /^(?!\/e\/).+/,
    );

    const description = await page.locator('meta[name="description"]').getAttribute("content");
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content");
    const ogDescription = await page.locator('meta[property="og:description"]').getAttribute("content");
    const twitterDescription = await page.locator('meta[name="twitter:description"]').getAttribute("content");
    expect(description).toMatch(/が公開した.+の記事です/);
    expect(description).not.toMatch(/AI 要約は準備中|近日中/);
    expect(description).not.toBe(ogTitle);
    expect(ogDescription).toBe(description);
    expect(twitterDescription).toBe(description);

    const structuredData = JSON.parse(
      await page.locator('script[type="application/ld+json"]').textContent() ?? "{}",
    ) as { headline?: string; description?: string; inLanguage?: string };
    expect(structuredData.description).not.toMatch(/AI 要約は準備中|AI summary pending|近日中/);
    expect(structuredData.description).not.toBe(structuredData.headline);
    expect(structuredData.inLanguage).toMatch(/^(ja-JP|en)$/);
  });

  test("sidebar category labels stay readable and only marquee when needed", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
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
    expect(labelMetrics.height, "label should not wrap onto multiple lines").toBeLessThanOrEqual(
      labelMetrics.lineHeight + 2,
    );
    const needsMarquee = marqueeScrollWidth - labelMetrics.clientWidth > 1;
    expect(needsMarquee, "the standard desktop sidebar shows the longest label at rest").toBe(false);
    expect(await opencodeItem.getAttribute("data-marquee")).toBeNull();
    const sidebarGeometry = await opencodeItem.evaluate((item) => {
      const box = (selector: string) => {
        const rect = item.querySelector(selector)?.getBoundingClientRect();
        return rect
          ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }
          : null;
      };
      const itemRect = item.getBoundingClientRect();
      return {
        item: { left: itemRect.left, right: itemRect.right },
        brand: box(".brand-tile"),
        name: box(".name"),
        spark: box(".spark"),
        count: box(".count"),
      };
    });
    expect(sidebarGeometry.name?.width, "category label keeps a useful reading width").toBeGreaterThan(80);
    expect(sidebarGeometry.brand?.right).toBeLessThanOrEqual((sidebarGeometry.name?.left ?? 0) + 1);
    expect(sidebarGeometry.name?.right).toBeLessThanOrEqual((sidebarGeometry.count?.left ?? 0) + 1);
    expect(sidebarGeometry.spark?.right).toBeLessThanOrEqual((sidebarGeometry.count?.left ?? 0) + 1);
    expect(sidebarGeometry.count?.right).toBeLessThanOrEqual(sidebarGeometry.item.right + 1);

    expect(
      marqueeScrollWidth,
      "the expanded sidebar should show the longest category label without clipping",
    ).toBeLessThanOrEqual(labelMetrics.clientWidth + 1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    for (const route of ["/categories/", "/c/copilot/"]) {
      for (const width of [1000, 981]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(route);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        const layoutMetrics = await page.evaluate(() => {
          const layout = document.querySelector<HTMLElement>(".layout:not(.lane-layout)");
          const sidebar = layout?.querySelector<HTMLElement>("aside.left");
          const main = layout?.querySelector<HTMLElement>("main");
          const items = Array.from(document.querySelectorAll<HTMLElement>("aside.left .side-item"));
          return {
            sidebarWidth: sidebar?.getBoundingClientRect().width ?? 0,
            mainWidth: main?.getBoundingClientRect().width ?? 0,
            labelsFit: items.length > 0 && items.every((item) => {
              const label = item.querySelector<HTMLElement>(".name");
              return !!label && label.scrollWidth <= label.clientWidth + 1 && !item.hasAttribute("data-marquee");
            }),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(layoutMetrics.sidebarWidth, `${route} at ${width}px keeps a readable sidebar`).toBeGreaterThanOrEqual(228);
        expect(layoutMetrics.mainWidth, `${route} at ${width}px preserves the main content width`).toBeGreaterThanOrEqual(600);
        expect(layoutMetrics.labelsFit, `${route} at ${width}px keeps every category label visible`).toBe(true);
        expect(layoutMetrics.overflow, `${route} at ${width}px should not overflow horizontally`).toBeLessThanOrEqual(0);
      }
    }
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

  test("Spotlight summary language and fallback badge stay truthful", async ({ page }) => {
    await page.goto("/");

    const jaSummary = page.locator("article.featured .featured-summary.i18n-ja");
    await expect(jaSummary).toBeVisible();
    const jaLang = await jaSummary.getAttribute("lang");
    expect(["ja", "en"]).toContain(jaLang);
    if (jaLang === "en") {
      const badge = jaSummary.locator(
        '.language-fallback-badge[data-fallback-language="en"]',
      );
      await expect(badge.locator(".i18n-ja")).toHaveText("AI 要約 EN");
    } else {
      await expect(jaSummary.locator(".language-fallback-badge")).toHaveCount(0);
    }

    await page.locator('.lang-btn[data-lang="en"]').click();
    const enSummary = page.locator("article.featured .featured-summary.i18n-en");
    await expect(enSummary).toBeVisible();
    const enLang = await enSummary.getAttribute("lang");
    expect(["en", "ja"]).toContain(enLang);
    if (enLang === "ja") {
      const badge = enSummary.locator(
        '.language-fallback-badge[data-fallback-language="ja"]',
      );
      await expect(badge.locator(".i18n-en")).toHaveText("Japanese AI summary");
    } else {
      await expect(enSummary.locator(".language-fallback-badge")).toHaveCount(0);
    }
  });

  test("Spotlight copy describes priority without claiming newest", async ({ page }) => {
    await page.goto("/");

    const label = page.locator("article.featured .featured-label");
    await expect(label.locator(".i18n-ja")).toContainText("要約済みの優先候補");
    await expect(label.locator(".i18n-ja")).not.toContainText("最新");
    await expect(label.locator(".i18n-en")).toContainText("summary-ready priority pick");
    await expect(label.locator(".i18n-en")).not.toContainText("latest");
  });

  test("language toggle changes html data-lang", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const jaBtn = page.locator('.lang-btn[data-lang="ja"]');
    const enBtn = page.locator('.lang-btn[data-lang="en"]');

    await expect(jaBtn).toHaveAttribute("aria-pressed", "true");
    await expect(jaBtn).toHaveAccessibleName("JA 日本語表示中");
    await expect(enBtn).toHaveAccessibleName("EN 英語表示に切り替え");

    await enBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(enBtn).toHaveAttribute("aria-pressed", "true");
    await expect(jaBtn).toHaveAccessibleName("JA Switch interface to Japanese");
    await expect(enBtn).toHaveAccessibleName("EN English interface active");
    await expect(page.locator(".banner .tagline.tagline-compact.i18n-en")).toContainText(
      /One batch hourly.*about every 6 hours/,
    );
    await page.locator(".mobile-tabbar button[data-menu-trigger]").click();
    const menu = page.locator("#site-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator("small .i18n-en").first()).toBeVisible();
    await expect(menu.locator("small .i18n-en").first()).not.toHaveText("");
    await expect(menu.locator("small .i18n-ja").first()).toBeHidden();
    await expect(menu.locator("[data-search-trigger] small .i18n-en")).toHaveText(
      "Search by keyword, source, or tag",
    );
    await page.keyboard.press("Escape");

    await jaBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "ja");
    await expect(jaBtn).toHaveAttribute("aria-pressed", "true");
    await expect(jaBtn).toHaveAccessibleName("JA 日本語表示中");
    await expect(enBtn).toHaveAccessibleName("EN 英語表示に切り替え");
    for (const button of [jaBtn, enBtn]) {
      const box = await button.boundingBox();
      expect(box, "language toggle has a rendered box").not.toBeNull();
      expect(box!.width, "language toggle meets the mobile target width").toBeGreaterThanOrEqual(44);
      expect(box!.height, "language toggle meets the mobile target height").toBeGreaterThanOrEqual(44);
    }
  });

  test("a fresh browser with no local storage renders JA by default with no lang param", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-lang", "ja");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.locator('.lang-btn[data-lang="ja"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page).not.toHaveURL(/[?&]lang=/);
  });

  test("a shared ?lang=en URL reproduces English in a fresh browser with no local storage", async ({ page }) => {
    // Simulates a reader opening a link someone shared after switching to
    // EN: no localStorage exists yet, so the URL alone must be truthful.
    await page.goto("/?lang=en");
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator('.lang-btn[data-lang="en"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("article.featured .featured-label .i18n-en")).toBeVisible();
  });

  test("?lang=en on an article/search/category URL is truthful and preserves other query params", async ({
    page,
  }) => {
    await page.goto("/");
    const detailPath = await page.locator(TIMELINE_ENTRY_LINK_SELECTOR).first().getAttribute("href");
    expect(detailPath, "at least one article detail href is available").toBeTruthy();

    // Article detail: a fresh visit with ?lang=en renders English immediately.
    await page.goto(`${detailPath}?lang=en`);
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");

    // Search: ?lang=en does not clobber the existing ?q= search intent, and
    // the query param order/content is preserved verbatim.
    await page.goto("/search/?q=Copilot&lang=en");
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(page.locator("#pagefind-search-input")).toHaveValue("Copilot");
    await expect(page).toHaveURL(/\/search\/\?q=Copilot&lang=en$/);

    // Category: ?lang=en renders English on a taxonomy destination too.
    await page.goto("/c/copilot/?lang=en");
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
  });

  test("?lang=en persists via local storage across navigation to a page without the param", async ({
    page,
  }) => {
    await page.goto("/?lang=en");
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");

    // A plain internal link (no ?lang=) still carries EN forward via
    // localStorage, and the new page's address bar becomes truthful too.
    await page.locator("a.footer-run-link").click();
    await expect(page).toHaveURL(/\/status\/?\?lang=en$/);
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
  });

  test("language toggle syncs the URL via replaceState and does not consume back navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page.goto("/status/");
    await expect(page.locator("html")).toHaveAttribute("data-lang", "ja");
    await expect(page).not.toHaveURL(/[?&]lang=/);

    const enBtn = page.locator('.lang-btn[data-lang="en"]');
    await enBtn.click();
    await expect(page).toHaveURL(/\/status\/?\?lang=en$/);

    // Back must return to the actual previous *page* ("/"), not just undo
    // the toggle: replaceState never pushed a history entry for it.
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/");

    await page.goForward();
    await expect(page).toHaveURL(/\/status\/?\?lang=en$/);
  });

  test("language toggle keeps focus on the clicked button", async ({ page }) => {
    await page.goto("/");
    const enBtn = page.locator('.lang-btn[data-lang="en"]');
    await enBtn.click();
    await expect(enBtn).toBeFocused();
    const jaBtn = page.locator('.lang-btn[data-lang="ja"]');
    await jaBtn.click();
    await expect(jaBtn).toBeFocused();
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
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: SummaryFixtureEntry[];
    };
    const fallbackEntry = index.entries.find((entry) => {
      const result = summaryForLangWithFallback(entry, "en");
      return result.isFallback && result.fallbackLang === "ja";
    });
    if (!fallbackEntry) {
      // The generated corpus can validly be fully bilingual. The fallback
      // helper contract remains covered independently in web-data tests.
      expect(fallbackEntry, "a fully bilingual generated corpus is valid").toBeUndefined();
      return;
    }

    await page.goto(`/e/${fallbackEntry.id}/`);
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(page.locator(".ed-tldr-title.i18n-en")).toHaveText("Summary highlight");
    const fallbackBody = page.locator(".ed-tldr-body.i18n-en");
    await expect(fallbackBody).toBeVisible();
    await expect(fallbackBody).toHaveAttribute("lang", "ja");
    const badge = fallbackBody.locator(
      '.language-fallback-badge[data-fallback-language="ja"]',
    );
    await expect(badge.locator(".i18n-en")).toHaveText("Japanese AI summary");
    await expect(fallbackBody.locator('[lang="ja"]')).not.toHaveText("");
    await expect(page.locator(".ed-disclaim")).toHaveAttribute("data-generation-scope", "ja-only");
  });

  test("detail Japanese TLDR labels an English-language fallback as a state", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: SummaryFixtureEntry[];
    };
    const fallbackEntry = index.entries.find((entry) => {
      const result = summaryForLangWithFallback(entry, "ja");
      return result.isFallback && result.fallbackLang === "en";
    });
    if (!fallbackEntry) {
      expect(fallbackEntry, "a fully bilingual generated corpus is valid").toBeUndefined();
      return;
    }

    await page.goto(`/e/${fallbackEntry.id}/`);
    await expect(page.locator(".ed-tldr-title.i18n-ja")).toHaveText("要点サマリ");
    const fallbackBody = page.locator(".ed-tldr-body.i18n-ja");
    await expect(fallbackBody).toBeVisible();
    await expect(fallbackBody).toHaveAttribute("lang", "en");
    const badge = fallbackBody.locator(
      '.language-fallback-badge[data-fallback-language="en"]',
    );
    await expect(badge.locator(".i18n-ja")).toHaveText("AI 要約 EN");
    await expect(fallbackBody.locator('[lang="en"]')).not.toHaveText("");
    const disclaimer = page.locator(".ed-disclaim");
    await expect(disclaimer).toHaveAttribute("data-generation-scope", "en-only");
    await expect(disclaimer.locator(".i18n-ja")).toContainText("日本語要約は準備中");
  });

  test("mobile detail hero media keeps its reserved height through image failure", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{
        id: string;
        image?: { src?: string };
      }>;
    };
    const imageEntry = index.entries.find((entry) => entry.image?.src?.trim());
    expect(imageEntry?.image?.src, "the generated corpus contains a detail hero image").toBeTruthy();
    await page.route(imageEntry!.image!.src!, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4wAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/e/${imageEntry!.id}/`);

    const hero = page.locator(".ed-hero");
    const heroImage = hero.locator(".ed-hero-img");
    await expect(hero).toHaveClass(/ed-hero-loaded/);
    const loadedGeometry = await hero.evaluate((element) => {
      const heroRect = element.getBoundingClientRect();
      const imageRect = element.querySelector("img")?.getBoundingClientRect();
      return {
        hero: { width: heroRect.width, height: heroRect.height },
        image: imageRect ? { width: imageRect.width, height: imageRect.height } : null,
      };
    });
    expect(loadedGeometry.hero.width).toBeGreaterThan(300);
    expect(loadedGeometry.hero.height).toBeGreaterThanOrEqual(188);
    expect(loadedGeometry.image?.height).toBeGreaterThanOrEqual(188);
    expect(loadedGeometry.image?.width).toBeGreaterThan(300);

    await heroImage.dispatchEvent("error");
    await expect(hero).toHaveClass(/ed-hero-failed/);
    const failedGeometry = await hero.evaluate((element) => {
      const heroRect = element.getBoundingClientRect();
      const imageRect = element.querySelector("img")?.getBoundingClientRect();
      const fallbackRect = element.querySelector(".ed-hero-fallback")?.getBoundingClientRect();
      return {
        hero: { width: heroRect.width, height: heroRect.height },
        image: imageRect ? { width: imageRect.width, height: imageRect.height } : null,
        fallback: fallbackRect
          ? { width: fallbackRect.width, height: fallbackRect.height }
          : null,
      };
    });
    expect(failedGeometry.image?.width ?? 0, "failed hero image leaves layout flow").toBe(0);
    expect(failedGeometry.fallback?.height).toBeGreaterThanOrEqual(188);
    expect(failedGeometry.fallback?.width).toBeGreaterThan(300);
    expect(
      Math.abs(failedGeometry.hero.height - loadedGeometry.hero.height),
      "image failure preserves the reserved hero height",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(failedGeometry.hero.width - loadedGeometry.hero.width),
      "image failure preserves the reserved hero width",
    ).toBeLessThanOrEqual(1);
  });

  test("arXiv detail returns to the paper lane instead of Research", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{
        id: string;
        source: string;
        sourceType: string;
        url: string;
      }>;
    };
    const arxivEntry = index.entries.find((entry) => (
      entry.source.startsWith("arxiv-")
      || entry.sourceType === "paper"
        && /(?:^|\.)arxiv\.org$/i.test(new URL(entry.url).hostname)
    ));
    expect(arxivEntry, "the generated corpus contains an arXiv detail entry").toBeTruthy();

    await page.goto(`/e/${arxivEntry!.id}/`);
    await expect(page.locator('.crumb-inner a[href="/arxiv/"]')).toHaveText("arXiv");
    await expect(page.locator('.header-switcher a[href="/arxiv"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('.mobile-tabbar a[href="/arxiv"]')).toHaveClass(/\bactive\b/);
    await expect(page.locator('.mobile-tabbar a[href="/"]')).not.toHaveClass(/\bactive\b/);
    await expect(page.locator('.mobile-tabbar a[href="/arxiv"]')).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator(".ed-cat-pill")).toHaveAttribute("href", "/arxiv/");
    await expect(page.locator(".ed-cat-pill")).toContainText("arXiv");
    await expect(page.locator(".cat-jump-link")).toHaveAttribute("href", "/arxiv/");
    await expect(page.locator(".cat-jump-link .cat-jump-name")).toHaveText("arXiv");
    await expect(page.locator('.cat-jump-link[href="/c/research"]')).toHaveCount(0);
    const importanceStanding = page.locator('[data-importance-standing="arxiv"] .muted-sm');
    await expect(importanceStanding.locator(".i18n-ja")).toContainText(
      /^\(arXiv \d+件中、同等以上 \d+件\)$/,
    );
    await expect(importanceStanding.locator(".i18n-ja")).not.toContainText("Papers / Benchmarks");
    await expect(page.locator("aside.left .side-item.active")).toHaveCount(0);
    await expect(page.locator('a[href="/c/research"].ed-cat-pill')).toHaveCount(0);
    const format = page.locator(`[data-entry-format="${arxivEntry!.sourceType}"]`);
    await expect(format.locator(".k .i18n-ja")).toHaveText("配信形式");
    await expect(format.locator(".v .i18n-ja")).toHaveText("論文");
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(format.locator(".k .i18n-en")).toBeVisible();
    await expect(format.locator(".k .i18n-en")).toHaveText("Format");
    await expect(format.locator(".v .i18n-en")).toHaveText("Paper");
    await expect(format.locator(".v .i18n-ja")).toBeHidden();
    await expect(importanceStanding.locator(".i18n-en")).toContainText(
      /^\(\d+ of \d+ arXiv entries are equal or higher\)$/,
    );
    const moreLink = page.locator(".ed-rel-h-more");
    if (await moreLink.count()) {
      await expect(moreLink).toHaveAttribute("href", "/arxiv/");
    }
  });

  test("detail and category supporting titles follow the active language", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{
        id: string;
        source: string;
        sourceType: string;
        url: string;
      }>;
    };
    const arxivEntry = index.entries.find((entry) => (
      entry.source.startsWith("arxiv-")
      || entry.sourceType === "paper"
        && /(?:^|\.)arxiv\.org$/i.test(new URL(entry.url).hostname)
    ));
    expect(arxivEntry, "the generated corpus contains an arXiv detail entry").toBeTruthy();
    await page.goto(`/e/${arxivEntry!.id}/`);

    const supportingLinks = page.locator(".ed-pn-card, .ed-rel-card, .rail-list > li > a");
    expect(
      await supportingLinks.count(),
      "the detail page exposes at least one supporting article title",
    ).toBeGreaterThan(0);
    const slots = await supportingLinks.evaluateAll((links) => links.map((link) => ({
      ja: link.querySelector<HTMLElement>(".i18n-ja")?.textContent?.trim() ?? "",
      en: link.querySelector<HTMLElement>(".i18n-en")?.textContent?.trim() ?? "",
    })));
    expect(slots.every((slot) => slot.ja.length > 0 && slot.en.length > 0)).toBeTruthy();

    await page.locator('.lang-btn[data-lang="en"]').click();
    const visibleLanguages = await supportingLinks.first().evaluate((link) => ({
      ja: getComputedStyle(link.querySelector<HTMLElement>(".i18n-ja")!).display,
      en: getComputedStyle(link.querySelector<HTMLElement>(".i18n-en")!).display,
    }));
    expect(visibleLanguages.ja).toBe("none");
    expect(visibleLanguages.en).not.toBe("none");

    await page.goto("/categories/");
    const latest = page.locator(".cat-latest").first();
    await expect(latest).toBeVisible();
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(latest.locator("strong.i18n-ja")).toBeHidden();
    await expect(latest.locator("strong.i18n-en")).toBeVisible();
    await expect(latest.locator("strong.i18n-en")).not.toHaveText("");
  });

  test("detail page exposes one explicit Pagefind title instead of concatenating language variants", async ({ page }) => {
    await page.goto("/");
    const detailHref = await page
      .locator('main article.card:has(.summary .s-text) h3.title a[href^="/e/"]')
      .first()
      .getAttribute("href");
    expect(detailHref, "home should link to at least one detail page").toBeTruthy();
    await page.goto(detailHref!);

    const pagefindTitle = page.locator('meta[data-pagefind-meta="title[content]"]');
    await expect(pagefindTitle).toHaveCount(1);
    const pagefindTitleJa = page.locator('meta[data-pagefind-meta="titleJa[content]"]');
    const pagefindTitleEn = page.locator('meta[data-pagefind-meta="titleEn[content]"]');
    expect(
      await pagefindTitleJa.count() + await pagefindTitleEn.count(),
      "at least one validated language-specific title is indexed",
    ).toBeGreaterThan(0);
    const indexedTitle = ((await pagefindTitle.getAttribute("content")) ?? "").trim();
    const visibleJaTitle = ((await page.locator(".ed-title .i18n-ja .ed-title-text").textContent()) ?? "").trim();
    expect(indexedTitle).toBeTruthy();
    expect(indexedTitle).toBe(visibleJaTitle);
    for (const lang of ["ja", "en"] as const) {
      const titleVariant = page.locator(`.ed-title > .i18n-${lang}`);
      const fallbackLanguage = await titleVariant.getAttribute("data-title-fallback");
      const originBadge = page.locator(
        `.ed-title-provenance > .i18n-${lang} .language-fallback-badge`,
      );
      await expect(titleVariant.locator(".language-fallback-badge")).toHaveCount(0);
      if (fallbackLanguage) {
        await expect(originBadge).toHaveCount(1);
        await expect(originBadge).toHaveAttribute("data-fallback-language", fallbackLanguage);
        await expect(originBadge).not.toHaveAttribute("aria-hidden", "true");
        const expectedLabel = lang === "ja"
          ? `原題 ${fallbackLanguage.toUpperCase()}`
          : `${fallbackLanguage === "ja" ? "Japanese" : "English"} title`;
        await expect(originBadge.locator(`.i18n-${lang}`)).toHaveText(expectedLabel);
        await expect(page.getByRole("heading", { level: 1 })).toHaveAttribute(
          "aria-describedby",
          "article-title-provenance",
        );
      } else {
        await expect(originBadge).toHaveCount(0);
      }
    }
    const activeTitle = page.locator(".ed-title > .i18n-ja .ed-title-text");
    await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
      ((await activeTitle.textContent()) ?? "").trim(),
    );
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveAccessibleName(
      /原題|English title/,
    );
    const authorityMeta = page.locator('meta[data-pagefind-filter="authority[content]"]');
    await expect(authorityMeta).toHaveCount(1);
    await expect(authorityMeta).toHaveAttribute(
      "content",
      /^(official|paper|community|news|aggregator|source)$/,
    );
    const authorityPill = page.locator("[data-source-authority]").first();
    await expect(authorityPill).toBeVisible();
    await expect(authorityPill).toContainText(/公式|論文|コミュニティ|報道|集約|出典/);
    const summaryMetadata = page.locator(
      'meta[data-pagefind-meta="summaryJa[content]"], meta[data-pagefind-meta="summaryEn[content]"]',
    );
    expect(await summaryMetadata.count(), "at least one validated summary is indexed").toBeGreaterThan(0);
    for (let index = 0; index < await summaryMetadata.count(); index++) {
      const content = ((await summaryMetadata.nth(index).getAttribute("content")) ?? "").trim();
      expect(content.length).toBeGreaterThan(0);
      expect(content).not.toMatch(/AI 要約未生成|AI summary pending|後続の Worker run/);
    }
    const generationDisclosure = page.locator(".ed-disclaim");
    await expect(generationDisclosure).toBeVisible();
    await expect(generationDisclosure).toHaveAttribute(
      "data-generation-scope",
      /^(bilingual|ja-only|en-only)$/,
    );
    const generationScope = await generationDisclosure.getAttribute("data-generation-scope");
    if (generationScope === "bilingual") {
      await expect(generationDisclosure.locator(".i18n-ja")).toContainText(
        /日本語版と英語版は言語ごとに独立して生成/,
      );
    } else if (generationScope === "ja-only") {
      await expect(generationDisclosure.locator(".i18n-ja")).toContainText(/英語要約は準備中/);
    } else {
      await expect(generationDisclosure.locator(".i18n-ja")).toContainText(/日本語要約は準備中/);
    }
    await page.locator('.lang-btn[data-lang="en"]').click();
    if (generationScope === "bilingual") {
      await expect(generationDisclosure.locator(".i18n-en")).toContainText(
        /generated independently for each language/i,
      );
    } else if (generationScope === "ja-only") {
      await expect(generationDisclosure.locator(".i18n-en")).toContainText(
        /summary is not yet available/i,
      );
    } else {
      await expect(generationDisclosure.locator(".i18n-en")).toContainText(
        /English summary is currently available/i,
      );
    }
  });

  test("detail title keeps visible provenance outside the semantic heading", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string; titleJa?: string; titleEn?: string }>;
    };
    const fallbackEntry = index.entries.find(
      (entry) => String(entry.titleJa ?? "").trim() && !String(entry.titleEn ?? "").trim(),
    );
    if (!fallbackEntry) {
      test.skip(true, "Current generated corpus has no English-title fallback entry.");
      return;
    }

    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/e/${fallbackEntry.id}/`);
      await page.locator('.lang-btn[data-lang="en"]').click();

      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toHaveAccessibleName(fallbackEntry.titleJa!.trim());
      await expect(heading).toHaveAccessibleDescription("Japanese title");
      await expect(heading).toHaveAttribute("aria-describedby", "article-title-provenance");
      await expect(heading).not.toContainText(/Japanese title|原題 JA/);
      await expect(heading.locator(".language-fallback-badge")).toHaveCount(0);

      const provenance = page.locator(
        '.ed-title-provenance > .i18n-en .language-fallback-badge[data-fallback-language="ja"]',
      );
      await expect(provenance).toBeVisible();
      await expect(provenance).not.toHaveAttribute("aria-hidden", "true");
      await expect(provenance.locator(".i18n-en")).toHaveText("Japanese title");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
  });

  test("detail metadata follows the effective title language", async ({ page }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: SummaryFixtureEntry[];
    };
    const correctedEntry = index.entries.find((entry) => (
      entry.lang && effectiveTitleLanguage(entry) !== entry.lang
    ));
    const targetEntry = correctedEntry ?? index.entries.find((entry) => entry.lang);
    expect(targetEntry, "current data includes an entry with title language metadata").toBeTruthy();

    const expectedLanguage = effectiveTitleLanguage(targetEntry!);
    await page.goto(`/e/${targetEntry!.id}/`);

    const metadataLanguage = page.locator("[data-entry-language]");
    await expect(metadataLanguage).toHaveAttribute("data-entry-language", expectedLanguage);
    await expect(metadataLanguage.locator(".v")).toHaveText(expectedLanguage.toUpperCase());
    await expect(page.locator("[data-reading-language]")).toHaveAttribute(
      "data-reading-language",
      expectedLanguage,
    );

    const jsonLd = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
    ) as { headline?: string; description?: string; inLanguage?: string };
    const structuredHeadline = page.locator(
      `.ed-title .i18n-${expectedLanguage} .ed-title-text`,
    );
    expect(jsonLd.headline).toBe((await structuredHeadline.textContent())?.trim());
    expect(jsonLd.description).toBeTruthy();
    expect(jsonLd.inLanguage).toBe(expectedLanguage === "ja" ? "ja-JP" : "en");
  });

  test("home keeps the decision path compact at tablet width", async ({ page }) => {
    const fullLabel = "Microsoft Foundry Engineering, AI Platform, Agent Operations, and Cloud Infrastructure Updates";
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto("/");
    await expect(page.locator(".banner-right")).toBeHidden();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await page.locator(".featured-src").evaluate((source) => {
      const fullLabel = "Microsoft Foundry Engineering, AI Platform, Agent Operations, and Cloud Infrastructure Updates";
      const label = source.querySelector("[data-source-disclosure-label]");
      if (label) label.textContent = fullLabel;
      const full = source.querySelector("[data-source-disclosure-full]");
      if (full) full.textContent = fullLabel;
    });

    const featuredDisclosure = page.locator(".featured-src.source-disclosure");
    const featuredTrigger = featuredDisclosure.locator("[data-source-disclosure-trigger]");
    const featuredPanel = featuredDisclosure.locator(".source-disclosure-panel");
    const featuredTabletTarget = await featuredTrigger.boundingBox();
    expect(featuredTabletTarget, "tablet Featured source disclosure target should exist").not.toBeNull();
    expect(featuredTabletTarget!.width).toBeGreaterThanOrEqual(44);
    expect(featuredTabletTarget!.height).toBeGreaterThanOrEqual(44);
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
    await expect(featuredPanel).toBeHidden();
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
    await expect(featuredPanel).toBeVisible();
    await expect(featuredDisclosure.locator("[data-source-disclosure-full]")).toHaveText(fullLabel);
    await expect(featuredPanel.locator(".source-disclosure-authority")).not.toHaveText("");
    await expect(featuredPanel.locator(".source-disclosure-link")).toHaveAttribute(
      "href",
      /^https:\/\//,
    );
    await expect(featuredPanel.locator(".source-disclosure-link")).toHaveAttribute(
      "rel",
      /noopener/,
    );
    await page.keyboard.press("Enter");
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
    await expect(featuredPanel).toBeHidden();
    await page.keyboard.press("Space");
    await expect(featuredDisclosure).toHaveAttribute("open", "");
    await expect(featuredPanel).toBeVisible();
    await page.keyboard.press("Space");
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
    await expect(featuredPanel).toBeHidden();

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
    const rankedPanel = rankedDisclosure.locator(".source-disclosure-panel");
    await expect(rankedPanel).toBeHidden();
    await rankedTrigger.click();
    await expect(rankedDisclosure).toHaveAttribute("open", "");
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
    await expect(rankedPanel).toBeHidden();

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
    await expect(featuredPanel).toBeHidden();
    const mobileTarget = await featuredTrigger.boundingBox();
    expect(mobileTarget, "mobile source disclosure target should exist").not.toBeNull();
    expect(mobileTarget!.width, "mobile source disclosure target should be at least 44px wide").toBeGreaterThanOrEqual(44);
    expect(mobileTarget!.height, "mobile source disclosure target should be at least 44px high").toBeGreaterThanOrEqual(44);
    await featuredTrigger.click();
    await expect(featuredDisclosure).toHaveAttribute("open", "");
    await expect(featuredPanel).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await featuredTrigger.click();
    await expect(featuredDisclosure).not.toHaveAttribute("open", "");
    await expect(featuredPanel).toBeHidden();
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
    await expect(page.locator("#worker-health-heading")).toBeVisible();
    await expect(page.locator("#source-health-heading")).toBeVisible();
    const workerHealthSection = page.locator(".status-hero");
    await expect(workerHealthSection).toBeVisible();
    await expect(workerHealthSection).not.toHaveAttribute("hidden", "");
    await expect(workerHealthSection).toHaveAttribute("aria-labelledby", "worker-health-heading");
    await expect(workerHealthSection).toHaveAttribute("aria-describedby", "worker-health-summary");
    const runStatus = await workerHealthSection.getAttribute("data-run-status");
    const runState = await workerHealthSection.getAttribute("data-run-state");
    expect(runStatus).toMatch(/^(ok|warn|err)$/);
    expect(runState).toMatch(/^(healthy|missing|late|failed|degraded)$/);
    await expect(workerHealthSection).not.toHaveAttribute("data-source-activity-status");
    const expectedRunTone = {
      healthy: "ok",
      missing: "warn",
      late: "err",
      failed: "err",
      degraded: "warn",
    } as const;
    expect(runStatus).toBe(expectedRunTone[runState as keyof typeof expectedRunTone]);
    await expect(workerHealthSection).toHaveClass(new RegExp(`\\bstatus-hero-${runStatus}\\b`));
    await expect(page.locator(".page-hero")).toHaveClass(
      new RegExp(`\\bpage-hero-status-${runStatus}\\b`),
    );
    await expect(page.locator("#worker-health-summary")).not.toBeEmpty();
    const statusHeroMetrics = page.locator(".page-hero-metric");
    await expect(statusHeroMetrics).toHaveCount(6);
    const statusHeroLabels = await statusHeroMetrics
      .locator(":scope > span > .i18n-ja")
      .allTextContents();
    expect(statusHeroLabels.map((label) => label.trim())).toEqual([
      "稼働状態",
      "収集エラー",
      "要約待ち",
      "本文待ち",
      "直近収集",
      "サイト更新",
    ]);
    const statusHeroValues = await statusHeroMetrics
      .locator(":scope > strong")
      .allTextContents();
    expect(statusHeroValues.every((value) => value.trim().length > 0 && !/NaN|undefined/.test(value))).toBe(true);
    const statusMetricScopes = await statusHeroMetrics.evaluateAll((metrics) =>
      metrics.map((metric) => ({
        scope: metric.getAttribute("data-metric-scope"),
        detail: metric.querySelector(".page-hero-metric-detail")?.textContent?.trim(),
      })),
    );
    expect(statusMetricScopes.every((metric) => Boolean(metric.scope && metric.detail))).toBe(true);
    await expect(page.locator('[data-health-scope="summary-queue"]')).toContainText("AI要約 Queue");
    const collectionMetric = page.locator('[data-health-scope="latest-batch"]');
    await expect(collectionMetric).toContainText(/\d+\/\d+/);
    await expect(page.locator('[data-health-scope="collection-run"]')).toHaveCount(1);
    await expect(page.locator('[data-health-domain="summary-queue"]')).toHaveCount(1);
    const summaryQueueMetric = page.locator('[data-health-scope="summary-queue"]');
    const bodyQueueMetric = page.locator('[data-health-scope="body-queue"]');
    await expect(summaryQueueMetric).toHaveCount(1);
    await expect(bodyQueueMetric).toHaveCount(1);
    await expect(page.locator('[data-health-scope="latest-run-enrichment-budget"]')).toHaveCount(1);
    await expect(page.locator('[data-health-scope="published-artifact"]')).toHaveCount(1);
    await expect(collectionMetric.locator("small > .i18n-en")).toHaveText(
      /batch \d+\/\d+ · \d+ registered sources/,
    );
    const summaryQueueMode = await summaryQueueMetric.getAttribute("data-summary-queue-mode");
    const summaryQueueState = await summaryQueueMetric.getAttribute("data-summary-queue-state");
    const bodyQueueMode = await bodyQueueMetric.getAttribute("data-body-queue-mode");
    const bodyQueueState = await bodyQueueMetric.getAttribute("data-body-queue-state");
    const bodyQueueMerged = await bodyQueueMetric.getAttribute("data-body-queue-merged");
    const bodyQueueEnqueued = await bodyQueueMetric.getAttribute("data-body-queue-enqueued");
    const bodyQueueEnqueueCap = await bodyQueueMetric.getAttribute("data-body-queue-enqueue-cap");
    expect(summaryQueueMode).toMatch(/^(enabled|disabled|missing-binding|error|unknown)$/);
    expect(summaryQueueState).toMatch(
      /^(active|clear|waiting-for-run|paused|unavailable|error|unknown)$/,
    );
    expect(bodyQueueMode).toMatch(/^(enabled|disabled|missing-binding|error|unknown)$/);
    expect(bodyQueueState).toMatch(
      /^(active|clear|waiting-for-run|paused|unavailable|error|unknown)$/,
    );
    if (["missing", "late", "failed"].includes(runState ?? "") && summaryQueueMode === "enabled") {
      expect(summaryQueueState).toBe("waiting-for-run");
      await expect(summaryQueueMetric).toHaveAttribute("data-health-tone", "neutral");
      await expect(summaryQueueMetric).not.toHaveClass(/\b(?:warn|err)\b/);
      await expect(summaryQueueMetric.locator("small > .i18n-en")).toContainText(
        "waiting for a successful run",
      );
    }
    if (["missing", "late", "failed"].includes(runState ?? "") && bodyQueueMode === "enabled") {
      expect(bodyQueueState).toBe("waiting-for-run");
      await expect(bodyQueueMetric).toHaveAttribute("data-health-tone", "neutral");
      await expect(bodyQueueMetric).not.toHaveClass(/\b(?:warn|err)\b/);
      await expect(bodyQueueMetric.locator("small > .i18n-en")).toContainText(
        "waiting for a successful run",
      );
    }
    if (bodyQueueMode !== "enabled") {
      await expect(bodyQueueMetric.locator("strong")).toHaveText("n/a");
      await expect(bodyQueueMetric).not.toHaveAttribute("data-body-queue-state", "clear");
    } else {
      await expect(bodyQueueMetric.locator("strong")).toHaveText(/^\d+$/);
      if (bodyQueueMerged !== "unknown") {
        await expect(bodyQueueMetric.locator("small > .i18n-ja")).toContainText(
          `本文ファイル反映 +${bodyQueueMerged}`,
        );
        await expect(bodyQueueMetric.locator("small > .i18n-en")).toContainText(
          `applied to body file +${bodyQueueMerged}`,
        );
      }
      if (bodyQueueEnqueueCap !== "unknown") {
        await expect(bodyQueueMetric.locator("small > .i18n-ja")).toContainText(
          `上限 ${bodyQueueEnqueueCap}件/run基準`,
        );
        await expect(bodyQueueMetric.locator("small > .i18n-en")).toContainText(
          `based on a ${bodyQueueEnqueueCap}/run cap`,
        );
      }
      if (bodyQueueEnqueued === "unknown") {
        await expect(bodyQueueMetric.locator("small > .i18n-ja")).toContainText(
          "送信件数 未計測",
        );
        await expect(bodyQueueMetric.locator("small > .i18n-en")).toContainText(
          "enqueue count not measured",
        );
      }
    }
    await expect(bodyQueueMetric.locator("small > .i18n-ja")).not.toContainText("回収 +");
    await expect(bodyQueueMetric.locator("small > .i18n-en")).not.toContainText("merged +");
    const enrichmentBudgetMetric = page.locator('[data-health-scope="latest-run-enrichment-budget"]');
    const enrichmentBudgetState = await enrichmentBudgetMetric.getAttribute("data-telemetry-state");
    expect(enrichmentBudgetState).toMatch(/^(recorded|not-recorded)$/);
    if (enrichmentBudgetState === "recorded") {
      await expect(enrichmentBudgetMetric).toContainText("直近runの生成枠 (合計)");
      await expect(enrichmentBudgetMetric.locator("strong")).toHaveText(/^\s*\d+\/\d+\s*$/);
      await expect(enrichmentBudgetMetric.locator("small > .i18n-ja")).toContainText(
        /合計 \d+ 件 \/ 上限 \d+ 件/,
      );
      if (bodyQueueEnqueued === "unknown") {
        await expect(enrichmentBudgetMetric.locator("small > .i18n-ja")).toContainText("本文 未記録");
        await expect(enrichmentBudgetMetric.locator("small > .i18n-en")).toContainText("bodies not recorded");
      }
    } else {
      await expect(enrichmentBudgetMetric.locator("strong > .i18n-en")).toHaveText("Not recorded");
      await expect(enrichmentBudgetMetric.locator("small > .i18n-en")).toContainText(
        "This published snapshot does not include",
      );
    }
    const limitedFilter = page.locator('[data-source-filter="limited"]');
    const allFilter = page.locator('[data-source-filter="all"]');
    const sourceRows = page.locator("#source-health-list .source-item");
    const visibleSourceRows = page.locator("#source-health-list .source-item:not([hidden])");
    const limitedCount = Number(await limitedFilter.getAttribute("data-source-count"));
    const expectedInitialCount = limitedCount > 0 ? limitedCount : await sourceRows.count();
    await expect(limitedFilter).toBeVisible();
    await expect(limitedFilter).toHaveAttribute("aria-pressed", limitedCount > 0 ? "true" : "false");
    await expect(allFilter).toBeVisible();
    await expect(allFilter).toHaveAttribute("aria-pressed", limitedCount > 0 ? "false" : "true");
    await expect(page.locator('[data-category-filter="all"]')).toBeVisible();
    await expect(visibleSourceRows).toHaveCount(expectedInitialCount);
    await expect(page.locator("#source-health-list .source-item:visible")).toHaveCount(expectedInitialCount);
    await expect(page.locator("[data-visible-source-count]").first()).toHaveText(
      String(expectedInitialCount),
    );
    await expect(visibleSourceRows.first().locator(".source-reason-line")).toBeVisible();
    await expect(visibleSourceRows.first()).toHaveAttribute(
      "data-state-source",
      "published-snapshot",
    );
    await expect(page.locator(".status-note[data-state-source='published-snapshot']")).toBeVisible();
    const sourceActivityCopy = await visibleSourceRows.first().locator(
      ".source-reason-line, .source-latest-age",
    ).allInnerTexts();
    expect(sourceActivityCopy.join(" ")).not.toMatch(/\d+(?:m|h|d|w|mo|y) ago/);
    await expect(visibleSourceRows.first().locator(".source-status-badge")).toContainText(
      /最近掲載あり|低活動|長期非掲載|未収録/,
    );
    await expect(visibleSourceRows.first().locator(".source-meta-line")).not.toContainText(/tier|stale\s*>/i);
    await expect(visibleSourceRows.first().locator(".source-latest-line")).toBeVisible();
    await expect(visibleSourceRows.first().locator(".source-time-block")).toHaveAttribute(
      "data-live-entry-count",
      /^\d+$/,
    );
    await expect(page.locator(".source-threshold-note .i18n-ja")).toContainText(
      /Blog 42h \/ 7d.*Community 7d \/ 30d.*Release 30d \/ 120d.*Research 14d \/ 60d/,
    );
    await expect(page.locator(".source-threshold-note .i18n-ja")).toContainText(
      "1値目までが「最近掲載あり」、2値目までが「低活動」",
    );
    await expect(limitedFilter.locator(".i18n-ja")).toHaveText("要確認");
    await expect(visibleSourceRows.first().locator(".source-time-block strong .i18n-ja")).toContainText(
      /^掲載 \d+件$/,
    );
    await expect(page.locator(".source-summary-card").filter({ hasText: "最近掲載あり率" })).toHaveCount(1);
    const sourceActivityStates = await sourceRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-source-activity-status")),
    );
    expect(sourceActivityStates.every((state) =>
      ["recent", "low-activity", "long-inactive", "not-listed"].includes(state ?? ""))).toBe(true);
    await expect(page.locator("#source-health-list")).not.toContainText(
      /正常|更新遅延|要確認|障害検出|failed source/i,
    );
    const sourceCoverage = page.locator('[data-health-scope="publication-activity"]');
    const coverageMetrics = await sourceCoverage.evaluate((element) => ({
      healthy: Number(element.getAttribute("data-healthy-source-count")),
      evaluated: Number(element.getAttribute("data-evaluated-source-count")),
      registered: Number(element.getAttribute("data-registered-source-count")),
      notListed: Number(element.getAttribute("data-not-listed-source-count")),
      percentage: Number(element.getAttribute("data-health-percentage")),
    }));
    expect(coverageMetrics.evaluated).toBeGreaterThan(0);
    expect(coverageMetrics.healthy).toBeLessThanOrEqual(coverageMetrics.evaluated);
    expect(coverageMetrics.evaluated).toBeLessThanOrEqual(coverageMetrics.registered);
    expect(coverageMetrics.evaluated + coverageMetrics.notListed).toBe(coverageMetrics.registered);
    expect(coverageMetrics.percentage).toBe(
      Math.round((coverageMetrics.healthy / coverageMetrics.evaluated) * 100),
    );
    await expect(sourceCoverage.locator("p > .i18n-ja")).toHaveText(
      new RegExp(
        `登録\\s*${coverageMetrics.registered}\\s*ソース.*`
        + `評価できる\\s*${coverageMetrics.evaluated}\\s*ソース中\\s*`
        + `${coverageMetrics.healthy}\\s*ソース.*未収録\\s*${coverageMetrics.notListed}\\s*ソース`,
      ),
    );
    const collectionFailures = page.locator('[data-health-scope="collection-failures"]');
    const collectionFailureCountValue = await collectionFailures.getAttribute(
      "data-collection-failure-count",
    );
    const collectionTelemetryState = await collectionFailures.getAttribute(
      "data-collection-telemetry-state",
    );
    if (collectionTelemetryState === "unavailable") {
      expect(collectionFailureCountValue).toBe("unknown");
      await expect(collectionFailures.locator("strong")).toContainText(/記録なし|Not recorded/);
      await expect(collectionFailures).not.toContainText(/すべて成功|completed successfully/);
    } else {
      expect(collectionTelemetryState).toBe("available");
      const collectionFailureCount = Number(collectionFailureCountValue);
      expect(collectionFailureCount).toBeGreaterThanOrEqual(0);
      if (collectionFailureCount === 0) {
        await expect(collectionFailures.locator("strong")).toContainText(/なし|None/);
      } else {
        await expect(collectionFailures.locator(".collection-failure-list li")).toHaveCount(
          collectionFailureCount,
        );
      }
    }
    const summaryServiceSnapshot = page.locator(
      '.status-detail-grid > [data-health-scope="ai-summary-service"]',
    );
    await expect(summaryServiceSnapshot).toHaveAttribute(
      "data-state-source",
      "published-snapshot",
    );
    await expect(summaryServiceSnapshot).toHaveAttribute(
      "data-observed-at",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    await expect(summaryServiceSnapshot.locator("strong > .i18n-en")).toContainText(
      /^Last run: /,
    );
    await expect(summaryServiceSnapshot.locator("small > .i18n-en")).toContainText(
      /Published snapshot:\s+/,
    );

    // The page identity stays concise; operational state belongs to the metric cards and footer.
    await expect(page.locator(".page-hero #status-heading")).toHaveText("Status");
    await expect(page.locator(".page-hero .page-count")).toHaveCount(0);
    const stateLabels = {
      healthy: "OK",
      missing: "NO DATA",
      late: "DELAYED",
      failed: "FAILED",
      degraded: "DEGRADED",
    } as const;
    const expectedStateLabel = stateLabels[runState as keyof typeof stateLabels];
    const expectedTone = expectedRunTone[runState as keyof typeof expectedRunTone];
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    const footerRunLink = page.locator("footer .footer-run-link");
    await expect(footerRunLink).toHaveAttribute("href", "/status");
    await expect(footerRunLink).toHaveAttribute("data-run-state", runState!);
    await expect(footerRunLink.locator("strong")).toHaveText(`run ${expectedStateLabel.toLowerCase()}`);
    await expect(footerRunLink).not.toHaveAttribute("aria-label");
    await expect(footerRunLink).toHaveAttribute(
      "title",
      /collection health: run (ok|no data|delayed|failed|degraded).*batch \d+\/\d+.*sources \d+\/\d+.*summary \d+.*ai explainer body/i,
    );
    await expect(footerRunLink).toHaveAccessibleName(
      /run (ok|no data|delayed|failed|degraded).*batch \d+\/\d+.*sources \d+\/\d+.*summary \d+.*body/i,
    );
    const footerRunDetail = await footerRunLink.getAttribute("data-run-detail");
    expect(footerRunDetail).toBeTruthy();
    const footerDot = footerRunLink.locator(".dot");
    await expect(footerDot).toHaveAttribute("data-run-tone", expectedTone);
    await expect(footerDot).toHaveClass(new RegExp(`\\bdot\\b.*\\b${expectedTone}\\b`));
    await expect(footerRunLink.locator(".mono")).not.toContainText(footerRunDetail!);
    await expect(footerRunLink.locator(".mono")).toContainText(
      /batch \d+\/\d+ · sources \d+\/\d+ · summary \d+/,
    );
    await expect(footerRunLink).toHaveAttribute("data-body-queue-backlog", /^(unknown|\d+)$/);
    const lastRunTime = footerRunLink.locator("time.footer-run-time");
    await expect(lastRunTime).toHaveCount(1);
    await expect(lastRunTime).toHaveAttribute(
      "datetime",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    await expect(lastRunTime).toContainText(/\S+/);
    await expect(page.locator(".footer-bar .item.mono")).toHaveCount(0);
    await expect(page.locator(".page-hero-copy > p > .i18n-ja")).toContainText("収集、AI要約、AI解説本文");
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator(".page-hero-copy > p > .i18n-en")).toBeVisible();
    await expect(page.locator(".page-hero-copy > p > .i18n-en")).toContainText("Check collection, AI summaries");
    await expect(page.locator("#worker-health-heading > .i18n-en")).toContainText("Collection and enrichment health");
    await expect(visibleSourceRows.first().locator(".source-status-badge > .i18n-en")).toContainText(
      /Recently listed|Low activity|Long inactive|Not listed/,
    );
    await expect(visibleSourceRows.first().locator(".source-reason-line > .i18n-en")).toContainText(
      /latest listing in this published snapshot|No listed entry is available/i,
    );
    await expect(visibleSourceRows.first().locator(".source-latest-line > .i18n-en")).toContainText(
      /Latest article/,
    );
  });

  test("status reaction config health shows configured (ok) when every dependency resolves true", async ({
    page,
  }) => {
    await page.route("**/api/reactions/config", async (route) => {
      expect(route.request().method(), "reaction config health check uses GET").toBe("GET");
      // Small artificial delay so the SSR-neutral "checking" state is observable
      // before the progressive-enhancement fetch resolves, without racing it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: {
            databaseBinding: true,
            hmacSecret: true,
            turnstileSecret: true,
            publicSiteKey: true,
            configured: true,
          },
        }),
      });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/status/");

    const card = reactionConfigCard(page);
    await expect(card).toHaveAttribute("data-reaction-config-state", "checking");
    await expect(card.locator("[data-reaction-config-label] > .i18n-ja")).toHaveText("確認中");
    await expect(card.locator("[data-reaction-config-flags]")).toBeHidden();

    await expect(card).toHaveAttribute("data-reaction-config-state", "configured", { timeout: 5_000 });
    await expect(card.locator("[data-reaction-config-label] > .i18n-ja")).toHaveText("設定済み");
    await expect(card.locator("[data-reaction-config-label] > .i18n-en")).toHaveText("Configured");
    await expect(card.locator("[data-reaction-config-detail] > .i18n-ja")).toContainText(
      "すべて揃っています",
    );
    const flagRows = card.locator("[data-reaction-config-flag]");
    await expect(flagRows).toHaveCount(4);
    await expect(card.locator("[data-reaction-config-flags]")).toBeVisible();
    for (const key of ["databaseBinding", "hmacSecret", "turnstileSecret", "publicSiteKey"]) {
      const row = card.locator(`[data-reaction-config-flag="${key}"]`);
      await expect(row).toHaveAttribute("data-reaction-config-flag-ok", "true");
      await expect(row.locator("[data-reaction-config-flag-state] > .i18n-ja")).toHaveText("設定済み");
      await expect(row.locator("[data-reaction-config-flag-state] > .i18n-en")).toHaveText("Configured");
    }
    await expect(card).toHaveClass(/reaction-config-card/);
    const beforeColor = await card.evaluate(
      (element) => getComputedStyle(element, "::before").backgroundColor,
    );
    expect(beforeColor).not.toBe("");
  });

  test("status reaction config health shows a neutral not-configured breakdown, never ERR, when partial", async ({
    page,
  }) => {
    await routeReactionConfig(page, {
      config: {
        databaseBinding: true,
        hmacSecret: false,
        turnstileSecret: false,
        publicSiteKey: false,
        configured: false,
      },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/status/");

    const card = reactionConfigCard(page);
    await expect(card).toHaveAttribute("data-reaction-config-state", "not-configured");
    await expect(card.locator("[data-reaction-config-label] > .i18n-ja")).toHaveText("未設定");
    await expect(card.locator("[data-reaction-config-label] > .i18n-en")).toHaveText("Not configured");
    await expect(card.locator("[data-reaction-config-detail] > .i18n-ja")).toContainText(
      "識別子署名用シークレット",
    );
    await expect(card.locator("[data-reaction-config-detail] > .i18n-ja")).toContainText(
      "Turnstile 検証シークレット",
    );
    await expect(card.locator("[data-reaction-config-detail] > .i18n-ja")).toContainText(
      "Turnstile 公開サイトキー",
    );
    await expect(card.locator("[data-reaction-config-detail] > .i18n-en")).toContainText(
      "Identity signing secret",
    );

    await expect(
      card.locator('[data-reaction-config-flag="databaseBinding"]'),
    ).toHaveAttribute("data-reaction-config-flag-ok", "true");
    for (const key of ["hmacSecret", "turnstileSecret", "publicSiteKey"]) {
      const row = card.locator(`[data-reaction-config-flag="${key}"]`);
      await expect(row).toHaveAttribute("data-reaction-config-flag-ok", "false");
      await expect(row.locator("[data-reaction-config-flag-state] > .i18n-en")).toHaveText(
        "Not configured",
      );
    }

    // "neutral, not ERR": the not-configured state must never carry a warn/err tone class
    // or color — this is an optional feature that degrades safely, not an incident.
    await expect(card).not.toHaveClass(/\berr\b/);
    await expect(card).not.toHaveClass(/\bwarn\b/);
    await expect(card).not.toHaveClass(/tone-error/);
    await expect(card).not.toHaveClass(/tone-warn/);
  });

  test("status reaction config health distinguishes endpoint unavailable from not-configured", async ({
    page,
  }) => {
    await page.route("**/api/reactions/config", async (route) => {
      await route.abort("failed");
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/status/");

    const card = reactionConfigCard(page);
    await expect(card).toHaveAttribute("data-reaction-config-state", "unavailable");
    await expect(card.locator("[data-reaction-config-label] > .i18n-ja")).toHaveText("確認できません");
    await expect(card.locator("[data-reaction-config-label] > .i18n-en")).toHaveText(
      "Check unavailable",
    );
    // Distinct wording from the resolved not-configured state (asserted above) so an
    // operator can tell "we don't know" apart from "we checked and it's missing".
    await expect(card.locator("[data-reaction-config-label] > .i18n-en")).not.toHaveText(
      "Not configured",
    );
    await expect(card.locator("[data-reaction-config-detail] > .i18n-en")).toContainText(
      "may be a network or temporary issue",
    );
    // Unresolved: the itemized flag breakdown never appears when we couldn't check at all.
    await expect(card.locator("[data-reaction-config-flags]")).toBeHidden();
    await expect(card).not.toHaveClass(/\berr\b/);
    await expect(card).not.toHaveClass(/\bwarn\b/);
  });

  test("status reaction config health never exposes secret or key values in the page", async ({
    page,
  }) => {
    const marker = "MARKER-SECRET-VALUE-DO-NOT-RENDER-1234567890";
    await routeReactionConfig(page, {
      config: {
        databaseBinding: true,
        hmacSecret: true,
        turnstileSecret: true,
        publicSiteKey: true,
        configured: true,
        // A malicious/misbehaving endpoint might try to smuggle a value through an
        // unexpected field; the client only ever reads the four known booleans.
        leakedHmacSecret: marker,
        leakedTurnstileSecret: marker,
      },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/status/");

    const card = reactionConfigCard(page);
    await expect(card).toHaveAttribute("data-reaction-config-state", "configured");
    const pageContent = await page.content();
    expect(pageContent).not.toContain(marker);
  });

  test("status reaction config health has accessible descriptions without live-region misuse", async ({
    page,
  }) => {
    await routeReactionConfig(page, {
      config: {
        databaseBinding: false,
        hmacSecret: false,
        turnstileSecret: false,
        publicSiteKey: false,
        configured: false,
      },
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/status/");

    const card = reactionConfigCard(page);
    await expect(card).toHaveAttribute("data-reaction-config-state", "not-configured");
    const heading = card.locator("h3.rail-title");
    await expect(heading).toHaveAttribute("id", "reaction-config-heading");
    await expect(card).toHaveAttribute("aria-labelledby", "reaction-config-heading");
    await expect(card).toHaveAttribute("aria-describedby", "reaction-config-detail");
    await expect(card.locator("#reaction-config-detail")).toHaveCount(1);
    // This card resolves once on load; it must not misuse aria-live as if it were a
    // continuously-updating live region.
    await expect(card).not.toHaveAttribute("aria-live");
    await expect(card.locator("[data-reaction-config-label]")).not.toHaveAttribute("aria-live");
    await expect(card.locator("[data-reaction-config-detail]")).not.toHaveAttribute("aria-live");

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(card.locator("[data-reaction-config-label] > .i18n-en")).toBeVisible();
    await expect(card.locator("[data-reaction-config-label] > .i18n-ja")).toBeHidden();
  });

  test("status reaction config health resolves without page overflow on mobile (390px)", async ({
    page,
  }) => {
    await routeReactionConfig(page, {
      config: {
        databaseBinding: true,
        hmacSecret: false,
        turnstileSecret: true,
        publicSiteKey: false,
        configured: false,
      },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/status/");

    // The whole `.status-insights` rail (every card in it, not just this one) is
    // intentionally hidden below 1181px in this app's responsive layout, so the
    // reaction-config card is expected to be non-visible here too — this asserts
    // that it still resolves cleanly off-screen (correct state, no overflow) rather
    // than asserting a visibility contract this rail has never had on mobile.
    const card = reactionConfigCard(page);
    await expect(card).toHaveAttribute("data-reaction-config-state", "not-configured");
    await expect(page.locator("aside.status-insights")).toBeHidden();
    await expect(page.locator("#worker-health-heading")).toBeVisible();
    await expect(page.locator("#source-health-heading")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("status publication activity action targets visible main content on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/status/");

    const action = page.locator('.page-hero-actions a[href="#source-health-heading"]');
    await expect(action).toHaveCount(1);
    await action.evaluate((link: HTMLAnchorElement) => link.click());
    await expect(page).toHaveURL(/\/status\/?#source-health-heading$/);

    const target = page.locator("#source-health-heading");
    await expect(target).toBeVisible();
    expect(await target.evaluate((element) => element.closest("aside") === null)).toBe(true);
    await expect(page.locator("#source-health-list [data-source-activity-status]")).not.toHaveCount(0);
    await expect(page.locator("#attention-list, #attention-list-mobile")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("status category insight yields to content until the right rail is available", async ({ page }) => {
    for (const width of [901, 1024, 1100, 1180]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/status/");
      await expect(page.locator("aside.status-insights"), `${width}px keeps the right rail collapsed`).toBeHidden();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }

    for (const width of [1181, 1280, 1359, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/status/");
      await expect(page.locator("aside.status-insights"), `${width}px shows the status insight rail`).toBeVisible();
      const layoutColumns = await page.locator(".layout").evaluate((layout) =>
        getComputedStyle(layout).gridTemplateColumns.split(" ").filter(Boolean).length,
      );
      expect(layoutColumns, `${width}px keeps the three-column status hierarchy`).toBe(3);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }

    await expect(page.locator(".category-health-list li").first()).toBeVisible();
    await expect(page.locator("aside.status-insights h3.rail-title")).toHaveCount(6);
    await expect(page.locator("aside.status-insights div.rail-title")).toHaveCount(0);
    await expect
      .poll(() =>
        page.locator("aside.status-insights").evaluate((element) => getComputedStyle(element).position),
      )
      .toBe("static");

    const geometry = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>(".category-health-list li"));
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        items: items.map((item) => {
          const itemRect = item.getBoundingClientRect();
          const detailRect = item.querySelector("small")?.getBoundingClientRect();
          return {
            itemLeft: itemRect.left,
            itemRight: itemRect.right,
            detailLeft: detailRect?.left ?? 0,
            detailRight: detailRect?.right ?? 0,
          };
        }),
      };
    });

    expect(geometry.overflow, "status page must not overflow horizontally").toBeLessThanOrEqual(0);
    expect(geometry.items.length).toBeGreaterThan(0);
    for (const item of geometry.items) {
      expect(item.detailLeft).toBeGreaterThanOrEqual(item.itemLeft - 1);
      expect(item.detailRight).toBeLessThanOrEqual(item.itemRight + 1);
    }

    await expect(
      page.locator(".status-insight-card:has(.category-health-list) .rail-title > .i18n-en"),
    ).toContainText("up to 8");
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator(".category-health-list small > .i18n-en").first()).toContainText("not listed");
  });

  test("status separates publication inactivity from collection failures", async ({ page }) => {
    await page.goto("/status/");
    await expect(page.locator("#attention-list, #attention-list-mobile")).toHaveCount(0);

    const longInactiveRows = page.locator(
      '.source-item[data-source-activity-status="long-inactive"]',
    );
    for (let index = 0; index < await longInactiveRows.count(); index++) {
      const row = longInactiveRows.nth(index);
      await expect(row).not.toHaveAttribute("data-source-status");
      await expect(row.locator(".source-status-badge")).toContainText(/長期非掲載|Long inactive/);
      await expect(row.locator(".status.error, .source-status-badge.error")).toHaveCount(0);
      await expect(row.locator(".source-reason-line")).toContainText(
        /長期間掲載がありません|No recent article is listed/,
      );
    }

    const offenders = await longInactiveRows.evaluateAll((rows) =>
      rows
        .map((row) => {
          const count = Number(
            (row.querySelector(".source-time-block") as HTMLElement | null)?.dataset.liveEntryCount ?? "0",
          );
          const reason = ((row.querySelector(".source-reason-line") as HTMLElement | null)?.innerText ?? "").toLowerCase();
          const latest = ((row.querySelector(".source-latest-age") as HTMLElement | null)?.innerText ?? "").toLowerCase();
          return { count, reason, latest };
        })
        .filter(
          (row) =>
            row.count > 0 &&
            (row.reason.includes("収集済み記事なし") ||
              row.reason.includes("通常の掲載間隔内") ||
              row.latest === "記事なし"),
        ),
    );
    expect(
      offenders,
      "data-bearing long-inactive rows should not use no-data or recent-activity copy",
    ).toEqual([]);

    const noDataRows = page.locator(
      '.source-item[data-source-activity-status="not-listed"]',
    );
    for (let index = 0; index < await noDataRows.count(); index++) {
      const row = noDataRows.nth(index);
      await expect(row).not.toHaveAttribute("data-source-status");
      await expect(row).toHaveAttribute("data-source-activity-status", "not-listed");
      await expect(row.locator(".source-status-badge")).toContainText(/未収録|Not listed/);
      await expect(row.locator(".status.error, .source-status-badge.error")).toHaveCount(0);
    }

    const collectionFailures = page.locator('[data-health-scope="collection-failures"]');
    const failureCountValue = await collectionFailures.getAttribute("data-collection-failure-count");
    if (failureCountValue === "unknown") {
      await expect(collectionFailures).toHaveAttribute("data-collection-telemetry-state", "unavailable");
      await expect(collectionFailures.locator(".collection-failure-list li")).toHaveCount(0);
    } else {
      const failureCount = Number(failureCountValue);
      await expect(collectionFailures.locator(".collection-failure-list li")).toHaveCount(failureCount);
    }
  });

  test("top-level page heroes give page context on desktop and mobile", async ({ page }) => {
    const topLevelPaths = ["/categories/", "/status/", "/about/", "/archive/"];
    for (const path of topLevelPaths) {
      await expectResponsivePageHero(page, path, true);
    }
    await expectResponsivePageHero(page, "/page/2/");
  });

  test("deep page heroes give page context on desktop and mobile", async ({ page }) => {
    const paths: string[] = [];
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
      await expectResponsivePageHero(page, path);
    }
  });

  test("every metric-bearing PageHero explains its population and window", async ({ page }) => {
    test.setTimeout(90_000);
    const paths = [
      "/categories/",
      "/status/",
      "/about/",
      "/archive/",
      "/archive/2026-07/",
      "/knowledge/",
      "/arxiv/",
      "/glossary/",
      "/page/2/",
      "/c/copilot/",
      "/c/copilot/page/2/",
      "/t/claude/",
      "/t/claude/page/2/",
    ];
    await page.goto("/");
    const routeContracts = await page.evaluate(
      async (routePaths) =>
        Promise.all(routePaths.map(async (path) => {
          const response = await fetch(path);
          const html = await response.text();
          const document = new DOMParser().parseFromString(html, "text/html");
          const metrics = [...document.querySelectorAll(".page-hero-metric")];
          return {
            path,
            status: response.status,
            contracts: metrics.map((item) => {
              const describedBy = item.getAttribute("aria-describedby") ?? "";
              const detail = describedBy ? document.getElementById(describedBy) : null;
              return {
                scope: item.getAttribute("data-metric-scope") ?? "",
                describedBy,
                detail: detail?.textContent?.trim() ?? "",
              };
            }),
          };
        })),
      paths,
    );
    for (const { path, status, contracts } of routeContracts) {
      expect(status, `${path} is generated`).toBeLessThan(400);
      expect(contracts.length, `${path} exposes summary metrics`).toBeGreaterThan(0);
      expect(
        contracts.every((metric) =>
          metric.scope.length > 0
          && metric.describedBy.length > 0
          && metric.detail.length > 0),
        `${path} metric contracts are self-explanatory`,
      ).toBe(true);
    }
  });

  test("metric-bearing PageHero stays compact across responsive widths", async ({ page }) => {
    const responsivePaths = [
      "/page/2/",
      "/c/copilot/page/2/",
      "/t/claude/page/2/",
      "/arxiv/",
      "/glossary/",
    ];
    const responsiveViewports = [
      [320, 844, 335],
      [375, 844, 335],
      [390, 844, 335],
      [414, 844, 335],
      [768, 900, 430],
    ] as const;
    const settleLayout = () =>
      page.evaluate(
        () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        ),
      );
    for (const path of responsivePaths) {
      await page.setViewportSize({ width: 320, height: 844 });
      await page.goto(path);
      for (const [width, height, maxHeroHeight] of responsiveViewports) {
        await page.setViewportSize({ width, height });
        await settleLayout();
        const hero = page.locator(".page-hero");
        await expect(hero).toBeVisible();
        const box = await hero.boundingBox();
        expect(box, `${path} hero renders at ${width}px`).not.toBeNull();
        expect(box!.height, `${path} metric detail remains compact at ${width}px`).toBeLessThan(maxHeroHeight);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          `${path} stays within ${width}px`,
        ).toBe(true);
        if (width === 390 && path === "/page/2/") {
          await expect(page.locator('[data-metric-scope="timeline-snapshot"]')).toBeVisible();
        }
        if (width === 390 && path === "/c/copilot/page/2/") {
          await expect(page.locator('[data-metric-scope="category-week-over-week"]')).toBeVisible();
          await expect(page.locator('[data-metric-scope="category-page-position"]')).toBeHidden();
        }
      }
    }
  });

  test("page families keep stable content widths across routes", async ({ page }) => {
    test.setTimeout(60_000);
    const measure = async (path: string, width: number, navigate = true) => {
      await page.setViewportSize({ width, height: 900 });
      if (navigate) {
        await page.goto(path);
      } else {
        await page.evaluate(
          () => new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          ),
        );
      }
      return page.evaluate(() => {
        const main = document.querySelector<HTMLElement>(".layout > main");
        const left = document.querySelector<HTMLElement>(".layout > aside.left");
        const tickerInner = document.querySelector<HTMLElement>(".ticker-bar .tb-inner");
        const crumbInner = document.querySelector<HTMLElement>(".crumb-inner");
        const box = (element: HTMLElement | null) => {
          if (!element || element.getClientRects().length === 0) return null;
          const rect = element.getBoundingClientRect();
          return { x: rect.x, width: rect.width, right: rect.right };
        };
        return {
          main: box(main),
          left: box(left),
          tickerInner: box(tickerInner),
          crumbInner: box(crumbInner),
          tickerContentX: tickerInner
            ? tickerInner.getBoundingClientRect().x + parseFloat(getComputedStyle(tickerInner).paddingLeft)
            : null,
          crumbContentX: crumbInner
            ? crumbInner.getBoundingClientRect().x + parseFloat(getComputedStyle(crumbInner).paddingLeft)
            : null,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
    };

    const routeEntries = [
      ["home", "/"],
      ["status", "/status/"],
      ["categories", "/categories/"],
      ["category", "/c/copilot/"],
      ["about", "/about/"],
      ["archive", "/archive/"],
    ] as const;
    const measurements = new Map<
      (typeof routeEntries)[number][0],
      {
        at1280: Awaited<ReturnType<typeof measure>>;
        at1440: Awaited<ReturnType<typeof measure>>;
      }
    >();
    for (const [key, path] of routeEntries) {
      const at1280 = await measure(path, 1280);
      const at1440 = await measure(path, 1440, false);
      measurements.set(key, { at1280, at1440 });
    }
    const at1280 = Object.fromEntries(
      [...measurements].map(([key, value]) => [key, value.at1280]),
    ) as Record<(typeof routeEntries)[number][0], Awaited<ReturnType<typeof measure>>>;
    expect(Math.abs(at1280.home.main!.width - at1280.status.main!.width)).toBeLessThanOrEqual(1);
    const home1280 = at1280.home;
    const categories1280 = at1280.categories;
    for (const key of ["categories", "category", "about", "archive"] as const) {
      const metrics = at1280[key];
      expect(
        Math.abs(metrics.main!.width - categories1280.main!.width),
        `${key} shares the exploration/content main width at 1280px`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(metrics.left!.x - categories1280.left!.x),
        `${key} shares the left-rail gutter at 1280px`,
      ).toBeLessThanOrEqual(1);
      expect(metrics.overflow, `${key} does not overflow at 1280px`).toBeLessThanOrEqual(0);
    }
    expect(home1280.tickerContentX, "ticker uses the shared page gutter").toBeCloseTo(
      home1280.left!.x,
      0,
    );

    const desktopWidths: number[] = [];
    for (const [key, path] of routeEntries) {
      const metrics = measurements.get(key)!.at1440;
      desktopWidths.push(metrics.main!.width);
      expect(metrics.overflow, `${path} does not overflow at 1440px`).toBeLessThanOrEqual(0);
    }
    expect(Math.max(...desktopWidths) - Math.min(...desktopWidths)).toBeLessThanOrEqual(1);

    const categoryDetail = measurements.get("category")!.at1440;
    expect(categoryDetail.crumbContentX, "breadcrumb uses the shared desktop gutter").toBeCloseTo(
      categoryDetail.left!.x,
      0,
    );
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
    await expect(page.locator('.cat-types[data-type-scope="category-live-entries"]')).toHaveCount(14);
    await expect(page.locator(".cat-types-scope .i18n-ja").first()).toHaveText("Live内訳");

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
    for (const width of [1440, 1360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/c/copilot/");

      const panel = page.locator(".category-side-panel");
      const sidebar = page.locator("aside.left");
      await expect(panel, `category panel visible at ${width}px`).toBeVisible();
      await expect(sidebar, `primary sidebar visible at ${width}px`).toBeVisible();
      await expect(panel.locator(".category-side-scope")).toHaveCount(2);
      await expect(panel.locator(".category-side-scope").first()).toContainText(/先頭|First/);
      const relatedMarker = panel.locator(".category-related-grid a > span").first();
      if (await relatedMarker.count()) {
        await expect(relatedMarker).not.toHaveText("Vs");
      }

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

    for (const { width, sidebarVisible } of [
      { width: 1359, sidebarVisible: true },
      { width: 1000, sidebarVisible: true },
      { width: 900, sidebarVisible: false },
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/c/copilot/");
      const panel = page.locator(".category-side-panel");
      const sidebar = page.locator("aside.left");
      await expect(panel, `category panel yields to the article list at ${width}px`).toBeHidden();
      if (sidebarVisible) {
        await expect(sidebar, `primary sidebar remains visible at ${width}px`).toBeVisible();
        await expect
          .poll(() => sidebar.evaluate((element) => getComputedStyle(element).position))
          .toBe("sticky");
      } else {
        await expect(sidebar, `primary sidebar yields to the article list at ${width}px`).toBeHidden();
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
  });

  test("status source filters only show matching rows", async ({ page }) => {
    await page.goto("/status/");

    const workerHealthSection = page.locator(".status-hero");
    const allRows = page.locator("#source-health-list [data-source-activity-status]");
    const limitedFilter = page.locator('[data-source-filter="limited"]');
    const allFilter = page.locator('[data-source-filter="all"]');
    const limitedCount = Number(await limitedFilter.getAttribute("data-source-count"));
    if (limitedCount > 0) {
      await expect(limitedFilter).toHaveAttribute("aria-pressed", "true");
      const initialStatuses = await allRows.evaluateAll((items) =>
        items
          .filter((item) => !(item as HTMLElement).hidden)
          .map((item) => (item as HTMLElement).dataset.sourceActivityStatus),
      );
      expect(initialStatuses).toHaveLength(limitedCount);
      expect(initialStatuses.every((status) => status !== "recent")).toBe(true);
    }

    await allFilter.click();
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#source-health-list [data-source-activity-status]:visible")).toHaveCount(
      await allRows.count(),
    );
    await expect(page.locator("[data-visible-source-count]").first()).toHaveText(
      String(await allRows.count()),
    );
    await expect(workerHealthSection).toBeVisible();
    await expect(workerHealthSection).not.toHaveAttribute("hidden", "");

    const targetFilter = await page.locator("[data-source-filter]").evaluateAll((buttons) => {
      const candidates = buttons
        .map((button) => {
          const element = button as HTMLElement;
          return {
            value: element.dataset.sourceFilter ?? "all",
            count: Number(element.dataset.sourceCount ?? Number.NaN),
          };
        })
        .filter((candidate) => !["all", "limited"].includes(candidate.value) && candidate.count > 0);
      return candidates[0]?.value ?? "";
    });
    expect(targetFilter, "the current status corpus exposes a non-empty source status").not.toBe("");

    const filterButton = page.locator(`[data-source-filter="${targetFilter}"]`);
    const expectedCount = Number(await filterButton.getAttribute("data-source-count"));
    await filterButton.click();
    await expect(filterButton).toHaveAttribute("aria-pressed", "true");

    const visibleStatuses = await page
      .locator("#source-health-list [data-source-activity-status]")
      .evaluateAll((items) =>
        items
          .filter((item) => !(item as HTMLElement).hidden)
          .map((item) => (item as HTMLElement).dataset.sourceActivityStatus),
      );
    expect(visibleStatuses).toHaveLength(expectedCount);
    expect(visibleStatuses.every((status) => status === targetFilter)).toBeTruthy();
    await expect(workerHealthSection).toBeVisible();
    await expect(workerHealthSection).not.toHaveAttribute("hidden", "");
  });

  test("sources route redirects to unified status page", async ({ page }) => {
    await page.goto("/sources/");

    await expect(page).toHaveURL(/\/status\/?$/);
    await expect(page.locator("#source-health-heading")).toBeVisible();
    const firstVisibleSource = page.locator("#source-health-list .source-item:not([hidden])").first();
    await expect(firstVisibleSource).toBeVisible();
    await expect(firstVisibleSource.locator(".source-status-badge")).toContainText(
      /最近掲載あり|低活動|長期非掲載|未収録/,
    );
    await expect(firstVisibleSource.locator(".source-meta-line")).not.toContainText(/tier|stale\s*>/i);
  });

  test("status category filter only shows matching sources", async ({ page }) => {
    await page.goto("/status/");
    await page.locator('[data-source-filter="all"]').click();

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

    const categoryButton = page.locator(`[data-category-filter="${targetCategory}"]`);
    const expectedCount = Number(await categoryButton.locator("span").innerText());
    await categoryButton.click();
    await expect(categoryButton).toHaveAttribute("aria-pressed", "true");

    const visibleCategories = await page.locator("#source-health-list [data-source-category]").evaluateAll((items) =>
      items
        .filter((item) => !(item as HTMLElement).hidden)
        .map((item) => (item as HTMLElement).dataset.sourceCategory),
    );
    expect(visibleCategories).toHaveLength(expectedCount);
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
    await expect(page.locator(".trend .chart-wrap")).toHaveAttribute(
      "aria-label",
      /^Papers\/Benchmarks trend chart/,
    );
    await expect(page.locator(".trend table caption")).toHaveText(
      "Papers/Benchmarks trend counts",
    );
    await expect(kpis.nth(0)).toBeVisible();
    await expect(kpis.nth(1)).toBeVisible();
    await expect(kpis.nth(2)).toBeHidden();
    await expect(kpis.nth(3)).toBeHidden();
    await expect(chart).toBeHidden();
    await expect(page.locator(".trend .x-axis")).toBeHidden();
    await expect(page.locator(".trend .legend .i18n-ja")).toContainText(
      "現在の Research 一覧",
    );
    await expect(page.locator(".trend .legend .i18n-ja")).not.toContainText(
      "data/stats.json",
    );
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

  test("About trust story and pipeline follow the active language", async ({ page }) => {
    await page.goto("/about/");
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator("[data-about-run-state]")).toHaveAttribute(
      "aria-label",
      /^Collection health:/,
    );
    await expect(page.locator(".page-hero-copy > p .i18n-en")).toContainText(
      "tracks daily changes across AI coding",
    );

    const panels = page.locator(".about-section-grid .about-panel");
    await expect(panels).toHaveCount(3);
    await expect(panels.nth(0).locator("h3 .i18n-en")).toHaveText(
      "A dashboard for not missing important changes",
    );
    await expect(panels.nth(1).locator("h3 .i18n-en")).toContainText(
      "One batch hourly",
    );
    await expect(panels.nth(2).locator("h3 .i18n-en")).toContainText(
      "preserve long-term trends",
    );
    for (let index = 0; index < await panels.count(); index += 1) {
      await expect(panels.nth(index).locator("h3 .i18n-ja")).toBeHidden();
      await expect(panels.nth(index).locator("p .i18n-ja")).toBeHidden();
    }

    const pipelineCards = page.locator(".pipeline-card");
    await expect(pipelineCards).toHaveCount(4);
    for (let index = 0; index < await pipelineCards.count(); index += 1) {
      await expect(pipelineCards.nth(index).locator("h3 .i18n-en")).toBeVisible();
      await expect(pipelineCards.nth(index).locator("p .i18n-en")).toBeVisible();
      await expect(pipelineCards.nth(index).locator("h3 .i18n-ja")).toBeHidden();
      await expect(pipelineCards.nth(index).locator("p .i18n-ja")).toBeHidden();
    }
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
      await expect(batchHeading).toContainText("約 6 時間周期");
      await expect(batchHeading.locator("xpath=following-sibling::p[1]")).toContainText(
        new RegExp(`${batchTotal} batch`),
      );
      await page.goto("/status/");
      await expect(page.locator('[data-health-scope="latest-batch"] small')).toContainText(`/${batchTotal}`);
    } else {
      await expect(batchHeading).toContainText("multi-batch");
    }
  });

  test("Privacy prompt pre-paint state matches storage, host, and route policy", async ({
    context,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    await context.route(`${PRODUCTION_ORIGIN}/**`, async (route) => {
      const source = new URL(route.request().url());
      const target = new URL(`${source.pathname}${source.search}`, baseURL!);
      const response = await route.fetch({ url: target.href });
      await route.fulfill({ response });
    });
    await context.route("https://pagead2.googlesyndication.com/**", (route) =>
      route.abort("blockedbyclient"));
    await context.route("**/_astro/*.js", (route) =>
      route.abort("blockedbyclient"));

    const validDate = "2026-07-27T00:00:00.000Z";
    const recordCases: Array<{ name: string; storedValue: string | null }> = [
      { name: "absent record", storedValue: null },
      { name: "malformed JSON", storedValue: "not-json" },
      {
        name: "extra record key",
        storedValue: JSON.stringify({
          version: 1,
          advertising: "allowed",
          decidedAt: validDate,
          analytics: "allowed",
        }),
      },
      {
        name: "old record version",
        storedValue: JSON.stringify({
          version: 0,
          advertising: "allowed",
          decidedAt: validDate,
        }),
      },
      {
        name: "invalid advertising choice",
        storedValue: JSON.stringify({
          version: 1,
          advertising: "unknown",
          decidedAt: validDate,
        }),
      },
      {
        name: "invalid decision date",
        storedValue: JSON.stringify({
          version: 1,
          advertising: "allowed",
          decidedAt: "not-a-date",
        }),
      },
      {
        name: "non-canonical decision date",
        storedValue: JSON.stringify({
          version: 1,
          advertising: "allowed",
          decidedAt: "2026-07-27T09:00:00+09:00",
        }),
      },
      {
        name: "allowed record",
        storedValue: JSON.stringify({
          version: 1,
          advertising: "allowed",
          decidedAt: validDate,
        }),
      },
      {
        name: "denied record",
        storedValue: JSON.stringify({
          version: 1,
          advertising: "denied",
          decidedAt: validDate,
        }),
      },
    ];
    const productionScenarios = recordCases.map(({ name, storedValue }) => {
      const expectedConsent = privacyConsentState(parsePrivacyConsent(storedValue));
      const visible = expectedConsent === "undecided";
      return {
        name: `production ${name}`,
        target: `${PRODUCTION_ORIGIN}/`,
        storedValue,
        expectedConsent,
        expectedState: visible ? "visible" : "hidden",
        visible,
      };
    });
    const scenarios: Array<{
      name: string;
      target: string;
      storedValue: string | null;
      expectedConsent: "allowed" | "denied" | "undecided";
      expectedState: "visible" | "hidden";
      visible: boolean;
      failStorageRead?: boolean;
    }> = [
      ...productionScenarios,
      {
        name: "unavailable production storage",
        target: `${PRODUCTION_ORIGIN}/`,
        storedValue: null,
        failStorageRead: true,
        expectedConsent: "undecided",
        expectedState: "visible",
        visible: true,
      },
      {
        name: "production Privacy route",
        target: `${PRODUCTION_ORIGIN}/privacy/`,
        storedValue: null,
        expectedConsent: "undecided",
        expectedState: "hidden",
        visible: false,
      },
      {
        name: "preview host",
        target: new URL("/", baseURL!).href,
        storedValue: null,
        expectedConsent: "undecided",
        expectedState: "hidden",
        visible: false,
      },
    ];

    for (const scenario of scenarios) {
      const scenarioPage = await context.newPage();
      await scenarioPage.setViewportSize({ width: 390, height: 844 });
      await installPrivacyPromptProbe(scenarioPage, {
        storedValue: scenario.storedValue,
        failStorageRead: scenario.failStorageRead,
      });
      const response = await scenarioPage.goto(scenario.target, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status(), `${scenario.name} response`).toBeLessThan(400);
      const evidence = await collectStablePrivacyLayout(scenarioPage);
      expect(evidence.stable, `${scenario.name} reaches a stable layout`).toBe(true);
      expect(evidence.firstLayout, `${scenario.name} captures initial prompt layout`).not.toBeNull();
      expect(
        evidence.firstLayout?.rootState,
        `${scenario.name} sets root state before prompt parsing`,
      ).toBe(scenario.expectedState);
      expect(evidence.rootState, `${scenario.name} keeps root state synchronized`).toBe(
        scenario.expectedState,
      );
      expect(
        evidence.advertisingState,
        `${scenario.name} inline parser matches the shared record parser`,
      ).toBe(scenario.expectedConsent);
      await expect(scenarioPage.locator("html")).not.toHaveAttribute(
        "data-privacy-consent-client",
        "ready",
      );
      expect(evidence.overflow, `${scenario.name} has no horizontal overflow`).toBeLessThanOrEqual(
        0,
      );

      if (scenario.visible) {
        expect(
          evidence.firstLayout?.display,
          `${scenario.name} is visible in its first layout`,
        ).not.toBe("none");
        expect(
          evidence.firstLayout?.height ?? 0,
          `${scenario.name} reserves prompt height before client initialization`,
        ).toBeGreaterThan(0);
        expect(evidence.promptVisible, `${scenario.name} stays visible after initialization`).toBe(
          true,
        );
        expect(evidence.promptHidden, `${scenario.name} removes hidden after initialization`).toBe(
          false,
        );
        expect(evidence.promptInert, `${scenario.name} removes inert after initialization`).toBe(
          false,
        );
      } else {
        expect(
          evidence.firstLayout?.display,
          `${scenario.name} never paints the prompt`,
        ).toBe("none");
        expect(evidence.firstLayout?.height, `${scenario.name} reserves no prompt height`).toBe(0);
        expect(evidence.promptVisible, `${scenario.name} remains prompt-free`).toBe(false);
        expect(evidence.promptHidden, `${scenario.name} keeps hidden semantics`).toBe(true);
        expect(evidence.promptInert, `${scenario.name} keeps inert semantics`).toBe(true);
      }
      await scenarioPage.close();
    }

    await context.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("Privacy prompt stays operable when the deferred client bundle is blocked", async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    let advertisingRequests = 0;
    await routeProductionHostToPreview(page, baseURL!);
    await page.route("https://pagead2.googlesyndication.com/**", async (route) => {
      advertisingRequests += 1;
      await route.abort("blockedbyclient");
    });
    await page.route(`${PRODUCTION_ORIGIN}/_astro/*.js`, (route) =>
      route.abort("blockedbyclient"));
    await installPrivacyPromptProbe(page, { storedValue: null });
    await page.setViewportSize({ width: 390, height: 844 });

    const response = await page.goto(`${PRODUCTION_ORIGIN}/`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBeLessThan(400);
    const initial = await collectStablePrivacyLayout(page);
    expect(initial.firstLayout?.display).not.toBe("none");
    expect(initial.firstLayout?.height ?? 0).toBeGreaterThan(0);
    expect(initial.promptVisible).toBe(true);
    expect(initial.promptHidden).toBe(false);
    expect(initial.promptInert).toBe(false);
    expect(initial.rootState).toBe("visible");
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-privacy-consent-client",
      "ready",
    );
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    expect(advertisingRequests).toBe(0);

    await page.getByRole("button", { name: "広告を許可" }).click();
    const storedValue = await page.evaluate((storageKey) =>
      window.localStorage.getItem(storageKey), PRIVACY_CONSENT_STORAGE_KEY);
    const record = parsePrivacyConsent(storedValue);
    expect(record?.advertising).toBe("allowed");
    const prompt = page.locator(".privacy-consent-prompt");
    await expect(prompt).toBeHidden();
    await expect(prompt).toHaveAttribute("inert", "");
    await expect(page.locator("html")).toHaveAttribute(
      "data-advertising-consent",
      "allowed",
    );
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    expect(advertisingRequests).toBe(0);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("Privacy consent prompt keeps first-load CLS within the good threshold", async ({
    browser,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const results: Array<{ name: string; cls: number }> = [];

    for (const viewport of [
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1280, height: 900 },
    ] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const scenarioPage = await context.newPage();
      await routeProductionHostToPreview(scenarioPage, baseURL!);
      await scenarioPage.route(
        "https://pagead2.googlesyndication.com/**",
        (route) => route.abort("blockedbyclient"),
      );
      await installPrivacyPromptProbe(scenarioPage, {
        storedValue: null,
        measureLayoutShift: true,
      });
      const response = await scenarioPage.goto(`${PRODUCTION_ORIGIN}/`, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status(), `${viewport.name} response`).toBeLessThan(400);
      const evidence = await collectStablePrivacyLayout(scenarioPage);
      expect(evidence.stable, `${viewport.name} reaches a stable layout`).toBe(true);
      expect(
        evidence.firstLayout?.display,
        `${viewport.name} prompt participates in the first layout`,
      ).not.toBe("none");
      expect(evidence.firstLayout?.height ?? 0).toBeGreaterThan(0);
      expect(evidence.promptVisible).toBe(true);
      expect(evidence.rootState).toBe("visible");
      expect(evidence.overflow).toBeLessThanOrEqual(0);
      expect(evidence.cls, `${viewport.name} exposes LayoutShift metrics`).not.toBeNull();
      expect(evidence.cls!, `${viewport.name} CLS remains good`).toBeLessThanOrEqual(0.1);
      results.push({ name: viewport.name, cls: evidence.cls! });
      await scenarioPage.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }

    console.log(
      `CONSENT_CLS: ${results.map((result) => `${result.name}=${result.cls.toFixed(4)}`).join(" ")}`,
    );
  });

  test("Privacy keeps optional ads off by default and exposes bilingual controls", async ({
    page,
  }) => {
    let deleteStatus = 200;
    await page.addInitScript(() => window.localStorage.clear());
    await page.route("**/api/reactions/config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: {
            databaseBinding: true,
            hmacSecret: true,
            turnstileSecret: false,
            publicSiteKey: false,
            configured: false,
          },
        }),
      });
    });
    await page.route("**/api/reactions/identity", async (route) => {
      expect(route.request().method()).toBe("DELETE");
      await route.fulfill({
        status: deleteStatus,
        contentType: "application/json",
        body: deleteStatus === 200
          ? JSON.stringify({ identity: { ready: false, deleted: true } })
          : JSON.stringify({ error: { code: "service_unavailable" } }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/privacy/");
    await expect(page.locator("body")).toHaveClass(/privacy-page/);
    await expect(page.locator(".footer-bar")).toHaveCSS("position", "static");
    await expect(page.locator("#privacy-heading")).toBeVisible();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /TECH Dashboardのデータ取扱い/,
    );
    await expect(page.locator(".privacy-consent-prompt")).toBeHidden();
    await expect(page.locator("#consent-settings-heading")).toBeVisible();
    await expect(page.getByRole("group", { name: "広告の同意設定" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "プライバシーページの案内" })).toBeVisible();
    await expect(page.locator('[data-consent-status="undecided"]')).toBeVisible();
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    await expect(page.locator("#contact")).toContainText("Studio344");
    await expect(page.locator("#contact")).toContainText("himiyosh@gmail.com");
    await expect(page.locator("#contact")).toContainText("日本");
    await expect(page.locator('a[href="mailto:himiyosh@gmail.com"]')).toBeVisible();

    const denied = page.getByRole("button", { name: "広告なしで続行" });
    await denied.click();
    await expect(denied).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-consent-status="denied"]')).toBeVisible();
    expect(
      await page.evaluate(() => {
        const value = window.localStorage.getItem("td:privacy-consent:v1");
        return value ? JSON.parse(value) : null;
      }),
    ).toMatchObject({ version: 1, advertising: "denied" });

    const allowed = page.getByRole("button", { name: "広告を許可" });
    await allowed.click();
    await expect(allowed).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-consent-status="allowed"]')).toBeVisible();
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);

    await page.evaluate(() => {
      window.localStorage.setItem("tech-dashboard-arxiv-view", "compact");
    });
    const clearPreferences = page.getByRole("button", { name: "ローカル設定を消去" });
    await clearPreferences.click();
    await expect(clearPreferences).toBeFocused();
    expect(
      await page.evaluate(() => ({
        consent: window.localStorage.getItem("td:privacy-consent:v1"),
        language: window.localStorage.getItem("td:lang"),
        arxiv: window.localStorage.getItem("tech-dashboard-arxiv-view"),
      })),
    ).toEqual({ consent: null, language: null, arxiv: null });

    const deleteOpen = page.locator("[data-reaction-delete-open]");
    await expect(deleteOpen).toHaveAccessibleName("削除を確認");
    await expect(
      page.locator('[data-reaction-delete-availability="ready"]'),
    ).toBeVisible();
    await deleteOpen.click();
    const confirmation = page.locator("[data-reaction-delete-confirmation]");
    await expect(confirmation).toBeVisible();
    await expect(deleteOpen).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "キャンセル" })).toBeFocused();
    await page.getByRole("button", { name: "削除する" }).click();
    await expect(page.locator('[data-privacy-control-status="success"]')).toBeVisible();
    await expect(deleteOpen).toBeFocused();
    await expect(deleteOpen).toHaveAttribute("aria-expanded", "false");

    deleteStatus = 503;
    await deleteOpen.click();
    const deleteConfirm = page.getByRole("button", { name: "削除する" });
    await deleteConfirm.click();
    await expect(page.locator('[data-privacy-control-status="error"]')).toBeVisible();
    await expect(deleteConfirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    await expect(deleteOpen).toBeFocused();

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator("#privacy-heading .i18n-en")).toBeVisible();
    await expect(page.locator("#privacy-heading .i18n-ja")).toBeHidden();
    await expect(page.locator("#choices .i18n-en").first()).toBeVisible();
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      /TECH Dashboard privacy, advertising consent/,
    );
    await expect(page.getByRole("group", { name: "Advertising consent setting" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Privacy page navigation" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue without ads" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Allow advertising" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Privacy policy .*opens in a new tab/ }).first(),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const tabbar = page.getByRole("navigation", { name: "Primary" });
    await tabbar.getByRole("button", { name: /Menu/ }).click();
    const privacyMenuLink = page.locator("#site-menu").getByRole("link", {
      name: /Privacy/,
    });
    await expect(privacyMenuLink).toBeVisible();
    await expect(privacyMenuLink).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    const targetHeights = await page
      .locator(
        ".consent-actions button, .privacy-controls button, .privacy-rail nav a, .third-party-list a, .privacy-contact a",
      )
      .evaluateAll((nodes) =>
        nodes
          .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0)
          .map((node) => node.getBoundingClientRect().height),
      );
    expect(targetHeights.length).toBeGreaterThan(0);
    expect(targetHeights.every((height) => height >= 44)).toBe(true);

    await page.setViewportSize({ width: 375, height: 667 });
    await deleteOpen.scrollIntoViewIfNeeded();
    await deleteOpen.click();
    await expect(confirmation).toBeVisible();
    await expect
      .poll(async () => {
        const [confirmationBox, tabbarBox] = await Promise.all([
          confirmation.boundingBox(),
          tabbar.boundingBox(),
        ]);
        return confirmationBox && tabbarBox
          ? tabbarBox.y - (confirmationBox.y + confirmationBox.height)
          : -1;
      })
      .toBeGreaterThanOrEqual(8);
    await page.getByRole("button", { name: "Delete data" }).click();
    const errorStatus = page.locator('[data-privacy-control-status="error"]');
    await expect(errorStatus).toBeVisible();
    await expect
      .poll(async () => {
        const [statusBox, tabbarBox] = await Promise.all([
          errorStatus.boundingBox(),
          tabbar.boundingBox(),
        ]);
        return statusBox && tabbarBox
          ? tabbarBox.y - (statusBox.y + statusBox.height)
          : -1;
      })
      .toBeGreaterThanOrEqual(8);
  });

  test("Privacy prompt stays operable above the mobile tabbar", async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    await routeProductionHostToPreview(page, baseURL!);
    await page.route("https://pagead2.googlesyndication.com/**", (route) =>
      route.abort("blockedbyclient"));
    await installPrivacyPromptProbe(page, { storedValue: null });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${PRODUCTION_ORIGIN}/`);
    const prompt = page.locator(".privacy-consent-prompt");
    await expect(prompt).toBeVisible();

    for (const width of [320, 360, 361, 390, 720, 721, 768, 1280]) {
      const height = width <= 720 ? 844 : 900;
      await page.setViewportSize({ width, height });
      await page.evaluate(
        () => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
      );
      const metrics = await page.evaluate(() => {
        const prompt = document.querySelector<HTMLElement>(".privacy-consent-prompt");
        const featured = document.querySelector<HTMLElement>("article.featured");
        const tabbar = document.querySelector<HTMLElement>(".mobile-tabbar");
        if (!prompt || !featured || !tabbar) return null;
        const promptBox = prompt.getBoundingClientRect();
        const featuredBox = featured.getBoundingClientRect();
        const tabbarBox = tabbar.getBoundingClientRect();
        const hit = document.elementFromPoint(
          promptBox.x + promptBox.width / 2,
          promptBox.y + promptBox.height / 2,
        );
        return {
          position: getComputedStyle(prompt).position,
          promptHidden: prompt.hidden,
          promptInert: prompt.hasAttribute("inert"),
          promptLeft: promptBox.left,
          promptRight: promptBox.right,
          promptBottom: promptBox.bottom,
          featuredTop: featuredBox.top,
          tabbarVisible: tabbarBox.width > 0 && tabbarBox.height > 0,
          targets: [...prompt.querySelectorAll<HTMLElement>("a, button")].map((target) => {
            const box = target.getBoundingClientRect();
            return {
              height: box.height,
              left: box.left,
              right: box.right,
            };
          }),
          promptHit: Boolean(hit?.closest(".privacy-consent-prompt")),
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        };
      });
      expect(metrics, `${width}px prompt metrics`).not.toBeNull();
      expect(metrics!.promptHidden, `${width}px prompt is not hidden`).toBe(false);
      expect(metrics!.promptInert, `${width}px prompt is operable`).toBe(false);
      expect(metrics!.promptLeft, `${width}px prompt stays inside the left edge`).toBeGreaterThanOrEqual(
        0,
      );
      expect(metrics!.promptRight, `${width}px prompt stays inside the right edge`).toBeLessThanOrEqual(
        metrics!.viewportWidth,
      );
      expect(metrics!.targets.length, `${width}px exposes consent controls`).toBeGreaterThan(0);
      expect(
        metrics!.targets.every((target) =>
          target.height >= 44
          && target.left >= 0
          && target.right <= metrics!.viewportWidth
        ),
        `${width}px consent targets remain at least 44px and inside the viewport`,
      ).toBe(true);
      expect(metrics!.promptHit, `${width}px prompt remains hit-testable`).toBe(true);
      expect(metrics!.overflow, `${width}px has no horizontal overflow`).toBeLessThanOrEqual(0);

      if (width <= 720) {
        expect(metrics!.position, `${width}px uses the mobile flow layout`).toBe("relative");
        expect(metrics!.tabbarVisible, `${width}px keeps the mobile tabbar`).toBe(true);
        expect(
          metrics!.promptBottom,
          `${width}px prompt remains before the first decision card`,
        ).toBeLessThanOrEqual(metrics!.featuredTop - 8);
      } else {
        expect(metrics!.position, `${width}px uses the desktop overlay layout`).toBe("fixed");
        expect(metrics!.tabbarVisible, `${width}px hides the mobile tabbar`).toBe(false);
        expect(metrics!.promptBottom, `${width}px prompt stays inside the viewport`).toBeLessThanOrEqual(
          metrics!.viewportHeight,
        );
      }
    }
  });

  test("Privacy deletion fails closed when the runtime endpoint is unavailable", async ({
    page,
  }) => {
    await page.route("**/api/reactions/config", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found" } }),
      }));
    await page.goto("/privacy/");
    const card = page.locator("[data-reaction-delete-card]");
    await expect(card).toHaveAttribute(
      "data-reaction-delete-state",
      "unavailable",
    );
    await expect(
      card.locator('[data-reaction-delete-availability="unavailable"]'),
    ).toBeVisible();
    await expect(card.locator("[data-reaction-delete-open]")).toBeHidden();
    await expect(card).toContainText("静的previewでは削除APIを確認できません");
  });

  test("Advertising loads only for current explicit consent on the production host", async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    let advertisingRequests = 0;
    await page.route("https://techdb.studio344.net/**", async (route) => {
      const source = new URL(route.request().url());
      const target = new URL(`${source.pathname}${source.search}`, baseURL!);
      const response = await route.fetch({ url: target.href });
      await route.fulfill({ response });
    });
    await page.route("https://pagead2.googlesyndication.com/**", async (route) => {
      advertisingRequests += 1;
      await route.abort("blockedbyclient");
    });
    await page.goto("https://techdb.studio344.net/");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    const prompt = page.locator(".privacy-consent-prompt");
    await expect(prompt).toBeVisible();
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    expect(advertisingRequests).toBe(0);

    await page.evaluate(() => {
      window.localStorage.setItem(
        "td:privacy-consent:v1",
        JSON.stringify({
          version: 0,
          advertising: "allowed",
          decidedAt: "2026-07-27T00:00:00.000Z",
        }),
      );
    });
    await page.reload();
    await expect(prompt).toBeVisible();
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    expect(advertisingRequests).toBe(0);

    await page.evaluate(() => {
      window.localStorage.setItem(
        "td:privacy-consent:v1",
        JSON.stringify({
          version: 1,
          advertising: "allowed",
          decidedAt: "2026-07-27T00:00:00.000Z",
        }),
      );
    });
    await page.reload();
    await expect(prompt).toBeHidden();
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(1);
    await expect.poll(() => advertisingRequests).toBe(1);

    await page.evaluate(() => {
      window.localStorage.setItem(
        "td:privacy-consent:v1",
        JSON.stringify({
          version: 1,
          advertising: "denied",
          decidedAt: "2026-07-27T00:00:00.000Z",
        }),
      );
    });
    await page.reload();
    await expect(prompt).toBeHidden();
    await expect(page.locator('script[src*="googlesyndication"]')).toHaveCount(0);
    expect(advertisingRequests).toBe(1);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("Advertising withdrawal unloads active scripts across tabs and restores focus", async ({
    context,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    await context.route("https://techdb.studio344.net/**", async (route) => {
      const source = new URL(route.request().url());
      const target = new URL(`${source.pathname}${source.search}`, baseURL!);
      const response = await route.fetch({ url: target.href });
      await route.fulfill({ response });
    });
    await context.route("https://pagead2.googlesyndication.com/**", (route) =>
      route.abort("blockedbyclient"));

    const settingsPage = await context.newPage();
    await settingsPage.goto("https://techdb.studio344.net/privacy/");
    await settingsPage.evaluate(() => {
      window.localStorage.setItem(
        "td:privacy-consent:v1",
        JSON.stringify({
          version: 1,
          advertising: "allowed",
          decidedAt: "2026-07-27T00:00:00.000Z",
        }),
      );
    });
    await settingsPage.reload();
    await expect(
      settingsPage.locator('script[src*="googlesyndication"]'),
    ).toHaveCount(1);

    const secondPage = await context.newPage();
    await secondPage.goto("https://techdb.studio344.net/");
    await expect(
      secondPage.locator('script[src*="googlesyndication"]'),
    ).toHaveCount(1);

    const denialButton = settingsPage.locator(
      '[data-consent-surface="settings"] [data-consent-choice="denied"]',
    );
    const settingsReload = settingsPage.waitForNavigation({ waitUntil: "domcontentloaded" });
    const secondReload = secondPage.waitForNavigation({ waitUntil: "domcontentloaded" });
    await denialButton.click();
    await Promise.all([settingsReload, secondReload]);

    await expect(
      settingsPage.locator('script[src*="googlesyndication"]'),
    ).toHaveCount(0);
    await expect(
      secondPage.locator('script[src*="googlesyndication"]'),
    ).toHaveCount(0);
    await expect(
      settingsPage.locator(
        '[data-consent-surface="settings"] [data-consent-choice="denied"]',
      ),
    ).toBeFocused();
    expect(
      await secondPage.evaluate(() => {
        const value = window.localStorage.getItem("td:privacy-consent:v1");
        return value ? JSON.parse(value).advertising : null;
      }),
    ).toBe("denied");

    await context.unrouteAll({ behavior: "ignoreErrors" });
    await settingsPage.close();
    await secondPage.close();
  });

  test("Research copy distinguishes selected research from paper-only arXiv browsing", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/c/research/");
    await expect(page.locator(".page-hero h1")).toContainText("Research");
    await expect(page.locator(".page-hero h1")).not.toContainText("Papers / Benchmarks");
    const arxivIds = new Set(
      (JSON.parse(readFileSync("data/index.json", "utf8")) as {
        entries: Array<{ id: string; source: string; sourceType: string; url: string }>;
      }).entries
        .filter((entry) => (
          entry.source.startsWith("arxiv-")
          || entry.sourceType === "paper" && /(?:^|\.)arxiv\.org$/i.test(new URL(entry.url).hostname)
        ))
        .map((entry) => entry.id),
    );
    const researchIds = await page.locator("main article.card h3.title > a").evaluateAll(
      (links) => links
        .map((link) => link.getAttribute("href")?.match(/^\/e\/([^/]+)\//)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    expect(
      researchIds.filter((id) => arxivIds.has(id)),
      "Research listing excludes entries owned by the arXiv lane",
    ).toEqual([]);
    const callout = page.locator(".research-split-callout");
    await expect(callout).toContainText("選定した論文・レポート");
    await expect(callout).toContainText("arXiv レーンでは論文だけ");
    await expect(callout.getByRole("link", { name: "arXiv Papers" })).toBeVisible();

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator(".page-hero-copy > p > .i18n-en")).toBeVisible();
    await expect(page.locator(".page-hero-copy > p > .i18n-en")).toContainText(
      "Browse Research updates",
    );
    await expect(callout.locator("h2 .i18n-en")).toHaveText(
      "Research includes selected papers and reports",
    );
    await expect(callout.locator("p.i18n-en")).toContainText(
      "dedicated arXiv lane",
    );
    await expect(page.locator(".section-header .sort .i18n-en")).toHaveText("Newest first");
    const sidePanel = page.locator(".category-side-panel");
    await expect(sidePanel.locator(".category-side-note > p.i18n-en")).toContainText(
      "High-volume arXiv papers",
    );
    await expect(sidePanel.locator(".category-side-note .side-action .i18n-en")).toHaveText(
      "Open arXiv Papers",
    );
    const latestTitleEn = sidePanel.locator(".category-latest-link > strong.i18n-en");
    if (await latestTitleEn.count()) {
      await expect(latestTitleEn).toBeVisible();
      await expect(latestTitleEn).not.toHaveText("");
      const renderedLang = await latestTitleEn.getAttribute("lang");
      expect(["en", "ja"]).toContain(renderedLang);
      if (renderedLang === "ja") {
        const badge = latestTitleEn.locator(
          '.language-fallback-badge[data-fallback-language="ja"]',
        );
        await expect(badge.locator(".i18n-en")).toHaveText("Japanese title");
      }
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
    expect(metrics.bodyQueueBacklog === null || Number.isFinite(metrics.bodyQueueBacklog)).toBeTruthy();
    expect(metrics.bodyQueueDrainEstimateHours === null || Number.isFinite(metrics.bodyQueueDrainEstimateHours)).toBeTruthy();
    expect(metrics.bodyQueueEnqueued === null || Number.isFinite(metrics.bodyQueueEnqueued)).toBeTruthy();
    expect(metrics.bodyQueueMerged === null || Number.isFinite(metrics.bodyQueueMerged)).toBeTruthy();
    expect(metrics.bodyQueueEnqueueCap === null || Number.isFinite(metrics.bodyQueueEnqueueCap)).toBeTruthy();
    expect(metrics.enrichmentEnqueueCap === null || Number.isFinite(metrics.enrichmentEnqueueCap)).toBeTruthy();
    expect(metrics.enrichmentEnqueued === null || Number.isFinite(metrics.enrichmentEnqueued)).toBeTruthy();
    expect(Number.isFinite(Date.parse(metrics.generatedAt))).toBeTruthy();
  });

  test("archive page links to monthly archive pages", async ({ page }) => {
    await page.goto("/archive/");

    await expect(page.locator(".crumb-bar")).toHaveCount(0);
    await expect(page.locator("#archive-heading")).toBeVisible();
    await expect(page.locator(".page-hero-metric").filter({ hasText: "All time" })).toHaveCount(0);
    await expect(page.locator('[data-metric-scope="timeline-live"]')).toContainText("Live index");
    const archivePopulations = await page.evaluate(() => {
      const metricValue = (scope: string) =>
        Number(document.querySelector(`[data-metric-scope="${scope}"] strong`)?.textContent?.trim());
      return {
        browsable: metricValue("archive-browsable"),
        stored: metricValue("archive-stored"),
      };
    });
    expect(archivePopulations.browsable).toBeGreaterThan(0);
    expect(archivePopulations.stored).toBeGreaterThan(archivePopulations.browsable);
    await expect(page.locator(".archive-spotlight").filter({ hasText: "Storage mix" })).toContainText(
      "hot = live収録時点の統計用snapshot",
    );
    const peakLabels = await page.locator("a.month-card").evaluateAll((cards) =>
      cards.map((card) => ({
        peakPercent: Number(card.getAttribute("data-peak-percent")),
        visualBarWidth: Number(card.getAttribute("data-visual-bar-width")),
        browsable: Number(card.getAttribute("data-browsable-count")),
        stored: Number(card.getAttribute("data-stored-count")),
        label: card.querySelector(".month-share")?.textContent?.trim() ?? "",
      })),
    );
    expect(peakLabels.length).toBeGreaterThan(0);
    for (const metric of peakLabels) {
      const expectedLabel = metric.peakPercent > 0 && metric.peakPercent < 1
        ? "<1% of peak"
        : `${metric.peakPercent}% of peak`;
      expect(metric.label).toBe(expectedLabel);
      expect(metric.visualBarWidth).toBeGreaterThanOrEqual(6);
      expect(metric.visualBarWidth).toBeLessThanOrEqual(100);
      expect(metric.browsable).toBeGreaterThan(0);
      expect(metric.stored).toBeGreaterThanOrEqual(metric.browsable);
    }
    expect(
      peakLabels.some((metric) => metric.peakPercent < 6 && metric.visualBarWidth === 6),
      "a sub-6% month keeps a visible bar without changing its factual label",
    ).toBe(true);
    const firstMonth = page.locator("a.month-card").first();
    await expect(firstMonth).toBeVisible();
    await expect(firstMonth.locator(".month-share")).toContainText(/% of peak/);
    await expect(firstMonth.locator(".month-category")).toContainText(
      /Top category.*\d+ browsable/,
    );
    await firstMonth.click();
    await expect(page).toHaveURL(/\/archive\/\d{4}-\d{2}\/?$/);
    await expect(page.locator("#archive-month-heading")).toBeVisible();
    const monthPopulations = await page.evaluate(() => {
      const metricValue = (scope: string) =>
        Number(document.querySelector(`[data-metric-scope="${scope}"] strong`)?.textContent?.trim());
      return {
        browsable: metricValue("month-browsable-count"),
        stored: metricValue("month-stored-count"),
      };
    });
    expect(monthPopulations.browsable).toBeGreaterThan(0);
    expect(monthPopulations.stored).toBeGreaterThanOrEqual(monthPopulations.browsable);
    await expect(page.locator('[data-metric-scope="month-top-category"]')).toContainText("Top category");
    await expect(page.locator('[data-metric-scope="month-top-source"]')).toContainText("Top source");
    await expect(page.locator(".page-hero-metric").filter({ hasText: /^Warm/ })).toHaveCount(0);
    await expect(page.locator(".month-rank-scope")).toHaveCount(2);
    await expect(page.locator(".month-rank-scope").first()).toHaveText(
      "Browsable entries in this month",
    );
    await expect(page.locator(".category-strip-label .i18n-ja")).toHaveText(
      "閲覧可能記事のカテゴリ内訳",
    );
  });

  test("archive warm rows keep detail routes while cold rows link to the source", async ({
    page,
  }) => {
    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string }>;
    };
    const liveIds = new Set(index.entries.map((entry) => entry.id));
    const archiveIndex = JSON.parse(
      readFileSync("data/archive/_index.json", "utf8"),
    ) as { months: string[] };
    let warmOnly: { id: string; month: string } | null = null;
    let cold: { id: string; month: string; url: string } | null = null;

    for (const month of archiveIndex.months) {
      const archive = JSON.parse(
        readFileSync(`data/archive/${month}.json`, "utf8"),
      ) as {
        entries: Array<{
          id: string;
          url: string;
          archiveTier?: string;
        }>;
      };
      if (!warmOnly) {
        const entry = archive.entries.find(
          (candidate) =>
            candidate.archiveTier === "warm" && !liveIds.has(candidate.id),
        );
        if (entry) warmOnly = { id: entry.id, month };
      }
      if (!cold) {
        const entry = archive.entries.find(
          (candidate) => candidate.archiveTier === "cold",
        );
        if (entry) cold = { id: entry.id, month, url: entry.url };
      }
      if (warmOnly && cold) break;
    }

    expect(warmOnly, "fixture includes a warm entry outside the live index").not.toBeNull();
    expect(cold, "fixture includes a cold archive entry").not.toBeNull();

    const warmResponse = await page.goto(`/e/${warmOnly!.id}/`);
    expect(warmResponse?.status()).toBeLessThan(400);
    await expect(page.locator("article.entry-detail")).toBeVisible();

    await page.goto(`/archive/${cold!.month}/`);
    const coldCard = page.locator(
      `article.card[data-entry-id="${cold!.id}"]`,
    );
    await expect(coldCard).toHaveAttribute("data-detail-destination", "source");
    await expect(coldCard.locator("h3.title > a")).toHaveAttribute(
      "href",
      cold!.url,
    );
    await expect(coldCard.locator("h3.title > a")).toHaveAttribute(
      "target",
      "_blank",
    );
    await expect(coldCard.locator("a.url > .i18n-ja")).toContainText("元記事");
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

    await page.setViewportSize({ width: 901, height: 844 });
    const compactSwitcher = page.locator("header .header-switcher");
    await expect(compactSwitcher.getByRole("link", { name: "Categories", exact: true })).toBeVisible();
    await expect(compactSwitcher.getByRole("link", { name: "arXiv", exact: true })).toBeVisible();
    await expect(compactSwitcher.getByRole("link", { name: "Knowledge", exact: true })).toBeVisible();
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
    await expect(menu.getByRole("link", { name: /Privacy/ })).toBeVisible();
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
    const mobileMenuToggle = page.locator("button.mobile-menu-trigger[data-menu-trigger]");

    await tabbar.getByRole("link", { name: "Categories" }).click();
    await expect(page).toHaveURL(/\/categories\/?$/);
    await expect(page.locator("#categories-heading")).toBeVisible();
    await expect(tabbar.getByRole("link", { name: "Categories" })).toHaveClass(/active/);
    await expect(tabbar.getByRole("button", { name: /Menu/ })).not.toHaveClass(/active/);
    await openMobileMenu();
    const openMobileMenuMetrics = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#site-menu");
      const trigger = document.querySelector<HTMLButtonElement>(
        "button.mobile-menu-trigger[data-menu-trigger]",
      );
      const tabbar = document.querySelector<HTMLElement>(".mobile-tabbar");
      const placeholder = document.querySelector<HTMLElement>(".mobile-menu-trigger-placeholder");
      if (!dialog || !trigger || !tabbar || !placeholder) return null;
      const triggerRect = trigger.getBoundingClientRect();
      const placeholderRect = placeholder.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const hit = document.elementFromPoint(
        triggerRect.left + triggerRect.width / 2,
        triggerRect.top + triggerRect.height / 2,
      );
      return {
        dialogOwnsToggle: dialog.contains(trigger),
        tabbarActionSlots: tabbar.querySelectorAll("a, .mobile-menu-trigger-placeholder").length,
        toggleOccupiesTabbarSlot:
          Math.abs(triggerRect.left - placeholderRect.left) <= 1 &&
          Math.abs(triggerRect.top - placeholderRect.top) <= 1 &&
          Math.abs(triggerRect.width - placeholderRect.width) <= 1 &&
          Math.abs(triggerRect.height - placeholderRect.height) <= 1,
        toggleIsHitTestable:
          hit === trigger || hit?.closest("button.mobile-menu-trigger") === trigger,
        toggleWidth: triggerRect.width,
        toggleHeight: triggerRect.height,
        sheetBottom: dialogRect.bottom,
        tabbarTop: tabbar.getBoundingClientRect().top,
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(openMobileMenuMetrics).not.toBeNull();
    expect(openMobileMenuMetrics!.dialogOwnsToggle).toBe(true);
    expect(openMobileMenuMetrics!.tabbarActionSlots).toBe(5);
    expect(openMobileMenuMetrics!.toggleOccupiesTabbarSlot).toBe(true);
    expect(openMobileMenuMetrics!.toggleIsHitTestable).toBe(true);
    expect(openMobileMenuMetrics!.toggleWidth).toBeGreaterThanOrEqual(44);
    expect(openMobileMenuMetrics!.toggleHeight).toBeGreaterThanOrEqual(44);
    expect(openMobileMenuMetrics!.sheetBottom).toBeLessThan(openMobileMenuMetrics!.tabbarTop);
    expect(openMobileMenuMetrics!.noHorizontalOverflow).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press("Tab");
      const focusEvidence = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>("#site-menu");
        const active = document.activeElement as HTMLElement | null;
        if (!dialog || !active) return null;
        const dialogRect = dialog.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return {
          insideDialog: dialog.contains(active),
          portalledToggle: active.matches(".mobile-menu-trigger.is-dialog-toggle"),
          activeTop: activeRect.top,
          activeBottom: activeRect.bottom,
          dialogTop: dialogRect.top,
          dialogBottom: dialogRect.bottom,
        };
      });
      expect(focusEvidence, `mobile Tab step ${index + 1} has a focused control`).not.toBeNull();
      expect(
        focusEvidence!.insideDialog,
        `mobile modal menu keeps focus on Tab step ${index + 1}`,
      ).toBe(true);
      if (!focusEvidence!.portalledToggle) {
        expect(focusEvidence!.activeTop).toBeGreaterThanOrEqual(focusEvidence!.dialogTop - 0.5);
        expect(focusEvidence!.activeBottom).toBeLessThanOrEqual(focusEvidence!.dialogBottom + 0.5);
      }
    }
    await mobileMenuToggle.click();
    await expect(menu).toBeHidden();
    await expect(mobileMenuToggle).toBeFocused();
    await mobileMenuToggle.click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(mobileMenuToggle).toBeFocused();
    await mobileMenuToggle.click();
    await page.mouse.click(4, 4);
    await expect(menu).toBeHidden();
    await expect(mobileMenuToggle).toBeFocused();
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
    await expect(page.locator("#source-health-heading")).toBeVisible();
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

  test("modal menu locks background scrolling and restores every dismiss path", async ({ page }) => {
    const menu = page.locator("#site-menu");
    const captureDocumentState = () =>
      page.evaluate(() => {
        const content = document.querySelector<HTMLElement>("#content-start");
        const header = document.querySelector<HTMLElement>("header .header-inner");
        const contentRect = content?.getBoundingClientRect();
        const headerRect = header?.getBoundingClientRect();
        return {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          bodyTop: document.body.getBoundingClientRect().top,
          contentTop: contentRect?.top ?? null,
          headerLeft: headerRect?.left ?? null,
          headerWidth: headerRect?.width ?? null,
          htmlStyle: document.documentElement.getAttribute("style") ?? "",
          bodyStyle: document.body.getAttribute("style") ?? "",
          htmlClass: document.documentElement.className,
          bodyClass: document.body.className,
          htmlInert: document.documentElement.hasAttribute("inert"),
          bodyInert: document.body.hasAttribute("inert"),
          htmlOverflow: getComputedStyle(document.documentElement).overflow,
          bodyOverflow: getComputedStyle(document.body).overflow,
          bodyPosition: getComputedStyle(document.body).position,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
    const settleLayout = () =>
      page.evaluate(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      );
    const setScrollPosition = async () => {
      await page.evaluate(() => window.scrollTo(0, 1200));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(900);
    };
    const expectBackgroundLocked = async (
      before: Awaited<ReturnType<typeof captureDocumentState>>,
    ) => {
      const locked = await captureDocumentState();
      expect(locked.scrollY, "fixed-body lock keeps the root scroll offset at zero").toBe(0);
      expect(locked.bodyPosition).toBe("fixed");
      expect(locked.htmlOverflow).toBe("hidden");
      expect(locked.bodyOverflow).toBe("hidden");
      expect(Math.abs(locked.bodyTop - before.bodyTop), "body visual position remains stable").toBeLessThanOrEqual(0.5);
      expect(Math.abs((locked.contentTop ?? 0) - (before.contentTop ?? 0)), "content does not move behind the dialog").toBeLessThanOrEqual(0.5);
      expect(Math.abs((locked.headerLeft ?? 0) - (before.headerLeft ?? 0)), "scrollbar compensation does not shift the header").toBeLessThanOrEqual(0.5);
      expect(Math.abs((locked.headerWidth ?? 0) - (before.headerWidth ?? 0)), "scrollbar compensation keeps the header width stable").toBeLessThanOrEqual(0.5);
      expect(locked.horizontalOverflow).toBe(false);
    };
    const expectDocumentRestored = async (
      before: Awaited<ReturnType<typeof captureDocumentState>>,
    ) => {
      await expect(menu).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before.scrollY);
      const restored = await captureDocumentState();
      expect(restored.scrollX).toBe(before.scrollX);
      expect(restored.scrollY).toBe(before.scrollY);
      expect(restored.htmlStyle).toBe(before.htmlStyle);
      expect(restored.bodyStyle).toBe(before.bodyStyle);
      expect(restored.htmlClass).toBe(before.htmlClass);
      expect(restored.bodyClass).toBe(before.bodyClass);
      expect(restored.htmlInert).toBe(before.htmlInert);
      expect(restored.bodyInert).toBe(before.bodyInert);
      expect(restored.horizontalOverflow).toBe(false);
    };

    for (const viewport of [
      {
        name: "mobile",
        width: 390,
        height: 844,
        trigger: ".mobile-tabbar button[data-menu-trigger]",
        close: "button.mobile-menu-trigger[data-menu-trigger]",
      },
      {
        name: "desktop",
        width: 1440,
        height: 900,
        trigger: "header .menu-trigger",
        close: "#site-menu [data-menu-close]",
      },
    ] as const) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/");
      await setScrollPosition();
      const before = await captureDocumentState();
      await page.locator(viewport.trigger).click();
      await expect(menu).toBeVisible();
      await settleLayout();
      await expectBackgroundLocked(before);

      await page.mouse.move(4, Math.round(viewport.height / 2));
      await page.mouse.wheel(0, 500);
      await expectBackgroundLocked(before);

      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 4, y: Math.round(viewport.height * 0.75) }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 4, y: Math.round(viewport.height * 0.35) }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await expectBackgroundLocked(before);

      await menu.locator("a").first().focus();
      await page.keyboard.press("PageDown");
      await expectBackgroundLocked(before);
      await page.keyboard.press("Space");
      await expectBackgroundLocked(before);

      await page.evaluate(() => window.scrollBy(0, 500));
      await expectBackgroundLocked(before);

      await page.locator(viewport.close).click();
      await expectDocumentRestored(before);
      await expect(page.locator(viewport.trigger)).toBeFocused();

      await setScrollPosition();
      const beforeEscape = await captureDocumentState();
      await page.locator(viewport.trigger).click();
      await page.keyboard.press("Escape");
      await expectDocumentRestored(beforeEscape);
      await expect(page.locator(viewport.trigger)).toBeFocused();

      await setScrollPosition();
      const beforeBackdrop = await captureDocumentState();
      await page.locator(viewport.trigger).click();
      await page.mouse.click(4, 4);
      await expectDocumentRestored(beforeBackdrop);
      await expect(page.locator(viewport.trigger)).toBeFocused();

      await setScrollPosition();
      const beforeSearch = await captureDocumentState();
      await page.locator(viewport.trigger).click();
      await menu.getByRole("button", { name: /Search/ }).click();
      await expectDocumentRestored(beforeSearch);
      await expect(page.locator("#pagefind-search-input")).toBeFocused();
      await page.locator("#pagefind-search-input").press("Escape");

      await setScrollPosition();
      const beforeNavigation = await captureDocumentState();
      await page.locator(viewport.trigger).click();
      await page.evaluate(() => {
        document.querySelector<HTMLAnchorElement>('#site-menu a[href="/archive"]')
          ?.addEventListener("click", (event) => event.preventDefault(), { once: true });
      });
      await menu.getByRole("link", { name: /Archive/ }).click();
      await expectDocumentRestored(beforeNavigation);
    }
  });

  test("mobile modal menu scrolls internally without moving the document", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 480 });
    await page.goto("/");
    await page.evaluate(() => window.scrollTo(0, 900));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
    const before = await page.evaluate(() => ({
      scrollY: window.scrollY,
      contentTop: document.querySelector("#content-start")?.getBoundingClientRect().top ?? null,
    }));

    const trigger = page.locator(".mobile-tabbar button[data-menu-trigger]");
    await trigger.click();
    const menu = page.locator("#site-menu");
    const list = menu.locator(".site-menu-list");
    await expect(menu).toBeVisible();
    const initialList = await list.evaluate((element) => ({
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      overscrollBehavior: getComputedStyle(element).overscrollBehavior,
    }));
    expect(initialList.scrollHeight).toBeGreaterThan(initialList.clientHeight);
    expect(initialList.overflowY).toBe("auto");
    expect(initialList.overscrollBehavior).toBe("contain");

    const listBox = await list.boundingBox();
    expect(listBox).not.toBeNull();
    await page.mouse.move(
      listBox!.x + listBox!.width / 2,
      listBox!.y + listBox!.height / 2,
    );
    await page.mouse.wheel(0, 300);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const whileOpen = await page.evaluate(() => ({
      scrollY: window.scrollY,
      contentTop: document.querySelector("#content-start")?.getBoundingClientRect().top ?? null,
    }));
    expect(whileOpen.scrollY).toBe(0);
    expect(Math.abs((whileOpen.contentTop ?? 0) - (before.contentTop ?? 0))).toBeLessThanOrEqual(0.5);

    await page.locator("button.mobile-menu-trigger[data-menu-trigger]").click();
    await expect(menu).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before.scrollY);
    await expect(trigger).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
  });

  test("menu breakpoint changes close the dialog and focus the visible trigger", async ({ page }) => {
    const menu = page.locator("#site-menu");
    const desktopMenuTrigger = page.locator("header .menu-trigger");
    const tabbar = page.getByRole("navigation", { name: "Primary" });
    const mobileMenuTrigger = tabbar.getByRole("button", { name: /Menu/ });
    const assertFocusedHitTestableTrigger = async (selector: string) => {
      const evidence = await page.evaluate((selector) => {
        const dialog = document.querySelector<HTMLDialogElement>("#site-menu");
        const trigger = document.querySelector<HTMLButtonElement>(selector);
        if (!dialog || !trigger) return null;
        const rect = trigger.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          dialogOpen: dialog.open,
          focused: document.activeElement === trigger,
          visible: trigger.getClientRects().length > 0,
          hitTestable: hit === trigger || hit?.closest("[data-menu-trigger]") === trigger,
        };
      }, selector);
      expect(evidence).toEqual({
        dialogOpen: false,
        focused: true,
        visible: true,
        hitTestable: true,
      });
    };
    const expectNoHorizontalOverflow = async () => {
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    };

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.evaluate(() => window.scrollTo(0, 900));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    const desktopScrollY = await page.evaluate(() => window.scrollY);
    await expect(desktopMenuTrigger).toBeVisible();
    await desktopMenuTrigger.click();
    await expect(menu).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(menu).toBeHidden();
    await expect(tabbar).toBeVisible();
    await expect(tabbar.locator("a, button")).toHaveCount(5);
    await assertFocusedHitTestableTrigger(".mobile-tabbar button.mobile-menu-trigger");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(desktopScrollY);
    await expectNoHorizontalOverflow();

    const mobileScrollY = await page.evaluate(() => window.scrollY);
    await mobileMenuTrigger.click();
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(menu).toBeHidden();
    await expect(tabbar).toBeHidden();
    await expect(desktopMenuTrigger).toBeVisible();
    await expect(page.locator("header .nav-shortcut")).toHaveCount(3);
    await expect(page.locator("header .nav-shortcut", { hasText: "Categories" })).toBeVisible();
    await expect(page.locator("header .nav-shortcut", { hasText: "arXiv" })).toBeVisible();
    await expect(page.locator("header .nav-shortcut", { hasText: "Knowledge" })).toBeVisible();
    await assertFocusedHitTestableTrigger("header .menu-trigger");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(mobileScrollY);
    await expectNoHorizontalOverflow();
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
    await expectMobileFirstDecisionNearViewport(page);
    const featuredThumb = featured.locator(".featured-thumb").first();
    const {
      featuredBox,
      thumbBox,
      bodyBox,
      mainBox,
      headerInnerBox,
      logoBox,
      langToggleBox,
      langButtonBoxes,
      tickerInnerBox,
      tickerControlBoxes,
      tickerSlideBox,
      tickerMetaBox,
      tickerTitleBox,
      taglineClipped,
      topRankBox,
      rankCardBoxes,
      rankSummaryBoxes,
      rankMetaBoxes,
      rankReasonCount,
    } = await page.evaluate(() => {
      const rect = (element: Element | null) => {
        if (!element || element.getClientRects().length === 0) return null;
        const box = element.getBoundingClientRect();
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          right: box.right,
          bottom: box.bottom,
        };
      };
      const featuredNode = document.querySelector("article.featured");
      const tagline = Array.from(
        document.querySelectorAll<HTMLElement>(".banner .tagline.i18n-ja"),
      ).find((element) => getComputedStyle(element).display !== "none");
      const tickerTitle = Array.from(
        document.querySelectorAll<HTMLElement>(".ticker-bar .tb-slide.is-active .tb-title"),
      ).find((title) => getComputedStyle(title).display !== "none");
      return {
        featuredBox: rect(featuredNode),
        thumbBox: rect(featuredNode?.querySelector(".featured-thumb") ?? null),
        bodyBox: rect(featuredNode?.querySelector(".featured-body") ?? null),
        mainBox: rect(document.querySelector(".layout main")),
        headerInnerBox: rect(document.querySelector("header .header-inner")),
        logoBox: rect(document.querySelector("header .logo")),
        langToggleBox: rect(document.querySelector("header .lang-toggle")),
        langButtonBoxes: Array.from(document.querySelectorAll<HTMLElement>("header .lang-btn")).map((button) => {
          const box = button.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        tickerInnerBox: rect(document.querySelector(".ticker-bar .tb-inner")),
        tickerControlBoxes: Array.from(document.querySelectorAll<HTMLElement>(".ticker-bar .tb-ctrl")).map((control) => {
          const box = control.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        tickerSlideBox: rect(document.querySelector(".ticker-bar .tb-slide.is-active")),
        tickerMetaBox: rect(document.querySelector(".ticker-bar .tb-slide.is-active .tb-meta")),
        tickerTitleBox: rect(tickerTitle ?? null),
        taglineClipped: Boolean(tagline && tagline.scrollHeight > tagline.clientHeight + 1),
        topRankBox: rect(document.querySelector(".top-rank")),
        rankCardBoxes: Array.from(document.querySelectorAll(".top-rank-item")).map((item) => rect(item)),
        rankSummaryBoxes: Array.from(document.querySelectorAll(".top-rank-item .rank-summary")).map((item) => rect(item)),
        rankMetaBoxes: Array.from(document.querySelectorAll(".top-rank-item .rank-meta")).map((item) => rect(item)),
        rankReasonCount: document.querySelectorAll(".top-rank-item .rank-reason").length,
      };
    });
    expect(featuredBox, "featured panel has a box").not.toBeNull();
    expect(thumbBox, "featured thumb has a box").not.toBeNull();
    expect(bodyBox, "featured body has a box").not.toBeNull();
    expect(Math.round(featuredBox!.width), "featured stays inside mobile content width").toBeLessThanOrEqual(390);
    expect(Math.round(featuredBox!.y), "first featured article appears without wasted top whitespace").toBeLessThanOrEqual(
      MOBILE_FIRST_DECISION_MAX_Y,
    );
    expect(Math.round(featuredBox!.height), "featured panel is not expanded by hidden fallback/image stacking").toBeLessThanOrEqual(260);
    expect(Math.round(thumbBox!.width), "featured thumb keeps compact mobile column").toBeLessThanOrEqual(110);
    expect(Math.round(thumbBox!.height), "featured media rail fills the card height").toBeGreaterThanOrEqual(Math.round(featuredBox!.height) - 2);
    expect(bodyBox!.x, "featured body sits to the right of the thumbnail").toBeGreaterThanOrEqual(thumbBox!.right - 1);
    expect(
      bodyBox!.x - thumbBox!.right,
      "featured grid does not reserve unused space between the thumbnail and body",
    ).toBeLessThanOrEqual(1);
    expect(
      bodyBox!.width,
      "featured body uses the remaining mobile card width instead of wrapping in the tablet column",
    ).toBeGreaterThanOrEqual(featuredBox!.width - thumbBox!.width - 3);
    expect(mainBox!.x, "mobile Home uses a balanced 16px left gutter").toBeCloseTo(16, 0);
    expect(mainBox!.width, "mobile Home widens its usable content area").toBeGreaterThanOrEqual(357);
    expect(
      Math.abs((logoBox!.y + logoBox!.height / 2) - (langToggleBox!.y + langToggleBox!.height / 2)),
      "mobile header keeps logo and language controls on one aligned row",
    ).toBeLessThanOrEqual(1);
    expect(
      langToggleBox!.y - headerInnerBox!.y,
      "mobile header keeps breathing room above the language controls",
    ).toBeGreaterThanOrEqual(10);
    expect(
      headerInnerBox!.bottom - langToggleBox!.bottom,
      "mobile header keeps breathing room below the language controls",
    ).toBeGreaterThanOrEqual(10);
    expect(logoBox!.right + 8, "mobile header keeps clear space between logo and language controls").toBeLessThanOrEqual(
      langToggleBox!.x,
    );
    expect(langButtonBoxes, "mobile language toggle keeps two controls").toHaveLength(2);
    for (const button of langButtonBoxes) {
      expect(button.width, "mobile language control keeps a 44px touch width").toBeGreaterThanOrEqual(44);
      expect(button.height, "mobile language control keeps a 44px touch height").toBeGreaterThanOrEqual(44);
    }
    expect(taglineClipped, "mobile hero copy is complete instead of line-clamped mid-sentence").toBe(false);
    expect(tickerInnerBox!.height, "mobile ticker is compact without shrinking its controls").toBeLessThanOrEqual(91);
    for (const control of tickerControlBoxes) {
      expect(control.width, "ticker control keeps a 44px touch width").toBeGreaterThanOrEqual(44);
      expect(control.height, "ticker control keeps a 44px touch height").toBeGreaterThanOrEqual(44);
    }
    expect(tickerSlideBox!.height, "ticker headline keeps a 44px touch height").toBeGreaterThanOrEqual(44);
    expect(tickerMetaBox!.bottom, "ticker category and tags occupy the first line").toBeLessThanOrEqual(
      tickerTitleBox!.y,
    );
    expect(tickerTitleBox!.width, "ticker title receives the full mobile headline width").toBeGreaterThanOrEqual(
      tickerSlideBox!.width - 1,
    );
    expect(rankReasonCount, "Top 3 removes the duplicated authority, format, and category row").toBe(0);
    expect(rankSummaryBoxes, "Top 3 keeps one summary line per article").toHaveLength(3);
    expect(topRankBox!.height, "Top 3 panel stays compact with article-specific summaries").toBeLessThanOrEqual(380);
    for (const cardBox of rankCardBoxes) {
      expect(cardBox!.height, "Top 3 card stays compact while retaining decision context").toBeLessThanOrEqual(118);
    }
    for (const summaryBox of rankSummaryBoxes) {
      expect(summaryBox!.height, "Top 3 summary stays on one clamped line").toBeLessThanOrEqual(20);
      expect(summaryBox!.width, "Top 3 summary has usable mobile width").toBeGreaterThanOrEqual(260);
    }
    for (const metaBox of rankMetaBoxes) {
      expect(metaBox!.height, "Top 3 source and time stay on one metadata row").toBeLessThanOrEqual(28);
    }
    await expect(page.locator(".top-rank-title .i18n-ja")).toHaveText(/次に見る Top 3/);

    const featuredImage = featured.locator(".featured-thumb.has-image img").first();
    if ((await featuredImage.count()) > 0) {
      await featuredImage.evaluate((img) => img.dispatchEvent(new Event("error")));
      await expect(featuredThumb).toHaveClass(/failed/);
      await expect(featuredThumb.locator(".featured-thumb-fallback")).toBeVisible();
      const fallbackGeometry = await featured.evaluate((node) => {
        const card = node.getBoundingClientRect();
        const thumb = node.querySelector(".featured-thumb")!.getBoundingClientRect();
        const fallback = node.querySelector(".featured-thumb-fallback")!.getBoundingClientRect();
        const body = node.querySelector(".featured-body")!.getBoundingClientRect();
        return {
          cardHeight: card.height,
          thumb: { width: thumb.width, height: thumb.height, right: thumb.right },
          fallback: { width: fallback.width, height: fallback.height },
          body: { x: body.x, width: body.width },
        };
      });
      expect(
        fallbackGeometry.cardHeight - fallbackGeometry.thumb.height,
        "failed image keeps a full-height media rail",
      ).toBeLessThanOrEqual(
        2 + LAYOUT_SUBPIXEL_EPSILON_PX,
      );
      expect(Math.abs(fallbackGeometry.fallback.width - fallbackGeometry.thumb.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(fallbackGeometry.fallback.height - fallbackGeometry.thumb.height)).toBeLessThanOrEqual(1);
      expect(fallbackGeometry.body.x - fallbackGeometry.thumb.right).toBeLessThanOrEqual(1);
    }

    for (const width of [320, 375, 390, 414, 621, 720, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const viewportLayout = await page.evaluate(() => {
        const rectFor = (element: Element | null | undefined) => {
          const box = element?.getBoundingClientRect();
          return box
            ? {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
                right: box.right,
                bottom: box.bottom,
              }
            : null;
        };
        const rect = (selector: string) => rectFor(document.querySelector<HTMLElement>(selector));
        const tickerTitle = Array.from(
          document.querySelectorAll<HTMLElement>(".ticker-bar .tb-slide.is-active .tb-title"),
        ).find((title) => getComputedStyle(title).display !== "none");
        return {
          rootScroll: document.documentElement.scrollWidth,
          bodyScroll: document.body.scrollWidth,
          innerWidth: window.innerWidth,
          featured: rect("article.featured"),
          image: rect("article.featured .featured-thumb"),
          content: rect("article.featured .featured-body"),
          logo: rect("header .logo"),
          langToggle: rect("header .lang-toggle"),
          headerInner: rect("header .header-inner"),
          main: rect(".layout main"),
          tickerSlide: rect(".ticker-bar .tb-slide.is-active"),
          tickerMeta: rect(".ticker-bar .tb-slide.is-active .tb-meta"),
          tickerTitle: rectFor(tickerTitle),
          tickerControls: Array.from(document.querySelectorAll<HTMLElement>(".ticker-bar .tb-ctrl")).map((control) => {
            const box = control.getBoundingClientRect();
            return { width: box.width, height: box.height };
          }),
        };
      });
      expect(viewportLayout.rootScroll, `${width}px root has no horizontal overflow`).toBeLessThanOrEqual(width + 1);
      expect(viewportLayout.bodyScroll, `${width}px body has no horizontal overflow`).toBeLessThanOrEqual(width + 1);
      expect(viewportLayout.image).not.toBeNull();
      expect(viewportLayout.content).not.toBeNull();
      expect(viewportLayout.featured).not.toBeNull();
      expect(viewportLayout.headerInner).not.toBeNull();
      expect(viewportLayout.langToggle).not.toBeNull();
      expect(viewportLayout.tickerSlide).not.toBeNull();
      expect(viewportLayout.tickerMeta).not.toBeNull();
      expect(viewportLayout.tickerTitle).not.toBeNull();
      expect(viewportLayout.content!.x).toBeGreaterThanOrEqual(viewportLayout.image!.right - 1);
      expect(viewportLayout.content!.right).toBeLessThanOrEqual(viewportLayout.featured!.right + 1);
      expect(viewportLayout.langToggle!.y).toBeGreaterThanOrEqual(viewportLayout.headerInner!.y);
      expect(viewportLayout.langToggle!.bottom).toBeLessThanOrEqual(viewportLayout.headerInner!.bottom);
      expect(
        viewportLayout.tickerMeta!.bottom,
        `${width}px ticker metadata stays above the headline`,
      ).toBeLessThanOrEqual(viewportLayout.tickerTitle!.y);
      expect(
        viewportLayout.tickerTitle!.width,
        `${width}px ticker headline uses the full slide width`,
      ).toBeGreaterThanOrEqual(viewportLayout.tickerSlide!.width - 1);

      if (width <= 720) {
        expect(viewportLayout.main!.x, `${width}px Home keeps a 16px gutter`).toBeCloseTo(16, 0);
        expect(viewportLayout.main!.width, `${width}px Home uses the remaining width`).toBeGreaterThanOrEqual(width - 33);
        expect(
          viewportLayout.langToggle!.y - viewportLayout.headerInner!.y,
          `${width}px header keeps breathing room above the language control`,
        ).toBeGreaterThanOrEqual(10);
        expect(
          viewportLayout.headerInner!.bottom - viewportLayout.langToggle!.bottom,
          `${width}px header keeps breathing room below the language control`,
        ).toBeGreaterThanOrEqual(10);
        expect(
          Math.abs(
            (viewportLayout.logo!.y + viewportLayout.logo!.height / 2)
              - (viewportLayout.langToggle!.y + viewportLayout.langToggle!.height / 2),
          ),
          `${width}px header does not wrap`,
        ).toBeLessThanOrEqual(1);
        expect(viewportLayout.logo!.right + 8).toBeLessThanOrEqual(viewportLayout.langToggle!.x);
        expect(
          viewportLayout.featured!.height - viewportLayout.image!.height,
          `${width}px media rail fills the Featured card`,
        ).toBeLessThanOrEqual(
          2 + LAYOUT_SUBPIXEL_EPSILON_PX,
        );
        expect(viewportLayout.content!.width).toBeGreaterThanOrEqual(
          viewportLayout.featured!.width - viewportLayout.image!.width - 3,
        );
        for (const control of viewportLayout.tickerControls) {
          expect(control.width).toBeGreaterThanOrEqual(44);
          expect(control.height).toBeGreaterThanOrEqual(44);
        }
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
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
      expect(summaryTextBox!.x, "mobile summary text starts at card body edge, not after the AI badge").toBeLessThanOrEqual(
        summaryBodyBox!.x + 2 + LAYOUT_SUBPIXEL_EPSILON_PX,
      );
      expect(
        summaryBodyBox!.width - summaryTextBox!.width,
        "mobile summary text keeps full readable width",
      ).toBeLessThanOrEqual(2 + LAYOUT_SUBPIXEL_EPSILON_PX);
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
      await expect(desktopCardThumb.locator(".fallback-src-mark")).toHaveCount(0);
      await expect(desktopCardThumb).not.toContainText("NO PREVIEW");
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
    await expect(page.locator(".search-ranking-note .i18n-en")).toContainText(
      "grouped by recency",
    );
    await expect(page.locator(".search-hit-type").first()).toHaveText("CATEGORY");
    await expect(page.locator(".search-hit-match").first()).toHaveAttribute(
      "data-match-scope",
      "category",
    );
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

  test("singleton tag links recover their article through exact search", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/");

    const index = JSON.parse(readFileSync("data/index.json", "utf8")) as {
      entries: Array<{ id: string; tags?: string[] }>;
    };
    const warmArchiveEntries = readdirSync("data/archive")
      .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
      .flatMap((name) => {
        const month = JSON.parse(readFileSync(`data/archive/${name}`, "utf8")) as {
          entries?: Array<{ id: string; tags?: string[]; archiveTier?: string }>;
        };
        return (month.entries ?? []).filter((entry) => entry.archiveTier === "warm");
      });
    const indexedEntries = [
      ...new Map(
        [...index.entries, ...warmArchiveEntries].map((entry) => [entry.id, entry]),
      ).values(),
    ];
    const tagCounts = new Map<string, number>();
    for (const entry of indexedEntries) {
      for (const tag of new Set((entry.tags ?? []).map(normalizeTagKey).filter(Boolean))) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const singletonTags = [...tagCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([tag]) => tag);
    const tagLinks = page.locator("main article.card .tag-chip[href^='/search?q=']");
    const tagIndex = await tagLinks.evaluateAll(
      (links, candidates) =>
        links.findIndex((link) => {
          const query = new URL((link as HTMLAnchorElement).href).searchParams.get("q") ?? "";
          return /[a-z]/.test(query) && candidates.includes(query);
        }),
      singletonTags,
    );
    expect(tagIndex).toBeGreaterThanOrEqual(0);
    const tagLink = tagLinks.nth(tagIndex);
    await expect(tagLink).toBeVisible();
    const searchHref = await tagLink.getAttribute("href");
    const detailHref = await tagLink.locator("xpath=ancestor::article[1]").locator("h3.title > a").getAttribute("href");
    expect(searchHref).toBeTruthy();
    expect(detailHref).toBeTruthy();
    const searchUrl = new URL(searchHref!, "http://localhost");
    const query = searchUrl.searchParams.get("q");
    const entryId = detailHref!.match(/^\/e\/([a-f0-9]{16})\/$/)?.[1];
    expect(query).toBeTruthy();
    expect(entryId).toBeTruthy();
    expect(searchUrl.searchParams.get("tag")).toBe(query);
    expect(searchUrl.searchParams.get("entry")).toBe(entryId);

    await tagLink.click();
    const input = page.locator("#pagefind-search-input");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(query!);
    await expect(page.locator(`.search-hit[href="${detailHref}"]`)).toBeVisible({ timeout: 15_000 });

    const caseVariant = query!.replace(/[a-z]/g, (character) => character.toUpperCase());
    expect(caseVariant).not.toBe(query);
    const caseQuery = new URLSearchParams({
      q: caseVariant,
      tag: caseVariant,
      entry: entryId!,
    });
    await page.goto(`/search?${caseQuery.toString()}`);
    await expect(input).toHaveValue(caseVariant);
    await expect(page.locator(".search-hit").first()).toHaveAttribute("href", detailHref!, { timeout: 15_000 });

    await input.fill(`${caseVariant}-manual`);
    await expect.poll(() => new URL(page.url()).searchParams.has("tag")).toBe(false);
    await expect.poll(() => new URL(page.url()).searchParams.has("entry")).toBe(false);
  });

  test("pagefind ranks same-recency articles by authority then importance", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      const now = Date.now();
      // Keep both dates in one recency tier while proving date does not outrank trust signals.
      const recentDay = (ageDays: number) =>
        new Date(now - ageDays * 86400000).toISOString().slice(0, 10);
      const result = (
        url: string,
        title: string,
        authority: string,
        importance: string,
        ageDays: number,
      ) => ({
        data: async () => ({
          url,
          meta: url.startsWith("/e/")
            ? { title, titleEn: title, summaryEn: `${title} explains agent operations.` }
            : { title },
          excerpt: `${title} explains agent operations.`,
          filters: {
            authority: [authority],
            importance: [importance],
            publishedDay: [recentDay(ageDays)],
          },
        }),
      });

      pagefind.search = async () => ({
        results: [
          result("/categories/", "Agent categories", "source", "3", 2),
          result("/e/community-agent/", "Community agent guide", "community", "3", 2),
          result("/e/official-agent-old/", "Official high-importance reference", "official", "3", 4),
          result("/e/official-agent-new/", "Official low-importance update", "official", "1", 2),
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
    expect(await hits.locator(".search-hit-title > span:last-child").allTextContents()).toEqual([
      "Official high-importance reference",
      "Official low-importance update",
      "Community agent guide",
      "Agent categories",
    ]);
    await expect(hits.first().locator(".search-hit-meta")).toContainText("重要度 High");
    await expect(hits.first().locator(".search-hit-match")).toHaveAttribute(
      "data-match-scope",
      "summary",
    );
    await input.press("Enter");
    await expect(page).toHaveURL(/\/search\/\?q=agent$/);
  });

  test("pagefind groups recent exact articles ahead of older authority matches", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      const result = (
        id: string,
        authority: string,
        importance: string,
        ageDays: number,
      ) => ({
        data: async () => ({
          url: `/e/${id}/`,
          meta: {
            titleEn: `Copilot ${id}`,
            summaryEn: `Copilot ${id} explains the current engineering update.`,
          },
          filters: {
            authority: [authority],
            importance: [importance],
            publishedDay: [new Date(Date.now() - ageDays * 86400000).toISOString().slice(0, 10)],
          },
        }),
      });
      pagefind.search = async () => ({
        results: [
          result("official-archive", "official", "3", 45),
          result("community-current", "community", "2", 2),
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("Copilot");
    const hits = page.locator(".search-hit");
    await expect(hits).toHaveCount(3);
    await expect(hits.nth(1)).toHaveAttribute("href", "/e/community-current/");
    await expect(hits.nth(2)).toHaveAttribute("href", "/e/official-archive/");
  });

  test("pagefind scans a bounded candidate window before applying recency ranking", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      (window as any).__tailCandidateHydrations = 0;
      const result = (
        url: string,
        title: string,
        publishedDay: string,
        exact = true,
      ) => ({
        data: async () => ({
          url,
          meta: {
            title,
            titleEn: title,
            summaryEn: exact
              ? `${title} explains usage metrics for engineering teams.`
              : "A nearby Pagefind candidate without the requested phrase.",
          },
          excerpt: exact
            ? `${title} explains usage metrics for engineering teams.`
            : "A nearby Pagefind candidate without the requested phrase.",
          filters: {
            authority: ["official"],
            importance: ["2"],
            publishedDay: [publishedDay],
          },
        }),
      });
      pagefind.search = async () => ({
        results: [
          ...Array.from({ length: 12 }, (_, index) =>
            result(
              `/e/usage-metrics-archive-${index}/`,
              `Usage metrics archive ${index}`,
              `2026-06-${String(index + 1).padStart(2, "0")}`,
            )),
          ...Array.from({ length: 77 }, (_, index) =>
            result(
              `/t/nearby-${index}/`,
              `Nearby developer tooling ${index}`,
              "2026-07-01",
              false,
            )),
          result(
            "/e/usage-metrics-current/",
            "Usage metrics current release",
            "2026-07-20",
          ),
          ...Array.from({ length: 2 }, (_, index) => ({
            data: async () => {
              (window as any).__tailCandidateHydrations += 1;
              return {
                url: `/t/tail-${index}/`,
                meta: { title: `Tail candidate ${index}` },
                excerpt: "A candidate after the bounded search window.",
                filters: {},
              };
            },
          })),
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("usage metrics");
    await expect(page.locator(".search-hit").first()).toHaveAttribute(
      "href",
      "/e/usage-metrics-current/",
    );
    await expect
      .poll(() => page.evaluate(() => (window as any).__tailCandidateHydrations))
      .toBe(0);
  });

  test("pagefind progressively resolves exact articles beyond the first result batch", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
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
              meta: {
                title: "Exact release reference",
                titleEn: "Exact release reference",
                summaryEn: "Exact release reference with stable provenance.",
              },
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
    await expect(page.locator(".search-hit-title > span[lang='en']")).toHaveText([
      "Exact release reference",
    ]);
  });

  test("search route restores and synchronizes its shareable query", async ({ page }) => {
    const noSlashResponse = await page.goto("/search?q=Copilot");
    expect(noSlashResponse?.status()).toBe(200);
    await expect(page.locator("#search-page-heading")).toHaveText(/Search/);
    const guide = page.locator("[data-search-page-guide]");
    await expect(guide).toBeHidden();
    const form = page.locator('header form.search[role="search"]');
    const input = form.locator('input[type="search"][name="q"]');
    await expect(form).toHaveAttribute("action", "/search/");
    await expect(form).toHaveAttribute("method", "get");
    await expect(input).toHaveValue("Copilot", { timeout: 10_000 });
    await expect(form).toHaveClass(/is-open/);
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => page.locator("#pagefind-results .search-hit").count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const noSlashResults = await page.locator("#pagefind-results .search-hit").evaluateAll((hits) =>
      hits.map((hit) => hit.getAttribute("href")).filter((href): href is string => Boolean(href)),
    );
    expect(noSlashResults.length).toBeGreaterThan(0);

    const slashResponse = await page.goto("/search/?q=Copilot");
    expect(slashResponse?.status()).toBe(200);
    await expect(input).toHaveValue("Copilot", { timeout: 10_000 });
    await expect(guide).toBeHidden();
    await expect(page.locator("#pagefind-results")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => page.locator("#pagefind-results .search-hit").count(), { timeout: 15_000 })
      .toBeGreaterThan(0);
    const slashResults = await page.locator("#pagefind-results .search-hit").evaluateAll((hits) =>
      hits.map((hit) => hit.getAttribute("href")).filter((href): href is string => Boolean(href)),
    );
    expect(slashResults).toEqual(noSlashResults);

    await input.fill("Claude");
    await expect(page).toHaveURL(/\/search\/\?q=Claude$/);
    await expect(guide).toBeHidden();
    await input.fill("");
    await expect(page).toHaveURL(/\/search\/?$/);
    await expect(guide).toBeVisible();
    await input.fill("Claude");
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
    await expectPagefindReady(page);
    await expect(input).toHaveValue("Copilot");
  });

  test("pagefind prioritizes category intent and hides internal category slugs", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
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
          meta: url.startsWith("/e/")
            ? { title, titleEn: title, summaryEn: `${title} gives a practical category overview.` }
            : { title },
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

  test("pagefind renders validated active-language summaries and reader-facing metadata", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = async (query: string) => ({
        results: query.toLowerCase().includes("status")
          ? [{
              data: async () => ({
                url: "/status/",
                meta: { title: "Status dashboard" },
                excerpt: "Status dashboard for collection operations.",
                filters: {},
              }),
            }]
          : query.toLowerCase().includes("unknown metadata")
            ? [{
                data: async () => ({
                  url: "/e/unknown-reader-labels/",
                  meta: {
                    titleEn: "Unknown metadata reference",
                    summaryEn: "Unknown metadata remains readable without exposing internal identifiers.",
                  },
                  excerpt: "RAW_UNKNOWN_EXCERPT",
                  filters: {
                    source: ["internal-source-slug"],
                    category: ["internal-category-slug"],
                  },
                }),
              }]
            : [
                {
                  data: async () => ({
                    url: "/e/raw-excerpt-only/",
                    meta: {
                      titleEn: "Nearby operations reference",
                      summaryEn: "Validated metadata does not contain the requested phrase.",
                    },
                    excerpt: "fallback agent appears only in this raw Pagefind excerpt",
                    filters: {},
                  }),
                },
                {
                  data: async () => ({
                    url: "/e/fallback-agent/",
                    meta: {
                      title: "Fallback agent reference",
                      titleEn: "Fallback agent reference",
                      summaryEn: "Fallback agent summary from validated English metadata.",
                    },
                    excerpt: "RAW_EXCERPT_SHOULD_NOT_RENDER",
                    filters: {
                      source: ["github-copilot"],
                      category: ["local-llm"],
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
    const input = page.locator("#pagefind-search-input");
    await input.fill("fallback agent");
    const hit = page.locator(".search-hit").first();
    await expect(page.locator(".search-hit")).toHaveCount(1);
    await expect(hit.locator(".search-hit-title > span[lang='en']")).toHaveText("Fallback agent reference");
    await expect(hit.locator(".search-hit-title .search-hit-fallback .i18n-ja")).toHaveText("原文 EN");
    await expect(hit.locator(".search-hit-summary")).toHaveText(
      "Fallback agent summary from validated English metadata.",
    );
    await expect(hit.locator(".search-hit-summary")).toHaveAttribute("lang", "en");
    await expect(hit.locator(".search-hit-summary")).not.toContainText("RAW_EXCERPT");
    await expect(hit.locator(".search-hit-excerpt .search-hit-fallback .i18n-ja")).toHaveText("原文 EN");
    await expect(hit.locator(".search-hit-meta")).toContainText("GitHub Copilot Blog");
    await expect(hit.locator(".search-hit-meta")).toContainText("Local Models");
    await expect(hit.locator(".search-hit-meta")).not.toContainText(/github-copilot|local-llm/);
    const authority = hit.locator(".search-hit-authority");
    await expect(authority).toHaveAttribute("data-source-authority", "official");
    await expect(authority.locator(".i18n-ja")).toBeVisible();
    await expect(authority.locator(".i18n-ja")).toHaveText("公式");
    await expect(page.locator("#pagefind-results")).not.toContainText("Nearby operations reference");

    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
    await expect(hit.locator(".search-hit-summary")).toHaveText(
      "Fallback agent summary from validated English metadata.",
    );
    await expect(hit.locator(".search-hit-fallback")).toHaveCount(0);
    await expect(hit.locator(".search-hit-title [lang='en']")).toHaveText("Fallback agent reference");
    await expect(authority.locator(".i18n-en")).toBeVisible();
    await expect(authority.locator(".i18n-en")).toHaveText("Official");

    await input.fill("status");
    await expect(hit.locator(".search-hit-meta")).toContainText("Status page");
    await expect(hit.locator(".search-hit-meta")).not.toContainText("/status/");

    await input.fill("unknown metadata");
    await expect(hit.locator(".search-hit-title")).toHaveText("Unknown metadata reference");
    await expect(hit.locator(".search-hit-meta")).toHaveText("Article");
    await expect(hit.locator(".search-hit-meta")).not.toContainText(
      /internal-source-slug|internal-category-slug|unknown-reader-labels/,
    );
    await expect(hit.locator(".search-hit-summary")).not.toContainText("RAW_UNKNOWN_EXCERPT");
  });

  test("pagefind matches article source labels without exposing internal source ids", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = async () => ({
        results: [
          {
            data: async () => ({
              url: "/e/source-label-search/",
              meta: {
                titleEn: "Agent operations reference",
                summaryEn: "A practical guide to production agent operations.",
              },
              filters: {
                source: ["github-copilot"],
                category: ["agent-fw"],
                authority: ["official"],
              },
            }),
          },
          {
            data: async () => ({
              url: "/e/internal-source-search/",
              meta: {
                titleEn: "Unrelated operations reference",
                summaryEn: "A separate guide without the requested source.",
              },
              filters: {
                source: ["internal-source-slug"],
                category: ["internal-category-slug"],
              },
            }),
          },
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("GitHub Copilot Blog");
    const hit = page.locator(".search-hit");
    await expect(hit).toHaveCount(1);
    await expect(hit).toHaveAttribute("href", "/e/source-label-search/");
    await expect(hit.locator(".search-hit-meta")).toContainText("GitHub Copilot Blog");
    await expect(page.locator("#pagefind-results")).not.toContainText("github-copilot");
    await expect(page.locator("#pagefind-results")).not.toContainText("internal-source-slug");
  });

  test("pagefind keeps hydrated results when another candidate times out", async ({ page }) => {
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = async () => ({
        results: [
          { data: () => new Promise(() => {}) },
          {
            data: async () => ({
              url: "/e/resilient-search/",
              meta: {
                title: "Resilient search result",
                titleEn: "Resilient search result",
                summaryEn: "Resilient search keeps successfully hydrated candidates.",
              },
              excerpt: "RAW_TIMEOUT_EXCERPT",
              filters: { authority: ["official"], importance: ["2"] },
            }),
          },
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("resilient search");
    const hit = page.locator(".search-hit");
    await expect(hit).toHaveCount(1, { timeout: 4_000 });
    await expect(hit.locator(".search-hit-title")).toContainText("Resilient search result");
    await expect(hit.locator(".search-hit-summary")).toHaveText(
      "Resilient search keeps successfully hydrated candidates.",
    );
    await expect(page.locator("#pagefind-results")).not.toHaveAttribute("aria-busy");
  });

  test("pagefind exact-result filtering ignores Unicode diacritics", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/");
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = async () => ({
        results: [
          {
            data: async () => ({
              url: "/e/cafe-result/",
              meta: { titleEn: "Café agent patterns" },
              excerpt: "A result whose exact text contains a Unicode diacritic.",
            }),
          },
          {
            data: async () => ({
              url: "/e/unrelated-result/",
              meta: { titleEn: "Coffee agent patterns" },
              excerpt: "A fuzzy Pagefind result that must not pass exact filtering.",
            }),
          },
        ],
      });
    });

    await page.locator("button[data-search-trigger]:visible").first().click();
    await page.locator("#pagefind-search-input").fill("cafe");
    await expect(page.locator(".search-hit")).toHaveCount(1);
    await expect(page.locator(".search-hit-title > span[lang='en']")).toHaveText(
      "Café agent patterns",
    );
    await expect(page.getByText("Coffee agent patterns")).toHaveCount(0);
  });

  test("pagefind search zero state gives next actions", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
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
    const recoveryGeometry = await page.locator(".search-empty-actions").evaluate((actions) => {
      const links = Array.from(actions.querySelectorAll("a")).map((link) => {
        const rect = link.getBoundingClientRect();
        return { width: rect.width, height: rect.height, right: rect.right };
      });
      const actionsRect = actions.getBoundingClientRect();
      return {
        links,
        actionsRight: actionsRect.right,
        noPageOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(recoveryGeometry.noPageOverflow, "search recovery actions should not overflow the mobile page").toBe(true);
    for (const link of recoveryGeometry.links) {
      expect(link.height, "search recovery action should keep a 44px block target").toBeGreaterThanOrEqual(43.5);
      expect(link.right, "search recovery action should remain inside its action group").toBeLessThanOrEqual(
        recoveryGeometry.actionsRight + 1,
      );
    }
  });

  test("closing search invalidates a delayed Pagefind response", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expectPagefindReady(page);
    await page.evaluate(() => {
      const pagefind = (window as any).__pagefind;
      pagefind.search = () => new Promise((resolve) => {
        (window as any).__resolveDelayedPagefind = () => resolve({
          results: [{
            data: async () => ({
              url: "/e/delayed-result/",
              meta: { titleEn: "Delayed result must stay closed" },
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

  test("narrow Search keeps header controls distinct, operable, and accessible", async ({ page }) => {
    const viewports = [
      { width: 375, height: 667 },
      { width: 390, height: 844 },
      { width: 720, height: 844 },
      { width: 721, height: 844 },
    ];

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await page.locator("header .lang-btn[data-lang='ja']").click();
      const menuTrigger = viewport.width <= 720
        ? page.locator(".mobile-tabbar button[data-menu-trigger]")
        : page.locator("header .menu-trigger");
      await menuTrigger.click();
      await page.locator("#site-menu [data-search-trigger]").click();

      const search = page.locator("body > header .search.is-open");
      const input = page.locator("#pagefind-search-input");
      const close = page.getByRole("button", { name: "Close search" });
      const jaButton = page.locator("body > header .lang-btn[data-lang='ja']");
      const enButton = page.locator("body > header .lang-btn[data-lang='en']");
      await expect(search).toBeVisible();
      await expect(input).toBeFocused();
      await expect(close).toBeVisible();

      const geometry = await page.evaluate(() => {
        const header = document.querySelector<HTMLElement>("body > header");
        const searchRoot = document.querySelector<HTMLElement>("body > header .search.is-open");
        const input = document.querySelector<HTMLElement>("#pagefind-search-input");
        const closeButton = document.querySelector<HTMLElement>("body > header [data-search-close]");
        const langToggle = document.querySelector<HTMLElement>("body > header .lang-toggle");
        const languageButtons = Array.from(
          document.querySelectorAll<HTMLElement>("body > header .lang-btn"),
        );
        if (!header || !searchRoot || !input || !closeButton || !langToggle) return null;
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            width: box.width,
            height: box.height,
          };
        };
        const overlapArea = (
          first: ReturnType<typeof rect>,
          second: ReturnType<typeof rect>,
        ) =>
          Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
          * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
        const searchBox = rect(searchRoot);
        const closeBox = rect(closeButton);
        const langBox = rect(langToggle);
        const headerButtons = Array.from(
          header.querySelectorAll<HTMLElement>("a, button"),
        ).filter((element) =>
          !searchRoot.contains(element)
          && element.getClientRects().length > 0
        );
        const hitOwnsCenter = (element: HTMLElement) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          ));
        };
        return {
          headerBottom: header.getBoundingClientRect().bottom,
          searchBox,
          closeBox,
          langBox,
          inputBox: rect(input),
          closeLanguageOverlap: overlapArea(closeBox, langBox),
          searchLanguageOverlap: overlapArea(searchBox, langBox),
          coveredHeaderControls: headerButtons.filter((element) =>
            overlapArea(searchBox, rect(element)) > 0
          ).map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim()),
          hitClose: hitOwnsCenter(closeButton),
          hitLanguages: languageButtons.map(hitOwnsCenter),
          languageButtons: languageButtons.map((button) => ({
            box: rect(button),
            ariaHidden: button.getAttribute("aria-hidden"),
            inert: button.hasAttribute("inert"),
            tabIndex: button.tabIndex,
          })),
          horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      });
      expect(geometry, `${viewport.width}px Search geometry`).not.toBeNull();
      expect(
        geometry!.searchBox.top,
        `${viewport.width}px Search begins below the visible header`,
      ).toBeGreaterThanOrEqual(geometry!.headerBottom + 7);
      expect(geometry!.closeLanguageOverlap, `${viewport.width}px close/language overlap`).toBe(0);
      expect(geometry!.searchLanguageOverlap, `${viewport.width}px Search/language overlap`).toBe(0);
      expect(geometry!.coveredHeaderControls, `${viewport.width}px covered header controls`).toEqual([]);
      expect(geometry!.hitClose, `${viewport.width}px close owns its center hit target`).toBe(true);
      expect(geometry!.hitLanguages, `${viewport.width}px language buttons own their hit targets`).toEqual([
        true,
        true,
      ]);
      expect(geometry!.horizontalOverflow, `${viewport.width}px horizontal overflow`).toBe(0);

      for (const [name, box] of [
        ["Search input", geometry!.inputBox],
        ["Search close", geometry!.closeBox],
        ["language toggle", geometry!.langBox],
        ...geometry!.languageButtons.map((button, index) => [
          index === 0 ? "JA" : "EN",
          button.box,
        ] as const),
      ] as const) {
        expect(box.left, `${viewport.width}px ${name} stays inside the left edge`).toBeGreaterThanOrEqual(0);
        expect(box.right, `${viewport.width}px ${name} stays inside the right edge`).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(box.top, `${viewport.width}px ${name} stays inside the top edge`).toBeGreaterThanOrEqual(0);
        expect(box.bottom, `${viewport.width}px ${name} stays inside the bottom edge`).toBeLessThanOrEqual(
          viewport.height,
        );
        expect(box.width, `${viewport.width}px ${name} keeps a 44px width`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${viewport.width}px ${name} keeps a 44px height`).toBeGreaterThanOrEqual(44);
      }
      expect(
        geometry!.languageButtons.map(({ ariaHidden, inert, tabIndex }) => ({
          ariaHidden,
          inert,
          tabIndex,
        })),
        `${viewport.width}px visible language controls remain semantic and keyboard reachable`,
      ).toEqual([
        { ariaHidden: null, inert: false, tabIndex: 0 },
        { ariaHidden: null, inert: false, tabIndex: 0 },
      ]);

      const headerAccessibility = await page.getByRole("banner").ariaSnapshot();
      expect(headerAccessibility).toContain('button "Close search"');
      expect(headerAccessibility).toContain('button "JA 日本語表示中"');
      expect(headerAccessibility).toContain('button "EN 英語表示に切り替え"');

      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(input).toBeFocused();

      if (viewport.width === 390) {
        for (let index = 0; index < 5; index += 1) await page.keyboard.press("Tab");
        await expect(jaButton).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(enButton).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.locator("html")).toHaveAttribute("data-lang", "en");
        await expect(page).toHaveURL(/[?&]lang=en(?:&|$)/);
        await expect(search).toBeVisible();
        await expect(enButton).toBeFocused();
        await jaButton.click();
        await expect(page.locator("html")).toHaveAttribute("data-lang", "ja");
      }

      if (viewport.width === 375) await input.press("Escape");
      else await close.click();
      await expect(search).toBeHidden();
      await expect(page.locator("[data-menu-trigger]:visible").first()).toBeFocused();
    }
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

  test("status publication activity is reachable on mobile without a huge scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/status/");

    const sourceHeading = page.locator("#source-health-heading");
    await expect(sourceHeading).toBeVisible();
    const box = await sourceHeading.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y, "publication activity must not be buried thousands of px down").toBeLessThan(2600);

    const firstSource = page.locator("#source-health-list .source-item:not([hidden])").first();
    await expect(firstSource).toBeVisible();
    const rowBox = await firstSource.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.y, "first publication activity row should be quickly reachable").toBeLessThan(3000);
    await expect(page.locator("#attention-list, #attention-list-mobile")).toHaveCount(0);
    await expect(page.locator("aside.status-insights")).toBeHidden();
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
    const heroRunState = page.locator(".banner-run-state[data-run-tone]");
    if (footerTone === "ok") {
      await expect(
        heroRunState,
        "Home hides normal collection health to preserve decision-space density",
      ).toBeHidden();
    } else {
      const heroTone = await heroRunState.first().getAttribute("data-run-tone");
      expect(heroTone, "Home warning tone must equal the shared footer tone").toBe(footerTone);
    }

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
    await expect(sourceCta.locator(".ed-header-cta-copy > .i18n-ja")).toHaveText("元記事を読む");
    await expect(sourceCta.locator("small")).not.toHaveText("");
    await expect(page.locator(".ed-hot-pill")).toHaveCount(0);
  });

  test("entry titles never blank in either language mode (LL-029)", async ({ page }) => {
    await page.goto("/");

    // Sample a wide net across the first timeline page (12 entries) so the
    // assertion covers JA-source entries with no English title.
    const titles = await page.locator("article.card h3.title").evaluateAll((nodes) =>
      nodes.map((node) => {
        const ja = node.querySelector(".i18n-ja")?.textContent ?? "";
        const enNode = node.querySelector(".i18n-en");
        const en = enNode?.textContent ?? "";
        const enLang = enNode?.getAttribute("lang") ?? "";
        const enOrigin = enNode
          ?.querySelector(".language-fallback-badge")
          ?.getAttribute("data-fallback-language") ?? "";
        return { ja: ja.trim(), en: en.trim(), enLang, enOrigin };
      }),
    );

    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      // After LL-029 the title must be non-empty in both language slots,
      // even if the EN slot falls back to the JA original with a semantic badge.
      expect(t.ja.length, `ja title blank: ${JSON.stringify(t)}`).toBeGreaterThan(0);
      expect(t.en.length, `en title blank: ${JSON.stringify(t)}`).toBeGreaterThan(0);
      expect(["en", "ja"], `EN title has explicit provenance: ${JSON.stringify(t)}`).toContain(
        t.enLang,
      );
      if (t.enLang === "ja") {
        expect(t.enOrigin, `JA fallback is labeled: ${JSON.stringify(t)}`).toBe("ja");
      } else {
        expect(t.enOrigin, `native EN title has no fallback badge: ${JSON.stringify(t)}`).toBe("");
      }
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

  test("arXiv opens on filters and papers without a duplicate source overview", async ({ page }) => {
    await page.goto("/arxiv/#source=arxiv-cs-ai");
    await expect(page.locator(".page-hero-metric").filter({ hasText: /^Showing/ })).toHaveCount(0);
    const arxivLast30d = page.locator('[data-metric-scope="arxiv-published-last-30d"]');
    await expect(arxivLast30d).toBeVisible();
    await expect(arxivLast30d.locator(".page-hero-metric-detail .i18n-en")).toContainText(
      "Archive-backed source totals",
    );
    await expect(page.locator(".page-hero-metric-detail")).toHaveCount(6);
    expect(
      await page.locator(".arxiv-layout > main > section").evaluateAll((sections) =>
        sections.map((section) => section.id || section.className),
      ),
      "the arXiv main column starts with controls and contains one paper timeline",
    ).toEqual(["paper-controls", "arxiv-timeline"]);
    await expect(page.locator(".paper-controls")).toBeVisible();
    await expect(page.locator(".paper-filter-tabs .paper-filter-btn").first()).toBeVisible();
    await expect(page.locator("#arxiv-timeline")).toBeVisible();
    await expect(page.locator('button[data-paper-filter="arxiv-cs-ai"][aria-pressed="true"]')).toHaveCount(2);
    const visiblePapers = page.locator('[data-paper-view-panel="cards"] [data-paper-entry]:visible');
    expect(await visiblePapers.count()).toBeGreaterThan(0);
    expect(await visiblePapers.evaluateAll((entries) =>
      entries.every((entry) => (entry as HTMLElement).dataset.source === "arxiv-cs-ai"),
    )).toBe(true);

    await page.locator('.paper-filter-tabs [data-paper-filter="arxiv-cs-cl"]').click();
    await expect(page).toHaveURL(/\/arxiv\/#source=arxiv-cs-cl$/);
    await expect(page.locator('button[data-paper-filter="arxiv-cs-cl"][aria-pressed="true"]')).toHaveCount(2);
    await expect(page.locator(".page-hero-metric").filter({ hasText: /^Showing/ })).toHaveCount(0);

    await page.evaluate(() => {
      window.location.hash = "source=arxiv-cs-lg";
    });
    await expect(page.locator('button[data-paper-filter="arxiv-cs-lg"][aria-pressed="true"]')).toHaveCount(2);

    await page.evaluate(() => {
      window.location.hash = "arxiv-cs-se";
    });
    await expect(page.locator('button[data-paper-filter="arxiv-cs-se"][aria-pressed="true"]')).toHaveCount(2);

    await page.locator('.paper-filter-tabs [data-paper-filter="all"]').click();
    await expect(page).toHaveURL(/\/arxiv\/$/);
    await expect(page.locator('.paper-filter-tabs [data-paper-filter="all"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("lane pages never collapse into a 3-column timeline grid (LL-091)", async ({ page }) => {
    // The timeline .layout has responsive media queries (a 200px sidebar and a
    // 3-col :has(aside.right) rule for 901-1180px) that previously bled into
    // .lane-layout, adding a phantom empty left column at mid widths. Lane
    // pages must stay 2-col (>=981px) or 1-col (<=980px), never 3-col, and
    // never show aside.left, at any width.
    const widths = [1280, 1180, 1100, 1000, 981, 980, 901, 768, 390];
    for (const path of ["/knowledge/", "/arxiv/"]) {
      await page.setViewportSize({ width: widths[0], height: 1000 });
      await page.goto(path);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
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
    await expect(page.locator(".page-hero-metric")).toHaveCount(5);
    await expect(page.locator(".page-hero-metric-detail")).toHaveCount(5);
    const knowledgeMetricScopes = await page.locator(".page-hero-metric").evaluateAll((metrics) =>
      metrics.map((metric) => ({
        scope: metric.getAttribute("data-metric-scope") ?? "",
        detail: metric.querySelector(".page-hero-metric-detail")?.textContent?.trim() ?? "",
      })),
    );
    expect(
      knowledgeMetricScopes.every((metric) => metric.scope.length > 0 && metric.detail.length > 0),
      "Knowledge hero metrics explain their population or time window",
    ).toBe(true);
    const sourceDescriptions = await groups
      .locator(".knowledge-source-desc .i18n-ja")
      .allInnerTexts();
    expect(sourceDescriptions).toHaveLength(groupCount);
    expect(
      new Set(sourceDescriptions).size,
      "each Knowledge source explains its specific scope",
    ).toBe(groupCount);
    expect(sourceDescriptions).not.toContain("ベストプラクティス / 技術知見ソース。");
    await page.locator('.lang-btn[data-lang="en"]').click();
    await expect(groups.first().locator(".knowledge-source-desc .i18n-en")).toBeVisible();
    await page.locator('.lang-btn[data-lang="ja"]').click();

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
      expect(
        geometry.cardHeight,
        "mobile Knowledge card keeps its uniform height",
      ).toBeCloseTo(148, 1);
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
    const stableImageCard = page.locator(
      `.kg-card:has(.kg-card-link[href="${imageHref}"])`,
    );
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
    ).toBe("人間による操作の確認（ボット対策）");

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
      "ボット対策の確認サービスを一時利用できません。",
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
    await expect(privacyLink).toHaveAttribute("href", "/privacy#anonymous-reactions");
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
    await expect(page).toHaveURL(/\/privacy\/?\?lang=en#anonymous-reactions$/);
    const privacyTarget = page.locator("#anonymous-reactions");
    await expect(privacyTarget).toBeVisible();
    await expect
      .poll(async () => {
        const targetBox = await privacyTarget.boundingBox();
        const headerBox = await page.locator("header").boundingBox();
        return targetBox && headerBox ? targetBox.y - (headerBox.y + headerBox.height) : -1;
      })
      .toBeGreaterThanOrEqual(8);
    await expect(privacyTarget).toHaveCSS("border-color", /rgb/);
    await expect(page.locator('.privacy-rail a[href="#anonymous-reactions"] .i18n-en')).toHaveText(
      "Anonymous likes",
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

    await button.click();
    const startedAt = Date.now();
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
      "ボット対策の確認を完了できませんでした。",
    );
    await expect(page.locator("#reaction-error-toast")).toBeVisible();
    await expect(
      page.locator("#reaction-error-toast [data-reaction-toast-copy]"),
    ).toContainText("ボット対策の確認を完了できませんでした。");
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
    await expect(page.locator(".page-hero-metric-detail")).toHaveCount(3);
    await expect(page.locator('[data-metric-scope="glossary-topic-groups"]')).toContainText("用語分類");
    await expect(page.locator('[data-metric-scope="glossary-editorial-picks"]')).toContainText(
      "編集マーク付き・期間集計なし",
    );
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
