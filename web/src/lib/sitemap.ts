import {
  ALL_ENTRIES,
  CATEGORY_META,
  MAIN_TIMELINE_ENTRIES,
  PAGE_SIZE,
  STATIC_TAG_PAGE_TAGS,
  entriesFor,
  entriesForTagPage,
} from "./data.ts";
import {
  ARCHIVE_MONTHS,
  ARCHIVE_WARM_ENTRIES,
} from "./archive.ts";
import { collectIndexableDetailEntries } from "./detail-indexability.ts";
import {
  SITEMAP_STATIC_PATHS,
  archiveMonthPath,
  categoryPath,
  detailPath,
  paginationPageNumbers,
  tagPath,
  timelinePagePath,
} from "./route-inventory.ts";
import { SITE_URL } from "./site.ts";

export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50_000_000;
export { SITEMAP_STATIC_PATHS };

export interface SitemapDocument {
  xml: string;
  urls: readonly string[];
  urlCount: number;
  byteLength: number;
}

interface SitemapLimits {
  maxUrls?: number;
  maxBytes?: number;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function canonicalInternalUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Sitemap path must be root-relative: ${path}`);
  }

  const canonicalOrigin = new URL(SITE_URL).origin;
  const url = new URL(path, `${canonicalOrigin}/`);
  if (url.origin !== canonicalOrigin || url.search || url.hash) {
    throw new Error(`Sitemap URL must be canonical, internal, and query-free: ${path}`);
  }
  return url.href;
}

/**
 * Mirrors every Astro HTML route family that search crawlers should discover
 * AND index. Redirects, feeds, utility JSON, query URLs, cold/dropped article
 * details, and body-less summary-only details are intentionally absent.
 *
 * Summary-only details are still generated and reachable (getStaticPaths in
 * web/src/pages/e/[id].astro keeps using the addressability policy) so no
 * existing URL 404s; they ship `noindex, follow` instead of a sitemap entry.
 * See web/src/lib/detail-indexability.ts for the split, and
 * web/scripts/validate-sitemap-dist.mjs for the build-time guard that the two
 * decisions never drift apart.
 */
export function collectSitemapPaths(): string[] {
  const paths: string[] = [...SITEMAP_STATIC_PATHS];

  for (const page of paginationPageNumbers(MAIN_TIMELINE_ENTRIES.length, PAGE_SIZE)) {
    paths.push(timelinePagePath(page));
  }

  for (const category of CATEGORY_META) {
    paths.push(categoryPath(category.slug));
    for (const page of paginationPageNumbers(entriesFor(category.slug).length, PAGE_SIZE)) {
      paths.push(categoryPath(category.slug, page));
    }
  }

  for (const tag of STATIC_TAG_PAGE_TAGS) {
    paths.push(tagPath(tag));
    for (const page of paginationPageNumbers(entriesForTagPage(tag).length, PAGE_SIZE)) {
      paths.push(tagPath(tag, page));
    }
  }

  for (const month of ARCHIVE_MONTHS) {
    paths.push(archiveMonthPath(month));
  }

  for (const entry of collectIndexableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES)) {
    paths.push(detailPath(entry.id));
  }

  return paths;
}

/**
 * Serializes one uncompressed sitemap and fails before publishing if either
 * protocol ceiling would be exceeded. `lastmod` is deliberately omitted:
 * source publication time is not the same as a route's modification time.
 */
export function serializeSitemap(
  paths: readonly string[],
  limits: SitemapLimits = {},
): SitemapDocument {
  const maxUrls = limits.maxUrls ?? SITEMAP_MAX_URLS;
  const maxBytes = limits.maxBytes ?? SITEMAP_MAX_BYTES;
  if (!Number.isInteger(maxUrls) || maxUrls < 1) {
    throw new Error(`Invalid sitemap URL limit: ${maxUrls}`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`Invalid sitemap byte limit: ${maxBytes}`);
  }

  const urls: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const url = canonicalInternalUrl(path);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length > maxUrls) {
      throw new Error(`Sitemap URL limit exceeded: ${urls.length} > ${maxUrls}`);
    }
  }

  const entries = urls.map((url) => `  <url><loc>${xmlEscape(url)}</loc></url>`).join("\n");
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    "</urlset>",
    "",
  ].join("\n");
  const byteLength = new TextEncoder().encode(xml).byteLength;
  if (byteLength > maxBytes) {
    throw new Error(`Sitemap byte limit exceeded: ${byteLength} > ${maxBytes}`);
  }

  return Object.freeze({
    xml,
    urls: Object.freeze(urls),
    urlCount: urls.length,
    byteLength,
  });
}

export const SITEMAP_DOCUMENT = serializeSitemap(collectSitemapPaths());
