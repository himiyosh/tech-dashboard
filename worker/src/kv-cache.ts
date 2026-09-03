import type { KeyValueBinding } from "./runtime-bindings.ts";

/**
 * Per-URL summary cache (KV) helpers.
 *
 * Background (LL-038): The original single-blob layout (`cache.v1`, ~5 MB
 * JSON of all URL→summary entries) made the summarizer Queue consumer
 * exhaust its 30 s CPU budget on JSON.parse / JSON.stringify alone. Splitting
 * the cache into one KV key per URL eliminates that overhead — get/put are
 * now O(entry size), not O(total cache size).
 *
 * Key format: `s:{hex-sha256(url)}`
 *   - 2-char prefix scopes the per-URL namespace (so OG image cache and
 *     unrelated keys never collide via list operations).
 *   - SHA-256 hex is 64 chars + 2 prefix = 66 chars, well under KV's 512-byte
 *     key limit, with effectively zero collision risk.
 *   - Hash is stable across runtimes (Worker subtle.digest, Node crypto).
 *
 * Backward compatibility: `cache.v1` (legacy blob) is preserved as a
 * read-only fallback during migration. Writes always go to per-URL keys.
 */
export interface CacheEntry {
  titleJa: string;
  /** Natural English headline from the summarizer (absent on legacy entries). */
  titleEn?: string;
  summaryJa: string;
  summaryEn: string;
  bodyJa: string;
  bodyEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
  model: string;
  cachedAt: string;
  publisherContractFingerprint?: string;
}

export const UNVERSIONED_JOB_FINGERPRINT = "legacy-unversioned-job";

const KEY_PREFIX = "s:";

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** SHA-256 hex digest of the URL. Stable across Workers and Node. */
export async function cacheKeyForUrl(url: string): Promise<string> {
  const data = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return KEY_PREFIX + toHex(digest);
}

/** Read a single cache entry by URL. Returns null on miss or parse error. */
export async function getCacheEntry(
  kv: KeyValueBinding,
  url: string,
): Promise<CacheEntry | null> {
  const key = await cacheKeyForUrl(url);
  return (await kv.get<CacheEntry>(key, "json")) ?? null;
}

/**
 * Read N cache entries in parallel. Returns a Map<url, CacheEntry>; missing
 * URLs are simply absent from the map. Use for the publisher's bounded
 * per-run lookup.
 */
export async function getCacheEntries(
  kv: KeyValueBinding,
  urls: readonly string[],
): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>();
  if (urls.length === 0) return out;
  const keys = await Promise.all(urls.map(cacheKeyForUrl));
  const values = await Promise.all(keys.map((k) => kv.get<CacheEntry>(k, "json")));
  for (let i = 0; i < urls.length; i++) {
    const v = values[i];
    if (v) out.set(urls[i]!, v);
  }
  return out;
}

/** Write a single cache entry by URL. */
export async function putCacheEntry(
  kv: KeyValueBinding,
  url: string,
  entry: CacheEntry,
): Promise<void> {
  const key = await cacheKeyForUrl(url);
  await kv.put(key, JSON.stringify(entry));
}

export function cacheEntryMatchesPublisherContract(
  entry: CacheEntry | null | undefined,
  expectedFingerprint?: string,
): boolean {
  if (!entry || !expectedFingerprint || !entry.publisherContractFingerprint) {
    return Boolean(entry);
  }
  return entry.publisherContractFingerprint === expectedFingerprint;
}

export function cacheMetadataMatchesPublisherContract(
  entry: CacheEntry | null | undefined,
  expectedFingerprint?: string,
): boolean {
  if (!entry) return false;
  if (!expectedFingerprint) return true;
  return entry.publisherContractFingerprint === expectedFingerprint;
}

/**
 * Read from per-URL keys first; fall back to the legacy `cache.v1` blob for
 * entries not yet migrated. Use during the transition window. After the
 * one-shot migration script (`scripts/kv-migrate.mjs`) populates per-URL
 * keys, fallback hits should approach zero and the blob can be retired.
 */
export async function getCacheEntriesWithLegacyFallback(
  kv: KeyValueBinding,
  urls: readonly string[],
  legacyBlobKey = "cache.v1",
): Promise<Map<string, CacheEntry>> {
  const primary = await getCacheEntries(kv, urls);
  const missing = urls.filter((u) => !primary.has(u));
  if (missing.length === 0) return primary;

  const legacy = (await kv.get<Record<string, CacheEntry>>(legacyBlobKey, "json")) ?? {};
  for (const url of missing) {
    const v = legacy[url];
    if (v) primary.set(url, v);
  }
  return primary;
}
