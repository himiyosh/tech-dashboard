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
});
