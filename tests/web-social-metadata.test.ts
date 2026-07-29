import { describe, expect, it } from "vitest";

import {
  ALL_ENTRIES,
  CATEGORY_META,
  summaryForLangWithFallback,
  titleForLang,
  titleForLangWithFallback,
} from "../web/src/lib/data.ts";
import {
  SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
  boundedSocialDescription,
} from "../web/src/lib/bounded-description.ts";
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
  localizedPendingArticleMetadataDescription,
  localizedPendingArticleMetadataTitle,
} from "../web/src/lib/social-metadata.ts";
import {
  GET as getSocialImage,
  generateSocialCardPng,
} from "../web/src/pages/social/tech-dashboard-v1.png.ts";

describe("localized social metadata", () => {
  it("keeps complete sentences inside the social description budget", () => {
    const productionSummary =
      "Diffusion language models generate multiple tokens in parallel rather than one at a time, achieving up to 2.42× faster inference than autoregressive LLMs. This architectural shift could significantly improve the practicality of locally-run language models.";
    const completeFirstSentence =
      "Diffusion language models generate multiple tokens in parallel rather than one at a time, achieving up to 2.42× faster inference than autoregressive LLMs.";
    expect(boundedSocialDescription(productionSummary, "en")).toBe(completeFirstSentence);
    expect(boundedSocialDescription(productionSummary, "en")).not.toContain("This ");
    expect(
      localizedArticleMetadataDescription({
        summary: productionSummary,
        lang: "en",
        sourceLabel: "Zenn AI",
        categoryLabel: "Local Models",
      }),
    ).toBe(completeFirstSentence);

    const japaneseFirstSentence = "日本語の最初の文は、160文字以内で完結しています。";
    const japaneseSummary =
      `${japaneseFirstSentence}${"次の説明は文末までが長く、境界内には収まりません".repeat(8)}。`;
    expect(boundedSocialDescription(japaneseSummary, "ja")).toBe(japaneseFirstSentence);

    const first = "The first sentence explains the change.";
    const second = " The second sentence records the user-visible result.";
    const third = ` ${"A final sentence contains additional context ".repeat(5)}.`;
    expect(boundedSocialDescription(`${first}${second}${third}`, "en")).toBe(
      `${first}${second}`,
    );
  });

  it("coalesces identifier, initialism, and abbreviation fragments", () => {
    const longTail = ` ${"This later sentence contains additional context ".repeat(5)}.`;
    const fixtures = [
      "Semantic Kernel for .NET developers improves agent orchestration.",
      "The U.S. SEC published guidance for AI model governance.",
      "Policies from the U.S. Department improve AI procurement.",
      "Dr. Smith published guidance for AI model governance.",
    ];
    for (const expected of fixtures) {
      expect(boundedSocialDescription(`${expected}${longTail}`, "en")).toBe(expected);
    }

    const decimalSentence = "Version 2.42 improves inference throughput.";
    const genuineSentence = "The API is stable.";
    const initialismEnding = "The company operates in the U.S.";
    const properNounTail =
      ` Microsoft announced ${"additional product context ".repeat(8)}.`;
    expect(boundedSocialDescription(`${decimalSentence}${longTail}`, "en")).toBe(
      decimalSentence,
    );
    expect(boundedSocialDescription(`${genuineSentence}${longTail}`, "en")).toBe(
      genuineSentence,
    );
    expect(boundedSocialDescription(`${initialismEnding}${longTail}`, "en")).toBe(
      initialismEnding,
    );
    expect(boundedSocialDescription(`${initialismEnding}${properNounTail}`, "en")).toBe(
      initialismEnding,
    );
  });

  it("falls back to safe word, grapheme, and entity boundaries", () => {
    const noSentenceBoundary = Array.from(
      { length: 40 },
      (_, index) => `metadata${index}`,
    ).join(" ");
    const wordBounded = boundedSocialDescription(noSentenceBoundary, "en");
    const wordPrefix = wordBounded.slice(0, -1);
    expect(wordBounded.endsWith("…")).toBe(true);
    expect(Array.from(wordBounded).length).toBeLessThanOrEqual(
      SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
    );
    expect(noSentenceBoundary.startsWith(wordPrefix)).toBe(true);
    expect(noSentenceBoundary[wordPrefix.length]).toBe(" ");

    const combiningWord = "Cafe\u0301";
    const emoji = "👩🏽‍💻";
    const unicodeInput = `${`${combiningWord} ${emoji} `.repeat(24)}without punctuation`;
    const unicodeBounded = boundedSocialDescription(unicodeInput, "en");
    expect(unicodeBounded.endsWith("…")).toBe(true);
    expect(Array.from(unicodeBounded).length).toBeLessThanOrEqual(
      SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
    );
    const unicodePrefix = unicodeBounded.slice(0, -1);
    expect(
      unicodePrefix.endsWith(combiningWord) || unicodePrefix.endsWith(emoji),
    ).toBe(true);

    const entityInput = `${"safe ".repeat(31)}&amp; continuation without punctuation`;
    const entityBounded = boundedSocialDescription(entityInput, "en");
    expect(entityBounded).toBe(`${"safe ".repeat(30)}safe…`);
    expect(entityBounded).not.toMatch(/&(?:#x?[\da-f]*|[a-z]*)…$/iu);

    expect(boundedSocialDescription("x".repeat(200), "en")).toBe("…");
  });

  it("preserves exact-boundary and already-short descriptions", () => {
    const exactBoundary = "界".repeat(SOCIAL_DESCRIPTION_CHARACTER_LIMIT);
    const shortDescription = "Short metadata without terminal punctuation";
    expect(boundedSocialDescription(exactBoundary, "ja")).toBe(exactBoundary);
    expect(boundedSocialDescription(shortDescription, "en")).toBe(shortDescription);
  });

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

  it("keeps pending metadata source-grounded and explicit about the missing summary", () => {
    const common = {
      sourceLabel: "GitHub Changelog",
      categoryLabel: "Industry & Policy",
      publishedAt: "2026-07-28T22:50:05.000Z",
      sourceUrl:
        "https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata",
    };
    const sourceTitle = "npm publish-time malware scanning and dual-use metadata";
    const japaneseSourceTitle = "AI エージェント開発の実践ガイド";
    const longSourceTitle =
      "GitHub Copilot app usage metrics now expand across report rollups";

    expect(
      localizedPendingArticleMetadataTitle({
        ...common,
        title: sourceTitle,
        lang: "ja",
      }),
    ).toBe(
      "npm publish-time malware scanning and dual-use metadata | GitHub Changelog | 2026-07-28 22:50 UTC",
    );
    expect(
      localizedPendingArticleMetadataTitle({
        ...common,
        title: japaneseSourceTitle,
        lang: "en",
      }),
    ).toBe(
      "AI エージェント開発の実践ガイド | GitHub Changelog | 2026-07-28 22:50 UTC",
    );
    expect(
      localizedPendingArticleMetadataTitle({
        ...common,
        title: longSourceTitle,
        lang: "en",
      }),
    ).toContain(longSourceTitle);

    const descriptionJa = localizedPendingArticleMetadataDescription({
      title: sourceTitle,
      lang: "ja",
      sourceLabel: common.sourceLabel,
      categoryLabel: common.categoryLabel,
    });
    const descriptionEn = localizedPendingArticleMetadataDescription({
      title: sourceTitle,
      lang: "en",
      sourceLabel: common.sourceLabel,
      categoryLabel: common.categoryLabel,
    });

    expect(descriptionJa).toBe(
      "AI 要約は準備中です。「npm publish-time malware scanning and dual-use metadata」はGitHub Changelogが公開したIndustry & Policyの記事です。",
    );
    expect(descriptionEn).toBe(
      'AI summary pending. "npm publish-time malware scanning and dual-use metadata" comes from GitHub Changelog in Industry & Policy.',
    );
    expect(`${descriptionJa} ${descriptionEn}`).not.toMatch(
      /generated summary|生成済み|近日中/,
    );
    expect(Array.from(descriptionJa).length).toBeLessThanOrEqual(
      SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
    );
    expect(Array.from(descriptionEn).length).toBeLessThanOrEqual(
      SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
    );

    const longTitle =
      "A very long source-grounded article title about secure AI agent evaluation, deployment, governance, and observability";
    const longDescriptionEn = localizedPendingArticleMetadataDescription({
      title: longTitle,
      lang: "en",
      sourceLabel: common.sourceLabel,
      categoryLabel: common.categoryLabel,
    });
    expect(longDescriptionEn).toContain("AI summary pending.");
    expect(longDescriptionEn).toContain(Array.from(longTitle).slice(0, 32).join(""));
    expect(longDescriptionEn).toContain(common.sourceLabel);
    expect(longDescriptionEn).toContain(common.categoryLabel);
    expect(Array.from(longDescriptionEn).length).toBeLessThanOrEqual(
      SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
    );

    const longJapaneseTitle =
      "大規模なAIエージェント運用における安全な評価と監視とガバナンスの実践的な設計指針".repeat(3);
    const longDescriptionJa = localizedPendingArticleMetadataDescription({
      title: longJapaneseTitle,
      lang: "ja",
      sourceLabel: common.sourceLabel,
      categoryLabel: common.categoryLabel,
    });
    expect(longDescriptionJa).toContain("AI 要約は準備中です");
    expect(longDescriptionJa).toContain(
      Array.from(longJapaneseTitle).slice(0, 32).join(""),
    );
    expect(longDescriptionJa).toContain(common.sourceLabel);
    expect(longDescriptionJa).toContain(common.categoryLabel);
    expect(Array.from(longDescriptionJa).length).toBeLessThanOrEqual(
      SOCIAL_DESCRIPTION_CHARACTER_LIMIT,
    );

    const consonantCategoryDescription = localizedPendingArticleMetadataDescription({
      title: sourceTitle,
      lang: "en",
      sourceLabel: "GitHub Blog",
      categoryLabel: "GitHub Copilot",
    });
    expect(consonantCategoryDescription).not.toContain("an GitHub Copilot article");
  });

  it("matches ready and pending title metadata branches across the current corpus", () => {
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
      const summaryAbsent = !summaryForLangWithFallback(entry, "ja").text
        && !summaryForLangWithFallback(entry, "en").text;
      const jaDisplayTitle = titleForLangWithFallback(entry, "ja").text;
      const enDisplayTitle = titleForLangWithFallback(entry, "en").text;
      const titleBuilder = summaryAbsent
        ? localizedPendingArticleMetadataTitle
        : localizedArticleMetadataTitle;
      const jaTitle = titleBuilder({
        ...common,
        title: summaryAbsent ? jaDisplayTitle : titleForLang(entry, "ja"),
        lang: "ja",
      });
      const enTitle = titleBuilder({
        ...common,
        title: summaryAbsent ? enDisplayTitle : titleForLang(entry, "en"),
        lang: "en",
      });

      if (summaryAbsent) {
        const sourcePrefix = Array.from(common.sourceLabel).slice(0, 19).join("");
        expect(jaTitle).toContain(jaDisplayTitle);
        expect(enTitle).toContain(enDisplayTitle);
        expect(jaTitle).toContain(sourcePrefix);
        expect(enTitle).toContain(sourcePrefix);
      } else {
        expect(enTitle).not.toMatch(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
        );
        expect(Array.from(jaTitle).length).toBeLessThanOrEqual(120);
        expect(Array.from(enTitle).length).toBeLessThanOrEqual(120);
      }
      expect(`${jaTitle} ${enTitle}`).not.toMatch(
        /AI 要約は準備中|AI summary pending|近日中/,
      );
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
