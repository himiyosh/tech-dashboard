import type { RawEntry } from "../types.ts";

/**
 * Anthropic News/Engineering HTML scraper.
 * Anthropic does not publish an RSS feed; scrape the listing page and
 * extract article links. publishedAt is extracted from the listing page
 * HTML when available; null otherwise.
 *
 * Intentional limits: we do not fetch each article page to avoid rate
 * limits. Title is derived from the slug (readable enough for MVP;
 * summarizer pipeline will normalize later).
 */
export interface AnthropicScrapeOpts {
  section: "news" | "engineering";
  limit?: number;
}

export async function collectAnthropic(opts: AnthropicScrapeOpts): Promise<RawEntry[]> {
  const { section, limit = 12 } = opts;
  const listingUrl =
    section === "engineering"
      ? "https://www.anthropic.com/engineering"
      : "https://www.anthropic.com/news";

  const res = await fetch(listingUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; tech-dashboard-harness/0.1)",
    },
  });
  if (!res.ok) {
    throw new Error(`anthropic-${section} HTTP ${res.status}`);
  }
  const html = await res.text();

  const prefix = section === "engineering" ? "/engineering/" : "/news/";
  // Match href="/news/<slug>" — slugs are kebab-case, avoid pagination paths.
  const re = new RegExp(
    `href="(${prefix}[a-z0-9][a-z0-9-]+)"`,
    "g",
  );
  const seen = new Set<string>();
  const slugs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1]!;
    if (seen.has(path)) continue;
    // Skip obvious non-article paths.
    if (path === prefix || path === prefix.slice(0, -1)) continue;
    seen.add(path);
    slugs.push(path);
    if (slugs.length >= limit) break;
  }

  // Try to extract dates from listing page HTML.
  // Anthropic listing pages sometimes include datetime attributes or
  // visible date strings near each article link.
  const dateMap = new Map<string, string>();
  // Pattern: <time datetime="2025-04-16"> near a link
  const timeRe = /href="(\/(?:news|engineering)\/[a-z0-9-]+)"[\s\S]*?<time[^>]+datetime="([^"]+)"/g;
  for (const tm of html.matchAll(timeRe)) {
    const p = tm[1]!;
    const d = new Date(tm[2]!);
    if (!Number.isNaN(d.getTime())) dateMap.set(p, d.toISOString());
  }
  // Reverse pattern: <time> before <a href>
  const timeRe2 = /<time[^>]+datetime="([^"]+)"[\s\S]*?href="(\/(?:news|engineering)\/[a-z0-9-]+)"/g;
  for (const tm of html.matchAll(timeRe2)) {
    const p = tm[2]!;
    if (dateMap.has(p)) continue;
    const d = new Date(tm[1]!);
    if (!Number.isNaN(d.getTime())) dateMap.set(p, d.toISOString());
  }

  return slugs.map((path) => {
    const slug = path.slice(prefix.length);
    const titleFromSlug = slug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      externalId: `anthropic-${section}-${slug}`,
      url: `https://www.anthropic.com${path}`,
      title: titleFromSlug,
      contentSnippet: "",
      publishedAt: dateMap.get(path) ?? null,
    };
  });
}

export const collectAnthropicNews = () => collectAnthropic({ section: "news" });
export const collectAnthropicEngineering = () =>
  collectAnthropic({ section: "engineering" });
