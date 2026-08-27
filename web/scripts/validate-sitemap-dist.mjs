import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "parse5";

const REDIRECT_MARKERS = [
  /<meta[^>]+http-equiv=["']refresh["']/i,
  /window\.location\.replace\(/,
];

/**
 * The only generated routes allowed to carry a `noindex` robots directive.
 * A noindex route is exempt from the sitemap-parity requirement, so without an
 * explicit allowlist any page that accidentally went noindex would silently
 * disappear from the sitemap instead of failing the build. Mirrors
 * `NOINDEX_PATHS` in web/src/lib/route-inventory.ts (a standalone .mjs cannot
 * import that TypeScript module); tests/web-sitemap.test.ts pins them together.
 * `/sample/article/` is listed for intent even though it is classified as a
 * redirect before the noindex check ever runs.
 */
export const EXPECTED_NOINDEX_PATHS = [
  "/sample/article/",
  "/search/",
];

/**
 * Detail routes are the one family whose indexability is decided by DATA, not
 * by a fixed route list: `/e/<id>/` carries `noindex` exactly when the entry
 * has no real, source-grounded body (web/src/lib/detail-indexability.ts), so
 * the set changes on every publisher run and cannot be enumerated here.
 *
 * Exempting them from the allowlist does not weaken the guard. Their
 * correctness is still enforced in both directions by the sitemap-parity gates
 * above - a noindex detail route in the sitemap fails, and an indexable detail
 * route missing from it fails - and by the unit tests that pin
 * `sitemap membership <-> robots directive` against the same predicate.
 */
const DATA_DRIVEN_NOINDEX_ROUTE_RE = /^\/e\/[^/]+\/$/;

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

// Google treats `none` as `noindex, nofollow`, so both directives exempt a
// route from the sitemap. Word-bounded on whitespace/commas so `index, follow`
// never matches.
const ROBOTS_NOINDEX_DIRECTIVE_RE = /(?:^|[\s,])(?:noindex|none)(?:[\s,]|$)/i;

function attributeValue(node, name) {
  if (!Array.isArray(node.attrs)) return null;
  return node.attrs.find((attribute) => attribute.name === name)?.value ?? null;
}

/**
 * One parse5 pass per document. Returns every href (HTML and foreign/SVG), the
 * document's canonical link, whether it declares a robots `noindex`/`none`
 * directive, and whether it carries a robots meta with no `content` attribute
 * at all.
 *
 * Every signal is read from the parsed tree, never from raw HTML, so
 * commented-out or script-embedded markup cannot be mistaken for a real meta
 * tag - the same property the href scan already relies on.
 */
function documentSignals(html) {
  const hrefs = [];
  const robotsDirectives = [];
  let robotsWithoutContent = false;
  let canonicalHref = null;
  const stack = [parse(html)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node.attrs)) {
      const isMeta = node.nodeName === "meta";
      let isRobotsMeta = false;
      let robotsContent = null;
      for (const attribute of node.attrs) {
        // parse5 normalizes HTML names and also exposes foreign/namespaced attrs
        // through this shape. Both HTML/SVG href attributes carry name="href".
        if (attribute.name === "href") hrefs.push(attribute.value);
        if (!isMeta) continue;
        if (
          attribute.name === "name"
          && attribute.value.trim().toLowerCase() === "robots"
        ) {
          isRobotsMeta = true;
        }
        if (attribute.name === "content") robotsContent = attribute.value;
      }
      if (isRobotsMeta) {
        if (robotsContent === null) robotsWithoutContent = true;
        else robotsDirectives.push(robotsContent);
      }
      // First canonical wins, mirroring how crawlers resolve duplicates. An
      // empty href is captured as "" (not null) so the caller can tell
      // "declared but empty" from "never declared" - `new URL("", base)`
      // equals base, which would otherwise pass a self-reference check.
      if (
        node.nodeName === "link"
        && canonicalHref === null
        && attributeValue(node, "rel")?.trim().toLowerCase() === "canonical"
      ) {
        canonicalHref = attributeValue(node, "href") ?? "";
      }
    }
    if (Array.isArray(node.childNodes)) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]);
      }
    }
  }
  return {
    hrefs,
    canonicalHref,
    noindex: robotsDirectives.some((value) => ROBOTS_NOINDEX_DIRECTIVE_RE.test(value)),
    robotsWithoutContent,
  };
}

function normalizedInternalDetailPath(href, documentUrl) {
  let url;
  try {
    url = new URL(href, documentUrl);
  } catch {
    return null;
  }
  if (url.origin !== documentUrl.origin) return null;
  const match = /^\/e\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) return null;
  try {
    return `/e/${encodeURIComponent(decodeURIComponent(match[1]))}/`;
  } catch {
    return `${url.pathname.replace(/\/?$/, "/")}`;
  }
}

export function validateSitemapDist({
  distDirectory,
  expectedNoindexPaths = EXPECTED_NOINDEX_PATHS,
}) {
  const allowedNoindex = new Set(expectedNoindexPaths);
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

  const canonicalHtmlPaths = new Set();
  const noindexPaths = new Set();
  const malformedRobotsPaths = new Set();
  const redirectPaths = new Set();
  const internalDetailLinks = [];
  const missingCanonical = [];
  const nonSelfCanonical = [];

  for (const filePath of htmlFiles(distDirectory)) {
    const route = routeForHtml(distDirectory, filePath);
    if (!route) continue;
    const html = readFileSync(filePath, "utf8");
    const isRedirect = REDIRECT_MARKERS.some((marker) => marker.test(html));
    (isRedirect ? redirectPaths : canonicalHtmlPaths).add(route);
    if (isRedirect) continue;
    const { hrefs, canonicalHref, noindex, robotsWithoutContent } = documentSignals(html);
    if (noindex) noindexPaths.add(route);
    if (robotsWithoutContent) malformedRobotsPaths.add(route);
    const documentUrl = new URL(route, `${canonicalOrigin}/`);
    // Every route we ask crawlers to index owes a self-referential canonical.
    // A noindex route is exempt: it is telling crawlers to ignore it anyway.
    if (!noindex) {
      if (canonicalHref === null || canonicalHref.trim() === "") {
        // An empty href resolves to the document itself, so it would pass a
        // naive self-reference comparison. Treat it as absent instead.
        missingCanonical.push(route);
      } else {
        let resolvedCanonical = null;
        try {
          resolvedCanonical = new URL(canonicalHref, documentUrl).href;
        } catch {
          resolvedCanonical = null;
        }
        if (resolvedCanonical !== documentUrl.href) {
          nonSelfCanonical.push(`${route} -> ${canonicalHref}`);
        }
      }
    }
    for (const href of hrefs) {
      const detailPath = normalizedInternalDetailPath(href, documentUrl);
      if (detailPath) internalDetailLinks.push({ route, detailPath });
    }
  }

  const missingHtml = [...sitemapPaths].filter((route) => !canonicalHtmlPaths.has(route));
  // A canonical route may leave the sitemap only by declaring `noindex`: the
  // page stays reachable for readers and inbound links while crawlers are told
  // not to index it (web/src/lib/detail-indexability.ts). Dropping a route from
  // the sitemap without that declaration is still a build failure, and so is
  // advertising a `noindex` route in the sitemap, so the two decisions cannot
  // drift apart silently in either direction.
  const missingSitemap = [...canonicalHtmlPaths].filter(
    (route) => !sitemapPaths.has(route) && !noindexPaths.has(route),
  );
  const noindexInSitemap = [...noindexPaths].filter((route) => sitemapPaths.has(route));
  const undeclaredNoindex = [...noindexPaths].filter(
    (route) => !allowedNoindex.has(route) && !DATA_DRIVEN_NOINDEX_ROUTE_RE.test(route),
  );
  const redirectInSitemap = [...redirectPaths].filter((route) => sitemapPaths.has(route));
  const invalidInternalDetailLinks = internalDetailLinks
    .filter(({ detailPath }) => !canonicalHtmlPaths.has(detailPath))
    .map(({ route, detailPath }) => `${route} -> ${detailPath}`);
  const failures = [];
  if (malformedRobotsPaths.size > 0) {
    // Reported first: an unreadable robots meta invalidates the indexability
    // classification of that route, so the sitemap findings below cannot be
    // trusted until it is fixed.
    failures.push(
      `robots meta without a content attribute: ${[...malformedRobotsPaths].slice(0, 10).join(", ")}`,
    );
  }
  if (missingHtml.length > 0) {
    failures.push(`sitemap URLs without canonical HTML: ${missingHtml.slice(0, 10).join(", ")}`);
  }
  if (missingSitemap.length > 0) {
    failures.push(
      `indexable canonical HTML absent from sitemap: ${missingSitemap.slice(0, 10).join(", ")}`,
    );
  }
  if (noindexInSitemap.length > 0) {
    failures.push(`noindex routes advertised in sitemap: ${noindexInSitemap.slice(0, 10).join(", ")}`);
  }
  if (redirectInSitemap.length > 0) {
    failures.push(`redirect-only URLs in sitemap: ${redirectInSitemap.slice(0, 10).join(", ")}`);
  }
  if (undeclaredNoindex.length > 0) {
    // Without this gate a route could quietly leave the sitemap just by
    // growing a noindex directive, and the parity check above would approve
    // it. Every intentional noindex route is named in EXPECTED_NOINDEX_PATHS.
    failures.push(
      `undeclared noindex routes (add them to EXPECTED_NOINDEX_PATHS or remove the directive): ${undeclaredNoindex.slice(0, 10).join(", ")}`,
    );
  }
  if (missingCanonical.length > 0) {
    failures.push(
      `indexable HTML without a canonical link: ${missingCanonical.slice(0, 10).join(", ")}`,
    );
  }
  if (nonSelfCanonical.length > 0) {
    failures.push(
      `indexable HTML with a non-self-referential canonical: ${nonSelfCanonical.slice(0, 10).join(", ")}`,
    );
  }
  if (invalidInternalDetailLinks.length > 0) {
    failures.push(
      `internal detail links without generated canonical routes: ${invalidInternalDetailLinks.slice(0, 10).join(", ")}`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`Built crawl parity validation failed:\n- ${failures.join("\n- ")}`);
  }

  return {
    sitemapUrlCount: sitemapPaths.size,
    sitemapByteLength,
    canonicalHtmlCount: canonicalHtmlPaths.size,
    noindexHtmlCount: noindexPaths.size,
    redirectCount: redirectPaths.size,
    internalDetailLinkCount: internalDetailLinks.length,
    invalidInternalDetailLinkCount: invalidInternalDetailLinks.length,
  };
}
