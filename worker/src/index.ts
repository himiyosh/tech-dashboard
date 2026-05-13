/**
 * Cloudflare Worker — scheduled harness runner.
 *
 * Replaces `.github/workflows/harness-daily.yml`. Cron trigger fires every
 * 6 hours; the Worker fetches RSS sources, normalizes, dedupes, summarizes
 * via Copilot Enterprise, and commits `data/index.json`, `data/archive/*`, and
 * `data/stats.json` back to GitHub via the Contents API. Cloudflare Pages
 * (Git-integrated) then picks up the push and auto-deploys.
 *
 * Bindings (see wrangler.toml):
 *   - SUMMARY_CACHE (KV)   replaces data/_summary-cache.json
 *   - COPILOT_PAT (secret) classic GH PAT with Copilot Enterprise
 *   - GH_TOKEN    (secret) fine-grained PAT, Contents: Write on this repo
 *   - GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (vars)
 *   - SUMMARIZE_MODEL, SUMMARIZE_MAX_NEW (vars)
 */
import { listSources } from "../../harness/registry.ts";
import { mergeEntryEnrichment } from "../../harness/pipeline/entry-merge.ts";
import { normalize } from "../../harness/pipeline/normalize.ts";
import { applyTags } from "../../harness/pipeline/tag.ts";
import { canonicalUrlKey } from "../../harness/pipeline/url.ts";
import { applyDeterministicContentFallback } from "./content-fallback.ts";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  groupArchiveEntries,
  mergeArchiveEntries,
  type ArchiveIndexFile,
  type ArchiveMonthFile,
} from "../../harness/publishers/archive-core.ts";
import { buildStatsPayload } from "../../harness/publishers/stats-core.ts";
import type {
  NormalizedEntry,
  CollectorRunResult,
  SourceDefinition,
} from "../../harness/types.ts";

interface Env {
  SUMMARY_CACHE: KVNamespace;
  COPILOT_PAT: string;
  GH_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  SUMMARIZE_MODEL: string;
  SUMMARIZE_MAX_NEW: string;
  SUMMARIZE_TIMEOUT_MS?: string;
  SUMMARIZE_CONCURRENCY?: string;
}

const INDEX_LIMIT = 2000;
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 25_000;
const DEFAULT_SUMMARIZE_CONCURRENCY = 4;
const SUMMARIZE_ATTEMPTS = 2;

/** Return epoch ms for sorting; nulls sort to end in descending order. */
function dateMs(iso: string | null): number {
  return iso ? new Date(iso).getTime() : -Infinity;
}

function entryUrlKey(entry: NormalizedEntry): string {
  return canonicalUrlKey(entry.url) ?? entry.url;
}

function preferEntry(current: NormalizedEntry | undefined, candidate: NormalizedEntry): NormalizedEntry {
  if (!current) return candidate;

  let preferred: NormalizedEntry;
  let fallback: NormalizedEntry;

  const candidateCollected = dateMs(candidate.collectedAt);
  const currentCollected = dateMs(current.collectedAt);
  if (candidateCollected !== currentCollected) {
    preferred = candidateCollected > currentCollected ? candidate : current;
    fallback = preferred === candidate ? current : candidate;
    return mergeEntryEnrichment(preferred, fallback);
  }

  if (candidate.importance !== current.importance) {
    preferred = candidate.importance > current.importance ? candidate : current;
    fallback = preferred === candidate ? current : candidate;
    return mergeEntryEnrichment(preferred, fallback);
  }

  preferred = dateMs(candidate.publishedAt) >= dateMs(current.publishedAt) ? candidate : current;
  fallback = preferred === candidate ? current : candidate;
  return mergeEntryEnrichment(preferred, fallback);
}

function setPreferredEntry(byUrl: Map<string, NormalizedEntry>, entry: NormalizedEntry): void {
  const key = entryUrlKey(entry);
  byUrl.set(key, preferEntry(byUrl.get(key), entry));
}
const COPILOT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
} as const;

interface CacheEntry {
  titleJa: string;
  summaryJa: string;
  summaryEn: string;
  bodyJa: string;
  bodyEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
  model: string;
  cachedAt: string;
}

interface FileChange {
  path: string;
  content: string;
}

// ---------- GitHub Contents API helpers --------------------------------------

async function ghGetFile(env: Env, path: string): Promise<{ content: string; sha: string } | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "tech-dashboard-worker",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gh get ${path} ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { content: string; sha: string; encoding: string };
  const content =
    body.encoding === "base64"
      ? new TextDecoder().decode(
          Uint8Array.from(atob(body.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)),
        )
      : body.content;
  return { content, sha: body.sha };
}

async function ghJson<T>(
  env: Env,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "tech-dashboard-worker",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`gh ${init?.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function ghCommitFiles(env: Env, message: string, changes: readonly FileChange[]): Promise<string | null> {
  if (changes.length === 0) return null;

  const refPath = `/git/ref/heads/${env.GITHUB_BRANCH}`;
  const ref = await ghJson<{ object: { sha: string } }>(env, refPath);
  const headSha = ref.object.sha;
  const headCommit = await ghJson<{ tree: { sha: string } }>(env, `/git/commits/${headSha}`);
  const tree = await ghJson<{ sha: string }>(env, "/git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: headCommit.tree.sha,
      tree: changes.map((change) => ({
        path: change.path,
        mode: "100644",
        type: "blob",
        content: change.content,
      })),
    }),
  });
  const commit = await ghJson<{ sha: string }>(env, "/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [headSha],
      committer: {
        name: "tech-dashboard-worker",
        email: "bot@users.noreply.github.com",
      },
    }),
  });
  await ghJson(env, `/git/refs/heads/${env.GITHUB_BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return commit.sha;
}

function stripGeneratedAt(json: string): string {
  return json.replace(/"generatedAt":\s*"[^"]+",?\n?/, "");
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function parseJson<T>(path: string, content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    console.warn(`[worker] invalid json ${path}: ${error}`);
    return null;
  }
}

async function ghJsonChangeIfChanged(
  env: Env,
  path: string,
  payload: unknown,
  existing?: { content: string; sha: string } | null,
): Promise<FileChange | null> {
  const content = stringifyJson(payload);
  const current = existing === undefined ? await ghGetFile(env, path) : existing;
  if (current && stripGeneratedAt(current.content) === stripGeneratedAt(content)) {
    return null;
  }
  return { path, content };
}

function uniqueEntriesById(entries: readonly NormalizedEntry[]): NormalizedEntry[] {
  const byId = new Map<string, NormalizedEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return [...byId.values()];
}

function entriesEqual(
  existingPayload: { entries?: NormalizedEntry[] } | null,
  nextEntries: readonly NormalizedEntry[],
): boolean {
  return JSON.stringify(existingPayload?.entries ?? []) === JSON.stringify(nextEntries);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishHistoryFiles(
  env: Env,
  archiveInputEntries: readonly NormalizedEntry[],
  liveEntries: readonly NormalizedEntry[],
  generatedAt: string,
): Promise<{
  archiveMonthsTouched: number;
  archiveFilesChanged: number;
  archiveIndexChanged: boolean;
  statsChanged: boolean;
  entriesArchived: number;
  entriesDropped: number;
  changes: FileChange[];
}> {
  const { byMonth, stats } = groupArchiveEntries(archiveInputEntries);
  const archiveIndexPath = "data/archive/_index.json";
  const archiveIndexFile = await ghGetFile(env, archiveIndexPath);
  const archiveIndex = archiveIndexFile
    ? parseJson<ArchiveIndexFile>(archiveIndexPath, archiveIndexFile.content)
    : null;
  const monthNames = new Set<string>([...(archiveIndex?.months ?? []), ...byMonth.keys()]);
  const monthFiles = new Map<string, ArchiveMonthFile>();
  const changes: FileChange[] = [];
  let archiveFilesChanged = 0;

  for (const month of [...monthNames].sort()) {
    const path = `data/archive/${month}.json`;
    const existingFile = await ghGetFile(env, path);
    const existingMonth = existingFile ? parseJson<ArchiveMonthFile>(path, existingFile.content) : null;
    const incomingEntries = byMonth.get(month) ?? [];
    const mergedEntries = incomingEntries.length > 0
      ? mergeArchiveEntries(existingMonth?.entries ?? [], incomingEntries)
      : existingMonth?.entries ?? [];
    if (mergedEntries.length === 0) continue;

    const monthPayload = buildArchiveMonthFile(month, mergedEntries, generatedAt);
    monthFiles.set(month, monthPayload);
    if (incomingEntries.length > 0) {
      const change = await ghJsonChangeIfChanged(env, path, monthPayload, existingFile);
      if (change) {
        changes.push(change);
        archiveFilesChanged++;
      }
    }
  }

  const archiveIndexPayload = buildArchiveIndexFile([...monthFiles.values()], generatedAt);
  const archiveIndexChange = await ghJsonChangeIfChanged(env, archiveIndexPath, archiveIndexPayload, archiveIndexFile);
  if (archiveIndexChange) changes.push(archiveIndexChange);
  const archivedEntries = [...monthFiles.values()].flatMap((monthFile) => monthFile.entries);
  const statsPayload = buildStatsPayload(uniqueEntriesById([...liveEntries, ...archivedEntries]), generatedAt);
  const statsChange = await ghJsonChangeIfChanged(env, "data/stats.json", statsPayload);
  if (statsChange) changes.push(statsChange);

  return {
    archiveMonthsTouched: stats.monthsTouched,
    archiveFilesChanged,
    archiveIndexChanged: archiveIndexChange !== null,
    statsChanged: statsChange !== null,
    entriesArchived: stats.entriesArchived,
    entriesDropped: stats.entriesDropped,
    changes,
  };
}

// ---------- Copilot token exchange ------------------------------------------

async function resolveCopilotToken(pat: string): Promise<string> {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${pat}`,
      "user-agent": COPILOT_HEADERS["user-agent"],
      "editor-version": COPILOT_HEADERS["editor-version"],
    },
  });
  if (!res.ok) throw new Error(`copilot token exchange ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

// ---------- Summarize -------------------------------------------------------

import { buildPrompt, parseResponse } from "./prompt.ts";
// Re-export for unit tests (tests/worker-parse.test.ts).
// NOTE: bare `export ... from` would *only* create a module-level re-export
// and would NOT bring the symbols into this module's local scope, leading to
// `ReferenceError: buildPrompt is not defined` inside callCopilot at runtime
// (see LL-030). Always import first, then re-export.
export { buildPrompt, parseResponse };

async function callCopilot(
  token: string,
  model: string,
  e: NormalizedEntry,
  timeoutMs: number,
): Promise<CacheEntry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(COPILOT_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 2400,
        messages: [
          {
            role: "system",
            content:
              "あなたは技術記事を日本語と英語の両方で要約するエディターです。指示された JSON 形式のみを返してください。",
          },
          { role: "user", content: buildPrompt(e) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`copilot ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = parseResponse(data.choices?.[0]?.message?.content ?? "");
    return {
      ...parsed,
      model,
      cachedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`copilot request timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function runWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!);
      } catch (err) {
        results[i] = err as R;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags)].slice(0, 10);
}

// ---------- OG image extraction ---------------------------------------------

/**
 * Fetch the article URL with a 5s timeout, look for <meta property="og:image">
 * (or twitter:image as a fallback), and return an absolute URL or null.
 * Reads only the first 64 KB to avoid downloading the whole page.
 */
async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; tech-dashboard-bot/0.1)",
        accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < 65536) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    try { await reader.cancel(); } catch { /* ignore */ }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const og = matchMetaContent(html, "og:image") ?? matchMetaContent(html, "twitter:image");
    if (!og) return null;
    return absolutizeUrl(og, url);
  } catch {
    return null;
  }
}

function matchMetaContent(html: string, prop: string): string | null {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*property\\s*=\\s*["']${escaped}["']`, "i"),
    new RegExp(`<meta[^>]+name\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']+)["'][^>]*name\\s*=\\s*["']${escaped}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

function absolutizeUrl(src: string, base: string): string | null {
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

// ---------- Pipeline ---------------------------------------------------------

async function runSource(
  source: SourceDefinition,
  collectedAt: string,
): Promise<{ result: CollectorRunResult; entries: NormalizedEntry[] }> {
  const start = Date.now();
  try {
    const raw = await source.collect(source);
    const entries = raw.map((r) => applyTags(normalize(r, source, collectedAt)));
    return {
      result: { sourceId: source.id, ok: true, count: entries.length, durationMs: Date.now() - start },
      entries,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        sourceId: source.id,
        ok: false,
        count: 0,
        durationMs: Date.now() - start,
        error: msg,
      },
      entries: [],
    };
  }
}

async function runHarness(env: Env): Promise<{ changed: boolean; stats: Record<string, number> }> {
  const collectedAt = new Date().toISOString();
  // Exclude file-system-backed sources (e.g. user-opml reads data/user-opml.xml).
  const allSources = listSources().filter((s) => s.id !== "user-opml");

  // Cloudflare Free Workers cap subrequests at 50 per invocation, so we cannot
  // fetch all 50 sources in a single run. Rotate sources across SOURCE_BATCHES
  // batches keyed by hour, so each source is refreshed every SOURCE_BATCHES hours.
  // Subrequest budget per run: ~13 sources + 1 GH read + 5 Copilot + 4 OG + 1 GH put = ~24.
  const SOURCE_BATCHES = 4;
  const batchIndex = Math.floor(Date.now() / 3600_000) % SOURCE_BATCHES;
  const sources = allSources.filter((_, i) => i % SOURCE_BATCHES === batchIndex);
  console.log(`[worker] run ${collectedAt}, batch ${batchIndex + 1}/${SOURCE_BATCHES} (${sources.length} of ${allSources.length} sources)`);

  // 0) Read existing index FIRST so we can merge fresh entries from this batch
  //    with prior entries from the other batches (avoids losing data).
  const existing = await ghGetFile(env, "data/index.json");
  let priorEntries: NormalizedEntry[] = [];
  if (existing?.content) {
    try {
      const parsed = JSON.parse(existing.content) as { entries?: NormalizedEntry[] };
      priorEntries = parsed.entries ?? [];
    } catch (err) {
      console.warn(`[worker] failed to parse existing index: ${err}`);
    }
  }

  // 1) Collect (only this batch's sources)
  const settled = await Promise.all(sources.map((s) => runSource(s, collectedAt)));
  const fresh = settled.flatMap((s) => s.entries);
  const okCount = settled.filter((s) => s.result.ok).length;
  console.log(`[worker] collect ok=${okCount}/${sources.length} fresh=${fresh.length} prior=${priorEntries.length}`);

  // 1.5) Merge fresh + prior. Prefer the freshest canonical URL on collision.
  const byUrl = new Map<string, NormalizedEntry>();
  for (const e of priorEntries) setPreferredEntry(byUrl, e);
  for (const e of fresh) setPreferredEntry(byUrl, e);
  const merged = [...byUrl.values()];

  // 2) Cap per source (importance-aware for high-volume sources) then sort newest-first then cap to INDEX_LIMIT.
  const PER_SOURCE_CAP = 50;
  const bySource = new Map<string, NormalizedEntry[]>();
  for (const e of merged) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }
  const pickScore = (e: NormalizedEntry): number => {
    const recencyDays = e.publishedAt
      ? (Date.now() - new Date(e.publishedAt).getTime()) / 86_400_000
      : 365;
    return (e.importance ?? 1) * 1000 - recencyDays;
  };
  const capped: NormalizedEntry[] = [];
  for (const [, arr] of bySource) {
    if (arr.length <= PER_SOURCE_CAP) {
      capped.push(...arr);
      continue;
    }
    const picked = [...arr].sort((a, b) => pickScore(b) - pickScore(a)).slice(0, PER_SOURCE_CAP);
    capped.push(...picked);
  }
  const sorted = capped
    .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt))
    .slice(0, INDEX_LIMIT);

  // 3) Resolve Copilot token (skip if PAT absent)
  let token: string | null = null;
  let copilotError: string | null = null;
  if (env.COPILOT_PAT) {
    try {
      token = await resolveCopilotToken(env.COPILOT_PAT);
    } catch (err) {
      copilotError = err instanceof Error ? err.message : String(err);
      console.warn(`[worker] copilot token exchange failed: ${copilotError}`);
    }
  } else {
    copilotError = "COPILOT_PAT not configured";
  }

  // 4) Summarize — apply KV cache, budget new calls.
  //    Cache stored as a single JSON blob keyed by URL to avoid
  //    hundreds of sequential KV gets (each ~30ms, which exhausts the
  //    Worker wall-time budget of ~30s).
  const model = env.SUMMARIZE_MODEL || "claude-sonnet-4.6";
  const maxNew = Number(env.SUMMARIZE_MAX_NEW || "25");
  const summarizeTimeoutMs = Number(env.SUMMARIZE_TIMEOUT_MS || String(DEFAULT_SUMMARIZE_TIMEOUT_MS));
  const summarizeConcurrency = Math.max(
    1,
    Number(env.SUMMARIZE_CONCURRENCY || String(DEFAULT_SUMMARIZE_CONCURRENCY)),
  );
  const CACHE_KEY = "cache.v1";
  const cacheBlob =
    (await env.SUMMARY_CACHE.get<Record<string, CacheEntry>>(CACHE_KEY, "json")) ?? {};

  const needsSummary: NormalizedEntry[] = [];
  const afterCache: NormalizedEntry[] = [];
  for (const e of sorted) {
    const hit = cacheBlob[e.url];
    const cachedTitleJa = hit?.titleJa || e.titleJa;
    if (hit && cachedTitleJa && hit.summaryJa && hit.summaryEn) {
      afterCache.push({
        ...e,
        titleJa: cachedTitleJa,
        summaryJa: hit.summaryJa,
        summaryEn: hit.summaryEn,
        bodyJa: hit.bodyJa || e.bodyJa || "",
        bodyEn: hit.bodyEn || e.bodyEn || "",
        importance: hit.importance,
        tags: dedupeTags([...e.tags, ...hit.extraTags]),
      });
      // Re-summarize entries cached before bodyJa/bodyEn was introduced.
      if (!hit.bodyJa || !hit.bodyEn) {
        needsSummary.push(e);
      }
    } else {
      needsSummary.push(e);
      afterCache.push(e);
    }
  }

  let summarized = 0;
  let errors = 0;
  if (token && needsSummary.length > 0) {
    const budget = needsSummary.slice(0, maxNew);
    console.log(`[worker] summarize ${budget.length} / ${needsSummary.length} (model=${model})`);
    const results = await runWithConcurrency(
      budget,
      async (e) => {
        for (let attempt = 1; attempt <= SUMMARIZE_ATTEMPTS; attempt++) {
          try {
            const r = await callCopilot(token!, model, e, summarizeTimeoutMs);
            cacheBlob[e.url] = r;
            return { url: e.url, entry: r, ok: true as const };
          } catch (err) {
            if (attempt < SUMMARIZE_ATTEMPTS) {
              console.warn(`[worker] summarize retry ${e.url}: ${err}`);
              await delayMs(500 * attempt);
              continue;
            }
            errors++;
            console.warn(`[worker] summarize err ${e.url}: ${err}`);
            return { url: e.url, ok: false as const };
          }
        }
        return { url: e.url, ok: false as const };
      },
      summarizeConcurrency,
    );
    const byUrl = new Map(
      results.filter((r): r is { url: string; entry: CacheEntry; ok: true } => r.ok).map((r) => [r.url, r.entry]),
    );
    summarized = byUrl.size;
    for (let i = 0; i < afterCache.length; i++) {
      const e = afterCache[i]!;
      const r = byUrl.get(e.url);
      if (r) {
        afterCache[i] = {
          ...e,
          titleJa: r.titleJa || e.titleJa,
          summaryJa: r.summaryJa,
          summaryEn: r.summaryEn || e.summaryEn,
          bodyJa: r.bodyJa || e.bodyJa || "",
          bodyEn: r.bodyEn || e.bodyEn || "",
          importance: r.importance,
          tags: dedupeTags([...e.tags, ...r.extraTags]),
        };
      }
    }
    // Persist the updated blob (single KV put).
    if (summarized > 0) {
      await env.SUMMARY_CACHE.put(CACHE_KEY, JSON.stringify(cacheBlob));
    }
  } else if (!token) {
    console.warn("[worker] no Copilot token — skipping summarization");
  }

  // 4.5) OG image enrichment — fetch <meta property="og:image"> for entries
  //      that still lack a thumbnail. Cached in KV under "og.v1" as a single
  //      blob keyed by URL. Capped per run to stay within Worker subrequest
  //      and CPU budgets.
  const OG_KEY = "og.v1";
  const OG_BUDGET_PER_RUN = 4;
  const ogBlob =
    (await env.SUMMARY_CACHE.get<Record<string, { src: string | null; checkedAt: string }>>(OG_KEY, "json")) ?? {};

  // Apply already-cached og hits.
  for (let i = 0; i < afterCache.length; i++) {
    const e = afterCache[i]!;
    if (e.image) continue;
    const cached = ogBlob[e.url];
    if (cached?.src) {
      afterCache[i] = {
        ...e,
        image: { src: cached.src, origSrc: cached.src, alt: e.title, width: 0, height: 0, source: "og" },
      };
    }
  }

  // Pick fresh URLs to fetch (no entry.image after cache; not in ogBlob yet).
  const ogTargets = afterCache
    .filter((e) => !e.image && !(e.url in ogBlob))
    .slice(0, OG_BUDGET_PER_RUN);

  let ogFound = 0;
  if (ogTargets.length > 0) {
    console.log(`[worker] og fetch ${ogTargets.length} entries`);
    const ogResults = await runWithConcurrency(
      ogTargets,
      async (e) => {
        const src = await fetchOgImage(e.url);
        ogBlob[e.url] = { src, checkedAt: new Date().toISOString() };
        if (src) ogFound++;
        return { url: e.url, src };
      },
      4,
    );
    const byUrl = new Map(ogResults.filter((r) => r.src).map((r) => [r.url, r.src as string]));
    for (let i = 0; i < afterCache.length; i++) {
      const e = afterCache[i]!;
      const src = byUrl.get(e.url);
      if (src && !e.image) {
        afterCache[i] = {
          ...e,
          image: { src, origSrc: src, alt: e.title, width: 0, height: 0, source: "og" },
        };
      }
    }
    if (ogTargets.length > 0) {
      await env.SUMMARY_CACHE.put(OG_KEY, JSON.stringify(ogBlob));
    }
  }
  console.log(`[worker] og: cached=${Object.keys(ogBlob).length}, new hits=${ogFound}`);

  // 5) Build payload (cap newest entries; dropped tier is retained only in reports)
  let summaryFallbacks = 0;
  let bodyFallbacks = 0;
  const contentReady = afterCache.map((entry) => {
    const result = applyDeterministicContentFallback(entry);
    summaryFallbacks += result.summaryFallbacks;
    bodyFallbacks += result.bodyFallbacks;
    return result.entry;
  });
  const retainedEntries = contentReady.filter((entry) => entry.archiveTier !== "dropped");
  const finalEntries = retainedEntries.slice(0, INDEX_LIMIT);
  const failedSources = settled.filter((s) => !s.result.ok).map((s) => s.result.sourceId);
  const health = {
    lastRunAt: new Date().toISOString(),
    batchIndex: batchIndex + 1,
    batchTotal: SOURCE_BATCHES,
    sourcesAttempted: sources.length,
    sourcesOk: settled.filter((s) => s.result.ok).length,
    sourcesFailed: failedSources,
    summarized,
    summarizeErrors: errors,
    summaryFallbacks,
    bodyFallbacks,
    copilotOk: token !== null,
    copilotError,
    ogCached: Object.keys(ogBlob).length,
    ogNewHits: ogFound,
  };
  const payload = {
    generatedAt: new Date().toISOString(),
    count: finalEntries.length,
    health,
    entries: finalEntries,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";

  // 6) Compare with existing index.json on GitHub (already loaded at step 0).
  const existingJson = existing?.content ?? "";
  const existingPayload = existing ? parseJson<{ entries?: NormalizedEntry[] }>("data/index.json", existing.content) : null;
  const existingCount = existingPayload?.entries?.length ?? 0;
  // SAFEGUARD (LL-032): never publish a data/index.json that drops more than
  // half of the entries that were live in the prior commit. A sudden collapse
  // almost always means an upstream read failure (e.g. ghGetFile null) — not a
  // legitimate edit — and silently overwriting main with an empty index has
  // catastrophic blast radius (loss of all live entries + archive integrity).
  // Abort the run and let the next cron retry instead.
  if (existingCount > 20 && finalEntries.length < existingCount / 2) {
    console.error(
      `[worker] aborting publish: finalEntries (${finalEntries.length}) collapsed from prior ${existingCount}; refusing to wipe data/index.json`,
    );
    return {
      changed: false,
      stats: { finalEntries: finalEntries.length, summarized, errors, abortedCollapse: 1 },
    };
  }
  const hasEntryChanges = !entriesEqual(existingPayload, finalEntries);
  // Compare ignoring `generatedAt` timestamp so unchanged runs don't churn commits.
  if (stripGeneratedAt(existingJson) === stripGeneratedAt(json)) {
    console.log("[worker] no data changes");
    return { changed: false, stats: { finalEntries: finalEntries.length, summarized, errors } };
  }

  const message = `chore(data): update tech dashboard ${payload.generatedAt}`;
  const historyStats = hasEntryChanges
    ? await publishHistoryFiles(env, contentReady, finalEntries, payload.generatedAt)
    : {
        archiveMonthsTouched: 0,
        archiveFilesChanged: 0,
        archiveIndexChanged: false,
        statsChanged: false,
        entriesArchived: 0,
        entriesDropped: 0,
        changes: [],
      };
  if (!hasEntryChanges) {
    console.log("[worker] entries unchanged; skip archive/stats refresh");
  }

  // 7) Commit to GitHub. Use one Git Data API commit so index/archive/stats stay in sync.
  const commitSha = await ghCommitFiles(env, message, [
    ...historyStats.changes,
    { path: "data/index.json", content: json },
  ]);
  console.log(`[worker] committed data/index.json (${finalEntries.length} entries)`);
  console.log(
    `[worker] history archiveChanged=${historyStats.archiveFilesChanged}, statsChanged=${historyStats.statsChanged}, commit=${commitSha}`,
  );
  return {
    changed: true,
    stats: {
      finalEntries: finalEntries.length,
      summarized,
      errors,
      ogFound,
      failed: failedSources.length,
      archived: historyStats.entriesArchived,
      dropped: historyStats.entriesDropped,
      archiveFilesChanged: historyStats.archiveFilesChanged,
      statsChanged: historyStats.statsChanged ? 1 : 0,
    },
  };
}

// ---------- Worker entry points ---------------------------------------------

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runHarness(env).catch((err) => {
        const stack = err instanceof Error && err.stack ? err.stack : String(err);
        console.error("[worker] fatal:", stack);
        throw err;
      }),
    );
  },

  // Manual trigger: `curl -X POST https://<worker>.workers.dev/run -H "x-trigger-token: ..."`
  // Returns 202 immediately; the harness runs in background via ctx.waitUntil.
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const authHeader = req.headers.get("x-trigger-token");
      if (!authHeader || authHeader !== env.GH_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      ctx.waitUntil(
        runHarness(env).catch((err) => console.error("[worker] manual run fatal:", err)),
      );
      return Response.json({ ok: true, status: "accepted", note: "running in background; check git log" }, { status: 202 });
    }
    return new Response(
      "tech-dashboard harness worker. POST /run (auth: x-trigger-token) to trigger.",
      { status: 200 },
    );
  },
} satisfies ExportedHandler<Env>;
