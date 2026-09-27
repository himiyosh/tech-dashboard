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
  bodies: Record<string, { bodyJa?: string; bodyEn?: string; chat?: unknown }>;
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
const hasFullArticleLayout = (entry: ArticleFixture) => {
  const record = bodies[entry.id];
  return isAddressableDetailEntry(entry)
    && hasBothBodies(entry)
    && entry.tags.length > 0
    && /^## /m.test(record?.bodyJa ?? "")
    && /^## /m.test(record?.bodyEn ?? "")
    && Array.isArray(record?.chat)
    && record.chat.length === 6;
};
const layoutEntry =
  entries.find((entry) => entry.id === "60582ab80f6848d9" && hasFullArticleLayout(entry))
  ?? entries.find(hasFullArticleLayout);

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

test("article rails adapt to the CSS viewport without stretching the prose or dialogue", async ({
  page,
}) => {
  expect(layoutEntry, "an addressable article with bilingual prose and dialogue").toBeTruthy();
  await page.goto(`/e/${layoutEntry!.id}/`);
  await expect(page.locator(".layout.entry-layout")).toBeVisible();
  await expect(page.locator("[data-article-chat] .ed-chat-turn")).toHaveCount(6);

  for (const width of [
    320, 390, 720, 768, 900, 901, 948, 1000, 1024, 1100, 1180, 1181, 1280,
    1359, 1360, 1440, 1680, 2000, 2248,
  ]) {
    await page.setViewportSize({ width, height: width <= 720 ? 844 : 900 });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const layout = await page.evaluate(() => {
      const box = (selector: string) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        if (getComputedStyle(node).display === "none" || !rect.width || !rect.height) return null;
        return {
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          width: rect.width, height: rect.height,
        };
      };
      const grid = document.querySelector<HTMLElement>(".layout.entry-layout")!;
      const right = document.querySelector<HTMLElement>(".layout.entry-layout > aside.right");
      const rightRect = box(".layout.entry-layout > aside.right");
      const chatHead = document.querySelector<HTMLElement>(".ed-chat-head")!;
      const chatStyle = getComputedStyle(chatHead);
      const footer = document.querySelector<HTMLElement>(".footer-bar")!;
      return {
        viewport: {
          innerWidth, outerWidth, clientWidth: document.documentElement.clientWidth,
          visualWidth: visualViewport?.width ?? 0,
          visualScale: visualViewport?.scale ?? 0,
          dpr: devicePixelRatio,
          scrollWidth: document.documentElement.scrollWidth,
        },
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        canvas: box(".layout.entry-layout"),
        header: box("body > header .header-inner"),
        crumb: box(".crumb-inner"),
        categoriesShortcut: box('header .nav-shortcut[href="/categories"]'),
        heroCategory: box(".ed-cat-pill"),
        headerControls: [
          ".header-inner .logo", ".header-inner .header-switcher",
          ".header-inner > .search", ".header-inner .lang-toggle",
          ".header-inner > .menu-trigger",
        ].map(box).filter((item) => item !== null),
        left: box(".layout.entry-layout > aside.left"),
        main: box(".entry-main"),
        article: box(".entry-detail"),
        right: rightRect,
        readingCard: box(".layout.entry-layout > aside.right .reading-card"),
        prose: box(".ed-body-prose.i18n-ja"),
        chat: box(".ed-chat"),
        tabbar: box(".mobile-tabbar"),
        footer: {
          position: getComputedStyle(footer).position,
          visible: getComputedStyle(footer).display !== "none",
        },
        chatHead: {
          position: chatStyle.position,
          background: chatStyle.backgroundColor,
          blur: chatStyle.backdropFilter,
          border: chatStyle.borderBottomWidth,
        },
        rightCardSpill: right && rightRect
          ? [...right.querySelectorAll<HTMLElement>(".side-card")]
            .some((card) => card.getBoundingClientRect().right > rightRect.right + 1)
          : false,
      };
    });
    const scope = `${width}px (CSS viewport ${layout.viewport.innerWidth}, outer ${layout.viewport.outerWidth}, DPR ${layout.viewport.dpr})`;
    expect(layout.viewport.innerWidth, scope).toBe(width);
    expect(layout.viewport.clientWidth, scope).toBeLessThanOrEqual(width);
    expect(layout.viewport.visualWidth, scope).toBeCloseTo(width, 0);
    expect(layout.viewport.visualScale, scope).toBe(1);
    expect(layout.viewport.dpr, scope).toBeGreaterThan(0);
    expect(layout.viewport.scrollWidth, `${scope}: no horizontal page scroll`).toBeLessThanOrEqual(width);
    const canvas = layout.canvas!;
    const main = layout.main!;
    const article = layout.article!;
    const prose = layout.prose!;
    const chat = layout.chat!;
    expect(Math.abs(canvas.left - layout.header!.left), `${scope}: header/canvas alignment`)
      .toBeLessThanOrEqual(1);
    expect(Math.abs(canvas.left - layout.crumb!.left), `${scope}: crumb/canvas alignment`)
      .toBeLessThanOrEqual(1);
    for (const [index, control] of layout.headerControls.entries()) {
      expect(control.left, `${scope}: header controls stay within their canvas`)
        .toBeGreaterThanOrEqual(layout.header!.left - 1);
      expect(control.right, `${scope}: header controls stay within their canvas`)
        .toBeLessThanOrEqual(layout.header!.right + 1);
      if (index > 0) {
        expect(layout.headerControls[index - 1].right, `${scope}: header controls do not overlap`)
          .toBeLessThanOrEqual(control.left + 1);
      }
    }
    expect(article.width, `${scope}: article fills its own grid track`).toBeCloseTo(main.width, 0);
    expect(chat.width, `${scope}: dialogue belongs to the article panel`)
      .toBeGreaterThan(main.width - 4);
    expect(prose.width, `${scope}: readable JA measure`).toBeLessThanOrEqual(641);
    expect(Math.abs((main.left + main.right - prose.left - prose.right) / 2),
      `${scope}: prose centered inside its article track`).toBeLessThanOrEqual(2);
    expect(layout.chatHead.position, `${scope}: dialogue header must not stick over prose`)
      .toBe("static");
    expect(layout.chatHead.background, scope).toBe("rgba(0, 0, 0, 0)");
    expect(layout.chatHead.blur, scope).toBe("none");
    expect(layout.chatHead.border, scope).toBe("0px");
    if (width <= 1180) {
      expect(layout.columns, scope).toBe(1);
      expect(layout.left, scope).toBeNull();
      expect(layout.right, scope).toBeNull();
      expect(Math.abs(prose.left - (layout.viewport.clientWidth - prose.right)),
        `${scope}: reading column is centered in the actual viewport`)
        .toBeLessThanOrEqual(8);
      if (width >= 901) {
        expect(main.width, `${scope}: centered panel keeps usable inline size`)
          .toBeGreaterThanOrEqual(Math.min(960, layout.viewport.clientWidth - 32) - 1);
        expect(layout.categoriesShortcut, `${scope}: taxonomy remains in header`).not.toBeNull();
        expect(layout.heroCategory, `${scope}: article lane remains reachable`).not.toBeNull();
      }
    } else {
      expect(layout.columns, scope).toBe(3);
      expect(layout.left, scope).not.toBeNull();
      expect(layout.right, scope).not.toBeNull();
      expect(layout.readingCard, scope).not.toBeNull();
      expect(layout.left!.right, scope).toBeLessThanOrEqual(main.left - 12);
      expect(main.right, scope).toBeLessThanOrEqual(layout.right!.left - 12);
      expect(layout.rightCardSpill, `${scope}: rail cards stay within their track`).toBe(false);
      expect(main.width, `${scope}: article is not squeezed by the rail`)
        .toBeGreaterThanOrEqual(width >= 1360 ? 750 : 590);
      const gutterDifference = prose.left - (layout.viewport.clientWidth - prose.right);
      const railDifference = layout.left!.width - layout.right!.width;
      expect(Math.abs(gutterDifference - railDifference),
        `${scope}: the only reading-column offset is the measured rail-width difference`)
        .toBeLessThanOrEqual(2);
    }
    if (width <= 720) {
      expect(layout.tabbar!.width, `${scope}: fixed navigation spans the CSS viewport`)
        .toBeCloseTo(layout.viewport.clientWidth, 0);
      expect(layout.footer.visible, `${scope}: mobile footer does not compete with navigation`)
        .toBe(false);
    } else {
      expect(layout.tabbar, `${scope}: desktop navigation stays in the header`).toBeNull();
      expect(layout.footer.position, `${scope}: article footer scrolls with content`).toBe("static");
    }
    if (width >= 1360) {
      expect(main.width - prose.width, `${scope}: spare width flows to source context`)
        .toBeLessThan(370);
    }
    if (width >= 2000) {
      expect(layout.right!.width, `${scope}: text-heavy rail has useful width`)
        .toBeGreaterThanOrEqual(350);
    }
  }

  await page.setViewportSize({ width: 948, height: 900 });
  const categories = page.locator('header .nav-shortcut[href="/categories"]');
  await categories.focus();
  await expect(categories).toBeFocused();
  const articleCategory = page.locator(".ed-cat-pill");
  await articleCategory.focus();
  await expect(articleCategory).toBeFocused();

  for (const width of [
    320, 390, 768, 900, 901, 948, 1000, 1024, 1100, 1180, 1181, 1280, 1440, 2000,
  ]) {
    await page.setViewportSize({ width, height: width <= 720 ? 844 : 900 });
    await page.locator('.lang-btn[data-lang="en"]').click();
    const en = await page.evaluate(() => {
      const main = document.querySelector(".entry-main")!.getBoundingClientRect();
      const prose = document.querySelector(".ed-body-prose.i18n-en")!.getBoundingClientRect();
      const controls = [
        ".header-inner .logo", ".header-inner .header-switcher",
        ".header-inner > .search", ".header-inner .lang-toggle",
        ".header-inner > .menu-trigger",
      ].map((selector) => document.querySelector(selector))
        .filter((node): node is Element => !!node && getComputedStyle(node).display !== "none")
        .map((node) => node.getBoundingClientRect());
      return {
        clientWidth: document.documentElement.clientWidth,
        mainCenter: (main.left + main.right) / 2,
        proseCenter: (prose.left + prose.right) / 2,
        proseLeft: prose.left,
        proseRight: prose.right,
        proseWidth: prose.width,
        leftRailWidth: document.querySelector(".layout.entry-layout > aside.left")!
          .getBoundingClientRect().width,
        rightRailWidth: document.querySelector(".layout.entry-layout > aside.right")!
          .getBoundingClientRect().width,
        headerOverlap: controls.some((rect, index) =>
          index > 0 && controls[index - 1].right > rect.left + 1),
        chatTurns: document.querySelectorAll("[data-article-chat] .ed-chat-turn").length,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(en.proseWidth, `${width}px EN prose is visible`).toBeGreaterThan(195);
    expect(en.proseWidth, `${width}px EN line measure`).toBeLessThanOrEqual(650);
    expect(Math.abs(en.mainCenter - en.proseCenter), `${width}px EN centered`).toBeLessThan(2);
    if (width <= 1180) {
      expect(Math.abs(en.proseLeft - (en.clientWidth - en.proseRight)),
        `${width}px EN viewport gutters`).toBeLessThanOrEqual(8);
    } else {
      const gutterDifference = en.proseLeft - (en.clientWidth - en.proseRight);
      expect(Math.abs(gutterDifference - (en.leftRailWidth - en.rightRailWidth)),
        `${width}px EN opposing rails`).toBeLessThanOrEqual(2);
    }
    expect(en.headerOverlap, `${width}px EN header controls`).toBe(false);
    expect(en.chatTurns, `${width}px preserves all dialogue turns`).toBe(6);
    expect(en.overflow, `${width}px EN page overflow`).toBeLessThanOrEqual(0);
  }
});

test("article Back to top is in flow and never obscures readable text", async ({ page }) => {
  expect(layoutEntry, "an addressable article with bilingual dialogue").toBeTruthy();
  await page.goto(`/e/${layoutEntry!.id}/`);
  const back = page.locator("#ed-back-to-top");
  await expect(back).toHaveAttribute("href", "#");
  await expect(page.locator("#ed-fab")).toHaveCount(0);

  for (const width of [320, 390, 768, 948, 1000, 1180, 1181, 1280, 1440, 1680, 2000]) {
    await page.setViewportSize({ width, height: width <= 720 ? 844 : 900 });
    for (const lang of ["ja", "en"] as const) {
      await page.locator(`.lang-btn[data-lang="${lang}"]`).click();
      await expect(back).toHaveAccessibleName(lang === "ja" ? "トップに戻る" : "Back to top");
      const position = await back.evaluate((node) => ({
        value: getComputedStyle(node).position,
        inMain: document.querySelector(".entry-main")?.contains(node),
      }));
      expect(position.value, `${width}px ${lang}: never fixed over article content`).toBe("static");
      expect(position.inMain, `${width}px ${lang}: action belongs to the article flow`).toBe(true);

      const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        await page.evaluate((top) => scrollTo({ top, behavior: "instant" }),
          Math.round(maxScroll * fraction));
        const collisions = await page.evaluate(() => {
          const action = document.querySelector<HTMLElement>("#ed-back-to-top")!;
          const actionRect = action.getBoundingClientRect();
          const selectors = [
            ".ed-body-prose p", ".ed-chat-text", ".ed-tldr-body",
            ".ed-pn-title", ".ed-rel-title", ".layout > aside.right .rail-list a",
            ".layout > aside.right .toc-list a", ".layout > aside.right .tag-cloud a",
          ];
          const overlapped: string[] = [];
          for (const selector of selectors) {
            for (const node of document.querySelectorAll<HTMLElement>(selector)) {
              if (!node.getClientRects().length) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const rect of range.getClientRects()) {
                const area = Math.max(0, Math.min(rect.right, actionRect.right) -
                  Math.max(rect.left, actionRect.left)) *
                  Math.max(0, Math.min(rect.bottom, actionRect.bottom) -
                    Math.max(rect.top, actionRect.top));
                if (area > 1) {
                  overlapped.push(selector);
                  break;
                }
              }
            }
          }
          return overlapped;
        });
        expect(collisions, `${width}px ${lang} scroll ${fraction}: no text under return link`)
          .toEqual([]);
      }
      const atEnd = await page.evaluate(() => {
        const action = document.querySelector<HTMLElement>("#ed-back-to-top")!;
        const rect = action.getBoundingClientRect();
        const tabbar = document.querySelector<HTMLElement>(".mobile-tabbar");
        const nav = tabbar && getComputedStyle(tabbar).display !== "none"
          ? tabbar.getBoundingClientRect() : null;
        return {
          width: rect.width,
          height: rect.height,
          insideViewport: rect.top >= 0 && rect.bottom <= innerHeight,
          tabbarGap: nav ? nav.top - rect.bottom : null,
          ownsCenter: action.contains(document.elementFromPoint(
            rect.left + rect.width / 2, rect.top + rect.height / 2,
          )),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      expect(atEnd.width, `${width}px ${lang}: keyboard and touch target width`)
        .toBeGreaterThanOrEqual(44);
      expect(atEnd.height, `${width}px ${lang}: keyboard and touch target height`)
        .toBeGreaterThanOrEqual(44);
      expect(atEnd.insideViewport, `${width}px ${lang}: end action is reachable`).toBe(true);
      expect(atEnd.ownsCenter, `${width}px ${lang}: actual pointer target`).toBe(true);
      if (atEnd.tabbarGap !== null) {
        expect(atEnd.tabbarGap, `${width}px ${lang}: article action clears mobile navigation`)
          .toBeGreaterThanOrEqual(8);
      }
      expect(atEnd.overflow, `${width}px ${lang}: no horizontal scroll`).toBeLessThanOrEqual(0);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [lang, name] of [["ja", "トップに戻る"], ["en", "Back to top"]] as const) {
    await page.locator(`.lang-btn[data-lang="${lang}"]`).click();
    await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
    const action = page.getByRole("link", { name });
    await action.focus();
    await expect(action).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await expect(page.locator("body > header .logo")).toBeFocused();
  }
});

test("article return link reaches the top without client JavaScript", async ({
  browser, page,
}) => {
  expect(layoutEntry, "an addressable detail route for no-script navigation").toBeTruthy();
  await page.goto(`/e/${layoutEntry!.id}/`);
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  try {
    const noScript = await context.newPage();
    await noScript.goto(page.url());
    const back = noScript.getByRole("link", { name: "トップに戻る" });
    await expect(back).toHaveAttribute("href", "#");
    await back.scrollIntoViewIfNeeded();
    expect(await noScript.evaluate(() => scrollY)).toBeGreaterThan(0);
    await back.click();
    await expect.poll(() => noScript.evaluate(() => scrollY)).toBe(0);
  } finally {
    await context.close();
  }
});

test("article sticky rails, contents links, and mobile controls remain reachable", async ({
  page,
}) => {
  expect(layoutEntry, "an addressable article with a contents rail").toBeTruthy();
  await page.goto(`/e/${layoutEntry!.id}/`);
  for (const width of [948, 1100, 1181, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => scrollTo({ top: 550, behavior: "instant" }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(resolve)));
    const clearance = await page.evaluate(() => {
      const headerBottom = document.querySelector("body > header")!.getBoundingClientRect().bottom;
      const left = document.querySelector<HTMLElement>(".layout.entry-layout > aside.left");
      const right = document.querySelector<HTMLElement>(".layout.entry-layout > aside.right");
      return {
        headerBottom,
        leftTop: left && getComputedStyle(left).display !== "none"
          ? left.getBoundingClientRect().top : null,
        rightTop: right && getComputedStyle(right).display !== "none"
          ? right.getBoundingClientRect().top : null,
      };
    });
    if (width >= 1181) {
      expect(clearance.leftTop, `${width}px category rail is present`).not.toBeNull();
      expect(clearance.leftTop!, `${width}px category rail clears the site header`)
        .toBeGreaterThanOrEqual(clearance.headerBottom + 8);
      expect(clearance.rightTop, `${width}px right rail is present`).not.toBeNull();
      expect(clearance.rightTop!, `${width}px reading rail clears the site header`)
        .toBeGreaterThanOrEqual(clearance.headerBottom + 8);
    } else {
      expect(clearance.leftTop, `${width}px panel has no off-center sidebar`).toBeNull();
      expect(clearance.rightTop, `${width}px panel defers the context rail`).toBeNull();
    }
  }

  await page.setViewportSize({ width: 1280, height: 900 });
  const firstTocLink = page.locator(".toc-list.i18n-ja a").first();
  await expect(firstTocLink).toBeVisible();
  const tocTarget = (await firstTocLink.getAttribute("href"))!.slice(1);
  expect((await firstTocLink.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await firstTocLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#${tocTarget}$`));
  await expect.poll(() => page.evaluate((id) =>
    document.getElementById(id)!.getBoundingClientRect().top, tocTarget,
  )).toBeLessThanOrEqual(180);
  const anchor = await page.evaluate((id) => ({
    targetTop: document.getElementById(id)!.getBoundingClientRect().top,
    headerBottom: document.querySelector("body > header")!.getBoundingClientRect().bottom,
  }), tocTarget);
  expect(anchor.targetTop, "the section heading is not obscured by the site header")
    .toBeGreaterThanOrEqual(anchor.headerBottom + 8);
  await page.evaluate(() => {
    const chat = document.querySelector(".ed-chat")!;
    scrollTo({ top: chat.getBoundingClientRect().top + scrollY + 100, behavior: "instant" });
  });
  const headerHit = await page.evaluate(() => {
    const main = document.querySelector(".entry-main")!.getBoundingClientRect();
    const hit = document.elementFromPoint((main.left + main.right) / 2, 12);
    return document.querySelector("body > header")?.contains(hit) ?? false;
  });
  expect(headerHit, "the conversation heading no longer overlays site navigation").toBe(true);

  for (const width of [320, 390, 768, 900]) {
    await page.setViewportSize({ width, height: width <= 720 ? 844 : 900 });
    const targets = await page.evaluate(() => {
      const dimensions = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
      return {
        crumb: dimensions(".crumb-inner a"),
        topics: dimensions(".ed-topic-links a"),
        moreTopics: dimensions(".ed-topic-more summary"),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(targets.crumb.length, `${width}px has Home and lane breadcrumb links`)
      .toBeGreaterThanOrEqual(2);
    expect(targets.topics.length, `${width}px has article topic links`).toBeGreaterThan(0);
    for (const [kind, boxes] of Object.entries({
      crumb: targets.crumb, topic: targets.topics, more: targets.moreTopics,
    })) {
      for (const box of boxes) {
        expect(box.height, `${width}px ${kind} target height`).toBeGreaterThanOrEqual(44);
        expect(box.width, `${width}px ${kind} target width`).toBeGreaterThanOrEqual(44);
      }
    }
    expect(targets.overflow, `${width}px with larger targets`).toBeLessThanOrEqual(0);
  }
});

test("article-only width rules do not change Home or category layouts", async ({ page }) => {
  for (const route of ["/", "/categories/"]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(route);
    const desktop = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".layout")!;
      return {
        articleRule: grid.classList.contains("entry-layout"),
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(desktop.articleRule, `${route} has no article layout override`).toBe(false);
    expect(desktop.columns, `${route} keeps its own desktop grid`)
      .toBe(route === "/" ? 3 : 2);
    expect(desktop.overflow, `${route} desktop overflow`).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(page.locator(".layout > aside.left")).toBeVisible();
    const panel = await page.evaluate(() => ({
      columns: getComputedStyle(document.querySelector(".layout")!).gridTemplateColumns
        .split(/\s+/).length,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    expect(panel.columns, `${route} retains its own two-column panel layout`).toBe(2);
    expect(panel.overflow, `${route} panel overflow`).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>(".layout")!;
      return {
        columns: getComputedStyle(grid).gridTemplateColumns.split(/\s+/).length,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(mobile.columns, `${route} retains a single mobile column`).toBe(1);
    expect(mobile.overflow, `${route} mobile overflow`).toBeLessThanOrEqual(0);
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
