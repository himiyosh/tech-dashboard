import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REDIRECT_MARKERS = [
  /<meta[^>]+http-equiv=["']refresh["']/i,
  /window\.location\.replace\(/,
];

function decodeXml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function routeForHtml(distDirectory, filePath) {
  const relative = path.relative(distDirectory, filePath).split(path.sep).join("/");
  if (relative === "index.html") return "/";
  if (!relative.endsWith("/index.html")) return null;
  return `/${relative.slice(0, -"index.html".length)}`;
}

function htmlFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name === "index.html") {
        files.push(absolute);
      }
    }
  };
  walk(root);
  return files;
}

export function validateSitemapDist({
  distDirectory,
  indexPath,
}) {
  const sitemapPath = path.join(distDirectory, "sitemap.xml");
  const sitemapXml = readFileSync(sitemapPath, "utf8");
  const sitemapByteLength = statSync(sitemapPath).size;
  const sitemapUrls = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => new URL(decodeXml(match[1])));
  if (sitemapUrls.length === 0) {
    throw new Error("Generated sitemap contains no URLs");
  }

  const canonicalOrigin = sitemapUrls[0].origin;
  const sitemapPaths = new Set();
  for (const url of sitemapUrls) {
    if (url.origin !== canonicalOrigin || url.search || url.hash) {
      throw new Error(`Non-canonical sitemap URL: ${url.href}`);
    }
    if (sitemapPaths.has(url.pathname)) {
      throw new Error(`Duplicate sitemap path: ${url.pathname}`);
    }
    sitemapPaths.add(url.pathname);
  }

  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const nonAddressableIds = new Set(
    index.entries
      .filter((entry) => entry.archiveTier === "cold" || entry.archiveTier === "dropped")
      .map((entry) => entry.id),
  );
  const canonicalHtmlPaths = new Set();
  const redirectPaths = new Set();
  const coldInboundLinks = [];

  for (const filePath of htmlFiles(distDirectory)) {
    const route = routeForHtml(distDirectory, filePath);
    if (!route) continue;
    const html = readFileSync(filePath, "utf8");
    const isRedirect = REDIRECT_MARKERS.some((marker) => marker.test(html));
    (isRedirect ? redirectPaths : canonicalHtmlPaths).add(route);

    for (const match of html.matchAll(/href=["'](?:https?:\/\/[^/"']+)?\/e\/([^/"'#?]+)\/["']/g)) {
      const id = decodeURIComponent(match[1]);
      if (nonAddressableIds.has(id)) {
        coldInboundLinks.push(`${route} -> /e/${id}/`);
      }
    }
  }

  const missingHtml = [...sitemapPaths].filter((route) => !canonicalHtmlPaths.has(route));
  const missingSitemap = [...canonicalHtmlPaths].filter((route) => !sitemapPaths.has(route));
  const redirectInSitemap = [...redirectPaths].filter((route) => sitemapPaths.has(route));
  const failures = [];
  if (missingHtml.length > 0) {
    failures.push(`sitemap URLs without canonical HTML: ${missingHtml.slice(0, 10).join(", ")}`);
  }
  if (missingSitemap.length > 0) {
    failures.push(`canonical HTML absent from sitemap: ${missingSitemap.slice(0, 10).join(", ")}`);
  }
  if (redirectInSitemap.length > 0) {
    failures.push(`redirect-only URLs in sitemap: ${redirectInSitemap.slice(0, 10).join(", ")}`);
  }
  if (coldInboundLinks.length > 0) {
    failures.push(`cold/dropped internal detail links: ${coldInboundLinks.slice(0, 10).join(", ")}`);
  }
  if (failures.length > 0) {
    throw new Error(`Built crawl parity validation failed:\n- ${failures.join("\n- ")}`);
  }

  return {
    sitemapUrlCount: sitemapPaths.size,
    sitemapByteLength,
    canonicalHtmlCount: canonicalHtmlPaths.size,
    redirectCount: redirectPaths.size,
    coldInboundLinkCount: coldInboundLinks.length,
  };
}
