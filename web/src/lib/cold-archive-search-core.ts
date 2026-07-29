import { archiveMonthPath } from "./route-inventory.ts";
import { normalizeSearchText } from "./search-normalize.ts";
import { normalizeTagKey } from "./tag-normalize.ts";

const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
]);

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

export const COLD_ARCHIVE_SEARCH_SCHEMA_VERSION = 1 as const;
export const COLD_ARCHIVE_SEARCH_MAX_BYTES = 1_000_000;

export type ColdArchiveAuthority =
  | "official"
  | "paper"
  | "community"
  | "news"
  | "aggregator"
  | "source";

export interface ColdArchiveSearchInput {
  id: string;
  url: string;
  month: string;
  archiveTier?: "hot" | "warm" | "cold" | "dropped";
  titleJa: string;
  titleEn: string;
  tags: readonly string[];
  source: string;
  category: string;
  authority: ColdArchiveAuthority;
  importance: 1 | 2 | 3;
  publishedAt: string;
}

export interface ColdArchiveSearchRecord {
  entryId: string;
  anchorId: string;
  archiveMonth: string;
  href: string;
  resultKind: "cold-archive";
  titleJa: string;
  titleEn: string;
  tags: string[];
  source: string;
  category: string;
  authority: ColdArchiveAuthority;
  importance: 1 | 2 | 3;
  publishedDay: string;
}

export interface ColdArchiveSearchPayload {
  schemaVersion: typeof COLD_ARCHIVE_SEARCH_SCHEMA_VERSION;
  generatedAt: string;
  count: number;
  entries: ColdArchiveSearchRecord[];
}

export interface ColdArchiveSearchItem {
  url: string;
  resultKind: "cold-archive";
  meta: {
    titleJa: string;
    titleEn: string;
    tags: string;
    archiveMonth: string;
  };
  filters: {
    source: string[];
    category: string[];
    authority: ColdArchiveAuthority[];
    importance: string[];
    publishedDay: string[];
    tag: string[];
  };
}

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAM_NAMES.has(lower);
}

function normalizeHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  const withoutWww = lower.startsWith("www.") ? lower.slice(4) : lower;
  return withoutWww === "m.youtube.com" ? "youtube.com" : withoutWww;
}

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

/**
 * Web-local copy of the archive publisher's canonical URL identity. Web code
 * cannot import repository-root runtime modules (R-005), so parity is fixed by
 * tests against harness/pipeline/url.ts.
 */
export function canonicalArchiveSearchKey(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    let host = normalizeHost(url.hostname);
    let path = normalizePath(url.pathname);
    let netflixPublication = host === "netflixtechblog.com";

    const mediumNetflixPrefix = "/netflix-techblog/";
    if (
      host === "medium.com"
      && path.toLowerCase().startsWith(mediumNetflixPrefix)
      && path.length > mediumNetflixPrefix.length
    ) {
      host = "netflixtechblog.com";
      path = normalizePath(path.slice("/netflix-techblog".length));
      netflixPublication = true;
    }

    if (host === "youtube.com" && path === "/watch") {
      const videoId = url.searchParams.get("v");
      const authority = url.port ? `${host}:${url.port}` : host;
      return videoId ? `${authority}${path}?v=${videoId}` : `${authority}${path}`;
    }

    const params = [...url.searchParams.entries()]
      .filter(
        ([name]) =>
          !isTrackingParam(name)
          && !(netflixPublication && name.toLowerCase() === "source"),
      )
      .sort(([aName, aValue], [bName, bValue]) =>
        aName === bName
          ? aValue.localeCompare(bValue)
          : aName.localeCompare(bName),
      );
    const query = params.length === 0
      ? ""
      : `?${new URLSearchParams(params).toString()}`;
    const authority = url.port ? `${host}:${url.port}` : host;
    return `${authority}${path}${query}`;
  } catch {
    return null;
  }
}

function stableHash64(value: string): string {
  let hash = FNV_OFFSET_BASIS_64;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
  }
  return hash.toString(16).padStart(16, "0");
}

export function coldArchiveAnchorId(rawUrl: string): string {
  const canonicalKey = canonicalArchiveSearchKey(rawUrl) ?? rawUrl.trim();
  return `archive-entry-${stableHash64(canonicalKey)}`;
}

export function createColdArchiveSearchRecord(
  input: ColdArchiveSearchInput,
): ColdArchiveSearchRecord | null {
  if (
    input.archiveTier !== "cold"
    || !canonicalArchiveSearchKey(input.url)
    || !/^\d{4}-\d{2}$/.test(input.month)
  ) {
    return null;
  }

  const titleJa = input.titleJa.trim();
  const titleEn = input.titleEn.trim();
  if (!titleJa && !titleEn) return null;

  const anchorId = coldArchiveAnchorId(input.url);
  return {
    entryId: input.id,
    anchorId,
    archiveMonth: input.month,
    href: `${archiveMonthPath(input.month)}#${anchorId}`,
    resultKind: "cold-archive",
    titleJa,
    titleEn,
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    source: input.source,
    category: input.category,
    authority: input.authority,
    importance: input.importance,
    publishedDay: input.publishedAt.slice(0, 10),
  };
}

export function coldArchiveRecordMatchesQuery(
  record: ColdArchiveSearchRecord,
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query.trim());
  if (!normalizedQuery) return false;
  if (record.tags.some((tag) => normalizeTagKey(tag) === normalizedQuery)) {
    return true;
  }

  const title = normalizeSearchText(`${record.titleJa} ${record.titleEn}`);
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  return title.includes(normalizedQuery)
    || (terms.length > 1 && terms.every((term) => title.includes(term)));
}

export function coldArchiveRecordToSearchItem(
  record: ColdArchiveSearchRecord,
): ColdArchiveSearchItem {
  return {
    url: record.href,
    resultKind: record.resultKind,
    meta: {
      titleJa: record.titleJa,
      titleEn: record.titleEn,
      tags: record.tags.join(" "),
      archiveMonth: record.archiveMonth,
    },
    filters: {
      source: [record.source],
      category: [record.category],
      authority: [record.authority],
      importance: [String(record.importance)],
      publishedDay: [record.publishedDay],
      tag: record.tags,
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string");
}

function isColdArchiveSearchRecord(
  value: unknown,
): value is ColdArchiveSearchRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ColdArchiveSearchRecord>;
  return typeof record.entryId === "string"
    && /^archive-entry-[a-f0-9]{16}$/.test(record.anchorId ?? "")
    && /^\d{4}-\d{2}$/.test(record.archiveMonth ?? "")
    && typeof record.href === "string"
    && record.href === `/archive/${record.archiveMonth}/#${record.anchorId}`
    && record.resultKind === "cold-archive"
    && typeof record.titleJa === "string"
    && typeof record.titleEn === "string"
    && isStringArray(record.tags)
    && typeof record.source === "string"
    && typeof record.category === "string"
    && [
      "official",
      "paper",
      "community",
      "news",
      "aggregator",
      "source",
    ].includes(record.authority ?? "")
    && [1, 2, 3].includes(record.importance ?? 0)
    && /^\d{4}-\d{2}-\d{2}$/.test(record.publishedDay ?? "");
}

export function parseColdArchiveSearchPayload(
  value: unknown,
): ColdArchiveSearchPayload {
  if (!value || typeof value !== "object") {
    throw new Error("Cold archive search payload must be an object.");
  }
  const payload = value as Partial<ColdArchiveSearchPayload>;
  if (
    payload.schemaVersion !== COLD_ARCHIVE_SEARCH_SCHEMA_VERSION
    || typeof payload.generatedAt !== "string"
    || !Array.isArray(payload.entries)
    || payload.entries.some((entry) => !isColdArchiveSearchRecord(entry))
    || payload.count !== payload.entries.length
  ) {
    throw new Error("Cold archive search payload is invalid.");
  }
  return payload as ColdArchiveSearchPayload;
}
