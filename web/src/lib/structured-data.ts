import type { JsonLdValue } from "./json-ld.ts";
import { PUBLIC_OPERATOR_NAME, REPO_URL, SITE_URL } from "./site.ts";
import {
  SOCIAL_IMAGE_HEIGHT,
  SOCIAL_IMAGE_URL,
  SOCIAL_IMAGE_WIDTH,
} from "./social-metadata.ts";

export type JsonLdObject = { [key: string]: JsonLdValue };

const CANONICAL_ORIGIN = new URL(SITE_URL).origin;

/** Brand name used for every first-party Organization node. */
export const SITE_NAME = "TECH Dashboard";
export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const EDITORIAL_POLICY_URL = `${SITE_URL}/editorial-policy/`;

/**
 * The single first-party publisher node.
 *
 * Detail pages carry commentary this site generated from a source's summary
 * and collection metadata (see the visible disclosure in e/[id].astro), so the
 * site - not the source organization - is the author and the publisher of that
 * text. The source is credited separately through `isBasedOn` / `citation`.
 */
export const SITE_ORGANIZATION: JsonLdObject = {
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  logo: {
    "@type": "ImageObject",
    url: SOCIAL_IMAGE_URL,
    contentUrl: SOCIAL_IMAGE_URL,
    width: SOCIAL_IMAGE_WIDTH,
    height: SOCIAL_IMAGE_HEIGHT,
  },
  parentOrganization: {
    "@type": "Organization",
    name: PUBLIC_OPERATOR_NAME,
  },
  publishingPrinciples: EDITORIAL_POLICY_URL,
  sameAs: [REPO_URL],
};

/**
 * Absolute canonical URL for a root-relative internal path. Fails loudly
 * instead of emitting a relative or off-origin URL into structured data.
 */
export function absoluteSiteUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`structured-data: site path must be root-relative: ${path}`);
  }
  const url = new URL(path, `${CANONICAL_ORIGIN}/`);
  if (url.origin !== CANONICAL_ORIGIN) {
    throw new Error(
      `structured-data: site path must stay on the canonical origin: ${path}`,
    );
  }
  return url.href;
}

/**
 * Origin of a source article URL, used as the source Organization's `url`.
 * tests/data-schema.test.ts already proves every entry URL parses, so an
 * unparseable URL here is a real data regression and must fail the build with
 * evidence rather than silently dropping the attribution.
 */
export function sourceOrganizationUrl(sourceUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error(`structured-data: source URL is not parseable: ${sourceUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`structured-data: source URL must be http(s): ${sourceUrl}`);
  }
  return `${parsed.origin}/`;
}

export interface DetailBreadcrumbInput {
  canonicalUrl: string;
  laneName: string;
  lanePath: string;
  currentLabel: string;
}

/**
 * Mirrors the visible crumb bar rendered by Portal.astro:332-343
 * (Home > lane > current title). The final item intentionally carries no
 * `item`: it is the page the reader is already on.
 */
export function buildDetailBreadcrumbJsonLd(
  input: DetailBreadcrumbInput,
): JsonLdObject {
  if (!input.laneName.trim() || !input.currentLabel.trim()) {
    throw new Error(
      `structured-data: breadcrumb labels must be non-empty for ${input.canonicalUrl}`,
    );
  }
  return {
    "@type": "BreadcrumbList",
    "@id": `${input.canonicalUrl}#breadcrumb`,
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: absoluteSiteUrl("/"),
      },
      {
        "@type": "ListItem",
        position: 2,
        name: input.laneName,
        item: absoluteSiteUrl(input.lanePath),
      },
      {
        "@type": "ListItem",
        position: 3,
        name: input.currentLabel,
      },
    ],
  };
}

export interface ArticleJsonLdInput {
  canonicalUrl: string;
  headline: string;
  description: string;
  /** Publication timestamp of the source announcement this page comments on. */
  datePublished: string;
  inLanguage: "ja-JP" | "en";
  image: {
    url: string;
    caption: string;
    width?: number;
    height?: number;
  };
  articleSection: string;
  keywords: string;
  source: {
    url: string;
    title: string;
    publisherName: string;
    datePublished: string;
  };
  breadcrumb: {
    laneName: string;
    lanePath: string;
    currentLabel: string;
  };
}

/**
 * `Article`, not `NewsArticle`: these pages are AI-written commentary derived
 * from a source summary plus collection metadata, not original news reporting,
 * and the page itself says so. `Article` is NewsArticle's supertype, so every
 * property consumers read (headline, image, datePublished, author, publisher,
 * mainEntityOfPage) stays valid.
 */
export function buildArticleJsonLd(input: ArticleJsonLdInput): JsonLdObject {
  const image: JsonLdObject = {
    "@type": "ImageObject",
    url: input.image.url,
    contentUrl: input.image.url,
    caption: input.image.caption,
  };
  if (typeof input.image.width === "number") {
    image.width = input.image.width;
  }
  if (typeof input.image.height === "number") {
    image.height = input.image.height;
  }

  const sourceWork: JsonLdObject = {
    "@type": "CreativeWork",
    "@id": input.source.url,
    url: input.source.url,
    datePublished: input.source.datePublished,
    publisher: {
      "@type": "Organization",
      name: input.source.publisherName,
      url: sourceOrganizationUrl(input.source.url),
    },
  };
  const sourceTitle = input.source.title.trim();
  if (sourceTitle) {
    sourceWork.name = sourceTitle;
  }

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.headline,
    description: input.description,
    url: input.canonicalUrl,
    datePublished: input.datePublished,
    inLanguage: input.inLanguage,
    image,
    author: SITE_ORGANIZATION,
    publisher: SITE_ORGANIZATION,
    isBasedOn: sourceWork,
    citation: { "@id": input.source.url },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": input.canonicalUrl,
      breadcrumb: buildDetailBreadcrumbJsonLd({
        canonicalUrl: input.canonicalUrl,
        ...input.breadcrumb,
      }),
    },
    articleSection: input.articleSection,
    keywords: input.keywords,
  };
}
