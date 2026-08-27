/**
 * tech-dashboard-body — Cloudflare Worker Queue consumer (body-file Phase B, LL-115).
 *
 * Receives one entry per invocation from the BODY_QUEUE producer
 * (tech-dashboard-harness). For each message:
 *   1. Resolve Copilot token from COPILOT_PAT.
 *   2. Generate the Japanese body and the English body as TWO SEPARATE
 *      plain-text calls (claude-opus-4.8, reasoning_effort=max).
 *   3. Write { bodyJa, bodyEn, model, cachedAt } to the SUMMARY_CACHE KV
 *      namespace under a `b:` per-URL key.
 *
 * Why a separate Worker (mirrors the summarizer, LL-037/LL-108):
 *   Body generation is the heaviest LLM work (two long opus calls per entry).
 *   Keeping it in its own Queue consumer (a) leaves the finally-stable
 *   summarizer untouched, (b) gives body jobs an independent timeout/retry
 *   budget, and (c) isolates body throughput tuning from summaries.
 *
 * Why two single-language calls (LL-106/LL-115):
 *   Asking a reasoning model for both long bodies in one JSON response risks
 *   the reasoning-loop-empties failure. Two plain-text single-language calls
 *   each finish cleanly (verified by live API probe).
 *
 * Failure handling mirrors the summarizer: Copilot timeout/token error -> throw
 * -> Cloudflare Queues retries with backoff; KV daily write cap -> ack and
 * retry tomorrow (LL-043); persistent failure -> DLQ.
 */
import {
  type BodyJob,
  buildBodyPromptEn,
  buildBodyPromptJa,
  cleanBodyText,
} from "../../worker/src/body-generate.ts";
import {
  hasMaterialBodyGroundingConflict,
  hasSufficientBodySourceGrounding,
  type SourceGroundingInput,
} from "../../harness/pipeline/source-grounding.ts";
import { type BodyCacheEntry, putBodyCacheEntry } from "../../worker/src/body-cache.ts";
import { UNVERSIONED_JOB_FINGERPRINT } from "../../worker/src/kv-cache.ts";

interface Env {
  SUMMARY_CACHE: KVNamespace;
  COPILOT_PAT: string;
  BODY_MODEL?: string;
  BODY_REASONING_EFFORT?: string;
  BODY_TIMEOUT_MS?: string;
  BODY_MAX_TOKENS?: string;
}

const COPILOT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
const COPILOT_HEADERS: Record<string, string> = {
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
};

const DEFAULT_MODEL = "claude-opus-4.8";
const DEFAULT_REASONING = "max";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4000;
// Token freshness skew must exceed the longest single call timeout so a token
// that passes the freshness check cannot expire mid-call (LL-105).
const TOKEN_REFRESH_SKEW_MS = 180_000;
const DEFAULT_TOKEN_TTL_MS = 20 * 60_000;
const ISSUE_KEY = "body.issue.v1";
const ISSUE_TTL_SECONDS = 6 * 60 * 60;
const RECENT_ISSUE_MS = 60 * 60_000;
const ERROR_REPEAT_THRESHOLD = 3;
type IssueScope = "entry" | "runtime";
// A body must be at least this many characters to count as real (guards against
// a near-empty response slipping through as "complete").
const MIN_BODY_CHARS = 120;

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

/**
 * One plain-text Copilot call. Returns the cleaned body string. Throws on
 * non-200 (so Cloudflare Queues retries) and force-refreshes the IDE token on a
 * 401 mid-batch expiry (LL-105). Empty content (reasoning-loop) throws so the
 * caller's retry / Queue retry kicks in.
 */
async function callCopilotText(
  pat: string,
  model: string,
  reasoningEffort: string,
  prompt: string,
  timeoutMs: number,
  maxTokens: number,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const token = await resolveCopilotToken(pat, attempt > 0);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestBody: Record<string, unknown> = {
        model,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content:
              "You are a professional technology editor. Return only the plain-text body the user requested — no JSON, no code fences, no preamble.",
          },
          { role: "user", content: prompt },
        ],
      };
      if (reasoningEffort && reasoningEffort !== "none") {
        requestBody.reasoning_effort = reasoningEffort;
      }
      const res = await fetch(COPILOT_ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...COPILOT_HEADERS,
        },
        body: JSON.stringify(requestBody),
      });
      if (res.status === 401 && attempt === 0) {
        await res.text().catch(() => "");
        continue;
      }
      if (!res.ok) {
        throw new Error(`copilot ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = cleanBodyText(body.choices?.[0]?.message?.content ?? "");
      if (content.length < MIN_BODY_CHARS) {
        throw new Error(`empty/short body (${content.length} chars)`);
      }
      return content;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function isBodyEntryComplete(
  entry: { bodyJa: string; bodyEn: string },
  source?: SourceGroundingInput,
): boolean {
  const structurallyComplete = Boolean(
    entry.bodyJa.trim().length >= MIN_BODY_CHARS &&
    entry.bodyEn.trim().length >= MIN_BODY_CHARS,
  );
  if (!structurallyComplete) return false;
  if (!source) return true;
  return (
    hasSufficientBodySourceGrounding(source) &&
    !hasMaterialBodyGroundingConflict(source, entry)
  );
}

export function buildBodyCacheEntry(
  job: BodyJob,
  bodyJa: string,
  bodyEn: string,
  model: string,
  cachedAt = new Date().toISOString(),
): BodyCacheEntry {
  return {
    bodyJa,
    bodyEn,
    model,
    cachedAt,
    publisherContractFingerprint:
      job.publisherContractFingerprint ?? UNVERSIONED_JOB_FINGERPRINT,
  };
}

async function processJob(env: Env, job: BodyJob): Promise<void> {
  const pat = env.COPILOT_PAT;
  const model = env.BODY_MODEL || DEFAULT_MODEL;
  const reasoning = env.BODY_REASONING_EFFORT || DEFAULT_REASONING;
  const timeoutMs = Number(env.BODY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxTokens = Number(env.BODY_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);
  if (!hasSufficientBodySourceGrounding(job.entry)) {
    throw new Error(`insufficient source grounding for ${job.url}`);
  }

  // Two separate single-language calls (LL-115). Sequential so one shared token
  // covers both and Copilot pressure stays moderate (max_concurrency also caps
  // parallel invocations). Each call is I/O-bound (no Worker CPU cost, LL-115).
  const bodyJa = await callCopilotText(pat, model, reasoning, buildBodyPromptJa(job.entry), timeoutMs, maxTokens);
  const bodyEn = await callCopilotText(pat, model, reasoning, buildBodyPromptEn(job.entry), timeoutMs, maxTokens);

  const entry = buildBodyCacheEntry(job, bodyJa, bodyEn, model);
  if (!isBodyEntryComplete(entry, job.entry)) {
    throw new Error(`incomplete or ungrounded body for ${job.url}`);
  }
  await putBodyCacheEntry(env.SUMMARY_CACHE, job.url, entry);
  await clearIssue(env, job.url);
}

function issueSummary(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 500);
}

export function classifyBodyIssueScope(err: unknown): IssueScope {
  const summary = issueSummary(err).toLowerCase();
  return summary.includes("incomplete or ungrounded body for ")
    || summary.includes("insufficient source grounding for ")
    || /empty\/short body \(\d+ chars\)/.test(summary)
    ? "entry"
    : "runtime";
}

function issueScopeFromRecord(issue: Record<string, unknown> | null): IssueScope {
  if (issue?.scope === "entry" || issue?.scope === "runtime") return issue.scope;
  return classifyBodyIssueScope(issue?.error ?? "");
}

async function writeIssue(
  env: Env,
  status: "retry" | "deferred",
  job: BodyJob,
  err: unknown,
): Promise<void> {
  try {
    const existing = await env.SUMMARY_CACHE.get<Record<string, unknown>>(ISSUE_KEY, "json");
    const scope = classifyBodyIssueScope(err);
    const sameIssue =
      existing?.status === status
      && existing?.url === job.url
      && issueScopeFromRecord(existing) === scope;
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
    console.warn("[body] issue heartbeat write failed:", issueErr);
  }
}

async function clearIssue(env: Env, url: string): Promise<void> {
  try {
    const existing = await env.SUMMARY_CACHE.get<Record<string, unknown>>(ISSUE_KEY, "json");
    if (existing?.url === url) {
      await env.SUMMARY_CACHE.delete(ISSUE_KEY);
    }
  } catch (issueErr) {
    console.warn("[body] issue heartbeat clear failed:", issueErr);
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
        recentIssue
        && issueStatus === "retry"
        && issueScope === "runtime"
        && repeatCount >= ERROR_REPEAT_THRESHOLD
          ? "error"
          : recentIssue
          ? "warn"
          : "ok";
      const ok = cacheBinding && Boolean(env.COPILOT_PAT) && issueSeverity !== "error";
      return Response.json(
        {
          ok,
          role: "body-queue-consumer",
          model: env.BODY_MODEL || DEFAULT_MODEL,
          reasoningEffort: env.BODY_REASONING_EFFORT || DEFAULT_REASONING,
          timeoutMs: Number(env.BODY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
          maxTokens: Number(env.BODY_MAX_TOKENS ?? DEFAULT_MAX_TOKENS),
          cacheBinding,
          copilotSecretConfigured: Boolean(env.COPILOT_PAT),
          recentIssue,
          issueSeverity,
          issueScope,
          issue,
        },
        {
          status: ok ? 200 : 503,
          headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
        },
      );
    }
    return new Response("tech-dashboard body worker. Queue consumer is active.", {
      status: 200,
      headers: { "content-type": "text/plain;charset=UTF-8" },
    });
  },

  async queue(batch: MessageBatch<BodyJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processJob(env, msg.body);
        msg.ack();
      } catch (err) {
        const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // LL-043: KV daily write cap -> ack and let the next cron re-enqueue.
        if (summary.includes("KV put() limit exceeded")) {
          console.warn(`[body] ack ${msg.body.url}: daily KV write cap reached, will retry tomorrow`);
          await writeIssue(env, "deferred", msg.body, summary);
          msg.ack();
        } else {
          console.warn(`[body] retry ${msg.body.url}: ${summary}`);
          await writeIssue(env, "retry", msg.body, summary);
          msg.retry();
        }
      }
    }
  },
} satisfies ExportedHandler<Env, BodyJob>;
