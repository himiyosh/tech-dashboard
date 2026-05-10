/**
 * VS Code Updates Atom collector (Tier 1 source #9).
 *
 * The release notes index is mostly navigation HTML and does not expose stable
 * dates for recent releases. The site Atom feed includes /updates/v1_NNN entries
 * with updated timestamps, so use that as the source of truth.
 */
import { XMLParser } from "fast-xml-parser";
import type { RawEntry, SourceDefinition } from "../types.ts";

const BASE = "https://code.visualstudio.com";
const MAX_ENTRIES = 12;
const FUTURE_SKEW_MS = 6 * 3600_000;

interface AtomEntry {
  title?: string | { "#text"?: string };
  link?: AtomLink | AtomLink[];
  id?: string;
  updated?: string;
  content?: string | { "#text"?: string };
}

interface AtomLink {
  "@_href"?: string;
  "@_rel"?: string;
}

interface AtomRoot {
  feed?: { entry?: AtomEntry[] | AtomEntry };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  textNodeName: "#text",
  processEntities: false,
});

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text.trim() : "";
  }
  return "";
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHtml(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linksOf(entry: AtomEntry): AtomLink[] {
  if (!entry.link) return [];
  return Array.isArray(entry.link) ? entry.link : [entry.link];
}

function entryUrl(entry: AtomEntry): string {
  const link = linksOf(entry).find((item) => item["@_rel"] !== "related" && item["@_href"]?.includes("/updates/v1_"));
  return link?.["@_href"] ?? "";
}

function relatedImage(entry: AtomEntry): string | undefined {
  return linksOf(entry).find((item) => item["@_rel"] === "related" && item["@_href"]?.startsWith("http"))?.["@_href"];
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseVscodeUpdatesFeed(xml: string, now = new Date()): RawEntry[] {
  const parsed = parser.parse(xml) as AtomRoot;
  const rawEntries = parsed.feed?.entry;
  const entries = rawEntries ? (Array.isArray(rawEntries) ? rawEntries : [rawEntries]) : [];
  const nowMs = now.getTime();

  return entries
    .map((entry) => {
      const url = entryUrl(entry);
      const version = url.match(/\/updates\/v1_(\d+)/)?.[1];
      const title = asText(entry.title);
      const publishedAt = parseDate(entry.updated);
      const contentSnippet = stripHtml(asText(entry.content));
      return { entry, url, version, title, publishedAt, contentSnippet };
    })
    .filter((item) => item.url && item.version && item.title && item.publishedAt)
    .filter((item) => new Date(item.publishedAt!).getTime() <= nowMs + FUTURE_SKEW_MS)
    .filter((item) => !/\binsiders?\b/i.test(`${item.title} ${item.contentSnippet}`))
    .sort((a, b) => Number(b.version) - Number(a.version))
    .slice(0, MAX_ENTRIES)
    .map((item) => ({
      externalId: `vscode-1.${item.version}`,
      url: item.url,
      title: `${item.title} Release Notes`,
      contentSnippet: item.contentSnippet || `Monthly release notes for ${item.title}.`,
      publishedAt: item.publishedAt!,
      ...(relatedImage(item.entry) ? { mediaThumbnail: relatedImage(item.entry) } : {}),
    }));
}

export async function collectVscodeUpdates(source: SourceDefinition): Promise<RawEntry[]> {
  const feedUrl = source.feedUrl.endsWith("/feed.xml") ? source.feedUrl : `${BASE}/feed.xml`;
  const res = await fetch(feedUrl, {
    headers: {
      Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      "User-Agent": "tech-dashboard-bot/0.1 (+https://github.com/himiyosh/tech-dashboard)",
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${feedUrl}`);
  return parseVscodeUpdatesFeed(await res.text());
}
