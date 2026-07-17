/**
 * Shared publisher runtime executed by the GitHub Actions Node job.
 *
 * The runtime collects sources, normalizes and dedupes entries, prepares
 * deferred Queue/KV effects, and commits the related data artifacts through
 * an immutable-snapshot CAS. The deployed Cloudflare harness is only the
 * OIDC-authenticated Free-plan bridge and does not execute this module.
 */
import { listSources } from "../../harness/registry.ts";
import { mergeEntryEnrichment } from "../../harness/pipeline/entry-merge.ts";
import { normalize, restampEntryFromSource } from "../../harness/pipeline/normalize.ts";
import {
  evaluateKeywordFilter,
  keywordFilterEntryFromNormalized,
} from "../../harness/pipeline/source-filter.ts";
import { applyTags, normalizeTags } from "../../harness/pipeline/tag.ts";
import { canonicalUrlKey, normalizeMediaUrl } from "../../harness/pipeline/url.ts";
import { applyDeterministicContentFallback } from "./content-fallback.ts";
import {
  needsGeneratedContent,
  selectSummaryJobBatch,
  selectSummaryLookupEntries,
  type SummaryJob,
} from "./summary-queue.ts";
import { type BodyJob } from "./body-generate.ts";
import {
  bodyBacklogAfterMerge,
  bodyEnqueueAllowance,
  DEFAULT_BODY_RETENTION_DAYS,
  isBodyRetentionEligible,
  selectBodyPipelineJobs,
} from "./body-queue.ts";
import {
  bodyCacheEntryMatchesPublisherContract,
  getBodyCacheEntries,
} from "./body-cache.ts";
import {
  bodiesPresentSet,
  mergeBodies,
  parseBodies,
  serializeBodies,
  type NewBody,
} from "./bodies-file.ts";
import {
  cacheEntryMatchesPublisherContract,
  cacheMetadataMatchesPublisherContract,
  getCacheEntriesWithLegacyFallback,
  putCacheEntry,
  type CacheEntry,
} from "./kv-cache.ts";
import {
  assertPublisherContractContent,
  DEPLOYED_PUBLISHER_FINGERPRINT,
  PUBLISHER_CONTRACT_PATH,
} from "./publisher-contract.ts";
import type {
  KeyValueBinding,
  QueueBatchBinding,
} from "./runtime-bindings.ts";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  groupArchiveEntries,
  mergeArchiveEntries,
  synchronizeArchiveTagsFromLive,
  type ArchiveIndexFile,
  type ArchiveMonthFile,
} from "../../harness/publishers/archive-core.ts";
import { buildStatsPayloadFromArtifacts } from "../../harness/publishers/stats-core.ts";
import type { StatsPayload } from "../../harness/publishers/stats-core.ts";
import type {
  NormalizedEntry,
  CollectorRunResult,
  SourceDefinition,
} from "../../harness/types.ts";

export interface GithubRepositoryEnv {
  GH_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
}

export interface PublisherEnv extends GithubRepositoryEnv {
  SUMMARY_CACHE: KeyValueBinding;
  COPILOT_PAT: string;
  SUMMARIZE_MODEL: string;
  SUMMARIZE_MAX_NEW: string;
  SUMMARIZE_TIMEOUT_MS?: string;
  SUMMARIZE_CONCURRENCY?: string;
  // Optional Queue producer for the split summarizer Worker (LL-037).
  SUMMARY_QUEUE?: QueueBatchBinding<SummaryJob>;
  ENABLE_SUMMARY_QUEUE?: string;
  ENQUEUE_MAX_NEW?: string;
  // Shared per-run Queue write allowance. Summary jobs have priority and body
  // jobs use the remaining capacity so combined KV writes stay bounded.
  ENRICHMENT_ENQUEUE_MAX_TOTAL?: string;
  // Recent summarizer retry URLs can be skipped briefly to avoid repeatedly
  // enqueueing the same incomplete-output failure every cron.
  SUMMARY_RETRY_COOLDOWN_MS?: string;
  // Max number of fallback entries to look up in KV per cron. Cap exists to
  // stay under Cloudflare's Worker subrequest budgets once the fallback
  // backlog grows. See LL-042 follow-up.
  KV_LOOKUP_CAP?: string;
  // Max number of missing thumbnails to fetch from article pages per cron.
  OG_BUDGET_PER_RUN?: string;
  // Optional Queue producer for the body Worker (body-file Phase B, LL-115).
  // When ENABLE_BODY_QUEUE !== "1" the whole body pipeline is a no-op, so the
  // collector can deploy this code safely before the body queue + worker exist.
  BODY_QUEUE?: QueueBatchBinding<BodyJob>;
  ENABLE_BODY_QUEUE?: string;
  // Max body jobs to enqueue per cron (consumer writes one `b:` KV per job,
  // bounded by the shared KV daily write budget, LL-043).
  BODY_ENQUEUE_MAX_NEW?: string;
  BODY_RETENTION_DAYS?: string;
  // Max current body candidates to inspect per run. Previous-run jobs receive
  // a separate bounded lookup so generated bodies are merged promptly.
  BODY_LOOKUP_CAP?: string;
}

export interface PublisherCommitFile {
  path: string;
  content: string;
}

export type PublisherCommitSink = (
  env: GithubRepositoryEnv,
  message: string,
  files: PublisherCommitFile[],
  expectedParentSha: string,
) => Promise<string | null>;

export interface RunHarnessOptions {
  batchOverride?: number;
  commitFiles?: PublisherCommitSink;
}

const INDEX_LIMIT = 2000;
// Legacy single-blob key. Read-only fallback during the per-URL migration
// (LL-038). New writes go through worker/src/kv-cache.ts (per-URL keys).
const CACHE_KEY = "cache.v1";
const SUMMARIZER_ISSUE_KEY = "summarizer.issue.v1";
const DEFAULT_SUMMARIZE_TIMEOUT_MS = 25_000;
const DEFAULT_SUMMARIZE_CONCURRENCY = 4;
const DEFAULT_SUMMARY_RETRY_COOLDOWN_MS = 2 * 60 * 60_000;
export const SOURCE_BATCHES = 6;
// Retry on Copilot timeout doubles subrequest cost without meaningfully
// raising success rate (sonnet long-form responses just need wall-time,
// not another attempt). Single attempt keeps us within the 1000-subrequest
// per-invocation budget. See LL-034.
const SUMMARIZE_ATTEMPTS = 1;

export function sourceBatchIndexAt(nowMs: number): number {
  return Math.floor(nowMs / 3600_000) % SOURCE_BATCHES;
}

export function assertSafePublisherEntryCount(
  existingCount: number,
  finalCount: number,
): void {
  if (existingCount > 20 && finalCount < existingCount / 2) {
    throw new Error(
      `aborting publish: finalEntries (${finalCount}) collapsed from prior ${existingCount}; refusing to wipe data/index.json`,
    );
  }
}

interface SummarizerIssue {
  status?: unknown;
  at?: unknown;
  url?: unknown;
}

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

function recentRetryCooldownUrls(
  issue: SummarizerIssue | null,
  nowMs: number,
  cooldownMs: number,
): Set<string> {
  if (cooldownMs <= 0) return new Set();
  if (issue?.status !== "retry" || typeof issue.url !== "string" || typeof issue.at !== "string") {
    return new Set();
  }
  const issueAt = Date.parse(issue.at);
  if (!Number.isFinite(issueAt) || nowMs - issueAt > cooldownMs) {
    return new Set();
  }
  return new Set([issue.url]);
}

async function readSummaryRetryCooldownUrls(env: PublisherEnv): Promise<Set<string>> {
  const cooldownMs = Number(env.SUMMARY_RETRY_COOLDOWN_MS ?? DEFAULT_SUMMARY_RETRY_COOLDOWN_MS);
  try {
    const issue = await env.SUMMARY_CACHE.get<SummarizerIssue>(SUMMARIZER_ISSUE_KEY, "json");
    return recentRetryCooldownUrls(issue, Date.now(), Number.isFinite(cooldownMs) ? cooldownMs : 0);
  } catch (err) {
    console.warn(`[worker] summarizer retry cooldown read failed: ${err}`);
    return new Set();
  }
}

function entryPassesCurrentSourceFilter(
  entry: NormalizedEntry,
  sourceDef: SourceDefinition | undefined,
): boolean {
  if (!sourceDef) return true;
  return evaluateKeywordFilter(keywordFilterEntryFromNormalized(entry), sourceDef, {
    allowLossyMissingInclude: true,
  }).keep;
}

export function applyCurrentSourceRules(
  entry: NormalizedEntry,
  sourceDef: SourceDefinition | undefined,
  referenceAt: string,
): NormalizedEntry | null {
  if (!sourceDef) return entry;
  const restamped = applyTags(restampEntryFromSource(entry, sourceDef, referenceAt));
  return entryPassesCurrentSourceFilter(restamped, sourceDef) ? restamped : null;
}

export function mergeFreshAndPriorEntries(
  fresh: readonly NormalizedEntry[],
  priorEntries: readonly NormalizedEntry[],
  sourceDefMap: ReadonlyMap<string, SourceDefinition>,
  referenceAt: string,
): { entries: NormalizedEntry[]; filteredPriorCount: number } {
  const filteredPrior = priorEntries
    .map((entry) => applyCurrentSourceRules(entry, sourceDefMap.get(entry.source), referenceAt))
    .filter((entry): entry is NormalizedEntry => entry !== null);
  const byUrl = new Map<string, NormalizedEntry>();
  for (const entry of filteredPrior) setPreferredEntry(byUrl, entry);
  for (const entry of fresh) setPreferredEntry(byUrl, entry);
  return {
    entries: [...byUrl.values()],
    filteredPriorCount: priorEntries.length - filteredPrior.length,
  };
}
const COPILOT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
} as const;

export interface FileChange {
  path: string;
  content: string;
}

// ---------- GitHub Contents API helpers --------------------------------------

// A bare fetch() has no timeout. If GitHub (api.github.com / raw.githubusercontent.com)
// stalls, the request hangs until Cloudflare kills the whole invocation *without
// a catchable error* — so scheduled()'s catch never runs, no failure heartbeat is
// written, and the last "pre-publish" heartbeat goes stale, tripping the
// "cron appears stuck after pre-publish heartbeat" health alert (LL-111). Bound
// every GitHub call with an AbortController so a hang throws instead, letting the
// run fail cleanly (error heartbeat) and the next cron retry. The collectors
// already do this (rss/anthropic use an 8s timeout); the GitHub helpers did not.
const GITHUB_FETCH_TIMEOUT_MS = 15_000;
const GITHUB_FETCH_RETRIES = 2;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface GhFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: (attempt: number) => number;
}

// GitHub fetch with timeout + retry on transient failures: a request that never
// got a response (timeout / network error) or a 429/5xx server error is retried.
// 4xx (incl. 404) is returned to the caller unretried because it is deterministic
// (auth, not-found). Retrying the Git Data API calls in ghCommitFiles is safe:
// blobs/trees are content-addressed, an orphaned commit is GC'd, and a ref PATCH
// to an already-applied sha is a no-op. This absorbs transient GitHub blips inside
// the same cron so they never produce an error heartbeat (no health flapping),
// while a persistent outage still throws once the retries are exhausted.
export async function ghFetch(
  url: string,
  init: RequestInit,
  label: string,
  options: GhFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? GITHUB_FETCH_TIMEOUT_MS;
  const retries = options.retries ?? GITHUB_FETCH_RETRIES;
  const backoffMs = options.backoffMs ?? ((attempt) => attempt * 750);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await delayMs(backoffMs(attempt));
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs, label, options.fetchImpl);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastErr = new Error(`${label} ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) throw err;
    }
  }
  throw lastErr ?? new Error(`${label} failed after ${retries} retries`);
}

async function ghGetFile(
  env: GithubRepositoryEnv,
  path: string,
  ref = env.GITHUB_BRANCH,
): Promise<{ content: string; sha: string } | null> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await ghFetch(
    url,
    {
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "tech-dashboard-worker",
      },
    },
    `gh get ${path}`,
  );
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

async function verifyRepositoryPublisherContract(
  env: GithubRepositoryEnv,
  ref = env.GITHUB_BRANCH,
): Promise<string> {
  const contractFile = await ghGetFile(env, PUBLISHER_CONTRACT_PATH, ref);
  if (!contractFile) {
    throw new Error(`repository publisher contract is missing at ${ref}: ${PUBLISHER_CONTRACT_PATH}`);
  }
  return assertPublisherContractContent(contractFile.content);
}

// Read a file from raw.githubusercontent.com (public repo, no auth, no
// redirect). Baseline reads pass an immutable commit SHA so the CDN cannot
// return an older branch snapshot while the final commit adopts a newer parent.
// This is cheaper in subrequest cost than the Contents API for large data files.
export async function ghGetFileRaw(
  env: GithubRepositoryEnv,
  path: string,
  ref: string,
): Promise<{ content: string } | null> {
  const url = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${ref}/${path}`;
  const res = await ghFetch(
    url,
    {
      headers: {
        "user-agent": "tech-dashboard-worker",
        "cache-control": "no-cache",
      },
    },
    `gh raw ${path}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gh raw ${path} ${res.status}: ${await res.text()}`);
  return { content: await res.text() };
}

async function ghJson<T>(
  env: GithubRepositoryEnv,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`;
  const res = await ghFetch(
    url,
    {
      ...init,
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "tech-dashboard-worker",
        ...(init?.headers ?? {}),
      },
    },
    `gh ${init?.method ?? "GET"} ${path}`,
  );
  if (!res.ok) throw new Error(`gh ${init?.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function getRepositoryBranchHeadSha(
  env: GithubRepositoryEnv,
): Promise<string> {
  const ref = await ghJson<{ object?: { sha?: unknown } }>(
    env,
    `/git/ref/heads/${env.GITHUB_BRANCH}`,
  );
  const sha = ref.object?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new Error(`repository branch ${env.GITHUB_BRANCH} returned an invalid head SHA`);
  }
  return sha;
}

export async function ghCommitFiles(
  env: GithubRepositoryEnv,
  message: string,
  changes: readonly FileChange[],
  expectedParentSha: string,
): Promise<string | null> {
  const headSha = await getRepositoryBranchHeadSha(env);
  if (headSha !== expectedParentSha) {
    throw new Error(
      `publisher snapshot changed: expected parent ${expectedParentSha}, found ${headSha}; refusing to publish stale data`,
    );
  }
  // Collection can span a main-branch merge. Re-check the marker at the exact
  // commit this data commit will parent so an obsolete runtime cannot publish
  // on top of a newer contract after passing only the start-of-run guard.
  await verifyRepositoryPublisherContract(env, headSha);
  if (changes.length === 0) return null;

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

export function jsonContentDiffers(
  existingContent: string,
  nextContent: string,
  options: { ignoreGeneratedAt?: boolean } = {},
): boolean {
  const ignoreGeneratedAt = options.ignoreGeneratedAt ?? true;
  const existingComparable = ignoreGeneratedAt ? stripGeneratedAt(existingContent) : existingContent;
  const nextComparable = ignoreGeneratedAt ? stripGeneratedAt(nextContent) : nextContent;
  return existingComparable !== nextComparable;
}

export function shouldIgnoreGeneratedAtForPath(path: string): boolean {
  return path !== "data/archive/_index.json" && path !== "data/stats.json";
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

export function parseBaselineJson<T>(
  path: string,
  file: { content: string } | null,
): T | null {
  if (!file) return null;
  try {
    return JSON.parse(file.content) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`refusing to publish with invalid baseline ${path}: ${reason}`);
  }
}

export function assertHistoryBaselinePair(
  archiveIndexFile: { content: string } | null,
  statsFile: { content: string } | null,
): void {
  if (Boolean(archiveIndexFile) === Boolean(statsFile)) return;

  const missingPath = archiveIndexFile ? "data/stats.json" : "data/archive/_index.json";
  throw new Error(`refusing to publish: history baseline pair is incomplete; ${missingPath} is missing`);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertArchiveIndexBaseline(
  value: unknown,
): asserts value is ArchiveIndexFile {
  const path = "data/archive/_index.json";
  if (!isJsonObject(value)) {
    throw new Error(`refusing to publish with invalid baseline ${path}: expected an object`);
  }
  if (typeof value.generatedAt !== "string" || value.generatedAt.length === 0) {
    throw new Error(`refusing to publish with invalid baseline ${path}: generatedAt must be a string`);
  }
  if (!Array.isArray(value.months) || !value.months.every((month) => typeof month === "string")) {
    throw new Error(`refusing to publish with invalid baseline ${path}: months must be a string array`);
  }
  if (!isJsonObject(value.perMonth)) {
    throw new Error(`refusing to publish with invalid baseline ${path}: perMonth must be an object`);
  }
  if (!Number.isInteger(value.totalEntries) || (value.totalEntries as number) < 0) {
    throw new Error(`refusing to publish with invalid baseline ${path}: totalEntries must be a non-negative integer`);
  }

  const monthPattern = /^\d{4}-\d{2}$/;
  const months = value.months as string[];
  const perMonth = value.perMonth as Record<string, unknown>;
  const indexedMonths = Object.keys(perMonth);
  if (
    months.some((month) => !monthPattern.test(month))
    || indexedMonths.some((month) => !monthPattern.test(month))
    || new Set(months).size !== months.length
  ) {
    throw new Error(`refusing to publish with invalid baseline ${path}: month keys must be unique YYYY-MM values`);
  }

  let totalEntries = 0;
  for (const month of indexedMonths) {
    const count = perMonth[month];
    if (!Number.isInteger(count) || (count as number) < 0) {
      throw new Error(`refusing to publish with invalid baseline ${path}: perMonth.${month} must be a non-negative integer`);
    }
    totalEntries += count as number;
  }

  const listed = [...months].sort();
  const counted = [...indexedMonths].sort();
  if (JSON.stringify(listed) !== JSON.stringify(counted)) {
    throw new Error(`refusing to publish with invalid baseline ${path}: months and perMonth keys must match`);
  }
  if (value.totalEntries !== totalEntries) {
    throw new Error(
      `refusing to publish with invalid baseline ${path}: totalEntries ${value.totalEntries} does not match perMonth total ${totalEntries}`,
    );
  }
}

export function parseArchiveIndexBaseline(
  file: { content: string } | null,
): ArchiveIndexFile | null {
  if (!file) return null;
  const value = parseBaselineJson<unknown>("data/archive/_index.json", file);
  assertArchiveIndexBaseline(value);
  return value;
}

export function assertArchiveMonthBaseline(
  month: string,
  archiveIndex: Pick<ArchiveIndexFile, "perMonth"> | null,
  existingFile: { content: string } | null,
): ArchiveMonthFile | null {
  const path = `data/archive/${month}.json`;
  const isIndexed = Object.hasOwn(archiveIndex?.perMonth ?? {}, month);
  const indexedCount = archiveIndex?.perMonth?.[month] ?? 0;
  if (isIndexed && !existingFile) {
    throw new Error(
      `refusing to publish: archive index records ${indexedCount} entries for ${month}, but ${path} is missing`,
    );
  }
  if (!existingFile) return null;

  const value = parseBaselineJson<unknown>(path, existingFile);
  if (!isJsonObject(value)) {
    throw new Error(`refusing to publish with invalid baseline ${path}: expected an object`);
  }
  if (typeof value.generatedAt !== "string" || value.generatedAt.length === 0) {
    throw new Error(`refusing to publish with invalid baseline ${path}: generatedAt must be a string`);
  }
  if (value.month !== month) {
    throw new Error(`refusing to publish with invalid baseline ${path}: month must equal ${month}`);
  }
  if (!Number.isInteger(value.count) || (value.count as number) < 0) {
    throw new Error(`refusing to publish with invalid baseline ${path}: count must be a non-negative integer`);
  }
  if (!Array.isArray(value.entries)) {
    throw new Error(`refusing to publish with invalid baseline ${path}: entries must be an array`);
  }
  if (value.count !== value.entries.length) {
    throw new Error(
      `refusing to publish with invalid baseline ${path}: count ${value.count} does not match entries length ${value.entries.length}`,
    );
  }
  if (isIndexed && indexedCount !== value.count) {
    throw new Error(
      `refusing to publish with invalid baseline ${path}: archive index count ${indexedCount} does not match month count ${value.count}`,
    );
  }

  return value as unknown as ArchiveMonthFile;
}

async function ghJsonChangeIfChanged(
  env: PublisherEnv,
  path: string,
  payload: unknown,
  existing: { content: string; sha?: string } | null,
): Promise<FileChange | null> {
  const content = stringifyJson(payload);
  if (
    existing &&
    !jsonContentDiffers(existing.content, content, {
      ignoreGeneratedAt: shouldIgnoreGeneratedAtForPath(path),
    })
  ) {
    return null;
  }
  return { path, content };
}

function entriesEqual(
  existingPayload: { entries?: NormalizedEntry[] } | null,
  nextEntries: readonly NormalizedEntry[],
): boolean {
  return JSON.stringify(existingPayload?.entries ?? []) === JSON.stringify(nextEntries);
}

export function selectArchiveUpdateEntries(
  existingPayload: { entries?: NormalizedEntry[] } | null,
  nextEntries: readonly NormalizedEntry[],
): NormalizedEntry[] {
  if (!existingPayload?.entries) return [...nextEntries];
  const existingByUrl = new Map(
    existingPayload.entries.map((entry) => [canonicalUrlKey(entry.url) ?? entry.url ?? entry.id, entry]),
  );
  return nextEntries.filter((entry) => {
    const key = canonicalUrlKey(entry.url) ?? entry.url ?? entry.id;
    return JSON.stringify(existingByUrl.get(key)) !== JSON.stringify(entry);
  });
}

export function selectArchiveInspectionMonths(
  archiveIndex: Pick<ArchiveIndexFile, "months" | "perMonth"> | null,
  incomingMonths: Iterable<string>,
): string[] {
  const months = new Set(incomingMonths);
  if (archiveIndex) {
    for (const month of archiveIndex.months ?? []) months.add(month);
    for (const month of Object.keys(archiveIndex.perMonth ?? {})) months.add(month);
  }
  return [...months].filter((month) => /^\d{4}-\d{2}$/.test(month)).sort();
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishHistoryFiles(
  env: PublisherEnv,
  archiveInputEntries: readonly NormalizedEntry[],
  liveEntries: readonly NormalizedEntry[],
  generatedAt: string,
  baselineRef: string,
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
  const archiveIndexPath = "data/archive/_index.json";
  const statsPath = "data/stats.json";

  // Read archive _index + existing stats in parallel from the captured
  // baseline. The immutable SHA keeps Contents API and raw CDN reads coherent.
  const [archiveIndexFile, existingStatsRaw] = await Promise.all([
    ghGetFile(env, archiveIndexPath, baselineRef),
    ghGetFileRaw(env, statsPath, baselineRef),
  ]);
  assertHistoryBaselinePair(archiveIndexFile, existingStatsRaw);
  const archiveIndex = parseArchiveIndexBaseline(archiveIndexFile);
  const existingStats = parseBaselineJson<StatsPayload>(statsPath, existingStatsRaw);

  // A missing baseline requires one full bootstrap. Normal runs merge only
  // entries whose published index representation changed.
  const entriesToMerge = archiveIndex && existingStats ? archiveInputEntries : liveEntries;
  const { byMonth, stats } = groupArchiveEntries(entriesToMerge, { includeHot: true });

  // The Node publisher reads every archive month from the immutable baseline.
  // This keeps tag synchronization exact and lets stats rebuild from the final
  // live + archive corpus instead of inheriting drift from an old stats file.
  const inspectionMonths = selectArchiveInspectionMonths(archiveIndex, byMonth.keys());
  const existingInspectionFiles = await Promise.all(
    inspectionMonths.map((month) =>
      ghGetFileRaw(env, `data/archive/${month}.json`, baselineRef),
    ),
  );

  const monthFiles = new Map<string, ArchiveMonthFile>();
  const finalMonthFiles = new Map<string, ArchiveMonthFile>();
  const archiveEntriesForStats: NormalizedEntry[] = [];
  const changes: FileChange[] = [];
  let archiveFilesChanged = 0;

  for (let i = 0; i < inspectionMonths.length; i++) {
    const month = inspectionMonths[i];
    const path = `data/archive/${month}.json`;
    const existingFile = existingInspectionFiles[i];
    const existingMonth = assertArchiveMonthBaseline(month, archiveIndex, existingFile);
    const incomingEntries = byMonth.get(month) ?? [];
    const tagSync = synchronizeArchiveTagsFromLive(
      mergeArchiveEntries(existingMonth?.entries ?? [], incomingEntries),
      liveEntries,
    );
    archiveEntriesForStats.push(...tagSync.entries);
    const mergedEntries = tagSync.entries;
    if (mergedEntries.length === 0) continue;

    const shouldWriteMonth = incomingEntries.length > 0 || tagSync.changed > 0;
    const monthPayload = shouldWriteMonth
      ? buildArchiveMonthFile(month, mergedEntries, generatedAt)
      : existingMonth;
    if (!monthPayload) {
      throw new Error(`refusing to publish without a validated archive payload for ${month}`);
    }
    finalMonthFiles.set(month, monthPayload);
    if (!shouldWriteMonth) continue;
    monthFiles.set(month, monthPayload);

    const change = await ghJsonChangeIfChanged(env, path, monthPayload, existingFile ?? null);
    if (change) {
      changes.push(change);
      archiveFilesChanged++;
    }
  }

  // Rebuild archive _index only from month files validated against the same
  // immutable baseline. Never carry forward unverified counts.
  const indexInputs = [...finalMonthFiles.values()];
  const archiveIndexPayload = buildArchiveIndexFile(indexInputs, generatedAt);
  const archiveIndexChange = await ghJsonChangeIfChanged(env, archiveIndexPath, archiveIndexPayload, archiveIndexFile);
  if (archiveIndexChange) changes.push(archiveIndexChange);

  const statsPayload = buildStatsPayloadFromArtifacts(
    liveEntries,
    archiveEntriesForStats,
    generatedAt,
  );
  const statsChange = await ghJsonChangeIfChanged(env, statsPath, statsPayload, existingStatsRaw ?? null);
  if (statsChange) changes.push(statsChange);

  return {
    archiveMonthsTouched: monthFiles.size,
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
  const res = await fetchWithTimeout(
    "https://api.github.com/copilot_internal/v2/token",
    {
      headers: {
        authorization: `token ${pat}`,
        "user-agent": COPILOT_HEADERS["user-agent"],
        "editor-version": COPILOT_HEADERS["editor-version"],
      },
    },
    GITHUB_FETCH_TIMEOUT_MS,
    "copilot token exchange",
  );
  if (!res.ok) throw new Error(`copilot token exchange ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

// ---------- Summarize -------------------------------------------------------

import { buildPrompt, buildQueuePrompt, parseResponse } from "./prompt.ts";
// Re-export for unit tests (tests/worker-parse.test.ts).
// NOTE: bare `export ... from` would *only* create a module-level re-export
// and would NOT bring the symbols into this module's local scope, leading to
// `ReferenceError: buildPrompt is not defined` inside callCopilot at runtime
// (see LL-030). Always import first, then re-export.
export { buildPrompt, buildQueuePrompt, parseResponse };

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
          { role: "user", content: buildQueuePrompt(e) },
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
  return normalizeTags(tags, 10);
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
    const html = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(buf);
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
    return new URL(normalizeMediaUrl(src), base).toString();
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

export async function runHarness(
  env: PublisherEnv,
  opts: RunHarnessOptions = {},
): Promise<{ changed: boolean; stats: Record<string, number> }> {
  const collectedAt = new Date().toISOString();
  // Exclude file-system-backed sources (e.g. user-opml reads data/user-opml.xml).
  const allSources = listSources().filter((s) => s.id !== "user-opml");

  // Rotate sources across six hourly batches. This lowers the peak collection
  // and parsing load from roughly fourteen to nine sources per invocation while
  // keeping each registry source on a predictable six-hour refresh cadence.
  const naturalBatch = sourceBatchIndexAt(Date.now());
  const batchIndex =
    opts.batchOverride !== undefined
      ? ((opts.batchOverride % SOURCE_BATCHES) + SOURCE_BATCHES) % SOURCE_BATCHES
      : naturalBatch;
  const sources = allSources.filter((_, i) => i % SOURCE_BATCHES === batchIndex);
  console.log(`[worker] run ${collectedAt}, batch ${batchIndex + 1}/${SOURCE_BATCHES} (${sources.length} of ${allSources.length} sources)${opts.batchOverride !== undefined ? " [forced]" : ""}`);
  const publisherSnapshotSha = await getRepositoryBranchHeadSha(env);
  const publisherContractFingerprint = await verifyRepositoryPublisherContract(
    env,
    publisherSnapshotSha,
  );
  await writeStartHeartbeat(env, {
    batchIndex: batchIndex + 1,
    batchTotal: SOURCE_BATCHES,
    sourcesAttempted: sources.length,
    publisherContractFingerprint,
  });

  // 0) Read existing index FIRST so we can merge fresh entries from this batch
  //    with prior entries from the other batches (avoids losing data).
  //
  // CRITICAL (LL-040/LL-211): Use raw.githubusercontent.com because the
  // Contents API omits content for files >1MB, but pin every baseline read to
  // the captured commit SHA so branch CDN staleness cannot roll data backward.
  const existing = await ghGetFileRaw(env, "data/index.json", publisherSnapshotSha);
  // Body-file architecture (LL-115): read the committed bodies.json so the body
  // pipeline can merge newly generated bodies and prune stale ones. Only read
  // when the body pipeline is active to save a subrequest otherwise.
  const existingBodies =
    env.ENABLE_BODY_QUEUE === "1"
      ? await ghGetFileRaw(env, "data/bodies.json", publisherSnapshotSha)
      : null;
  let priorEntries: NormalizedEntry[] = [];
  let previousBodyPendingIds: string[] = [];
  if (existing?.content) {
    try {
      const parsed = JSON.parse(existing.content) as {
        entries?: NormalizedEntry[];
        health?: { bodyMergePendingIds?: unknown };
      };
      priorEntries = parsed.entries ?? [];
      const pendingIds = parsed.health?.bodyMergePendingIds;
      if (Array.isArray(pendingIds)) {
        previousBodyPendingIds = [...new Set(
          pendingIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
        )].slice(0, 100);
      }
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

  const sourceDefMap = new Map(listSources().map((s) => [s.id, s]));
  // 1.5) Reapply current source rules ONLY to prior merged entries before
  // canonical merge. Fresh entries already passed the current registry during
  // collection, often with a longer raw snippet than normalize() keeps in
  // contentSnippet; re-filtering the normalized fresh record can falsely drop
  // it after truncation.
  const { entries: qualityFiltered, filteredPriorCount: filteredByCurrentRules } =
    mergeFreshAndPriorEntries(fresh, priorEntries, sourceDefMap, collectedAt);
  if (filteredByCurrentRules > 0) {
    console.log(`[worker] source keyword filters removed ${filteredByCurrentRules} prior merged entries`);
  }

  // 2) Cap per source (importance-aware for high-volume sources) then sort newest-first then cap to INDEX_LIMIT.
  const PER_SOURCE_CAP = 50;
  // Per-category cap: categories that would otherwise dominate the index
  // get an additional ceiling applied after per-source capping.
  const CATEGORY_CAPS: Partial<Record<string, number>> = {
    research: 120,
  };
  const bySource = new Map<string, NormalizedEntry[]>();
  for (const e of qualityFiltered) {
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
  for (const [sourceId, arr] of bySource) {
    const sourceCap = sourceDefMap.get(sourceId)?.perSourceCap ?? PER_SOURCE_CAP;
    if (arr.length <= sourceCap) {
      capped.push(...arr);
      continue;
    }
    const picked = [...arr].sort((a, b) => pickScore(b) - pickScore(a)).slice(0, sourceCap);
    capped.push(...picked);
  }
  // Apply per-category cap (keeps highest-scoring entries within each category).
  const byCategory = new Map<string, NormalizedEntry[]>();
  for (const e of capped) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }
  const categoryCapped: NormalizedEntry[] = [];
  for (const [category, arr] of byCategory) {
    const cap = CATEGORY_CAPS[category];
    if (!cap || arr.length <= cap) {
      categoryCapped.push(...arr);
      continue;
    }
    const picked = [...arr].sort((a, b) => pickScore(b) - pickScore(a)).slice(0, cap);
    categoryCapped.push(...picked);
    console.log(`[worker] category cap: ${category} ${arr.length} → ${picked.length}`);
  }
  const sorted = categoryCapped
    .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt))
    .slice(0, INDEX_LIMIT);

  const model = env.SUMMARIZE_MODEL || "claude-sonnet-4.6";
  const maxNew = Number(env.SUMMARIZE_MAX_NEW || "25");
  const inlineSummarizeEnabled = maxNew > 0;

  // 3) Resolve Copilot token only for legacy inline summarization. Queue
  // summarization is handled by worker-summarizer, whose /health verifies its
  // own COPILOT_PAT. Skipping this exchange saves one external subrequest from
  // the already tight harness Free-plan budget.
  let token: string | null = null;
  let copilotError: string | null = null;
  const copilotOk = inlineSummarizeEnabled ? false : true;
  let inlineCopilotOk = copilotOk;
  if (inlineSummarizeEnabled && env.COPILOT_PAT) {
    try {
      token = await resolveCopilotToken(env.COPILOT_PAT);
      inlineCopilotOk = true;
    } catch (err) {
      copilotError = err instanceof Error ? err.message : String(err);
      console.warn(`[worker] copilot token exchange failed: ${copilotError}`);
    }
  } else if (inlineSummarizeEnabled) {
    copilotError = "COPILOT_PAT not configured";
  }

  // 4) Summarize — apply KV cache, budget new calls.
  //    Cache stored as a single JSON blob keyed by URL to avoid
  //    hundreds of sequential KV gets (each ~30ms, which exhausts the
  //    Worker wall-time budget of ~30s).
  const summarizeTimeoutMs = Number(env.SUMMARIZE_TIMEOUT_MS || String(DEFAULT_SUMMARIZE_TIMEOUT_MS));
  const summarizeConcurrency = Math.max(
    1,
    Number(env.SUMMARIZE_CONCURRENCY || String(DEFAULT_SUMMARIZE_CONCURRENCY)),
  );
  // Per-URL KV (LL-038/042). We only read KV for entries that might need a
  // cache update — entries already carrying a real AI summary are skipped.
  //
  // Root-cause fix (2026-05-24): the earlier cap of 60 (LL-042 follow-up)
  // caused a permanent blind-spot. Entries at positions 60+ were never
  // KV-checked, never entered `lookedUpUrls`, and maybeEnqueueSummaryJobs
  // incorrectly treated them as "has real summary — skip". Result: a growing
  // tail (484 entries, 400+ permanently stuck) that never got enqueued.
  //
  // The harness is still constrained by the Free-plan external subrequest cap,
  // and scheduled invocations also do GitHub/raw/source/OG fetches. Keep KV
  // reads low and rely on round-robin so every fallback is eventually checked.
  const KV_LOOKUP_CAP = Math.max(
    1,
    Number(env.KV_LOOKUP_CAP ?? "20"),
  );
  const summarySelectionNowMs = Date.now();
  const allFallback = sorted.filter(needsGeneratedContent);
  const summaryRetryCooldownUrls = await readSummaryRetryCooldownUrls(env);
  const lookupSelection = selectSummaryLookupEntries(sorted, KV_LOOKUP_CAP, {
    nowMs: summarySelectionNowMs,
    skipUrls: summaryRetryCooldownUrls,
  });
  const needsKvLookup = lookupSelection.entries;
  // lookedUpUrls: URLs we actually issued KV.get for.
  //   Absent from set  → real AI summary exists; do not enqueue.
  //   Present but no hitsByUrl hit → KV miss; MUST enqueue.
  const lookedUpUrls = new Set(needsKvLookup.map((e) => e.url));
  // uncheckedFallbackUrls: fallback entries skipped this cron because
  // allFallback.length > KV_LOOKUP_CAP. We know they're fallbacks (no real
  // summary) even without a KV read, so maybeEnqueueSummaryJobs treats them
  // the same as KV-miss entries.
  const uncheckedFallbackUrls = new Set(
    allFallback.filter((e) => !lookedUpUrls.has(e.url)).map((e) => e.url),
  );
  const hitsByUrl = await getCacheEntriesWithLegacyFallback(
    env.SUMMARY_CACHE,
    needsKvLookup.map((e) => e.url),
    CACHE_KEY,
  );
  if (summaryRetryCooldownUrls.size > 0) {
    console.log(
      `[worker] summary retry cooldown active for ${summaryRetryCooldownUrls.size} url(s)`,
    );
  }
  console.log(
    `[worker] cache lookups ${needsKvLookup.length} / ${sorted.length} (fallback total=${allFallback.length}, unchecked=${uncheckedFallbackUrls.size}, cap=${KV_LOOKUP_CAP}, priorityOffset=${lookupSelection.startIndex})`,
  );

  const needsSummary: NormalizedEntry[] = [];
  const afterCache: NormalizedEntry[] = [];
  for (const e of sorted) {
    const rawHit = hitsByUrl.get(e.url);
    const hit = cacheEntryMatchesPublisherContract(
      rawHit,
      publisherContractFingerprint,
    )
      ? rawHit
      : undefined;
    const cachedTitleJa = hit?.titleJa || e.titleJa;
    if (hit && cachedTitleJa && hit.summaryJa && hit.summaryEn) {
      afterCache.push({
        ...e,
        titleJa: cachedTitleJa,
        summaryJa: hit.summaryJa,
        summaryEn: hit.summaryEn,
        bodyJa: hit.bodyJa || e.bodyJa || "",
        bodyEn: hit.bodyEn || e.bodyEn || "",
        importance: cacheMetadataMatchesPublisherContract(
          hit,
          publisherContractFingerprint,
        )
          ? hit.importance
          : e.importance,
        tags: cacheMetadataMatchesPublisherContract(
          hit,
          publisherContractFingerprint,
        )
          ? dedupeTags([...e.tags, ...hit.extraTags])
          : e.tags,
      });
      // Re-summarize entries cached before bodyJa/bodyEn was introduced.
      if (!hit.bodyJa || !hit.bodyEn) {
        needsSummary.push(e);
      }
    } else if (!hit && !needsGeneratedContent(e)) {
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
            const versioned = {
              ...r,
              publisherContractFingerprint,
            };
            await putCacheEntry(env.SUMMARY_CACHE, e.url, versioned);
            return { url: e.url, entry: versioned, ok: true as const };
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
      results.flatMap((result) =>
        result.ok ? [[result.url, result.entry] as const] : [],
      ),
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
  } else if (inlineSummarizeEnabled && !token) {
    console.warn("[worker] no Copilot token — skipping summarization");
  }

  // 4.5) OG image enrichment — fetch <meta property="og:image"> for entries
  //      that still lack a thumbnail. Cached in KV under "og.v1" as a single
  //      blob keyed by URL. Capped per run to stay within Worker subrequest
  //      and CPU budgets.
  const OG_KEY = "og.v1";
  const OG_BUDGET_PER_RUN = Math.max(0, Number(env.OG_BUDGET_PER_RUN ?? "1"));
  const ogBlob =
    (await env.SUMMARY_CACHE.get<Record<string, { src: string | null; checkedAt: string }>>(OG_KEY, "json")) ?? {};

  // Apply already-cached og hits.
  for (let i = 0; i < afterCache.length; i++) {
    const e = afterCache[i]!;
    if (e.image) continue;
    const cached = ogBlob[e.url];
    if (cached?.src) {
      const src = normalizeMediaUrl(cached.src);
      cached.src = src;
      afterCache[i] = {
        ...e,
        image: { src, origSrc: src, alt: e.title, width: 0, height: 0, source: "og" },
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
      const rawSrc = byUrl.get(e.url);
      const src = rawSrc ? normalizeMediaUrl(rawSrc) : "";
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

  const failedSources = settled.filter((s) => !s.result.ok).map((s) => s.result.sourceId);
  const queueCap = Math.max(1, Number(env.ENQUEUE_MAX_NEW ?? 30));
  const queueEnabled = env.ENABLE_SUMMARY_QUEUE === "1";
  const queueMode = queueEnabled ? (env.SUMMARY_QUEUE ? "enabled" : "missing-binding") : "disabled";
  const prePublishFallbackTotal = afterCache.filter(needsGeneratedContent).length;
  const prePublishFallbackPercent =
    afterCache.length === 0 ? 0 : Math.round((prePublishFallbackTotal / afterCache.length) * 100);
  const prePublishQueueBatch = selectSummaryJobBatch(
    afterCache,
    hitsByUrl,
    lookedUpUrls,
    queueCap,
    uncheckedFallbackUrls,
    {
      nowMs: summarySelectionNowMs,
      skipUrls: summaryRetryCooldownUrls,
      publisherContractFingerprint,
    },
  );

  // Enqueue before the CPU-heavy publish phase. Jobs carry the publisher
  // fingerprint, so a later parent-SHA rejection cannot make a newer publisher
  // consume stale enrichment output.
  const earlyEnqueued = await maybeEnqueueSummaryJobs(
    env,
    afterCache,
    hitsByUrl,
    lookedUpUrls,
    uncheckedFallbackUrls,
    summaryRetryCooldownUrls,
    summarySelectionNowMs,
    publisherContractFingerprint,
  );
  if (earlyEnqueued > 0) {
    console.log(`[worker] enqueued ${earlyEnqueued} summary jobs (pre-publish path)`);
  }
  await writeHeartbeat(
    env,
    {
      batchIndex: batchIndex + 1,
      batchTotal: SOURCE_BATCHES,
      sourcesAttempted: sources.length,
      sourcesOk: settled.filter((s) => s.result.ok).length,
      sourcesFailed: failedSources,
      copilotOk: inlineCopilotOk,
      fallbackPercent: prePublishFallbackPercent,
      queueMode,
      queueCap,
      enqueueCandidates: queueEnabled && env.SUMMARY_QUEUE ? prePublishQueueBatch.jobs.length : 0,
      summaryQueueBacklog: prePublishQueueBatch.eligibleCount,
      summaryQueueDrainEstimateHours: prePublishQueueBatch.drainEstimateHours,
      summaryQueueStartIndex: prePublishQueueBatch.startIndex,
      summaryQueueCooldownCount: prePublishQueueBatch.cooldownCount,
      kvLookupCount: needsKvLookup.length,
      kvLookupCap: KV_LOOKUP_CAP,
      publisherContractFingerprint,
    },
    false,
    earlyEnqueued,
    prePublishFallbackTotal,
    "pre-publish",
  );

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
  const fallbackTotal = finalEntries.filter(needsGeneratedContent).length;
  const fallbackPercent = finalEntries.length === 0 ? 0 : Math.round((fallbackTotal / finalEntries.length) * 100);
  const summaryQueueBatch = selectSummaryJobBatch(
    finalEntries,
    hitsByUrl,
    lookedUpUrls,
    queueCap,
    uncheckedFallbackUrls,
    {
      nowMs: summarySelectionNowMs,
      skipUrls: summaryRetryCooldownUrls,
      publisherContractFingerprint,
    },
  );
  const enqueueCandidates = queueEnabled && env.SUMMARY_QUEUE ? summaryQueueBatch.jobs.length : 0;
  // Body-file pipeline (LL-115): merge generated bodies into data/bodies.json
  // and enqueue body-less entries. Summary jobs keep priority within the
  // shared Queue write allowance; body jobs consume only the unused capacity.
  // No-op unless ENABLE_BODY_QUEUE=1.
  const bodyGeneratedAt = new Date().toISOString();
  const configuredBodyEnqueueCap = Math.max(
    0,
    Number(env.BODY_ENQUEUE_MAX_NEW ?? 10),
  );
  const totalEnrichmentEnqueueCap = Math.max(
    0,
    Number(env.ENRICHMENT_ENQUEUE_MAX_TOTAL ?? queueCap),
  );
  const effectiveBodyEnqueueCap = bodyEnqueueAllowance(
    totalEnrichmentEnqueueCap,
    earlyEnqueued,
    configuredBodyEnqueueCap,
  );
  const bodyPipeline = await runBodyPipeline(
    env,
    finalEntries,
    existingBodies?.content ?? null,
    bodyGeneratedAt,
    publisherContractFingerprint,
    {
      previousPendingIds: previousBodyPendingIds,
      enqueueCap: effectiveBodyEnqueueCap,
    },
  );
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
    fallbackTotal,
    fallbackPercent,
    kvLookupCap: KV_LOOKUP_CAP,
    kvLookupCount: needsKvLookup.length,
    queueMode,
    queueCap,
    enqueueCandidates,
    summaryQueueEnqueued: earlyEnqueued,
    summaryQueueBacklog: summaryQueueBatch.eligibleCount,
    summaryQueueDrainEstimateHours: summaryQueueBatch.drainEstimateHours,
    summaryQueueStartIndex: summaryQueueBatch.startIndex,
    summaryQueueCooldownCount: summaryQueueBatch.cooldownCount,
    copilotOk: inlineCopilotOk,
    copilotError,
    ogCached: Object.keys(ogBlob).length,
    ogNewHits: ogFound,
    publisherContractFingerprint,
    ...bodyPipeline.health,
    enrichmentEnqueueCap: totalEnrichmentEnqueueCap,
    enrichmentEnqueued: earlyEnqueued + bodyPipeline.enqueued,
    enrichmentRemaining: Math.max(
      0,
      totalEnrichmentEnqueueCap - earlyEnqueued - bodyPipeline.enqueued,
    ),
  };
  // Body-file architecture (LL-115): the long-form body is NOT stored in
  // data/index.json. It lives in data/bodies.json (managed by the body pipeline
  // above). Strip body fields from the published index regardless of what the
  // cache merge produced, so the index stays well under the CI size budget
  // (LL-112) and a stale `s:` cache hit carrying a legacy body can never
  // re-bloat it (LL-073). `finalEntries` keeps its shape for archive/stats
  // (archive compacts body away anyway).
  const indexEntries = finalEntries.map((e) => ({ ...e, bodyJa: "", bodyEn: "" }));
  const payload = {
    generatedAt: new Date().toISOString(),
    count: indexEntries.length,
    health,
    entries: indexEntries,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";
  console.log(
    `[worker] payload ready entries=${finalEntries.length}, fallback=${fallbackTotal}, summaryFallbacks=${summaryFallbacks}, bodyFallbacks=${bodyFallbacks}, bytes=${json.length}`,
  );

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
  try {
    assertSafePublisherEntryCount(existingCount, finalEntries.length);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[worker] ${err.message}`);
    await writeFailureHeartbeat(env, err, "collapse-guard");
    throw err;
  }
  const hasEntryChanges = !entriesEqual(existingPayload, indexEntries);
  const archiveUpdateEntries = selectArchiveUpdateEntries(existingPayload, indexEntries);
  const indexUnchanged = !jsonContentDiffers(existingJson, json);
  const bodiesChanged = bodyPipeline.bodiesFileContent !== null;
  const noDataChanges = indexUnchanged && !bodiesChanged;
  const message = `chore(data): update tech dashboard ${payload.generatedAt}`;
  // Compare ignoring `generatedAt` timestamp so unchanged runs don't churn commits.
  // Queue enqueue already happened in the pre-publish path above because
  // cache state (some entries are still fallbacks) is independent of whether
  // the index payload changed. The commit sink still runs with zero files so
  // effect-only runs must pass the same final snapshot CAS before effects can
  // be persisted. Body-file (LL-115): also commit when only
  // data/bodies.json changed (new bodies merged / stale ones pruned).
  const historyStats = !noDataChanges && hasEntryChanges
    ? await publishHistoryFiles(
        env,
        archiveUpdateEntries,
        finalEntries,
        payload.generatedAt,
        publisherSnapshotSha,
      )
    : {
        archiveMonthsTouched: 0,
        archiveFilesChanged: 0,
        archiveIndexChanged: false,
        statsChanged: false,
        entriesArchived: 0,
        entriesDropped: 0,
        changes: [],
      };
  if (!noDataChanges && !hasEntryChanges) {
    console.log("[worker] entries unchanged; skip archive/stats refresh");
  }

  // 7) Commit to GitHub. Use one Git Data API commit so index/archive/stats/
  // bodies stay in sync. Only include index.json when its content actually
  // changed (avoid churning generatedAt on a bodies-only update); always
  // include bodies.json when the body pipeline produced a new version.
  const commitFiles = noDataChanges ? [] : [...historyStats.changes];
  if (!noDataChanges && !indexUnchanged) {
    commitFiles.push({ path: "data/index.json", content: json });
  }
  if (!noDataChanges && bodyPipeline.bodiesFileContent) {
    commitFiles.push({ path: "data/bodies.json", content: bodyPipeline.bodiesFileContent });
  }
  const commitSha = await (opts.commitFiles ?? ghCommitFiles)(
    env,
    message,
    commitFiles,
    publisherSnapshotSha,
  );
  if (noDataChanges) {
    console.log("[worker] no data changes; snapshot verified");
    await writeHeartbeat(env, health, false, earlyEnqueued, allFallback.length);
    return {
      changed: false,
      stats: {
        finalEntries: finalEntries.length,
        summarized,
        errors,
        enqueued: earlyEnqueued,
      },
    };
  }
  console.log(`[worker] committed ${commitFiles.map((f) => f.path).join(", ")} (${finalEntries.length} entries)`);
  console.log(
    `[worker] history archiveChanged=${historyStats.archiveFilesChanged}, statsChanged=${historyStats.statsChanged}, bodiesMerged=${bodyPipeline.health.bodyMerged}, bodyEnqueued=${bodyPipeline.enqueued}, commit=${commitSha}`,
  );

  // 8) Record the pre-publish enqueue result in the final heartbeat. Queue
  // dispatch happens before GitHub publish so AI backfill is not blocked by
  // large JSON serialization or transient GitHub failures.
  const enqueued = earlyEnqueued;
  await writeHeartbeat(env, health, true, enqueued, allFallback.length);

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

const HEARTBEAT_KEY = "heartbeat.v1";
const HEALTH_STALE_MS = 150 * 60_000;
const HEALTH_STARTED_STUCK_MS = 10 * 60_000;
const HEALTH_PREPUBLISH_STUCK_MS = 30 * 60_000;
const HEALTH_ERROR_FRESH_MS = 6 * 60 * 60_000;

type HarnessHeartbeatStatus = "started" | "pre-publish" | "published" | "checked" | "aborted" | "error";

export interface HeartbeatHealthSnapshot {
  batchIndex: number;
  batchTotal: number;
  sourcesOk: number;
  sourcesAttempted: number;
  sourcesFailed: string[];
  copilotOk: boolean;
  fallbackPercent?: number;
  queueMode?: string;
  queueCap?: number;
  enqueueCandidates?: number;
  summaryQueueBacklog?: number;
  summaryQueueEnqueued?: number;
  summaryQueueDrainEstimateHours?: number;
  summaryQueueStartIndex?: number;
  summaryQueueCooldownCount?: number;
  kvLookupCount?: number;
  kvLookupCap?: number;
  bodyQueueMode?: string;
  bodyBacklog?: number;
  bodyEnqueueCandidates?: number;
  bodyEnqueueCap?: number;
  bodyEnqueued?: number;
  bodyLookupCount?: number;
  bodyMerged?: number;
  bodyPruned?: number;
  bodyQueueDrainEstimateHours?: number;
  bodyMergePendingIds?: string[];
  enrichmentEnqueueCap?: number;
  enrichmentEnqueued?: number;
  enrichmentRemaining?: number;
  publisherContractFingerprint?: string;
}

export function buildHeartbeatPayload(
  health: HeartbeatHealthSnapshot,
  changed: boolean,
  summaryEnqueued: number,
  fallbackTotal: number,
  status: HarnessHeartbeatStatus,
  now = new Date(),
): Record<string, unknown> {
  return {
    ok: status !== "aborted" && status !== "error",
    status,
    lastCronAt: now.toISOString(),
    changed,
    enqueued: summaryEnqueued,
    fallbackTotal,
    batchIndex: health.batchIndex,
    batchTotal: health.batchTotal,
    sourcesOk: health.sourcesOk,
    sourcesAttempted: health.sourcesAttempted,
    sourcesFailed: health.sourcesFailed,
    copilotOk: health.copilotOk,
    fallbackPercent: health.fallbackPercent,
    queueMode: health.queueMode,
    queueCap: health.queueCap,
    enqueueCandidates: health.enqueueCandidates,
    summaryQueueBacklog: health.summaryQueueBacklog,
    summaryQueueEnqueued: health.summaryQueueEnqueued,
    summaryQueueDrainEstimateHours: health.summaryQueueDrainEstimateHours,
    summaryQueueStartIndex: health.summaryQueueStartIndex,
    summaryQueueCooldownCount: health.summaryQueueCooldownCount,
    kvLookupCount: health.kvLookupCount,
    kvLookupCap: health.kvLookupCap,
    bodyQueueMode: health.bodyQueueMode,
    bodyBacklog: health.bodyBacklog,
    bodyEnqueueCandidates: health.bodyEnqueueCandidates,
    bodyEnqueueCap: health.bodyEnqueueCap,
    bodyEnqueued: health.bodyEnqueued,
    bodyLookupCount: health.bodyLookupCount,
    bodyMerged: health.bodyMerged,
    bodyPruned: health.bodyPruned,
    bodyQueueDrainEstimateHours: health.bodyQueueDrainEstimateHours,
    bodyMergePendingIds: health.bodyMergePendingIds ?? [],
    enrichmentEnqueueCap: health.enrichmentEnqueueCap,
    enrichmentEnqueued: health.enrichmentEnqueued,
    enrichmentRemaining: health.enrichmentRemaining,
    publisherContractFingerprint:
      health.publisherContractFingerprint ?? DEPLOYED_PUBLISHER_FINGERPRINT,
  };
}

function errorSummary(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 500);
}

/**
 * Write a lightweight heartbeat to KV on every cron run (even no-op). This
 * lets the /health endpoint report "last cron checked N minutes ago" even when
 * no data changed and data/index.json wasn't committed (LL: worker reliability).
 */
async function writeHeartbeat(
  env: PublisherEnv,
  health: HeartbeatHealthSnapshot,
  changed: boolean,
  summaryEnqueued: number,
  fallbackTotal: number,
  status: HarnessHeartbeatStatus = changed ? "published" : "checked",
): Promise<void> {
  try {
    const hb = buildHeartbeatPayload(
      health,
      changed,
      summaryEnqueued,
      fallbackTotal,
      status,
    );
    // 7-day TTL: if Worker stops running, the heartbeat expires naturally.
    await env.SUMMARY_CACHE.put(HEARTBEAT_KEY, JSON.stringify(hb), {
      expirationTtl: 7 * 24 * 3600,
    });
  } catch (err) {
    // Best-effort; never fail the cron over a heartbeat write error.
    console.warn("[worker] heartbeat write failed:", err);
  }
}

async function writeStartHeartbeat(
  env: PublisherEnv,
  run: {
    batchIndex: number;
    batchTotal: number;
    sourcesAttempted: number;
    publisherContractFingerprint: string;
  },
): Promise<void> {
  try {
    const hb = {
      ok: true,
      status: "started",
      lastCronAt: new Date().toISOString(),
      batchIndex: run.batchIndex,
      batchTotal: run.batchTotal,
      sourcesAttempted: run.sourcesAttempted,
      publisherContractFingerprint: run.publisherContractFingerprint,
    };
    await env.SUMMARY_CACHE.put(HEARTBEAT_KEY, JSON.stringify(hb), {
      expirationTtl: 7 * 24 * 3600,
    });
  } catch (err) {
    console.warn("[worker] start heartbeat write failed:", err);
  }
}

async function writeFailureHeartbeat(
  env: PublisherEnv,
  err: unknown,
  trigger: "scheduled" | "manual-run" | "collapse-guard",
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const existing = (await env.SUMMARY_CACHE.get<Record<string, unknown>>(HEARTBEAT_KEY, "json")) ?? {};
    const previousFailureCount =
      typeof existing.failureCount === "number" && Number.isFinite(existing.failureCount)
        ? existing.failureCount
        : 0;
    const hb = {
      ...existing,
      ok: false,
      status: trigger === "collapse-guard" ? "aborted" : "error",
      lastCronAt: now,
      lastErrorAt: now,
      lastError: errorSummary(err),
      lastErrorTrigger: trigger,
      failureCount: previousFailureCount + 1,
      publisherContractFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
    };
    await env.SUMMARY_CACHE.put(HEARTBEAT_KEY, JSON.stringify(hb), {
      expirationTtl: 7 * 24 * 3600,
    });
  } catch (heartbeatErr) {
    console.warn("[worker] failure heartbeat write failed:", heartbeatErr);
  }
}

export function evaluateHarnessHealth(
  hb: Record<string, unknown> | null,
  nowMs = Date.now(),
): { ok: boolean; status: "ok" | "warn" | "error"; errors: string[]; warnings: string[]; ageSeconds?: number } {
  if (!hb) {
    return {
      ok: false,
      status: "error",
      errors: ["no heartbeat yet; cron has not run since deployment"],
      warnings: [],
    };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const lastCronAt = typeof hb.lastCronAt === "string" ? hb.lastCronAt : "";
  const lastCronMs = Date.parse(lastCronAt);
  const ageMs = Number.isFinite(lastCronMs) ? Math.max(0, nowMs - lastCronMs) : Number.POSITIVE_INFINITY;
  const ageSeconds = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : undefined;
  const status = typeof hb.status === "string" ? hb.status : "unknown";

  if (!Number.isFinite(lastCronMs)) {
    errors.push("heartbeat is missing a valid lastCronAt");
  } else if (ageMs > HEALTH_STALE_MS) {
    errors.push(`cron heartbeat is stale (${Math.round(ageMs / 60_000)}m old)`);
  }

  if (status === "started") {
    if (Number.isFinite(ageMs) && ageMs > HEALTH_STARTED_STUCK_MS) {
      errors.push(`cron appears stuck after start heartbeat (${Math.round(ageMs / 60_000)}m old)`);
    } else if (errors.length === 0) {
      warnings.push("cron run is still in progress");
    }
    return {
      ok: errors.length === 0,
      status: errors.length > 0 ? "error" : "warn",
      errors,
      warnings,
      ageSeconds,
    };
  }

  if (status === "error" || status === "aborted") {
    const lastErrorAt = typeof hb.lastErrorAt === "string" ? Date.parse(hb.lastErrorAt) : Number.NaN;
    const errorAgeMs = Number.isFinite(lastErrorAt) ? nowMs - lastErrorAt : 0;
    if (!Number.isFinite(lastErrorAt) || errorAgeMs <= HEALTH_ERROR_FRESH_MS) {
      errors.push(typeof hb.lastError === "string" ? hb.lastError : `last cron status is ${status}`);
    }
  }

  if (status === "pre-publish" && Number.isFinite(ageMs) && ageMs > HEALTH_PREPUBLISH_STUCK_MS) {
    errors.push(`cron appears stuck after pre-publish heartbeat (${Math.round(ageMs / 60_000)}m old)`);
  }

  if (hb.queueMode !== "enabled") {
    errors.push(`summary queue is ${String(hb.queueMode ?? "unknown")}`);
  }

  if (hb.copilotOk === false) {
    warnings.push("Copilot token exchange failed; summaries may not refresh");
  }

  const sourcesAttempted =
    typeof hb.sourcesAttempted === "number" && Number.isFinite(hb.sourcesAttempted) ? hb.sourcesAttempted : 0;
  const sourcesOk = typeof hb.sourcesOk === "number" && Number.isFinite(hb.sourcesOk) ? hb.sourcesOk : 0;
  const sourcesFailed = Array.isArray(hb.sourcesFailed) ? hb.sourcesFailed.length : 0;
  if (sourcesAttempted > 0 && sourcesOk === 0) {
    errors.push("all source collection attempts failed");
  } else if (sourcesFailed > 0) {
    warnings.push(`${sourcesFailed} source collection error(s) in the latest batch`);
  }

  const fallbackPercent =
    typeof hb.fallbackPercent === "number" && Number.isFinite(hb.fallbackPercent) ? hb.fallbackPercent : 0;
  if (fallbackPercent >= 25) {
    warnings.push(`summary fallback rate is high (${fallbackPercent}%)`);
  }

  return {
    ok: errors.length === 0,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warn" : "ok",
    errors,
    warnings,
    ageSeconds,
  };
}

/**
 * Send up to ENQUEUE_MAX_NEW entries lacking a real cached summary to the
 * SUMMARY_QUEUE. Returns the number actually enqueued. No-op when disabled
 * or when the queue binding is missing.
 */
async function maybeEnqueueSummaryJobs(
  env: PublisherEnv,
  entries: readonly NormalizedEntry[],
  hitsByUrl: Map<string, CacheEntry>,
  lookedUpUrls: Set<string>,
  uncheckedFallbackUrls: Set<string>,
  summaryRetryCooldownUrls: ReadonlySet<string>,
  nowMs: number,
  publisherContractFingerprint: string,
): Promise<number> {
  if (env.ENABLE_SUMMARY_QUEUE !== "1") return 0;
  if (!env.SUMMARY_QUEUE) {
    console.warn("[worker] ENABLE_SUMMARY_QUEUE=1 but SUMMARY_QUEUE binding missing");
    return 0;
  }
  const cap = Math.max(1, Number(env.ENQUEUE_MAX_NEW ?? 30));
  const { jobs: candidates, eligibleCount, startIndex, drainEstimateHours } = selectSummaryJobBatch(
    entries,
    hitsByUrl,
    lookedUpUrls,
    cap,
    uncheckedFallbackUrls,
    {
      nowMs,
      skipUrls: summaryRetryCooldownUrls,
      publisherContractFingerprint,
    },
  );
  if (eligibleCount > 0) {
    console.log(
      `[worker] summary queue candidates=${eligibleCount}, enqueue=${candidates.length}, start=${startIndex}, estimatedDrainHours=${drainEstimateHours}`,
    );
  }

  // Queue.sendBatch caps at 100 messages and 256 KB per call. Chunk so the
  // producer can keep sending large backfill waves without hitting
  // "Payload Too Large".
  if (candidates.length === 0) return 0;
  const CHUNK = 100;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const slice = candidates.slice(i, i + CHUNK);
    try {
      await env.SUMMARY_QUEUE.sendBatch(slice.map((body) => ({ body })));
    } catch (err) {
      console.warn(`[worker] summary queue enqueue skipped: ${err}`);
      return i;
    }
  }
  return candidates.length;
}

// ---------- Body pipeline (body-file Phase B, LL-115) -----------------------

interface BodyPipelineResult {
  /** Serialized data/bodies.json to commit, or null when unchanged. */
  bodiesFileContent: string | null;
  enqueued: number;
  health: {
    bodyQueueMode: string;
    bodyEnqueueCap: number;
    bodyEnqueueCandidates: number;
    bodyBacklog: number;
    bodyQueueDrainEstimateHours: number;
    bodyLookupCount: number;
    bodyPendingLookupCount: number;
    bodyMergePendingIds: string[];
    bodyMerged: number;
    bodyPruned: number;
    bodiesTotal: number;
    bodyRetentionDays: number;
    bodyRetentionEligible: number;
  };
}

/**
 * Body-file pipeline (LL-115). Runs after the index payload is built:
 *   1. Merge newly generated bodies (`b:` KV) into data/bodies.json and prune
 *      bodies whose entry is no longer live.
 *   2. Enqueue live entries that have a real summary but no body yet.
 *
 * Fully gated behind ENABLE_BODY_QUEUE so the collector can ship this code
 * before the body queue + worker exist (no-op until activated). Best-effort:
 * never throws into the publish path.
 */
async function runBodyPipeline(
  env: PublisherEnv,
  liveEntries: readonly NormalizedEntry[],
  existingBodiesContent: string | null,
  generatedAt: string,
  publisherContractFingerprint: string,
  options: {
    previousPendingIds?: readonly string[];
    enqueueCap?: number;
  } = {},
): Promise<BodyPipelineResult> {
  const retentionDays = Math.max(
    1,
    Number(env.BODY_RETENTION_DAYS ?? DEFAULT_BODY_RETENTION_DAYS),
  );
  const referenceMs = Date.parse(generatedAt);
  const retainedEntries = liveEntries.filter((entry) =>
    isBodyRetentionEligible(
      entry,
      Number.isFinite(referenceMs) ? referenceMs : Date.now(),
      retentionDays,
    ),
  );
  const disabled = (mode: string): BodyPipelineResult => ({
    bodiesFileContent: null,
    enqueued: 0,
    health: {
      bodyQueueMode: mode,
      bodyEnqueueCap: 0,
      bodyEnqueueCandidates: 0,
      bodyBacklog: 0,
      bodyQueueDrainEstimateHours: 0,
      bodyLookupCount: 0,
      bodyPendingLookupCount: 0,
      bodyMergePendingIds: [],
      bodyMerged: 0,
      bodyPruned: 0,
      bodiesTotal: parseBodies(existingBodiesContent).count,
      bodyRetentionDays: retentionDays,
      bodyRetentionEligible: retainedEntries.length,
    },
  });

  if (env.ENABLE_BODY_QUEUE !== "1") return disabled("disabled");
  if (!env.BODY_QUEUE) {
    console.warn("[worker] ENABLE_BODY_QUEUE=1 but BODY_QUEUE binding missing");
    return disabled("missing-binding");
  }

  try {
    const existingBodies = parseBodies(existingBodiesContent);
    const present = bodiesPresentSet(existingBodies);
    const retainedIds = new Set(retainedEntries.map((e) => e.id));

    // Current candidates still use one selection for lookup and enqueue
    // (LL-116). Jobs emitted by the previous Publisher run get one priority
    // lookup first, so completed Queue work is folded into bodies.json before
    // the round-robin window advances. A pending miss is not carried again.
    const lookupCap = Math.max(0, Number(env.BODY_LOOKUP_CAP ?? 10));
    const configuredEnqueueCap = Math.max(0, Number(env.BODY_ENQUEUE_MAX_NEW ?? 10));
    const enqueueCap = Math.min(
      configuredEnqueueCap,
      Math.max(0, Math.floor(options.enqueueCap ?? configuredEnqueueCap)),
    );
    const selection = selectBodyPipelineJobs(
      retainedEntries,
      present,
      options.previousPendingIds ?? [],
      lookupCap,
      { publisherContractFingerprint },
    );

    // 1) Merge: read `b:` KV for the selected entries and fold any freshly
    //    generated bodies into bodies.json (prune happens in mergeBodies).
    const hits = selection.lookupJobs.length
      ? await getBodyCacheEntries(env.SUMMARY_CACHE, selection.lookupJobs.map((j) => j.url))
      : new Map();
    const newBodies: NewBody[] = [];
    for (const job of selection.lookupJobs) {
      const candidate = hits.get(job.url);
      const hit = bodyCacheEntryMatchesPublisherContract(
        candidate,
        publisherContractFingerprint,
      )
        ? candidate
        : undefined;
      if (hit) {
        newBodies.push({ id: job.entry.id, bodyJa: hit.bodyJa, bodyEn: hit.bodyEn, model: hit.model, cachedAt: hit.cachedAt });
      }
    }
    const merge = mergeBodies(existingBodies, newBodies, retainedIds, generatedAt);

    // 2) Enqueue the selected entries that do NOT yet have a generated body (KV
    //    miss), so worker-body generates them for a future run's merge.
    const toEnqueue = selection.candidateJobs
      .filter((job) => {
        const hit = hits.get(job.url);
        return !bodyCacheEntryMatchesPublisherContract(
          hit,
          publisherContractFingerprint,
        );
      })
      .slice(0, enqueueCap);
    let enqueued = 0;
    if (toEnqueue.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < toEnqueue.length; i += CHUNK) {
        const slice = toEnqueue.slice(i, i + CHUNK);
        try {
          await env.BODY_QUEUE.sendBatch(slice.map((body) => ({ body })));
          enqueued += slice.length;
        } catch (err) {
          console.warn(`[worker] body queue enqueue skipped: ${err}`);
          break;
        }
      }
    }
    if (selection.eligibleCount > 0 || merge.changed) {
      console.log(
        `[worker] body pipeline: backlog=${selection.eligibleCount}, pendingLookup=${selection.pendingJobs.length}, candidateLookup=${selection.candidateJobs.length}, merged=${merge.added}, pruned=${merge.pruned}, enqueue=${enqueued}, enqueueCap=${enqueueCap}`,
      );
    }

    const remainingBacklog = bodyBacklogAfterMerge(selection.eligibleCount, merge.added);
    return {
      bodiesFileContent: merge.changed ? serializeBodies(merge.payload) : null,
      enqueued,
      health: {
        bodyQueueMode: "enabled",
        bodyEnqueueCap: enqueueCap,
        bodyEnqueueCandidates: toEnqueue.length,
        bodyBacklog: remainingBacklog,
        bodyQueueDrainEstimateHours: enqueueCap > 0
          ? Math.ceil(remainingBacklog / enqueueCap)
          : 0,
        bodyLookupCount: selection.lookupJobs.length,
        bodyPendingLookupCount: selection.pendingJobs.length,
        bodyMergePendingIds: toEnqueue.slice(0, enqueued).map((job) => job.entry.id),
        bodyMerged: merge.added,
        bodyPruned: merge.pruned,
        bodiesTotal: merge.payload.count,
        bodyRetentionDays: retentionDays,
        bodyRetentionEligible: retainedEntries.length,
      },
    };
  } catch (err) {
    console.warn(`[worker] body pipeline error (non-fatal): ${err}`);
    return disabled("error");
  }
}

// ---------- Worker entry points ---------------------------------------------

export default {
  // Await runHarness directly: the scheduled handler itself can use the full
  // cron wall-time budget. ctx.waitUntil is bounded to a short window after
  // invocation end, which previously cancelled mid-collection (LL-033).
  async scheduled(
    _event: ScheduledController,
    env: PublisherEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    try {
      await runHarness(env);
    } catch (err) {
      const stack = err instanceof Error && err.stack ? err.stack : String(err);
      console.error("[worker] fatal:", stack);
      await writeFailureHeartbeat(env, err, "scheduled");
      throw err;
    }
  },

  // Manual trigger: `curl -X POST https://<worker>.workers.dev/run -H "x-trigger-token: ..."`
  // Returns 202 immediately; the harness runs in background via ctx.waitUntil.
  async fetch(req: Request, env: PublisherEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const authHeader = req.headers.get("x-trigger-token");
      if (!authHeader || authHeader !== env.GH_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      ctx.waitUntil(
        runHarness(env).catch(async (err) => {
          console.error("[worker] manual run fatal:", err);
          await writeFailureHeartbeat(env, err, "manual-run");
        }),
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
      const batchIndex = sourceBatchIndexAt(Date.now());
      const sources = onlyId
        ? allSources.filter((s) => s.id === onlyId)
        : all
        ? allSources
        : allSources.filter((_, i) => i % SOURCE_BATCHES === batchIndex);
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
    // Public health endpoint — exposes cron heartbeat for the status page.
    // No auth required; the response contains only operational metrics.
    //   curl https://tech-dashboard-harness.himiyosh.workers.dev/health
    if (url.pathname === "/health" && req.method === "GET") {
      const hb = await env.SUMMARY_CACHE.get(HEARTBEAT_KEY, "json") as Record<string, unknown> | null;
      const health = evaluateHarnessHealth(hb);
      const body = JSON.stringify({
        ...(hb ?? {}),
        ...health,
        ...(health.errors[0] ? { error: health.errors[0] } : {}),
      });
      return new Response(body, {
        status: health.ok ? 200 : 503,
        headers: {
          "content-type": "application/json;charset=UTF-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        },
      });
    }
    return new Response(
      "tech-dashboard harness worker. POST /run (auth: x-trigger-token) to trigger.",
      { status: 200 },
    );
  },
} satisfies ExportedHandler<PublisherEnv>;
