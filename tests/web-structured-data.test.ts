import { describe, expect, it } from "vitest";

import { serializeJsonLd } from "../web/src/lib/json-ld.ts";
import {
  ORGANIZATION_ID,
  SITE_NAME,
  absoluteSiteUrl,
  buildArticleJsonLd,
  buildDetailBreadcrumbJsonLd,
  sourceOrganizationUrl,
  type ArticleJsonLdInput,
} from "../web/src/lib/structured-data.ts";

const INPUT: ArticleJsonLdInput = {
  canonicalUrl: "https://techdb.studio344.net/e/a1f18e3cdc190979/",
  headline: "Gemini 3.7 Flash の要点",
  description: "AI 要約: Gemini 3.7 Flash の公開内容を整理します。",
  datePublished: "2026-08-20T09:00:00.000Z",
  inLanguage: "ja-JP",
  image: {
    url: "https://techdb.studio344.net/social/tech-dashboard-v1.png",
    caption: "TECH Dashboard のブランド画像",
    width: 1_200,
    height: 630,
  },
  articleSection: "モデル",
  keywords: "gemini, google",
  source: {
    url: "https://blog.google/products/gemini/flash/",
    title: "Introducing Gemini 3.7 Flash",
    publisherName: "Google Blog",
    datePublished: "2026-08-20T09:00:00.000Z",
  },
  breadcrumb: {
    laneName: "モデル",
    lanePath: "/c/models/",
    currentLabel: "Gemini 3.7 Flash の要点",
  },
};

interface ParsedListItem {
  position?: number;
  name?: string;
  item?: string;
}

interface ParsedArticle {
  "@type"?: string;
  headline?: string;
  url?: string;
  datePublished?: string;
  dateModified?: string;
  inLanguage?: string;
  image?: { url?: string; contentUrl?: string; width?: number; height?: number };
  author?: { "@id"?: string; name?: string; url?: string };
  publisher?: { "@id"?: string; name?: string };
  isBasedOn?: {
    url?: string;
    name?: string;
    datePublished?: string;
    publisher?: { name?: string; url?: string };
  };
  citation?: { "@id"?: string };
  mainEntityOfPage?: {
    "@id"?: string;
    breadcrumb?: { "@type"?: string; itemListElement?: ParsedListItem[] };
  };
}

function parsedArticle(): ParsedArticle {
  return JSON.parse(serializeJsonLd(buildArticleJsonLd(INPUT))) as ParsedArticle;
}

describe("detail article structured data", () => {
  it("credits this site as the author and the source only as the work it is based on", () => {
    const parsed = parsedArticle();

    expect(parsed["@type"]).toBe("Article");
    expect(serializeJsonLd(buildArticleJsonLd(INPUT))).not.toContain("NewsArticle");
    expect(parsed.author?.name).toBe(SITE_NAME);
    expect(parsed.author?.["@id"]).toBe(ORGANIZATION_ID);
    expect(parsed.author?.url).toBe("https://techdb.studio344.net/");
    expect(parsed.publisher?.["@id"]).toBe(ORGANIZATION_ID);
    expect(parsed.publisher?.name).toBe(SITE_NAME);
    expect(parsed.author?.name).not.toBe(INPUT.source.publisherName);

    expect(parsed.isBasedOn?.url).toBe(INPUT.source.url);
    expect(parsed.isBasedOn?.name).toBe(INPUT.source.title);
    expect(parsed.isBasedOn?.datePublished).toBe(INPUT.source.datePublished);
    expect(parsed.isBasedOn?.publisher?.name).toBe(INPUT.source.publisherName);
    expect(parsed.isBasedOn?.publisher?.url).toBe("https://blog.google/");
    expect(parsed.citation?.["@id"]).toBe(INPUT.source.url);
  });

  it("keeps headline, date, image and mainEntityOfPage intact and adds no dateModified", () => {
    const parsed = parsedArticle();

    expect(parsed.headline).toBe(INPUT.headline);
    expect(parsed.url).toBe(INPUT.canonicalUrl);
    expect(parsed.datePublished).toBe(INPUT.datePublished);
    expect(parsed.inLanguage).toBe("ja-JP");
    expect(parsed.image?.url).toBe(INPUT.image.url);
    expect(parsed.image?.contentUrl).toBe(INPUT.image.url);
    expect(parsed.image?.width).toBe(1_200);
    expect(parsed.image?.height).toBe(630);
    expect(parsed.mainEntityOfPage?.["@id"]).toBe(INPUT.canonicalUrl);
    expect(Object.keys(parsed)).not.toContain("dateModified");
  });

  it("omits image dimensions instead of emitting null when the source has none", () => {
    const parsed = JSON.parse(
      serializeJsonLd(
        buildArticleJsonLd({
          ...INPUT,
          image: { url: INPUT.image.url, caption: INPUT.image.caption },
        }),
      ),
    ) as ParsedArticle;

    expect(parsed.image?.url).toBe(INPUT.image.url);
    expect(Object.keys(parsed.image ?? {})).not.toContain("width");
    expect(Object.keys(parsed.image ?? {})).not.toContain("height");
  });

  it("nests one BreadcrumbList that mirrors Home / lane / current page", () => {
    const breadcrumb = parsedArticle().mainEntityOfPage?.breadcrumb;
    const items = breadcrumb?.itemListElement ?? [];

    expect(breadcrumb?.["@type"]).toBe("BreadcrumbList");
    expect(items.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(items.map((item) => item.name)).toEqual([
      "Home",
      INPUT.breadcrumb.laneName,
      INPUT.breadcrumb.currentLabel,
    ]);
    expect(items[0]?.item).toBe("https://techdb.studio344.net/");
    expect(items[1]?.item).toBe("https://techdb.studio344.net/c/models/");
    expect(Object.keys(items[2] ?? {})).not.toContain("item");
  });

  it("fails closed on unusable source and site URLs instead of guessing one", () => {
    expect(() => sourceOrganizationUrl("not a url")).toThrow(
      /source URL is not parseable/,
    );
    expect(() => sourceOrganizationUrl("javascript:alert(1)")).toThrow(
      /source URL must be http\(s\)/,
    );
    expect(() => absoluteSiteUrl("c/models/")).toThrow(/root-relative/);
    expect(() => absoluteSiteUrl("//evil.example.com/")).toThrow(/root-relative/);
    expect(() =>
      buildDetailBreadcrumbJsonLd({
        canonicalUrl: INPUT.canonicalUrl,
        laneName: "  ",
        lanePath: "/c/models/",
        currentLabel: INPUT.breadcrumb.currentLabel,
      }),
    ).toThrow(/breadcrumb labels must be non-empty/);
  });
});
