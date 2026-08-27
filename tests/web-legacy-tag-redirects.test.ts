import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  legacyTagRedirects,
  writeLegacyTagRedirects,
} from "../web/scripts/legacy-tag-redirects.mjs";

const entries = [
  { tags: ["alpha", "Café", "popular"] },
  { tags: ["ALPHA", "cafe", "popular"] },
  ...Array.from({ length: 8 }, () => ({ tags: ["popular"] })),
  { tags: ["singleton"] },
];

describe("legacy tag redirects", () => {
  it("keeps tags below the full-page threshold recoverable", () => {
    expect(legacyTagRedirects(entries)).toEqual([
      {
        tag: "alpha",
        encodedTag: "alpha",
        searchHref: "/search/?q=alpha&tag=alpha",
      },
      {
        tag: "cafe",
        encodedTag: "cafe",
        searchHref: "/search/?q=cafe&tag=cafe",
      },
    ]);
  });

  it("writes small noindex recovery pages without overwriting full tag pages", () => {
    const root = mkdtempSync(path.join(tmpdir(), "techdb-tag-redirects-"));
    try {
      const indexPath = path.join(root, "index.json");
      const distDirectory = path.join(root, "dist");
      writeFileSync(
        indexPath,
        JSON.stringify({ entries }),
        "utf8",
      );
      expect(writeLegacyTagRedirects({ distDirectory, indexPath })).toBe(2);
      const html = readFileSync(path.join(distDirectory, "t", "alpha", "index.html"), "utf8");
      // "follow" is deliberate: the stub's only content is a link to the
      // search results, and that link should be followed.
      expect(html).toContain('name="robots" content="noindex, follow"');
      // Self-referential canonical. These stubs used to point their canonical
      // at /search/?q=…, which robots.txt now disallows — a canonical must
      // never name a URL crawlers are told not to fetch.
      expect(html).toContain('<link rel="canonical" href="/t/alpha/"');
      expect(html).not.toContain('rel="canonical" href="/search');
      expect(html).toContain('content="0;url=/search/?q=alpha&amp;tag=alpha"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
