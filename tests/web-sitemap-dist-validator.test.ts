import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSitemapDist } from "../web/scripts/validate-sitemap-dist.mjs";

const ORIGIN = "https://example.test";

function writeRoute(dist: string, route: string, html: string): void {
  const directory = route === "/"
    ? dist
    : path.join(dist, route.replace(/^\/|\/$/g, ""));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "index.html"), html);
}

function writeSitemap(dist: string, routes: string[]): void {
  const urls = routes
    .map((route) => `  <url><loc>${new URL(route, `${ORIGIN}/`).href}</loc></url>`)
    .join("\n");
  writeFileSync(
    path.join(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${urls}</urlset>\n`,
  );
}

describe("built sitemap detail-link invariant", () => {
  it.each([
    {
      name: "quoted nested parent-relative href",
      sourceRoute: "/nested/deep/",
      html: '<a href="../../e/valid/">Parent relative</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "unquoted nested parent-relative href",
      sourceRoute: "/nested/deep/",
      html: "<a href=../../e/valid/>Unquoted parent relative</a>",
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "nested dot-relative href",
      sourceRoute: "/e/",
      html: '<a href="./valid/">Dot relative</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "decimal numeric character references",
      sourceRoute: "/nested/deep/",
      html: '<a href="&#47;e&#47;valid&#47;">Decimal entities</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "hex numeric character references",
      sourceRoute: "/nested/deep/",
      html: '<a href="&#x2f;e&#x2F;valid&#x2f;">Hex entities</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "named character references",
      sourceRoute: "/nested/deep/",
      html: '<a href="&sol;e&sol;valid&sol;">Named entities</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "root-relative href",
      sourceRoute: "/nested/deep/",
      html: '<a href="/e/valid/">Root relative</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "absolute same-origin href",
      sourceRoute: "/nested/deep/",
      html: '<a href="https://example.test/e/valid/">Absolute</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "same-origin and external protocol-relative hrefs",
      sourceRoute: "/nested/deep/",
      html: [
        '<a href="//example.test/e/valid/">Same-origin protocol-relative</a>',
        '<a href="//external.test/e/missing/">External protocol-relative</a>',
      ].join(""),
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "query/hash-only and external hrefs",
      sourceRoute: "/nested/deep/",
      html: [
        '<a href="?view=compact">Query only</a>',
        '<a href="#summary">Hash only</a>',
        '<a href="https://external.test/e/not-internal/">External</a>',
      ].join(""),
      detailRoute: null,
      expectedDetailLinks: 0,
    },
    {
      name: "script style and comment fake href text",
      sourceRoute: "/nested/deep/",
      html: [
        `<script>const fake = 'href="/e/script-missing/"';</script>`,
        `<style>/* href="/e/style-missing/" */</style>`,
        `<!-- <a href="/e/comment-missing/">Comment fake</a> -->`,
      ].join(""),
      detailRoute: null,
      expectedDetailLinks: 0,
    },
    {
      name: "malformed but browser-recoverable markup",
      sourceRoute: "/nested/deep/",
      html: '<main><a href="/e/valid/"><strong>Recovered</main>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "foreign SVG href attribute",
      sourceRoute: "/nested/deep/",
      html: '<svg><a href="/e/valid/"><text>SVG link</text></a></svg>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "namespaced foreign xlink href attribute",
      sourceRoute: "/nested/deep/",
      html: '<svg><a xlink:href="/e/valid/"><text>Legacy SVG link</text></a></svg>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
    {
      name: "HTML-escaped href",
      sourceRoute: "/nested/deep/",
      html: '<a href="../../e/valid/?a=1&amp;b=2#fragment">Escaped query</a>',
      detailRoute: "/e/valid/",
      expectedDetailLinks: 1,
    },
  ])("accepts $name using the containing canonical route as its base", ({
    sourceRoute,
    html,
    detailRoute,
    expectedDetailLinks,
  }) => {
    const dist = mkdtempSync(path.join(tmpdir(), "techdb-sitemap-validator-"));
    const routes = detailRoute ? [sourceRoute, detailRoute] : [sourceRoute];
    try {
      writeSitemap(dist, routes);
      writeRoute(dist, sourceRoute, html);
      if (detailRoute) writeRoute(dist, detailRoute, "<article>Valid detail</article>");

      expect(validateSitemapDist({ distDirectory: dist })).toMatchObject({
        sitemapUrlCount: routes.length,
        canonicalHtmlCount: routes.length,
        internalDetailLinkCount: expectedDetailLinks,
        invalidInternalDetailLinkCount: 0,
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("rejects a route-relative link whose canonical detail HTML is missing", () => {
    const dist = mkdtempSync(path.join(tmpdir(), "techdb-sitemap-validator-missing-"));
    const routes = ["/", "/nested/deep/"];
    try {
      writeSitemap(dist, routes);
      writeRoute(dist, "/", "<main>Home</main>");
      writeRoute(
        dist,
        "/nested/deep/",
        "<a href=&#47;e&#47;archive-only-cold&#47;>Archive-only missing detail</a>",
      );
      expect(() => validateSitemapDist({ distDirectory: dist })).toThrow(
        /\/nested\/deep\/ -> \/e\/archive-only-cold\//,
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("sitemap / noindex parity invariant", () => {
  function makeDist(): string {
    return mkdtempSync(path.join(tmpdir(), "sitemap-noindex-"));
  }

  it("accepts a noindex canonical route absent from the sitemap", () => {
    const dist = makeDist();
    try {
      writeRoute(dist, "/keep/", '<html><head></head><body><a href="/e/thin/">Thin</a></body></html>');
      writeRoute(
        dist,
        "/e/thin/",
        '<html><head><meta name="robots" content="noindex, follow"></head><body></body></html>',
      );
      writeSitemap(dist, ["/keep/"]);
      expect(validateSitemapDist({ distDirectory: dist })).toMatchObject({
        sitemapUrlCount: 1,
        canonicalHtmlCount: 2,
        noindexHtmlCount: 1,
        internalDetailLinkCount: 1,
        invalidInternalDetailLinkCount: 0,
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("rejects a noindex route advertised in the sitemap", () => {
    const dist = makeDist();
    try {
      writeRoute(dist, "/keep/", '<html><head></head><body><a href="/e/thin/">Thin</a></body></html>');
      writeRoute(
        dist,
        "/e/thin/",
        '<html><head><meta name="robots" content="noindex, follow"></head><body></body></html>',
      );
      writeSitemap(dist, ["/keep/", "/e/thin/"]);
      expect(() => validateSitemapDist({ distDirectory: dist })).toThrow(
        /noindex routes advertised in sitemap: \/e\/thin\//,
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("rejects an indexable canonical route absent from the sitemap", () => {
    const dist = makeDist();
    try {
      writeRoute(dist, "/keep/", "<html><head></head><body></body></html>");
      writeRoute(dist, "/orphan/", "<html><head></head><body></body></html>");
      writeSitemap(dist, ["/keep/"]);
      expect(() => validateSitemapDist({ distDirectory: dist })).toThrow(
        /indexable canonical HTML absent from sitemap/,
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("does not read a noindex directive out of comments or scripts", () => {
    const dist = makeDist();
    try {
      writeRoute(dist, "/keep/", "<html><head></head><body></body></html>");
      writeRoute(
        dist,
        "/orphan/",
        '<html><head><!-- <meta name="robots" content="noindex"> -->'
        + '<script>\'<meta name="robots" content="noindex">\'</script>'
        + "</head><body></body></html>",
      );
      writeSitemap(dist, ["/keep/"]);
      // The page is NOT actually noindex, so it must still be required in the
      // sitemap. A regex-based reader would wrongly exempt it here.
      expect(() => validateSitemapDist({ distDirectory: dist })).toThrow(
        /indexable canonical HTML absent from sitemap/,
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("rejects a robots meta without a content attribute", () => {
    const dist = makeDist();
    try {
      writeRoute(dist, "/keep/", '<html><head><meta name="robots"></head><body></body></html>');
      writeSitemap(dist, ["/keep/"]);
      // Fail closed: an unreadable directive must not silently default to
      // "indexable".
      expect(() => validateSitemapDist({ distDirectory: dist })).toThrow(
        /robots meta without a content attribute/,
      );
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it("treats an explicit index directive as indexable", () => {
    const dist = makeDist();
    try {
      writeRoute(
        dist,
        "/keep/",
        '<html><head><meta name="robots" content="index, follow"></head><body></body></html>',
      );
      writeSitemap(dist, ["/keep/"]);
      expect(validateSitemapDist({ distDirectory: dist })).toMatchObject({
        noindexHtmlCount: 0,
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});
