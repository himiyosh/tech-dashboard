import { expect, test, type Locator } from "@playwright/test";
import { SITE_URL } from "../../web/src/lib/site.ts";

declare global {
  interface Window {
    capturedArticleShare?: ShareData;
    articleShareCopyCount?: number;
    articleShareManualCopy?: string;
  }
}

async function expectUsableShareButton(button: Locator): Promise<void> {
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded();
  const geometry = await button.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const center = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      hit: node === center || node.contains(center),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.hit).toBe(true);
  expect(geometry.overflow).toBeLessThanOrEqual(0);
}

test("detail and primary article cards expose separate, usable share actions on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const featured = page.locator("article.featured");
  if (await featured.count()) {
    await expect(featured.locator('[data-article-share][data-share-variant="featured"]')).toHaveCount(1);
    await expectUsableShareButton(featured.locator("[data-article-share]"));
    await expect(featured.locator("[data-article-share]")).toHaveAccessibleName(/^シェア\s*:\s*\S/);
  }
  const ranked = page.locator(".top-rank-item");
  await expect(ranked.locator("[data-article-share]")).toHaveCount(0);
  if (await ranked.count()) {
    await expect(ranked.first().locator('a.rank-content-link[href^="/e/"]')).toBeVisible();
  }
  const cards = page.locator("main article.card");
  const visibleCards = page.locator("main article.card:visible");
  expect(await visibleCards.count()).toBeGreaterThan(0);
  expect(await cards.locator("[data-article-share]").count()).toBe(await cards.count());
  await expectUsableShareButton(visibleCards.first().locator("[data-article-share]"));
  await expect(visibleCards.first().locator("[data-article-share]")).toHaveAccessibleName(/^シェア\s*:\s*\S/);

  const detailHref = await page.locator('main article.card:visible h3.title a[href^="/e/"]').first().getAttribute("href");
  expect(detailHref).toBeTruthy();
  await page.goto(detailHref!, { waitUntil: "domcontentloaded" });
  const detailShare = page.locator('.ed-action-strip [data-article-share][data-share-variant="detail"]');
  await expectUsableShareButton(detailShare);
  await expect(detailShare).toHaveAccessibleName(/^この記事をシェア\s*:\s*\S/);
  await expect(page.locator('article.entry-detail .ed-header-cta')).toBeVisible();

  await page.goto("/knowledge/", { waitUntil: "domcontentloaded" });
  const knowledgeCards = page.locator(".kg-card:visible");
  if (await knowledgeCards.count()) {
    expect(await knowledgeCards.locator("[data-article-share]").count()).toBe(await knowledgeCards.count());
    const share = knowledgeCards.first().locator('[data-article-share][data-share-variant="knowledge"]');
    await expectUsableShareButton(share);
    await expect(share).toHaveAccessibleName(/^シェア\s*:\s*\S/);
    await expect(knowledgeCards.first().locator(".kg-card-link")).toBeVisible();
  }
});

test("share controls preserve card content and stay clear of neighboring links", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const card = page.locator("main article.card:visible").first();
  const share = card.locator("[data-article-share]");
  for (const width of [375, 390, 768, 981, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(share).toBeVisible();
    const geometry = await card.evaluate((node) => {
      const action = node.querySelector("[data-article-share]")?.getBoundingClientRect();
      const articleLink = node.querySelector(".card-footer .url")?.getBoundingClientRect();
      if (!action || !articleLink) return null;
      const overlaps = action.left < articleLink.right && action.right > articleLink.left
        && action.top < articleLink.bottom && action.bottom > articleLink.top;
      return {
        actionWidth: action.width,
        actionHeight: action.height,
        overlaps,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(geometry, `card controls at ${width}px`).not.toBeNull();
    expect(geometry!.actionWidth).toBeGreaterThanOrEqual(44);
    expect(geometry!.actionHeight).toBeGreaterThanOrEqual(44);
    expect(geometry!.overlaps).toBe(false);
    expect(geometry!.overflow).toBeLessThanOrEqual(0);
  }

  await page.goto("/knowledge/", { waitUntil: "domcontentloaded" });
  const knowledge = page.locator(".kg-card:visible").first();
  if (await knowledge.count()) {
    for (const width of [375, 390, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const geometry = await knowledge.evaluate((node) => {
        const action = node.querySelector("[data-article-share]")?.getBoundingClientRect();
        const summary = node.querySelector(".kg-sum.i18n-ja");
        const sumBox = summary?.getBoundingClientRect();
        if (!action || !summary || !sumBox) return null;
        const contentRight = sumBox.right - Number.parseFloat(getComputedStyle(summary).paddingRight);
        return {
          actionWidth: action.width,
          actionHeight: action.height,
          summaryContentRight: contentRight,
          actionLeft: action.left,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      expect(geometry, `Knowledge card at ${width}px`).not.toBeNull();
      expect(geometry!.actionWidth).toBeGreaterThanOrEqual(44);
      expect(geometry!.actionHeight).toBeGreaterThanOrEqual(44);
      expect(geometry!.summaryContentRight).toBeLessThanOrEqual(geometry!.actionLeft + 2);
      expect(geometry!.overflow).toBeLessThanOrEqual(0);
    }
  }
});

test("share buttons are absent without JavaScript rather than leaving dead controls", async ({ request }) => {
  const response = await request.get("/");
  const html = await response.text();
  expect(response.status()).toBe(200);
  expect(html).toMatch(/<button\b(?=[^>]*\bdata-article-share\b)(?=[^>]*\bhidden\b)(?=[^>]*\binert\b)[^>]*>/);
});

test("native sharing sends the article title and canonical URL in the active language", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => { window.capturedArticleShare = data; },
    });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator('.lang-btn[data-lang="en"]').click();

  const card = page.locator('main article.card:visible:has(h3.title a[href^="/e/"])').first();
  const button = card.locator("[data-article-share]");
  const title = await button.getAttribute("data-share-title-en");
  const url = await button.getAttribute("data-share-url");
  expect(url).toMatch(new RegExp(`^${SITE_URL}/e/`));
  await button.click();

  await expect.poll(() => page.evaluate(() => window.capturedArticleShare)).toEqual({
    title,
    text: title,
    url: `${url}?lang=en`,
  });
  await expect(page.locator("#article-share-status")).toBeEmpty();
  await expect(page).toHaveURL(/\?lang=en$/);
});

test("canceling the native share sheet neither copies nor claims success", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => { throw new DOMException("Canceled", "AbortError"); },
    });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { window.articleShareCopyCount = (window.articleShareCopyCount ?? 0) + 1; } },
    });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const share = page.locator("main article.card:visible [data-article-share]").first();
  await share.click();
  await expect(share).not.toHaveAttribute("aria-busy");
  expect(await page.evaluate(() => window.articleShareCopyCount ?? 0)).toBe(0);
  await expect(page.locator("#article-share-status")).toBeEmpty();
  await expect(page.locator("#article-share-toast")).not.toHaveClass(/is-visible/);
});

test("a share-sheet failure explicitly falls back to a copied link", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async () => { throw new DOMException("Unavailable", "NotAllowedError"); },
    });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { window.articleShareManualCopy = text; } },
    });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const share = page.locator("main article.card:visible [data-article-share]").first();
  const title = await share.getAttribute("data-share-title-ja");
  const url = await share.getAttribute("data-share-url");
  await share.click();
  await expect(page.locator("#article-share-status")).toHaveText(
    "共有先を開けなかったため、タイトルとURLをコピーしました。",
  );
  await expect(page.locator("#article-share-toast")).toHaveText(
    "共有先を開けなかったため、タイトルとURLをコピーしました。",
  );
  await expect(page.locator("#article-share-toast")).toHaveClass(/is-visible/);
  await expect(page.locator("#article-share-toast")).toHaveCSS("opacity", "1");
  expect(await page.evaluate(() => window.articleShareManualCopy)).toBe(`${title}\n${url}`);
});

test("clipboard failure offers manual copy without reporting a successful share", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } },
    });
    window.prompt = () => { throw new Error("Browser prompt must not be used"); };
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const share = page.locator(
    'main article.card:visible[data-detail-destination="internal"] [data-article-share][data-share-target="detail"]',
  ).first();
  await expect(share).toBeVisible();
  const title = await share.getAttribute("data-share-title-ja");
  const url = await share.getAttribute("data-share-url");
  if (!url) throw new Error("Internal article share URL is missing");
  const detailUrl = new URL(url);
  expect(detailUrl.origin).toBe(SITE_URL);
  expect(detailUrl.pathname).toMatch(/^\/e\/[^/]+\/$/);
  expect(detailUrl.search).toBe("");
  expect(detailUrl.hash).toBe("");
  await share.click();
  const manual = page.locator("#article-share-manual");
  await expect(manual).toBeVisible();
  await expect(manual).toHaveAttribute("open", "");
  await expect(manual).toHaveAccessibleName("自動コピーできませんでした");
  await expect(manual).toHaveAccessibleDescription("以下のタイトルとURLを選択してコピーしてください。");
  const text = manual.getByRole("textbox", { name: "タイトルとURL" });
  await expect(text).toHaveValue(`${title}\n${url}`);
  await expect(text).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(manual.getByRole("button", { name: "閉じる" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(text).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(manual.getByRole("button", { name: "閉じる" })).toBeFocused();
  await expect(page.locator("#article-share-status")).toBeEmpty();
  await expect(share).not.toHaveAttribute("aria-busy");
  const geometry = await manual.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(390);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(844);
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  await manual.getByRole("button", { name: "閉じる" }).click();
  await expect(manual).toBeHidden();
  await expect(share).toBeFocused();
  await expect(share).not.toHaveAttribute("aria-busy");

  await page.locator('.lang-btn[data-lang="en"]').click();
  const englishTitle = await share.getAttribute("data-share-title-en");
  await share.click();
  await expect(manual).toBeVisible();
  await expect(manual).toHaveAccessibleName("Automatic copy unavailable");
  await expect(manual.getByRole("textbox", { name: "Title and URL" }))
    .toHaveValue(`${englishTitle}\n${url}?lang=en`);
  await page.keyboard.press("Escape");
  await expect(manual).toBeHidden();
  await expect(share).toBeFocused();
});
