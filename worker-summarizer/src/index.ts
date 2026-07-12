/**
 * tech-dashboard-summarizer — Cloudflare Worker Queue consumer.
 *
 * Receives one entry per invocation from the SUMMARY_QUEUE producer
 * (tech-dashboard-harness). For each message:
 *   1. Resolve Copilot token from COPILOT_PAT.
 *   2. Call Copilot /chat/completions with the compact bilingual summary prompt.
 *   3. If the response is incomplete, retry once with a compact recovery prompt.
 *   4. Parse the response and write it into SUMMARY_CACHE KV under the entry URL.
 *
 * Why a separate Worker (LL-037):
 *   The harness Worker hit Cloudflare's default 30 s/invocation CPU cap when
 *   running summarize alongside publishHistoryFiles. Splitting summarize into
 *   its own Queue consumer gives summary generation an isolated retry and
 *   timeout budget.
 *
 * Failure handling:
 *   - Copilot timeout / token error: throw -> Cloudflare Queues retries
 *     with exponential backoff (max_retries=2, see wrangler.toml).
 *   - Incomplete model output: retry once in-process with a compact JSON-only
 *     prompt before handing the message back to Cloudflare Queues.
 *   - After max_retries, message goes to the DLQ for manual triage.
 */
import type { NormalizedEntry } from "../../harness/types.ts";
import { hasUsableBilingualSummary } from "../../harness/pipeline/summary-quality.ts";
import { buildSummaryPrompt, parseResponse } from "../../worker/src/prompt.ts";
import { type CacheEntry, putCacheEntry } from "../../worker/src/kv-cache.ts";

interface Env {
  SUMMARY_CACHE: KVNamespace;
  COPILOT_PAT: string;
  SUMMARIZE_MODEL: string;
  SUMMARIZE_TIMEOUT_MS?: string;
  SUMMARIZE_MAX_TOKENS?: string;
}

/**
 * Shape of a queue message produced by the harness Worker. Keep small:
 * queues cap message size, and the prompt derives context from collected
 * metadata plus RSS/Atom snippets carried in summaryEn/summaryJa.
 */
export interface SummaryJob {
  url: string;
  // The full NormalizedEntry would be more than we need. Avoids bloating the
  // queue payload while still carrying the RSS/Atom snippet that normalization
  // placed in summaryEn/summaryJa.
  entry: Pick<
    NormalizedEntry,
    "id" | "url" | "title" | "category" | "source" | "sourceType"
  > &
    Partial<
      Pick<
        NormalizedEntry,
        | "titleJa"
        | "titleEn"
        | "summaryJa"
        | "summaryEn"
        | "lang"
        | "publishedAt"
        | "tags"
        | "importance"
      >
    >;
}

// LL-038 fix: per-URL KV keys instead of a single multi-MB blob. The blob
// is still read by the harness Worker as a fallback during migration, but
// the summarizer writes only per-URL keys to avoid the JSON.parse/stringify
// CPU bomb that was busting the 30 s Worker CPU cap.
const COPILOT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
const COPILOT_HEADERS: Record<string, string> = {
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1600;
// Refresh the IDE token when fewer than this many ms remain. Must exceed the
// longest single callCopilot timeout (DEFAULT_TIMEOUT_MS = 60s) so a token
// that passes the freshness check cannot expire *during* a long LLM call
// and return `401 IDE token expired` (LL-105).
const TOKEN_REFRESH_SKEW_MS = 240_000;
const DEFAULT_TOKEN_TTL_MS = 20 * 60_000;
const ISSUE_KEY = "summarizer.issue.v1";
const ISSUE_TTL_SECONDS = 6 * 60 * 60;
const RECENT_ISSUE_MS = 60 * 60_000;
const ERROR_REPEAT_THRESHOLD = 3;
type IssueScope = "entry" | "runtime";
const RECOVERY_TIMEOUT_MS = 45_000;

let cachedCopilotToken: { pat: string; token: string; expiresAtMs: number } | null = null;

async function resolveCopilotToken(pat: string, forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedCopilotToken?.pat === pat &&
    cachedCopilotToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now
  ) {
    return cachedCopilotToken.token;
  }
  if (forceRefresh) cachedCopilotToken = null;

  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${pat}`,
      "user-agent": COPILOT_HEADERS["user-agent"],
      "editor-version": COPILOT_HEADERS["editor-version"],
    },
  });
  if (!res.ok) {
    throw new Error(`copilot token exchange ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; expires_at?: number };
  const expiresAtMs =
    typeof body.expires_at === "number" && Number.isFinite(body.expires_at)
      ? body.expires_at * 1000
      : now + DEFAULT_TOKEN_TTL_MS;
  cachedCopilotToken = { pat, token: body.token, expiresAtMs };
  return body.token;
}

async function callCopilot(
  pat: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  maxTokens: number,
): Promise<CacheEntry> {
  // Resolve the IDE token here (not in the caller) so a single processJob
  // that issues up to three long LLM calls always re-checks freshness. On a
  // `401 IDE token expired` we force a fresh exchange and retry the call once;
  // the cached token had likely expired mid-batch (LL-105).
  for (let attempt = 0; ; attempt++) {
    const token = await resolveCopilotToken(pat, attempt > 0);
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
          // Quality-first queue mode: this Worker has a larger CPU/timeout budget
          // than the harness Worker, so use the same long-form contract as local
          // backfills.
          max_tokens: maxTokens,
          messages: [
            {
              role: "system",
              content:
                "You are a bilingual technical editor. Always return only the JSON object the user requested. Do not include code fences, prose preface, or commentary. Use natural Japanese for *Ja fields and native English for *En fields.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }),
      });
      if (res.status === 401 && attempt === 0) {
        // IDE token rejected as expired. Drain the body, force a fresh
        // exchange, and retry once before giving up.
        await res.text().catch(() => "");
        continue;
      }
      if (!res.ok) {
        throw new Error(`copilot ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content ?? "";
      const parsed = parseResponse(content);
      return {
        ...parsed,
        model,
        cachedAt: new Date().toISOString(),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function isCompleteCacheEntry(entry: CacheEntry): boolean {
  return Boolean(
    entry.titleJa.trim() &&
      entry.summaryJa.trim() &&
      entry.summaryEn.trim() &&
      entry.bodyJa.trim() &&
      entry.bodyEn.trim(),
  );
}

/**
 * The dashboard publishes a real (non-fallback) entry from the SUMMARY alone:
 * a Japanese title plus a JA and EN summary. The long bilingual body is shown
 * only on the article detail page and is acceptable as a deterministic fallback
 * until a real one is generated. So the queue consumer must persist an entry as
 * soon as the summary is complete — discarding a perfectly good summary because
 * the (longest, most truncation-prone) body field came back empty was the main
 * generation bottleneck: most fallback entries had NO KV summary at all and
 * stayed boilerplate forever (LL-104).
 */
export function isSummaryComplete(
  entry: CacheEntry,
  titles: Partial<Pick<NormalizedEntry, "title" | "titleJa" | "titleEn">> = {},
): boolean {
  return Boolean(
    entry.titleJa.trim() &&
      hasUsableBilingualSummary({
        ...entry,
        title: titles.title,
        titleJa: entry.titleJa || titles.titleJa,
        titleEn: titles.titleEn,
      }),
  );
}

async function processJob(env: Env, job: SummaryJob): Promise<void> {
  // Per-URL KV (LL-038): single KV.put per entry, no read-modify-write.
  // The producer (harness Worker) already filters out cached entries before
  // enqueuing, so duplicate work is rare. Each key is independent so parallel
  // consumer invocations can never clobber each other's writes.

  const pat = env.COPILOT_PAT;
  const model = env.SUMMARIZE_MODEL || "claude-sonnet-4.6";
  const timeoutMs = Number(env.SUMMARIZE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxTokens = Number(env.SUMMARIZE_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);

  // Summary-only prompt (LL-106). claude-sonnet-4.6 emits opaque reasoning
  // tokens that count against max_tokens; asking for a long bilingual body in
  // the same call exhausts the budget and the chat endpoint returns
  // {"choices":[]} (empty) -> "incomplete summary" -> ZERO summaries written.
  // We request only title + JA/EN summary so reasoning + answer fit. Long-form
  // body generation is handled by the separate body-file pipeline.
  let entry = await callCopilot(pat, model, buildSummaryPrompt(job.entry), timeoutMs, maxTokens);

  if (!isSummaryComplete(entry, job.entry)) {
    console.warn(`[summarizer] retry summary prompt ${job.url}: first output was incomplete`);
    entry = await callCopilot(
      pat,
      model,
      buildSummaryPrompt(job.entry),
      Math.min(timeoutMs, RECOVERY_TIMEOUT_MS),
      maxTokens,
    );
  }

  // Persist as soon as the summary is complete, even if the long-form body is
  // still missing after all recovery attempts. The collector merges entries on
  // title+summaryJa+summaryEn and fills bodies deterministically; throwing away
  // a complete summary because the body truncated left most fallback entries
  // with no KV summary at all and was the real "stuck summaries" cause (LL-104).
  if (!isSummaryComplete(entry, job.entry)) {
    throw new Error(`incomplete summary for ${job.url}`);
  }

  await putCacheEntry(env.SUMMARY_CACHE, job.url, entry);
  await clearIssue(env, job.url);
}

function issueSummary(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 500);
}

function classifyIssueScope(err: unknown): IssueScope {
  return issueSummary(err).toLowerCase().includes("incomplete summary for ")
    ? "entry"
    : "runtime";
}

function issueScopeFromRecord(issue: Record<string, unknown> | null): IssueScope {
  if (issue?.scope === "entry" || issue?.scope === "runtime") return issue.scope;
  return classifyIssueScope(issue?.error ?? "");
}

async function writeIssue(
  env: Env,
  status: "retry" | "deferred",
  job: SummaryJob,
  err: unknown,
): Promise<void> {
  try {
    const existing = await env.SUMMARY_CACHE.get<Record<string, unknown>>(ISSUE_KEY, "json");
    const scope = classifyIssueScope(err);
    const sameIssue =
      existing?.status === status &&
      existing?.url === job.url &&
      issueScopeFromRecord(existing) === scope;
    const repeatCount =
      sameIssue && typeof existing?.repeatCount === "number" && Number.isFinite(existing.repeatCount)
        ? existing.repeatCount + 1
        : 1;
    await env.SUMMARY_CACHE.put(
      ISSUE_KEY,
      JSON.stringify({
        ok: status === "deferred" || scope === "entry" || repeatCount < ERROR_REPEAT_THRESHOLD,
        status,
        scope,
        at: new Date().toISOString(),
        url: job.url,
        source: job.entry.source,
        category: job.entry.category,
        repeatCount,
        error: issueSummary(err),
      }),
      { expirationTtl: ISSUE_TTL_SECONDS },
    );
  } catch (issueErr) {
    console.warn("[summarizer] issue heartbeat write failed:", issueErr);
  }
}

async function clearIssue(env: Env, url: string): Promise<void> {
  try {
    const existing = await env.SUMMARY_CACHE.get<Record<string, unknown>>(ISSUE_KEY, "json");
    if (existing?.url === url) {
      await env.SUMMARY_CACHE.delete(ISSUE_KEY);
    }
  } catch (issueErr) {
    console.warn("[summarizer] issue heartbeat clear failed:", issueErr);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health" && req.method === "GET") {
      const cache = env.SUMMARY_CACHE;
      const cacheBinding = Boolean(cache);
      const issue = cache
        ? await cache.get<Record<string, unknown>>(ISSUE_KEY, "json")
        : null;
      const issueAt = typeof issue?.at === "string" ? Date.parse(issue.at) : Number.NaN;
      const recentIssue = Number.isFinite(issueAt) && Date.now() - issueAt <= RECENT_ISSUE_MS;
      const issueStatus = typeof issue?.status === "string" ? issue.status : null;
      const issueScope = issueScopeFromRecord(issue);
      const repeatCount =
        typeof issue?.repeatCount === "number" && Number.isFinite(issue.repeatCount)
          ? issue.repeatCount
          : recentIssue && issueStatus === "retry"
          ? 1
          : 0;
      const issueSeverity =
        recentIssue &&
        issueStatus === "retry" &&
        issueScope === "runtime" &&
        repeatCount >= ERROR_REPEAT_THRESHOLD
          ? "error"
          : recentIssue
          ? "warn"
          : "ok";
      const ok = cacheBinding && Boolean(env.COPILOT_PAT) && issueSeverity !== "error";
      return Response.json(
        {
          ok,
          role: "queue-consumer",
          model: env.SUMMARIZE_MODEL || "claude-sonnet-4.6",
          timeoutMs: Number(env.SUMMARIZE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
          maxTokens: Number(env.SUMMARIZE_MAX_TOKENS ?? DEFAULT_MAX_TOKENS),
          cacheBinding,
          copilotSecretConfigured: Boolean(env.COPILOT_PAT),
          recentIssue,
          issueSeverity,
          issueScope,
          issue,
        },
        {
          status: ok ? 200 : 503,
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          },
        },
      );
    }
    return new Response("tech-dashboard summarizer worker. Queue consumer is active.", {
      status: 200,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
  },

  async queue(batch: MessageBatch<SummaryJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processJob(env, msg.body);
        msg.ack();
      } catch (err) {
        const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // LL-043: KV daily write cap (1000/day on free tier) returns
        // "KV put() limit exceeded for the day". Retrying just burns through
        // max_retries and pushes the message to the DLQ — which is exactly
        // what we don't want for a transient daily-rate problem. Ack instead;
        // the next cron run after UTC midnight will re-enqueue any still-
        // fallback entry.
        if (summary.includes("KV put() limit exceeded")) {
          console.warn(`[summarizer] ack ${msg.body.url}: daily KV write cap reached, will retry tomorrow`);
          await writeIssue(env, "deferred", msg.body, summary);
          msg.ack();
        } else {
          console.warn(`[summarizer] retry ${msg.body.url}: ${summary}`);
          await writeIssue(env, "retry", msg.body, summary);
          msg.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env, SummaryJob>;
