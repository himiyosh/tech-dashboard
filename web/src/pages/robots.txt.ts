import type { APIRoute } from "astro";
import { SITE_URL } from "../lib/site.ts";

/**
 * Query-shell URLs. `/search` renders one client-side Pagefind shell, so every
 * `?q=` / `?tag=` / `?entry=` variant returns the same near-empty HTML. The built
 * site links thousands of distinct query variants of it (from `tagHref()` tag
 * chips and from the legacy tag stubs), which is crawl budget spent on pages that
 * can never carry indexable content.
 *
 * The bare `/search/` route is deliberately NOT listed: it carries
 * `<meta name="robots" content="noindex, follow">` and a crawler has to be able to
 * fetch it to read that directive. robots.txt patterns are matched against
 * path + query string, so `/search?` and `/search/?` block only the query variants
 * and leave the bare route reachable. Longest match wins over `Allow: /`.
 */
export const ROBOTS_DISALLOWED_PATTERNS = [
  "/search?",
  "/search/?",
] as const;

export const GET: APIRoute = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      ...ROBOTS_DISALLOWED_PATTERNS.map((pattern) => `Disallow: ${pattern}`),
      "",
      `Sitemap: ${SITE_URL}/sitemap.xml`,
      "",
    ].join("\n"),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    },
  );
