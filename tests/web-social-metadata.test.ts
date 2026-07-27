import { describe, expect, it } from "vitest";

import {
  ALL_ENTRIES,
  CATEGORY_META,
  titleForLang,
} from "../web/src/lib/data.ts";
import { ARCHIVE_WARM_ENTRIES } from "../web/src/lib/archive.ts";
import { collectAddressableDetailEntries } from "../web/src/lib/detail-addressability.ts";
import { sourceLabel } from "../web/src/lib/source-meta.ts";
import {
  HOME_DESCRIPTION_EN,
  HOME_DESCRIPTION_JA,
  HOME_PAGE_METADATA,
  HOME_TITLE_EN,
  HOME_TITLE_JA,
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_TYPE,
  SOCIAL_IMAGE_URL,
  SOCIAL_IMAGE_WIDTH,
  articleSocialImage,
  localizedArticleMetadataDescription,
  localizedArticleMetadataTitle,
} from "../web/src/lib/social-metadata.ts";
import {
  GET as getSocialImage,
  generateSocialCardPng,
} from "../web/src/pages/social/tech-dashboard-v1.png.ts";

describe("localized social metadata", () => {
  it("defines complete localized Home metadata with one absolute brand image", () => {
    expect(HOME_PAGE_METADATA).toMatchObject({
      canonicalUrl: "https://techdb.studio344.net/",
      socialUrlJa: "https://techdb.studio344.net/",
      socialUrlEn: "https://techdb.studio344.net/?lang=en",
      type: "website",
      titleJa: HOME_TITLE_JA,
      titleEn: HOME_TITLE_EN,
      descriptionJa: HOME_DESCRIPTION_JA,
      descriptionEn: HOME_DESCRIPTION_EN,
      image: {
        url: SOCIAL_IMAGE_URL,
        type: SOCIAL_IMAGE_TYPE,
        width: SOCIAL_IMAGE_WIDTH,
        height: SOCIAL_IMAGE_HEIGHT,
      },
    });
    expect(new URL(HOME_PAGE_METADATA.image.url).origin).toBe(
      "https://techdb.studio344.net",
    );
    expect(HOME_PAGE_METADATA.descriptionJa).not.toBe(HOME_PAGE_METADATA.descriptionEn);
  });

  it("keeps a valid source image and only claims dimensions that are known", () => {
    expect(
      articleSocialImage(
        {
          src: "https://cdn.example.com/cover.webp?size=large",
          width: 1_600,
          height: 900,
        },
        "日本語タイトル",
        "English title",
      ),
    ).toEqual({
      url: "https://cdn.example.com/cover.webp?size=large",
      altJa: "「日本語タイトル」の元記事画像",
      altEn: 'Source image for "English title"',
      type: "image/webp",
      width: 1_600,
      height: 900,
    });

    const unknownDimensions = articleSocialImage(
      { src: "/media/cover", width: 0, height: 0 },
      "日本語タイトル",
      "English title",
    );
    expect(unknownDimensions.url).toBe("https://techdb.studio344.net/media/cover");
    expect(unknownDimensions.type).toBeUndefined();
    expect(unknownDimensions.width).toBeUndefined();
    expect(unknownDimensions.height).toBeUndefined();
  });

  it("uses the repository-owned fallback for missing, unsafe, or unsupported source images", () => {
    for (const image of [
      undefined,
      { src: "" },
      { src: "javascript:alert(1)" },
      { src: "https://cdn.example.com/cover.svg" },
      { src: "https://cdn.example.com/cover.avif?size=large" },
    ]) {
      const metadata = articleSocialImage(image, "日本語タイトル", "English title");
      expect(metadata).toMatchObject({
        url: SOCIAL_IMAGE_URL,
        type: SOCIAL_IMAGE_TYPE,
        width: SOCIAL_IMAGE_WIDTH,
        height: SOCIAL_IMAGE_HEIGHT,
      });
      expect(metadata.altJa).toContain("元記事画像が未収録");
      expect(metadata.altEn).toContain("without a source image");
    }
  });

  it("never fills missing-language metadata with another language or pending boilerplate", () => {
    expect(
      localizedArticleMetadataTitle({
        title: "",
        lang: "ja",
        sourceLabel: "Anthropic Engineering",
        categoryLabel: "Claude",
        publishedAt: "2026-07-27T12:34:56.000Z",
        sourceUrl: "https://example.com/articles/anthropic-update",
      }),
    ).toBe("Anthropic EngineeringのClaude更新 | 2026-07-27 12:34 UTC");
    expect(
      localizedArticleMetadataTitle({
        title: "",
        lang: "en",
        sourceLabel: "Zenn AI",
        categoryLabel: "Local Models",
        publishedAt: "2026-07-27T12:34:56.000Z",
        sourceUrl: "https://zenn.dev/example/articles/abcdef123456",
      }),
    ).toBe("Local Models update from Zenn AI | 2026-07-27 12:34 UTC");
    expect(
      localizedArticleMetadataTitle({
        title: "【Unity × Cursor】Cursorが変える開発体験",
        lang: "en",
        sourceLabel: "Qiita",
        categoryLabel: "Cursor",
        publishedAt: "2026-07-27T12:34:56.000Z",
        sourceUrl: "https://qiita.com/example/items/abcdef123456",
      }),
    ).toBe("Cursor update from Qiita | 2026-07-27 12:34 UTC");
    expect(
      localizedArticleMetadataTitle({
        title: "",
        lang: "ja",
        sourceLabel: "Cline Releases",
        categoryLabel: "Cline / Roo",
        publishedAt: "2026-07-09T03:24:26.000Z",
        sourceUrl: "https://github.com/cline/cline/releases/tag/sdk%2Fcore%2Fv0.0.59",
      }),
    ).toBe("Cline ReleasesのCline / Roo更新 | sdk/core/v0.0.59");

    const jaDescription = localizedArticleMetadataDescription({
      summary: "",
      lang: "ja",
      sourceLabel: "GitHub Blog",
      categoryLabel: "Copilot",
    });
    const enDescription = localizedArticleMetadataDescription({
      summary: "",
      lang: "en",
      sourceLabel: "GitHub Blog",
      categoryLabel: "Copilot",
    });
    expect(jaDescription).toContain("GitHub Blogが公開したCopilotの記事");
    expect(enDescription).toContain("An article from GitHub Blog in Copilot");
    expect(`${jaDescription} ${enDescription}`).not.toMatch(
      /AI 要約は準備中|AI summary pending|近日中/,
    );
  });

  it("keeps every addressable article title language-safe and unique in the current corpus", () => {
    const addressable = collectAddressableDetailEntries(
      ALL_ENTRIES,
      ARCHIVE_WARM_ENTRIES,
    );
    const jaTitles = new Set<string>();
    const enTitles = new Set<string>();
    for (const entry of addressable) {
      const categoryLabel = CATEGORY_META.find(
        (category) => category.slug === entry.category,
      )?.name ?? "Technology";
      const common = {
        sourceLabel: sourceLabel(entry.source, entry.url),
        categoryLabel,
        publishedAt: entry.publishedAt,
        sourceUrl: entry.url,
      };
      const jaTitle = localizedArticleMetadataTitle({
        ...common,
        title: titleForLang(entry, "ja"),
        lang: "ja",
      });
      const enTitle = localizedArticleMetadataTitle({
        ...common,
        title: titleForLang(entry, "en"),
        lang: "en",
      });

      expect(enTitle).not.toMatch(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
      );
      expect(`${jaTitle} ${enTitle}`).not.toMatch(
        /AI 要約は準備中|AI summary pending|近日中/,
      );
      expect(Array.from(jaTitle).length).toBeLessThanOrEqual(120);
      expect(Array.from(enTitle).length).toBeLessThanOrEqual(120);
      expect(
        articleSocialImage(entry.image, jaTitle, enTitle).url,
      ).not.toMatch(/\.(?:avif|svg)(?:$|[?#])/i);
      expect(jaTitles.has(jaTitle), `duplicate JA metadata title: ${jaTitle}`).toBe(false);
      expect(enTitles.has(enTitle), `duplicate EN metadata title: ${enTitle}`).toBe(false);
      jaTitles.add(jaTitle);
      enTitles.add(enTitle);
    }
    expect(jaTitles.size).toBe(addressable.length);
    expect(enTitles.size).toBe(addressable.length);
  });
});

describe("repository-owned social image", () => {
  it("generates a deterministic 1200x630 PNG", async () => {
    const first = generateSocialCardPng();
    const second = generateSocialCardPng();
    expect(first).toEqual(second);
    expect([...first.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    expect(view.getUint32(16)).toBe(SOCIAL_IMAGE_WIDTH);
    expect(view.getUint32(20)).toBe(SOCIAL_IMAGE_HEIGHT);
    expect(first.byteLength).toBeGreaterThan(10_000);

    const response = getSocialImage();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(SOCIAL_IMAGE_TYPE);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(
      Buffer.from(await response.arrayBuffer()).equals(Buffer.from(first)),
    ).toBe(true);
  });
});
