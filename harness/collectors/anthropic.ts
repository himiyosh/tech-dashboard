import type { RawEntry } from "../types.ts";

/**
 * Anthropic News/Engineering HTML scraper.
 * Anthropic does not publish an RSS feed, so we scrape the listing page,
 * then fetch each article page to extract title, publish date, and hero
 * summary for pre-LLM preview text.
 */
export interface AnthropicScrapeOpts {
  section: "news" | "engineering";
  limit?: number;
}

interface AnthropicArticleMeta {
  title: string | null;
  contentSnippet: string;
  publishedAt: string | null;
}

function decodeHtml(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, "-")
    .replace(/&ndash;/g, "-")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function textFromHtml(input: string): string {
  return decodeHtml(
    input
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(input: string, max = 800): string {
  const text = input.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function metaContent(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyFirst = new RegExp(`<meta[^>]+(?:property|name)="${escaped}"[^>]+content="([^"]*)"`, "i");
  const contentFirst = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${escaped}"`, "i");
  const match = html.match(keyFirst) ?? html.match(contentFirst);
  return match ? decodeHtml(match[1]!).trim() : null;
}

function parsePublishedAt(html: string): string | null {
  const datetime = html.match(/<time[^>]+datetime="([^"]+)"/i)?.[1];
  const direct = datetime ? new Date(datetime) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct.toISOString();

  const text = textFromHtml(html.slice(0, 60_000));
  const visible = text.match(/\bPublished\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\b/);
  if (!visible) return null;
  const parsed = new Date(`${visible[1]} 00:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function firstMatchText(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    const text = match ? textFromHtml(match[1]!) : "";
    if (text) return text;
  }
  return null;
}

function extractParagraphs(html: string, pattern: RegExp, limit: number): string[] {
  const paragraphs: string[] = [];
  for (const match of html.matchAll(pattern)) {
    const text = textFromHtml(match[1]!);
    if (text && !paragraphs.includes(text)) paragraphs.push(text);
    if (paragraphs.length >= limit) break;
  }
  return paragraphs;
}

export function parseAnthropicArticleHtml(html: string): AnthropicArticleMeta {
  const title = firstMatchText(html, [/<h1[^>]*>([\s\S]*?)<\/h1>/i])
    ?? metaContent(html, "og:title")?.replace(/\s*\|\s*Anthropic\s*$/i, "").trim()
    ?? null;
  const heroSummary = firstMatchText(html, [
    /<p[^>]+class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /<div[^>]+class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ]);
  const bodyParagraphs = extractParagraphs(
    html,
    /<p[^>]+class="[^"]*(?:post-text|body|article)[^"]*"[^>]*>([\s\S]*?)<\/p>/gi,
    2,
  );
  const articleHtml = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html;
  const fallbackParagraphs = bodyParagraphs.length > 0
    ? bodyParagraphs
    : extractParagraphs(articleHtml, /<p[^>]*>([\s\S]*?)<\/p>/gi, 2);
  const contentParts = heroSummary
    ? [heroSummary]
    : fallbackParagraphs.filter((p) => !/^Published\b/.test(p));
  const contentSnippet = truncateText(contentParts.filter(Boolean).join(" "));

  return {
    title,
    contentSnippet,
    publishedAt: parsePublishedAt(html),
  };
}

async function fetchAnthropicArticle(url: string): Promise<AnthropicArticleMeta | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; tech-dashboard-harness/0.1)",
      },
    });
    if (!res.ok) return null;
    return parseAnthropicArticleHtml(await res.text());
  } catch {
    return null;
  }
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
  const re = new RegExp(`href="(${prefix}[a-z0-9][a-z0-9-]+)"`, "g");
  const seen = new Set<string>();
  const slugs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const path = m[1]!;
    if (seen.has(path)) continue;
    if (path === prefix || path === prefix.slice(0, -1)) continue;
    seen.add(path);
    slugs.push(path);
    if (slugs.length >= limit) break;
  }

  const dateMap = new Map<string, string>();
  const timeRe = /href="(\/(?:news|engineering)\/[a-z0-9-]+)"[\s\S]*?<time[^>]+datetime="([^"]+)"/g;
  for (const tm of html.matchAll(timeRe)) {
    const p = tm[1]!;
    const d = new Date(tm[2]!);
    if (!Number.isNaN(d.getTime())) dateMap.set(p, d.toISOString());
  }
  const timeRe2 = /<time[^>]+datetime="([^"]+)"[\s\S]*?href="(\/(?:news|engineering)\/[a-z0-9-]+)"/g;
  for (const tm of html.matchAll(timeRe2)) {
    const p = tm[2]!;
    if (dateMap.has(p)) continue;
    const d = new Date(tm[1]!);
    if (!Number.isNaN(d.getTime())) dateMap.set(p, d.toISOString());
  }

  const entries: RawEntry[] = [];
  for (const path of slugs) {
    const slug = path.slice(prefix.length);
    const titleFromSlug = slug
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const url = `https://www.anthropic.com${path}`;
    const article = await fetchAnthropicArticle(url);
    entries.push({
      externalId: `anthropic-${section}-${slug}`,
      url,
      title: article?.title || titleFromSlug,
      contentSnippet: article?.contentSnippet || titleFromSlug,
      publishedAt: article?.publishedAt ?? dateMap.get(path) ?? null,
    });
  }

  return entries;
}

export const collectAnthropicNews = () => collectAnthropic({ section: "news" });
export const collectAnthropicEngineering = () =>
  collectAnthropic({ section: "engineering" });
