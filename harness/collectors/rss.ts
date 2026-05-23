/**
 * Generic RSS / Atom collector.
 *
 * Handles both RSS 2.0 and Atom 1.0 with a single parser. Returns RawEntry[].
 * Intentionally small: normalization and tagging happen downstream.
 */
import { XMLParser } from "fast-xml-parser";
import type { RawEntry, SourceDefinition } from "../types.ts";

interface RssItem {
  title?: string | { "#text"?: string };
  link?: string | { "@_href"?: string; "#text"?: string } | Array<{ "@_href"?: string; "@_rel"?: string }>;
  guid?: string | { "#text"?: string };
  id?: string;
  pubDate?: string;
  published?: string;
  updated?: string;
  description?: string | { "#text"?: string };
  summary?: string | { "#text"?: string };
  content?: string | { "#text"?: string };
  "media:thumbnail"?: { "@_url"?: string } | Array<{ "@_url"?: string }>;
  enclosure?: { "@_url"?: string; "@_type"?: string };
  author?: string | { name?: string; "#text"?: string };
}

interface RssFeedRoot {
  rss?: { channel?: { item?: RssItem[] | RssItem } };
  feed?: { entry?: RssItem[] | RssItem };
  // arXiv and other RDF-style feeds expose <item> as siblings of <channel>
  // inside <rdf:RDF>.
  "rdf:RDF"?: { item?: RssItem[] | RssItem; channel?: unknown };
  RDF?: { item?: RssItem[] | RssItem; channel?: unknown };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  textNodeName: "#text",
  // Atom feeds (GitHub Releases, Simon Willison) embed hundreds of XML
  // entities in content which trips fast-xml-parser's 1000-expansion ceiling.
  // We disable entity expansion in the parser and decode the common five
  // named entities manually in asText() — sufficient for title/summary fields.
  processEntities: false,
});

const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Coerce a value that may be string | {#text} | undefined into a plain string. */
function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return decodeEntities(v.trim());
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    if (typeof rec["#text"] === "string") return decodeEntities((rec["#text"] as string).trim());
  }
  return "";
}

/** Extract link URL from either RSS <link>string</link> or Atom <link href=".."/>. */
function asLink(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    // Atom: multiple <link> elements, prefer rel="alternate"
    const arr = v as Array<Record<string, unknown>>;
    const alt = arr.find((x) => x["@_rel"] === "alternate" || x["@_rel"] == null);
    if (alt && typeof alt["@_href"] === "string") return alt["@_href"];
    const first = arr[0];
    if (first && typeof first["@_href"] === "string") return first["@_href"];
    return "";
  }
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    if (typeof rec["@_href"] === "string") return rec["@_href"];
    if (typeof rec["#text"] === "string") return rec["#text"];
  }
  return "";
}

function asDate(v: unknown): string | null {
  const s = asText(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Extract a publish date from an article HTML page. Tries in order:
 *  1. <meta property="article:published_time" content="...">
 *  2. JSON-LD "datePublished":"..."  (accepts YYYY-MM-DD; treats as UTC midnight)
 *  3. <time datetime="..."> (first occurrence)
 * Returns null if no usable date is found.
 */
export function extractPublishedAtFromHtml(html: string): string | null {
  const meta = html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i)
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="article:published_time"/i);
  if (meta) {
    const d = new Date(meta[1]!);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (ld) {
    let s = ld[1]!;
    // Bare YYYY-MM-DD → anchor to UTC midnight so it parses deterministically.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const tm = html.match(/<time[^>]+datetime="([^"]+)"/i);
  if (tm) {
    const d = new Date(tm[1]!);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Per-run cap on per-article date fetches (subrequest budget — see LL-036/037). */
const MAX_ARTICLE_DATE_FETCHES = 15;

async function fetchArticleDate(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "tech-dashboard-bot/0.1 (+https://github.com/himiyosh/tech-dashboard)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return extractPublishedAtFromHtml(await res.text());
  } catch {
    return null;
  }
}

function asThumbnail(item: RssItem): string | undefined {
  const thumb = item["media:thumbnail"];
  if (Array.isArray(thumb)) {
    const first = thumb[0];
    if (first?.["@_url"]) return first["@_url"];
  } else if (thumb && typeof thumb === "object") {
    if (thumb["@_url"]) return thumb["@_url"];
  }
  const enc = item.enclosure;
  if (enc && typeof enc === "object" && enc["@_url"] && typeof enc["@_type"] === "string" && enc["@_type"].startsWith("image/")) {
    return enc["@_url"];
  }
  return undefined;
}

/** Pick the first usable <img src> from description/content/summary HTML. */
function extractInlineImage(html: string): string | undefined {
  if (!html) return undefined;
  const re = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1]?.trim();
    if (!src) continue;
    if (src.startsWith("data:")) continue;
    // Skip tiny tracking pixels and avatar-like assets.
    if (/(spacer|pixel|1x1|tracker|beacon)/i.test(src)) continue;
    if (src.startsWith("http://") || src.startsWith("https://")) return src;
    if (src.startsWith("//")) return "https:" + src;
  }
  return undefined;
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch a feed URL and parse it into RawEntry[]. */
export async function collectRss(source: SourceDefinition): Promise<RawEntry[]> {
  const res = await fetch(source.feedUrl, {
    headers: {
      "User-Agent": "tech-dashboard-bot/0.1 (+https://github.com/himiyosh/tech-dashboard)",
      Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${source.feedUrl}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml) as RssFeedRoot;

  let rawItems: RssItem[] = [];
  // Recognize the root element first; absence of <item> inside a recognized
  // root means "empty feed" (legitimate — e.g. arXiv on weekends) not an error.
  let rootRecognized = false;
  if (parsed.rss?.channel) {
    rootRecognized = true;
    const items = parsed.rss.channel.item;
    if (items) rawItems = Array.isArray(items) ? items : [items];
  } else if (parsed.feed) {
    rootRecognized = true;
    const items = parsed.feed.entry;
    if (items) rawItems = Array.isArray(items) ? items : [items];
  } else if (parsed["rdf:RDF"]) {
    rootRecognized = true;
    const items = parsed["rdf:RDF"].item;
    if (items) rawItems = Array.isArray(items) ? items : [items];
  } else if (parsed.RDF) {
    rootRecognized = true;
    const items = parsed.RDF.item;
    if (items) rawItems = Array.isArray(items) ? items : [items];
  }
  if (!rootRecognized) {
    throw new Error(`Feed has no recognized root (<rss>/<feed>/<rdf:RDF>): ${source.feedUrl}`);
  }

  const entries: RawEntry[] = [];
  for (const item of rawItems) {
    const title = asText(item.title);
    const url = asLink(item.link);
    if (!title || !url) continue;

    const externalId = asText(item.guid) || asText(item.id) || url;
    const publishedAt = asDate(item.pubDate ?? item.published ?? item.updated);
    const descriptionRaw = asText(item.description ?? item.summary ?? item.content);
    const contentSnippet = descriptionRaw ? stripHtml(descriptionRaw).slice(0, 800) : undefined;
    const mediaThumbnail = asThumbnail(item) ?? extractInlineImage(descriptionRaw);
    const authorRaw = item.author;
    let author: string | undefined;
    if (typeof authorRaw === "string") author = authorRaw;
    else if (authorRaw && typeof authorRaw === "object") {
      author = (authorRaw.name as string) ?? (authorRaw["#text"] as string) ?? undefined;
    }

    entries.push({
      externalId,
      url,
      title,
      ...(contentSnippet !== undefined ? { contentSnippet } : {}),
      publishedAt,
      ...(mediaThumbnail !== undefined ? { mediaThumbnail } : {}),
      ...(author !== undefined ? { author } : {}),
    });
  }

  // Opt-in: feeds without per-item dates (e.g. Google Developers Blog) get
  // their publishedAt populated by fetching each article HTML. Capped per run.
  if (source.fetchArticleDate) {
    let budget = MAX_ARTICLE_DATE_FETCHES;
    for (const e of entries) {
      if (budget <= 0) break;
      if (e.publishedAt) continue;
      budget--;
      const real = await fetchArticleDate(e.url);
      if (real) e.publishedAt = real;
    }
  }

  return entries;
}
