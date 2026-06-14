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

const ANTHROPIC_LISTING_TIMEOUT_MS = 10_000;
const ANTHROPIC_ARTICLE_TIMEOUT_MS = 8_000;
const ANTHROPIC_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; tech-dashboard-harness/0.1)",
} as const;

async function fetchAnthropicHtml(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: ANTHROPIC_HEADERS,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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

  // 2026-05: anthropic.com switched to a Next.js layout where the publish
  // date is rendered as <div class="body-3 agate">Apr 16, 2026</div> in the
  // PostDetail hero block, with no <time> tag and no leading "Published"
  // word. Match the bare "Mon DD, YYYY" pattern inside the article hero.
  const text = textFromHtml(html.slice(0, 80_000));
  const labeled = text.match(/\bPublished\s+([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})\b/);
  const bare = text.match(/\b([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\b/);
  const picked = labeled?.[1] ?? bare?.[1];
  if (!picked) return null;
  const parsed = new Date(`${picked} 00:00:00 UTC`);
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
    return parseAnthropicArticleHtml(await fetchAnthropicHtml(url, ANTHROPIC_ARTICLE_TIMEOUT_MS));
  } catch {
    return null;
  }
}

export async function collectAnthropic(opts: AnthropicScrapeOpts): Promise<RawEntry[]> {
  // Default 6 (history: 12 -> 5 -> 2). Inline Worker summarize is now disabled
  // (SUMMARIZE_MAX_NEW=0; summaries run via the queue / local backfill), which
  // frees the subrequest budget that previously forced limit=2. Anthropic has
  // no RSS feed, so this listing scrape is the only way to accumulate their
  // news / engineering best-practice posts — 6 detail fetches per run lets the
  // archive build up without busting the per-invocation subrequest ceiling.
  const { section, limit = 6 } = opts;
  const listingUrl =
    section === "engineering"
      ? "https://www.anthropic.com/engineering"
      : "https://www.anthropic.com/news";

  let html: string;
  try {
    html = await fetchAnthropicHtml(listingUrl, ANTHROPIC_LISTING_TIMEOUT_MS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`anthropic-${section} fetch failed: ${message}`);
  }

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
