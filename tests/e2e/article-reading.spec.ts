import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "../../web/src/lib/detail-addressability.ts";
import { canonicalSourceUrl, sourceLabel } from "../../web/src/lib/source-meta.ts";
import { tagLabel } from "../../web/src/lib/tag-label.ts";
import { normalizeTagKey } from "../../web/src/lib/tag-normalize.ts";

interface ArticleFixture extends DetailAddressableEntry {
  id: string;
  url: string;
  source: string;
  tags: string[];
  publishedAt: string;
  collectedAt: string;
}

const entries = (JSON.parse(readFileSync("data/index.json", "utf8")) as {
  entries: ArticleFixture[];
}).entries;
const bodies = (JSON.parse(readFileSync("data/bodies.json", "utf8")) as {
  bodies: Record<string, { bodyJa?: string; bodyEn?: string }>;
}).bodies;
const hasBothBodies = (entry: ArticleFixture) =>
  Boolean(bodies[entry.id]?.bodyJa && bodies[entry.id]?.bodyEn);
const bodyEntry =
  entries.find((entry) =>
    entry.id === "60582ab80f6848d9"
    && isAddressableDetailEntry(entry)
    && hasBothBodies(entry)
  )
  ?? entries.find((entry) =>
    isAddressableDetailEntry(entry)
    && hasBothBodies(entry)
    && /^## /m.test(bodies[entry.id]!.bodyJa!)
    && /^## /m.test(bodies[entry.id]!.bodyEn!)
  );

test("article prose retains natural Japanese spacing and a measured JA/EN reading column", async ({ page }) => {
  expect(bodyEntry, "an addressable article with bilingual headed prose").toBeTruthy();
  await page.goto(`/e/${bodyEntry!.id}/`);

  for (const width of [320, 390, 948, 1280]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    for (const lang of ["ja", "en"] as const) {
      await page.locator(`.lang-btn[data-lang="${lang}"]`).click();
      const geometry = await page.evaluate((activeLang) => {
        const prose = document.querySelector<HTMLElement>(`.ed-body-prose.i18n-${activeLang}`);
        const paragraph = prose?.querySelector<HTMLElement>("p");
        const heading = prose?.querySelector<HTMLElement>("h2.ed-sec-h");
        if (!prose || !paragraph || !heading) return null;
        const style = getComputedStyle(paragraph);
        const proseRect = prose.getBoundingClientRect();
        const paraRect = paragraph.getBoundingClientRect();
        const headingRect = heading.getBoundingClientRect();
        const keyword = prose.querySelector<HTMLAnchorElement>("a.kw");
        const keywordStyle = keyword ? getComputedStyle(keyword) : null;
        let phrase: { text: string; extraWidth: number } | null = null;
        if (activeLang === "ja") {
          const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d");
          if (context) context.font = style.font;
          let node: Node | null;
          while (!phrase && (node = walker.nextNode())) {
            const match = node.textContent?.match(/[一-龯ぁ-ゟ゠-ヿ]{4,}/u);
            if (!match || !context) continue;
            const offset = node.textContent!.indexOf(match[0]);
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 4);
            const rangeRect = range.getBoundingClientRect();
            if (rangeRect.height < Number.parseFloat(style.lineHeight) * 1.2) {
              const text = match[0].slice(0, 4);
              phrase = {
                text,
                extraWidth: rangeRect.width - context.measureText(text).width,
              };
            }
          }
        }
        return {
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
          proseWidth: proseRect.width,
          paragraphLeft: paraRect.left,
          paragraphRight: paraRect.right,
          headingLeft: headingRect.left,
          textAlign: style.textAlign,
          textJustify: style.textJustify,
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
          keyword: keywordStyle
            ? {
                underline: keywordStyle.textDecorationLine,
                padding: Number.parseFloat(keywordStyle.paddingLeft)
                  + Number.parseFloat(keywordStyle.paddingRight),
              }
            : null,
          phrase,
        };
      }, lang);
      expect(geometry, `${width}px ${lang}: article body and heading`).not.toBeNull();
      const measured = geometry!;
      expect(measured.pageOverflow, `${width}px ${lang}: no page overflow`).toBeLessThanOrEqual(0);
      expect(measured.proseWidth, `${width}px ${lang}: readable line measure`).toBeLessThanOrEqual(650);
      expect(measured.fontSize, `${width}px ${lang}: body font floor`).toBeGreaterThanOrEqual(16);
      expect(measured.lineHeight / measured.fontSize).toBeGreaterThanOrEqual(1.65);
      expect(measured.textAlign).toBe("start");
      expect(measured.textJustify).not.toBe("inter-character");
      expect(Math.abs(measured.headingLeft - measured.paragraphLeft)).toBeLessThanOrEqual(1);
      expect(measured.paragraphRight).toBeLessThanOrEqual(width);
      if (lang === "ja") {
        expect(measured.phrase, `${width}px: rendered Japanese phrase exists`).not.toBeNull();
        expect(
          Math.abs(measured.phrase!.extraWidth),
          `${width}px: ${measured.phrase!.text} is not expanded by justification`,
        ).toBeLessThanOrEqual(2);
      }
      if (measured.keyword) {
        expect(measured.keyword.underline).toContain("underline");
        expect(measured.keyword.padding).toBe(0);
      }
    }
  }
});

test("article topics stay routable and detailed metadata remains accessible but quiet", async ({
  page,
}) => {
  const target =
    entries.find((entry) => entry.id === "60582ab80f6848d9" && entry.tags.length > 5)
    ?? entries.find((entry) => isAddressableDetailEntry(entry) && entry.tags.length > 5);
  expect(target, "an article with more than five topic tags").toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/e/${target!.id}/`);

  await expect(page.locator(".ed-byline [data-source-authority]")).toBeVisible();
  await expect(page.locator(".ed-published[datetime]")).toHaveAttribute(
    "datetime",
    target!.publishedAt,
  );
  await expect(page.locator(".ed-priority")).toBeVisible();
  await expect(page.locator(".ed-disclaim")).toBeVisible();

  const topics = page.getByRole("navigation", { name: "関連トピック" });
  const moreTopics = topics.locator(".ed-topic-more");
  await expect(topics.locator(".ed-topic-links").first().locator("a")).toHaveCount(5);
  await expect(moreTopics.locator(".ed-topic-links")).toBeHidden();
  await moreTopics.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(moreTopics).toHaveAttribute("open", "");
  await expect(moreTopics.locator(".ed-topic-links")).toBeVisible();
  const links = await topics.locator("a[data-tag-key]").evaluateAll((nodes) =>
    nodes.map((node) => ({
      key: node.getAttribute("data-tag-key") ?? "",
      label: node.textContent?.trim() ?? "",
      href: node.getAttribute("href") ?? "",
    })),
  );
  expect(links.map((link) => link.key)).toEqual(target!.tags);
  for (const link of links) {
    expect(link.label).toBe(tagLabel(link.key));
    const key = normalizeTagKey(link.key);
    const url = new URL(link.href, page.url());
    expect(
      url.pathname === `/t/${encodeURIComponent(key)}`
        || (url.pathname === "/search" && url.searchParams.get("tag") === key),
      `tag ${link.key} retains a canonical article/topic destination`,
    ).toBe(true);
  }
  const rawMeta = await page.locator('meta[property="article:tag"]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("content")),
  );
  expect(rawMeta).toEqual(target!.tags);
  const structured = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
  ) as { keywords?: string };
  expect(structured.keywords).toBe(target!.tags.join(", "));

  const details = page.locator(".ed-meta-details");
  await expect(details.locator(".ed-meta-strip")).toBeHidden();
  const trigger = details.locator("summary");
  await trigger.focus();
  await page.keyboard.press("Space");
  await expect(trigger).toBeFocused();
  await expect(details).toHaveAttribute("open", "");
  await expect(details.locator(".ed-meta-strip")).toBeVisible();
  await expect(details.locator('[data-meta-field="published"] time')).toHaveAttribute(
    "datetime",
    target!.publishedAt,
  );
  await expect(details.locator('[data-meta-field="collected"] time')).toHaveAttribute(
    "datetime",
    target!.collectedAt,
  );
  const sample = details.locator("[data-source-sample-count]");
  const listedCount = Number(await sample.getAttribute("data-source-sample-count"));
  expect(listedCount).toBeGreaterThan(0);
  expect(listedCount).toBeLessThanOrEqual(30);
  await expect(sample.locator("dt .i18n-ja")).toContainText(`掲載直近 ${listedCount} 件`);
  await expect(sample.locator("dd")).toContainText("/ 3");
  await expect(sample.locator("dd")).toContainText("1=情報 · 2=中 · 3=高");

  await page.locator('.lang-btn[data-lang="en"]').click();
  await expect(page.getByRole("navigation", { name: "Related topics" })).toBeVisible();
  await expect(trigger).toHaveText(/Article details & collection record/);
  await expect(sample.locator("dt .i18n-en")).toBeVisible();
  await expect(sample.locator("dt .i18n-en")).toContainText(`last ${listedCount} listed`);
  await expect(sample.locator("dd .i18n-en")).toContainText("1=Info · 2=Medium · 3=High");
  await page.evaluate(() => {
    document.querySelector(".ed-meta-details > summary")?.scrollIntoView({ block: "center" });
  });
  const safeArea = await page.evaluate(() => {
    const summary = document.querySelector(".ed-meta-details > summary")!.getBoundingClientRect();
    const tabbar = document.querySelector(".mobile-tabbar")!.getBoundingClientRect();
    const hit = document.elementFromPoint(summary.left + summary.width / 2, summary.top + summary.height / 2);
    return {
      summaryBottom: summary.bottom,
      tabbarTop: tabbar.top,
      hitSummary: Boolean(hit?.closest(".ed-meta-details > summary")),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  expect(safeArea.summaryBottom).toBeLessThan(safeArea.tabbarTop - 8);
  expect(safeArea.hitSummary).toBe(true);
  expect(safeArea.overflow).toBeLessThanOrEqual(0);
});

test("canonical source provenance and summary-only details retain their honest states", async ({
  page,
}) => {
  const redirected = entries.find((entry) =>
    isAddressableDetailEntry(entry)
    && canonicalSourceUrl(entry.url) !== entry.url,
  );
  if (redirected) {
    await page.goto(`/e/${redirected.id}/`);
    await expect(page.locator(".ed-src-name")).toHaveText(
      sourceLabel(redirected.source, redirected.url),
    );
    await expect(page.locator(".ed-header-cta")).toHaveAttribute(
      "href",
      canonicalSourceUrl(redirected.url),
    );
    await page.locator(".ed-meta-details > summary").click();
    await expect(page.locator("[data-collection-source]")).toContainText(
      sourceLabel(redirected.source),
    );
  }

  const withoutBody = entries.find((entry) =>
    isAddressableDetailEntry(entry) && !bodies[entry.id],
  );
  expect(withoutBody, "an addressable summary-only article").toBeTruthy();
  await page.goto(`/e/${withoutBody!.id}/`);
  await expect(page.locator(".ed-body-prose")).toHaveCount(0);
  await expect(page.locator(".ed-summary-only")).toBeVisible();
  await expect(page.locator(".ed-disclaim")).toBeVisible();
  await expect(page.locator(".ed-meta-strip")).toBeHidden();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".ed-meta-details > summary").click();
  await expect(page.locator(".ed-meta-strip")).toBeVisible();
  await expect(page.locator(".ed-meta-details > summary")).toBeFocused();
});
