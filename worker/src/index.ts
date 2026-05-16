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
  getCacheEntriesWithLegacyFallback,
  putCacheEntry,
} from "./kv-cache.ts";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  groupArchiveEntries,
  mergeArchiveEntries,
  type ArchiveIndexFile,
  type ArchiveMonthFile,
} from "../../harness/publishers/archive-core.ts";
import { buildStatsPayload } from "../../harness/publishers/stats-core.ts";
import type { StatsPayload } from "../../harness/publishers/stats-core.ts";
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
  // Optional Queue producer for the split summarizer Worker (LL-037).
  // Bound only when [[queues.producers]] is uncommented in wrangler.toml.
  SUMMARY_QUEUE?: Queue<SummaryJob>;
  ENABLE_SUMMARY_QUEUE?: string;
  ENQUEUE_MAX_NEW?: string;
}

interface SummaryJob {
  url: string;
  entry: Pick<
    NormalizedEntry,
    "id" | "url" | "title" | "category" | "source" | "sourceType"
  >;
}

const INDEX_LIMIT = 2000;
// Legacy single-blob key. Read-only fallback during the per-URL migration
// (LL-038). New writes go through worker/src/kv-cache.ts (per-URL keys).
const CACHE_KEY = "cache.v1";
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 25_000;
const DEFAULT_SUMMARIZE_CONCURRENCY = 4;
// Retry on Copilot timeout doubles subrequest cost without meaningfully
// raising success rate (sonnet long-form responses just need wall-time,
// not another attempt). Single attempt keeps us within the 1000-subrequest
// per-invocation budget. See LL-034.
const SUMMARIZE_ATTEMPTS = 1;

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

// Read a file from raw.githubusercontent.com (public repo, no auth, no
// redirect). Cheaper in subrequest cost than ghGetFile because Contents API
// calls go through api.github.com with auth + occasional redirects. Use this
// for files whose few-minute Fastly cache staleness is acceptable (archives,
// stats) but NOT for read-after-write-critical files like data/index.json.
// LL-036.
async function ghGetFileRaw(env: Env, path: string): Promise<{ content: string } | null> {
  const url = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "tech-dashboard-worker",
      "cache-control": "no-cache",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gh raw ${path} ${res.status}: ${await res.text()}`);
  return { content: await res.text() };
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
  existing?: { content: string; sha?: string } | null,
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

/**
 * Build a stats payload incrementally from an existing baseline.
 *
 * We can no longer afford to re-read every archive month every cron run
 * (LL-036: ~25 subrequests for untouched months exhausted the 1000/inv
 * budget through redirect amplification). Instead, treat the existing
 * data/stats.json as the source of truth for untouched-month contributions,
 * then subtract the OLD entries of months touched this run and add their
 * NEW (merged) entries plus the current live entries.
 *
 * Invariant: removed ⊆ previous baseline contents. added is the union of
 * live entries and merged touched-month entries. Untouched-month entries
 * never enter `removed` or `added` because their archive file is unchanged.
 *
 * Bootstrap: if existing is null (first run after deploy of this code), we
 * fall back to buildStatsPayload(added) — accurate for everything except
 * untouched-month buckets which will appear empty until the next run that
 * touches them. The next run that touches each month restores accuracy
 * incrementally; in practice the local harness or a manual run can rebuild
 * the full stats once.
 */
function buildIncrementalStats(opts: {
  existing: StatsPayload | null;
  removed: readonly NormalizedEntry[];
  added: readonly NormalizedEntry[];
  generatedAt: string;
}): StatsPayload {
  const { existing, removed, added, generatedAt } = opts;
  if (!existing) return buildStatsPayload(added, generatedAt);

  // Recompute deltas from the entry sets we have.
  const removedStats = buildStatsPayload(removed, generatedAt);
  const addedStats = buildStatsPayload(added, generatedAt);

  type CategoryMap = Partial<Record<string, number>>;
  const mergeCategory = (a: CategoryMap, b: CategoryMap, sign: 1 | -1): CategoryMap => {
    const out: CategoryMap = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const next = (out[k] ?? 0) + sign * (v ?? 0);
      if (next <= 0) delete out[k];
      else out[k] = next;
    }
    return out;
  };

  // byMonth: untouched months unchanged; touched months replaced.
  const monthMap = new Map(existing.byMonth.map((m) => [m.month, { ...m, byCategory: { ...m.byCategory } }]));
  for (const m of removedStats.byMonth) {
    const cur = monthMap.get(m.month);
    if (!cur) continue;
    cur.count -= m.count;
    cur.byCategory = mergeCategory(cur.byCategory, m.byCategory, -1);
    if (cur.count <= 0) monthMap.delete(m.month);
    else monthMap.set(m.month, cur);
  }
  for (const m of addedStats.byMonth) {
    const cur = monthMap.get(m.month) ?? { month: m.month, count: 0, byCategory: {} as CategoryMap };
    cur.count += m.count;
    cur.byCategory = mergeCategory(cur.byCategory, m.byCategory, 1);
    monthMap.set(m.month, cur);
  }

  // byDay: same logic, but only last 90d is retained by buildStatsPayload, so
  // we use addedStats.byDay as the new source of truth for any day it
  // touches, and remove any baseline day that fell out of the 90d window.
  const dayMap = new Map(existing.byDay.map((d) => [d.date, { ...d, byCategory: { ...d.byCategory } }]));
  for (const d of removedStats.byDay) {
    const cur = dayMap.get(d.date);
    if (!cur) continue;
    cur.count -= d.count;
    cur.byCategory = mergeCategory(cur.byCategory, d.byCategory, -1);
    if (cur.count <= 0) dayMap.delete(d.date);
    else dayMap.set(d.date, cur);
  }
  for (const d of addedStats.byDay) {
    const cur = dayMap.get(d.date) ?? { date: d.date, count: 0, byCategory: {} as CategoryMap };
    cur.count += d.count;
    cur.byCategory = mergeCategory(cur.byCategory, d.byCategory, 1);
    dayMap.set(d.date, cur);
  }
  // Prune days older than 90 days relative to generatedAt.
  const cutoffDay = new Date(new Date(generatedAt).getTime() - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const date of [...dayMap.keys()]) {
    if (date < cutoffDay) dayMap.delete(date);
  }

  // bySource: subtract removed contributions, add added.
  const sourceMap = new Map(existing.bySource.map((s) => [s.source, { ...s }]));
  for (const s of removedStats.bySource) {
    const cur = sourceMap.get(s.source);
    if (!cur) continue;
    cur.total -= s.total;
    cur.last30d -= s.last30d;
    if (cur.total <= 0) sourceMap.delete(s.source);
    else sourceMap.set(s.source, cur);
  }
  for (const s of addedStats.bySource) {
    const cur = sourceMap.get(s.source) ?? { source: s.source, total: 0, last30d: 0 };
    cur.total += s.total;
    cur.last30d += s.last30d;
    sourceMap.set(s.source, cur);
  }

  const byImportance: Record<"1" | "2" | "3", number> = {
    "1": Math.max(0, existing.byImportance["1"] - removedStats.byImportance["1"] + addedStats.byImportance["1"]),
    "2": Math.max(0, existing.byImportance["2"] - removedStats.byImportance["2"] + addedStats.byImportance["2"]),
    "3": Math.max(0, existing.byImportance["3"] - removedStats.byImportance["3"] + addedStats.byImportance["3"]),
  };

  const totals = {
    allTime: Math.max(0, existing.totals.allTime - removedStats.totals.allTime + addedStats.totals.allTime),
    last30d: Math.max(0, existing.totals.last30d - removedStats.totals.last30d + addedStats.totals.last30d),
    last7d: Math.max(0, existing.totals.last7d - removedStats.totals.last7d + addedStats.totals.last7d),
    last24h: Math.max(0, existing.totals.last24h - removedStats.totals.last24h + addedStats.totals.last24h),
  };

  return {
    generatedAt,
    totals,
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byMonth: [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
    bySource: [...sourceMap.values()].sort((a, b) => b.total - a.total),
    byImportance,
  };
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
  // includeHot: true keeps current-month hot entries in the monthly archive
  // so byDay stats remain stable even after entries get evicted from the live
  // index by PER_SOURCE_CAP or age into `dropped`.
  const { byMonth, stats } = groupArchiveEntries(archiveInputEntries, { includeHot: true });
  const archiveIndexPath = "data/archive/_index.json";
  const statsPath = "data/stats.json";

  // Read archive _index + existing stats in parallel (2 subrequests).
  // These are read-after-write critical so use the Contents API for _index;
  // stats is fine via raw CDN because we only use it as a baseline to merge.
  const [archiveIndexFile, existingStatsRaw] = await Promise.all([
    ghGetFile(env, archiveIndexPath),
    ghGetFileRaw(env, statsPath),
  ]);
  const archiveIndex = archiveIndexFile
    ? parseJson<ArchiveIndexFile>(archiveIndexPath, archiveIndexFile.content)
    : null;
  const existingStats = existingStatsRaw
    ? parseJson<StatsPayload>(statsPath, existingStatsRaw.content)
    : null;

  // ONLY read months that received new entries this run. Previously we read
  // every month in archive_index (~25 months → ~25 subrequests + redirect
  // amplification on the Standard plan's 1000/inv budget). Untouched months
  // keep their archive file content as-is; we carry their stats contribution
  // forward from existing data/stats.json. LL-036.
  const touchedMonths = [...byMonth.keys()].sort();
  const existingTouchedFiles = await Promise.all(
    touchedMonths.map((month) => ghGetFileRaw(env, `data/archive/${month}.json`)),
  );

  const monthFiles = new Map<string, ArchiveMonthFile>();
  const oldTouchedEntries: NormalizedEntry[] = [];
  const newTouchedEntries: NormalizedEntry[] = [];
  const changes: FileChange[] = [];
  let archiveFilesChanged = 0;

  for (let i = 0; i < touchedMonths.length; i++) {
    const month = touchedMonths[i];
    const path = `data/archive/${month}.json`;
    const existingFile = existingTouchedFiles[i];
    const existingMonth = existingFile ? parseJson<ArchiveMonthFile>(path, existingFile.content) : null;
    const incomingEntries = byMonth.get(month) ?? [];
    const mergedEntries = mergeArchiveEntries(existingMonth?.entries ?? [], incomingEntries);
    if (mergedEntries.length === 0) continue;

    const monthPayload = buildArchiveMonthFile(month, mergedEntries, generatedAt);
    monthFiles.set(month, monthPayload);
    oldTouchedEntries.push(...(existingMonth?.entries ?? []));
    newTouchedEntries.push(...mergedEntries);

    const change = await ghJsonChangeIfChanged(env, path, monthPayload, existingFile ?? null);
    if (change) {
      changes.push(change);
      archiveFilesChanged++;
    }
  }

  // Build archive _index by overlaying touched-month counts onto the existing
  // perMonth map (untouched months keep their prior count).
  const newPerMonth: Record<string, number> = { ...(archiveIndex?.perMonth ?? {}) };
  for (const [month, file] of monthFiles) newPerMonth[month] = file.count;
  const allKnownMonths = Object.keys(newPerMonth)
    .filter((m) => /^\d{4}-\d{2}$/.test(m))
    .sort();
  const indexInputs: ArchiveMonthFile[] = allKnownMonths.map((month) => ({
    generatedAt,
    month,
    count: newPerMonth[month],
    entries: [],
  }));
  const archiveIndexPayload = buildArchiveIndexFile(indexInputs, generatedAt);
  const archiveIndexChange = await ghJsonChangeIfChanged(env, archiveIndexPath, archiveIndexPayload, archiveIndexFile);
  if (archiveIndexChange) changes.push(archiveIndexChange);

  // Incremental stats: start from existing baseline, subtract contributions of
  // old touched-month entries, add contributions of merged touched-month +
  // live entries. Untouched-month contributions remain accurate because the
  // archive files themselves were not modified this run.
  const statsPayload = buildIncrementalStats({
    existing: existingStats,
    removed: oldTouchedEntries,
    added: uniqueEntriesById([...liveEntries, ...newTouchedEntries]),
    generatedAt,
  });
  const statsChange = await ghJsonChangeIfChanged(env, statsPath, statsPayload, existingStatsRaw ?? null);
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

async function runHarness(
  env: Env,
  opts: { batchOverride?: number } = {},
): Promise<{ changed: boolean; stats: Record<string, number> }> {
  const collectedAt = new Date().toISOString();
  // Exclude file-system-backed sources (e.g. user-opml reads data/user-opml.xml).
  const allSources = listSources().filter((s) => s.id !== "user-opml");

  // Cloudflare Free Workers cap subrequests at 50 per invocation, so we cannot
  // fetch all 50 sources in a single run. Rotate sources across SOURCE_BATCHES
  // batches keyed by hour, so each source is refreshed every SOURCE_BATCHES hours.
  // Subrequest budget per run: ~13 sources + 1 GH read + 5 Copilot + 4 OG + 1 GH put = ~24.
  const SOURCE_BATCHES = 4;
  const naturalBatch = Math.floor(Date.now() / 3600_000) % SOURCE_BATCHES;
  const batchIndex =
    opts.batchOverride !== undefined
      ? ((opts.batchOverride % SOURCE_BATCHES) + SOURCE_BATCHES) % SOURCE_BATCHES
      : naturalBatch;
  const sources = allSources.filter((_, i) => i % SOURCE_BATCHES === batchIndex);
  console.log(`[worker] run ${collectedAt}, batch ${batchIndex + 1}/${SOURCE_BATCHES} (${sources.length} of ${allSources.length} sources)${opts.batchOverride !== undefined ? " [forced]" : ""}`);

  // 0) Read existing index FIRST so we can merge fresh entries from this batch
  //    with prior entries from the other batches (avoids losing data).
  //
  // CRITICAL (LL-040): Use raw.githubusercontent.com here. GitHub Contents
  // API silently returns content="" for files >1MB; data/index.json grew
  // past 1MB which made every cron run drop ALL prior entries (collapsing
  // ~947 → ~227 each cron). raw.* has up to ~5min Fastly cache but cron
  // runs are 60min apart so staleness is acceptable.
  const existing = await ghGetFileRaw(env, "data/index.json");
  let priorEntries: NormalizedEntry[] = [];
  if (existing?.content) {
    try {
      const parsed = JSON.parse(existing.content) as { entries?: NormalizedEntry[] };
      priorEntries = parsed.entries ?? [];
    } catch (err) {
      console.warn(`[worker] failed to parse existing index: ${err}`);
    }
  }

  // 1) Collect (only this batch's sources). Throttle to COLLECT_CONCURRENCY
  // simultaneous fetches so we don't hit Cloudflare Workers' simultaneous
  // outbound connection ceiling (~6) or burn the 1000-subrequest budget on
  // redirect chains compounded across parallel fetches. LL-035.
  const COLLECT_CONCURRENCY = 5;
  const settled = await runWithConcurrency(
    [...sources],
    (s) => runSource(s, collectedAt),
    COLLECT_CONCURRENCY,
  );
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
  // Per-URL KV (LL-038). To stay under the 1000-subrequest/invocation cap
  // we only read KV for entries that might need a cache update — entries
  // that already carry a real AI summary in the merged data (summaryJa not
  // empty AND not the deterministic-fallback lead 「このエントリは 」) are
  // trusted as-is and skipped. Fallback entries are checked because the
  // summarizer Worker may have written a real summary into KV since the
  // previous cron run.
  const FALLBACK_SUMMARY_PREFIX = "このエントリは ";
  const needsKvLookup = sorted.filter(
    (e) => !e.summaryJa || e.summaryJa.startsWith(FALLBACK_SUMMARY_PREFIX),
  );
  // Track which URLs we actually issued a KV.get for. A URL absent from this
  // Set was skipped because it already carries a real AI summary in the
  // merged data (do not enqueue). A URL present in the Set but absent from
  // hitsByUrl is a genuine KV miss — the entry has no cached summary yet
  // and MUST be enqueued so the summarizer Worker can generate one.
  const lookedUpUrls = new Set(needsKvLookup.map((e) => e.url));
  const hitsByUrl = await getCacheEntriesWithLegacyFallback(
    env.SUMMARY_CACHE,
    needsKvLookup.map((e) => e.url),
    CACHE_KEY,
  );
  console.log(
    `[worker] cache lookups ${needsKvLookup.length} / ${sorted.length} (skipped ${sorted.length - needsKvLookup.length} entries with real summaries)`,
  );

  const needsSummary: NormalizedEntry[] = [];
  const afterCache: NormalizedEntry[] = [];
  for (const e of sorted) {
    const hit = hitsByUrl.get(e.url);
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
    } else if (!hit && e.summaryJa && !e.summaryJa.startsWith(FALLBACK_SUMMARY_PREFIX)) {
      // Skipped KV lookup; entry already has a real summary from a prior run.
      afterCache.push(e);
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
            // Per-URL KV write (LL-038). Independent per entry so parallel
            // workers never clobber each other.
            await putCacheEntry(env.SUMMARY_CACHE, e.url, r);
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
      try {
        await env.SUMMARY_CACHE.put(OG_KEY, JSON.stringify(ogBlob));
      } catch (err) {
        // LL-043: KV writes have a 1000/day free-tier cap. Swallow this
        // particular failure so the publish + Queue enqueue path still
        // completes — the OG blob can refresh on a later cron when the
        // daily allowance resets at UTC midnight.
        console.warn(`[worker] og kv put skipped: ${err}`);
      }
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
  // NOTE: Queue enqueue must run BEFORE this early-return because cache
  // state (some entries are still fallbacks) is independent of whether the
  // index payload changed. A manual /run hitting "no data changes" should
  // still push outstanding fallback entries onto the Queue so the
  // summarizer Worker can process them. We intentionally pay one extra
  // KV.get loop on no-op runs to keep the autonomous backfill flowing.
  if (stripGeneratedAt(existingJson) === stripGeneratedAt(json)) {
    console.log("[worker] no data changes");
    const enqueuedNoop = await maybeEnqueueSummaryJobs(env, finalEntries, hitsByUrl, lookedUpUrls);
    if (enqueuedNoop > 0) {
      console.log(`[worker] enqueued ${enqueuedNoop} summary jobs (no-op publish path)`);
    }
    return { changed: false, stats: { finalEntries: finalEntries.length, summarized, errors, enqueued: enqueuedNoop } };
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

  // 8) Optional: enqueue uncached entries to the summarizer Queue (LL-037).
  // Off by default; activate via wrangler.toml (ENABLE_SUMMARY_QUEUE=1 and
  // [[queues.producers]] binding). We reuse `hitsByUrl` collected earlier
  // in this run to avoid a second 900+ per-URL KV.get pass that would blow
  // through the Standard plan's 1000-subrequest/invocation budget.
  const enqueued = await maybeEnqueueSummaryJobs(env, finalEntries, hitsByUrl, lookedUpUrls);
  if (enqueued > 0) {
    console.log(`[worker] enqueued ${enqueued} summary jobs`);
  }

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
      enqueued,
    },
  };
}

/**
 * Send up to ENQUEUE_MAX_NEW entries lacking a real cached summary to the
 * SUMMARY_QUEUE. Returns the number actually enqueued. No-op when disabled
 * or when the queue binding is missing.
 */
async function maybeEnqueueSummaryJobs(
  env: Env,
  entries: readonly NormalizedEntry[],
  hitsByUrl: Map<string, CacheEntry>,
  lookedUpUrls: Set<string>,
): Promise<number> {
  if (env.ENABLE_SUMMARY_QUEUE !== "1") return 0;
  if (!env.SUMMARY_QUEUE) {
    console.warn("[worker] ENABLE_SUMMARY_QUEUE=1 but SUMMARY_QUEUE binding missing");
    return 0;
  }
  // hitsByUrl + lookedUpUrls were populated earlier in runHarness from
  // per-URL KV + legacy cache.v1 fallback. Reusing them here saves ~900
  // subrequests per cron and keeps us under the 1000/inv cap. We need both:
  // hitsByUrl alone cannot distinguish "entry skipped because real summary
  // exists" (don't enqueue) from "entry looked up but KV miss" (DO enqueue
  // — the summarizer Worker must populate cache).
  const cap = Math.max(1, Number(env.ENQUEUE_MAX_NEW ?? 5));

  const candidates: SummaryJob[] = [];
  for (const e of entries) {
    if (candidates.length >= cap) break;
    if (!lookedUpUrls.has(e.url)) {
      // Skipped KV lookup; entry already carries a real AI summary. Skip.
      continue;
    }
    const hit = hitsByUrl.get(e.url);
    const hasRealCache =
      hit &&
      hit.summaryJa &&
      hit.summaryEn &&
      hit.bodyJa &&
      hit.bodyEn &&
      hit.model !== "deterministic-fallback";
    if (hasRealCache) continue;
    candidates.push({
      url: e.url,
      entry: {
        id: e.id,
        url: e.url,
        title: e.title,
        category: e.category,
        source: e.source,
        sourceType: e.sourceType,
      },
    });
  }

  // Queue.sendBatch caps at 100 messages and 256 KB per call. Chunk so the
  // producer can keep sending large backfill waves without hitting
  // "Payload Too Large".
  if (candidates.length === 0) return 0;
  const CHUNK = 100;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const slice = candidates.slice(i, i + CHUNK);
    await env.SUMMARY_QUEUE.sendBatch(slice.map((body) => ({ body })));
  }
  return candidates.length;
}

// ---------- Worker entry points ---------------------------------------------

export default {
  // Await runHarness directly: the scheduled handler itself can use the full
  // cron wall-time budget. ctx.waitUntil is bounded to a short window after
  // invocation end, which previously cancelled mid-collection (LL-033).
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runHarness(env);
    } catch (err) {
      const stack = err instanceof Error && err.stack ? err.stack : String(err);
      console.error("[worker] fatal:", stack);
      throw err;
    }
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
    // Option B diagnostic: probe Worker -> Copilot connectivity with full
    // timing/header capture. Returns observations as JSON so we can compare
    // to local curl behavior without relying on tail timing.
    //   curl -X POST https://<worker>/diag/copilot -H "x-trigger-token: ..."
    if (url.pathname === "/diag/copilot" && req.method === "POST") {
      const authHeader = req.headers.get("x-trigger-token");
      if (!authHeader || authHeader !== env.GH_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const observations: Record<string, unknown> = {};
      // Query param ?big=1 sends a max_tokens=2400 bilingual prompt to mimic
      // the real summarize workload.
      const big = url.searchParams.get("big") === "1";
      try {
        const tExchangeStart = Date.now();
        const token = await resolveCopilotToken(env.COPILOT_PAT);
        observations.tokenExchangeMs = Date.now() - tExchangeStart;
        observations.tokenLength = token.length;
        observations.tokenPrefix = token.slice(0, 6);
        observations.mode = big ? "big(2400)" : "min(10)";
        // Single chat completion to measure E2E reachability.
        const controller = new AbortController();
        const timeoutMs = 28_000;
        const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
        const tFetchStart = Date.now();
        try {
          const body = big
            ? {
                model: env.SUMMARIZE_MODEL || "claude-sonnet-4.6",
                temperature: 0.2,
                max_tokens: 2400,
                messages: [
                  {
                    role: "system",
                    content:
                      "あなたは技術記事を日本語と英語の両方で要約するエディターです。指示された JSON 形式のみを返してください。",
                  },
                  {
                    role: "user",
                    content:
                      '以下の記事を日英二言語で要約。JSON: {"titleJa":"...","summaryJa":"...","summaryEn":"...","bodyJa":"...(約400字)","bodyEn":"...(about 400 words)","importance":1,"extraTags":[]}\n\nタイトル: Claude Opus 4.7 announcement\n本文: Anthropic released Claude Opus 4.7 with improvements to coding, reasoning, and tool use. The model achieves state-of-the-art on SWE-bench, supports 1M context, and includes new capabilities for agentic workflows.',
                  },
                ],
              }
            : {
                model: env.SUMMARIZE_MODEL || "claude-sonnet-4.6",
                max_tokens: 10,
                messages: [{ role: "user", content: "Reply with exactly: OK" }],
              };
          const res = await fetch(COPILOT_ENDPOINT, {
            method: "POST",
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              ...COPILOT_HEADERS,
            },
            body: JSON.stringify(body),
          });
          observations.fetchMs = Date.now() - tFetchStart;
          observations.status = res.status;
          observations.statusText = res.statusText;
          observations.responseHeaders = Object.fromEntries(res.headers.entries());
          const text = await res.text();
          observations.bodyPreview = text.slice(0, 300);
        } catch (err) {
          observations.fetchMs = Date.now() - tFetchStart;
          observations.fetchError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          observations.aborted = controller.signal.aborted;
          observations.abortReason = controller.signal.aborted ? String(controller.signal.reason) : null;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        observations.tokenExchangeError =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      return Response.json(observations, { status: 200 });
    }
    // Option B diagnostic: time each source in the current batch (or all
    // sources with ?all=1) and return per-source ok/duration/count/error.
    // Lets us see whether collection alone is busting wall-time/subrequest
    // budget and which source(s) are responsible.
    //   curl -X POST https://<worker>/diag/collect -H "x-trigger-token: ..."
    if (url.pathname === "/diag/collect" && req.method === "POST") {
      const authHeader = req.headers.get("x-trigger-token");
      if (!authHeader || authHeader !== env.GH_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const all = url.searchParams.get("all") === "1";
      const onlyId = url.searchParams.get("only");
      const allSources = listSources().filter((s) => s.id !== "user-opml");
      const batchIndex = Math.floor(Date.now() / 3600_000) % 4;
      const sources = onlyId
        ? allSources.filter((s) => s.id === onlyId)
        : all
        ? allSources
        : allSources.filter((_, i) => i % 4 === batchIndex);
      const collectedAt = new Date().toISOString();
      const tStart = Date.now();
      const settled = await Promise.all(
        sources.map(async (s) => {
          const t = Date.now();
          try {
            const raw = await s.collect(s);
            return {
              id: s.id,
              ok: true as const,
              count: raw.length,
              durationMs: Date.now() - t,
            };
          } catch (err) {
            return {
              id: s.id,
              ok: false as const,
              durationMs: Date.now() - t,
              error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            };
          }
        }),
      );
      const totalMs = Date.now() - tStart;
      const okCount = settled.filter((r) => r.ok).length;
      const totalEntries = settled.reduce((acc, r) => acc + (r.ok ? r.count : 0), 0);
      return Response.json(
        {
          collectedAt,
          batchIndex: batchIndex + 1,
          mode: all ? "all" : "current-batch",
          sourceCount: sources.length,
          okCount,
          totalEntries,
          totalMs,
          slowest: [...settled].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
          failed: settled.filter((r) => !r.ok),
          all: settled,
        },
        { status: 200 },
      );
    }
    // Force-run a specific batch (or natural batch) with AWAIT, so the HTTP
    // response blocks until the harness completes (no waitUntil cancellation).
    // Use to recover sources from batches that were lost during outage.
    //   curl -X POST "https://<worker>/diag/run-batch?batch=3" \
    //     -H "x-trigger-token: ..." --max-time 180
    // Subrequest profiling is on by default; append `&profile=0` to disable.
    // Response includes `fetchProfile` with total subrequests, byHost,
    // byBucket (host + first path segment), slowest URLs, and errors.
    if (url.pathname === "/diag/run-batch" && req.method === "POST") {
      const authHeader = req.headers.get("x-trigger-token");
      if (!authHeader || authHeader !== env.GH_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const batchParam = url.searchParams.get("batch");
      const batchOverride = batchParam !== null ? Number(batchParam) : undefined;
      if (batchOverride !== undefined && !Number.isInteger(batchOverride)) {
        return new Response("invalid batch param", { status: 400 });
      }
      const profile = url.searchParams.get("profile") !== "0";
      const t = Date.now();

      // Wrap globalThis.fetch to count subrequests by host + path-prefix so we
      // can see where the 1000-per-invocation budget is being spent. LL-036.
      const originalFetch = globalThis.fetch;
      const fetchLog: Array<{ url: string; method: string; status: number; ms: number }> = [];
      if (profile) {
        const wrapped: typeof fetch = async (input, init) => {
          const start = Date.now();
          const reqUrl =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;
          const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
          try {
            const res = await originalFetch(input as RequestInfo, init);
            fetchLog.push({ url: reqUrl, method, status: res.status, ms: Date.now() - start });
            return res;
          } catch (err) {
            fetchLog.push({ url: reqUrl, method, status: -1, ms: Date.now() - start });
            throw err;
          }
        };
        (globalThis as { fetch: typeof fetch }).fetch = wrapped;
      }

      const buildProfile = () => {
        const byHost = new Map<string, number>();
        const byBucket = new Map<string, number>();
        for (const e of fetchLog) {
          let host = e.url;
          let bucket = e.url;
          try {
            const u = new URL(e.url);
            host = u.host;
            const seg = u.pathname.split("/").filter(Boolean)[0] ?? "";
            bucket = `${u.host}/${seg}`;
          } catch {}
          byHost.set(host, (byHost.get(host) ?? 0) + 1);
          byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
        }
        const sortDesc = (m: Map<string, number>) =>
          [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v }));
        return {
          total: fetchLog.length,
          byHost: sortDesc(byHost),
          byBucket: sortDesc(byBucket).slice(0, 30),
          slowest: [...fetchLog].sort((a, b) => b.ms - a.ms).slice(0, 20),
          errors: fetchLog.filter((e) => e.status < 0 || e.status >= 500).slice(0, 30),
        };
      };

      try {
        const result = await runHarness(env, { batchOverride });
        return Response.json(
          {
            ok: true,
            batchOverride,
            elapsedMs: Date.now() - t,
            ...result,
            ...(profile ? { fetchProfile: buildProfile() } : {}),
          },
          { status: 200 },
        );
      } catch (err) {
        return Response.json(
          {
            ok: false,
            batchOverride,
            elapsedMs: Date.now() - t,
            error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            ...(profile ? { fetchProfile: buildProfile() } : {}),
          },
          { status: 500 },
        );
      } finally {
        if (profile) {
          (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
        }
      }
    }
    return new Response(
      "tech-dashboard harness worker. POST /run (auth: x-trigger-token) to trigger.",
      { status: 200 },
    );
  },
} satisfies ExportedHandler<Env>;
