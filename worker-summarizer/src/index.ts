/**
 * tech-dashboard-summarizer — Cloudflare Worker Queue consumer.
 *
 * Receives one entry per invocation from the SUMMARY_QUEUE producer
 * (tech-dashboard-harness). For each message:
 *   1. Resolve Copilot token from COPILOT_PAT.
 *   2. Call Copilot /chat/completions with the long-form bilingual JSON prompt.
 *   3. If the response is incomplete, retry once with a compact recovery prompt.
 *   4. Parse the response and write it into SUMMARY_CACHE KV under the entry URL.
 *
 * Why a separate Worker (LL-037):
 *   The harness Worker hit Cloudflare's default 30 s/invocation CPU cap when
 *   running summarize alongside publishHistoryFiles. Splitting summarize into
 *   its own Queue consumer lets this Worker use a larger CPU/timeout budget
 *   for quality-first article bodies.
 *
 * Failure handling:
 *   - Copilot timeout / token error: throw -> Cloudflare Queues retries
 *     with exponential backoff (max_retries=2, see wrangler.toml).
 *   - Incomplete model output: retry once in-process with a compact JSON-only
 *     prompt before handing the message back to Cloudflare Queues.
 *   - After max_retries, message goes to the DLQ for manual triage.
 */
import type { NormalizedEntry } from "../../harness/types.ts";
import { buildPrompt, buildQueuePrompt, parseResponse } from "../../worker/src/prompt.ts";
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

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_TOKENS = 6000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 20 * 60_000;
const ISSUE_KEY = "summarizer.issue.v1";
const ISSUE_TTL_SECONDS = 6 * 60 * 60;
const RECENT_ISSUE_MS = 60 * 60_000;
const ERROR_REPEAT_THRESHOLD = 3;
const RECOVERY_TIMEOUT_MS = 90_000;
const RECOVERY_MAX_TOKENS = 3500;
const FIELD_REPAIR_TIMEOUT_MS = 60_000;
const FIELD_REPAIR_MAX_TOKENS = 2500;

let cachedCopilotToken: { pat: string; token: string; expiresAtMs: number } | null = null;

async function resolveCopilotToken(pat: string): Promise<string> {
  const now = Date.now();
  if (
    cachedCopilotToken?.pat === pat &&
    cachedCopilotToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now
  ) {
    return cachedCopilotToken.token;
  }

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
  token: string,
  model: string,
  prompt: string,
  timeoutMs: number,
  maxTokens: number,
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

export function isCompleteCacheEntry(entry: CacheEntry): boolean {
  return Boolean(
    entry.titleJa.trim() &&
      entry.summaryJa.trim() &&
      entry.summaryEn.trim() &&
      entry.bodyJa.trim() &&
      entry.bodyEn.trim(),
  );
}

function missingFields(entry: CacheEntry): Array<keyof Pick<CacheEntry, "titleJa" | "summaryJa" | "summaryEn" | "bodyJa" | "bodyEn">> {
  return (["titleJa", "summaryJa", "summaryEn", "bodyJa", "bodyEn"] as const).filter(
    (field) => !entry[field].trim(),
  );
}

function mergeCacheEntry(base: CacheEntry, patch: CacheEntry): CacheEntry {
  return {
    ...base,
    titleJa: patch.titleJa.trim() || base.titleJa,
    summaryJa: patch.summaryJa.trim() || base.summaryJa,
    summaryEn: patch.summaryEn.trim() || base.summaryEn,
    bodyJa: patch.bodyJa.trim() || base.bodyJa,
    bodyEn: patch.bodyEn.trim() || base.bodyEn,
    importance: patch.importance || base.importance,
    extraTags: [...new Set([...base.extraTags, ...patch.extraTags])].slice(0, 6),
    model: patch.model || base.model,
    cachedAt: patch.cachedAt || base.cachedAt,
  };
}

function buildFieldRepairPrompt(job: SummaryJob, partial: CacheEntry): string {
  const missing = missingFields(partial).join(", ");
  return [
    `Repair the incomplete JSON summary for this article.`,
    `Return one complete valid JSON object with all required fields non-empty.`,
    `Missing fields: ${missing}`,
    ``,
    `Article title: ${job.entry.title}`,
    `Category: ${job.entry.category}`,
    `Source: ${job.entry.source} (${job.entry.sourceType})`,
    `URL: ${job.entry.url}`,
    job.entry.summaryEn ? `Collected English context: ${job.entry.summaryEn}` : "",
    job.entry.summaryJa ? `Collected Japanese context: ${job.entry.summaryJa}` : "",
    ``,
    `Preserve these existing non-empty values exactly unless they are clearly malformed:`,
    JSON.stringify(partial, null, 2),
    ``,
    `Required JSON shape:`,
    `{`,
    `  "titleJa": "non-empty Japanese title",`,
    `  "summaryJa": "non-empty Japanese summary, 80-140 chars",`,
    `  "summaryEn": "non-empty English summary, 90-170 chars",`,
    `  "bodyJa": "non-empty Japanese context note, 240-420 chars, 2-3 paragraphs separated by \\\\n\\\\n",`,
    `  "bodyEn": "non-empty native English context note, 140-220 words, 2-3 paragraphs separated by \\\\n\\\\n",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["lowercase-kebab"]`,
    `}`,
    ``,
    `Use only facts supported by the title and collected context. Hedge uncertain implications.`,
  ].filter(Boolean).join("\n");
}

async function processJob(env: Env, job: SummaryJob): Promise<void> {
  // Per-URL KV (LL-038): single KV.put per entry, no read-modify-write.
  // The producer (harness Worker) already filters out cached entries before
  // enqueuing, so duplicate work is rare. Each key is independent so parallel
  // consumer invocations can never clobber each other's writes.

  const token = await resolveCopilotToken(env.COPILOT_PAT);
  const model = env.SUMMARIZE_MODEL || "claude-sonnet-4.6";
  const timeoutMs = Number(env.SUMMARIZE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxTokens = Number(env.SUMMARIZE_MAX_TOKENS ?? DEFAULT_MAX_TOKENS);

  let entry = await callCopilot(token, model, buildPrompt(job.entry), timeoutMs, maxTokens);

  if (!isCompleteCacheEntry(entry)) {
    console.warn(`[summarizer] recovery prompt ${job.url}: primary output was incomplete`);
    entry = await callCopilot(
      token,
      model,
      buildQueuePrompt(job.entry),
      Math.min(timeoutMs, RECOVERY_TIMEOUT_MS),
      Math.min(maxTokens, RECOVERY_MAX_TOKENS),
    );
  }

  if (!isCompleteCacheEntry(entry)) {
    console.warn(
      `[summarizer] field repair prompt ${job.url}: missing ${missingFields(entry).join(", ")}`,
    );
    const repaired = await callCopilot(
      token,
      model,
      buildFieldRepairPrompt(job, entry),
      Math.min(timeoutMs, FIELD_REPAIR_TIMEOUT_MS),
      Math.min(maxTokens, FIELD_REPAIR_MAX_TOKENS),
    );
    entry = mergeCacheEntry(entry, repaired);
  }

  // Do not poison the cache with malformed JSON or missing long-form fields.
  if (!isCompleteCacheEntry(entry)) {
    throw new Error(`incomplete summary for ${job.url}`);
  }

  await putCacheEntry(env.SUMMARY_CACHE, job.url, entry);
  await clearIssue(env, job.url);
}

function issueSummary(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, 500);
}

async function writeIssue(
  env: Env,
  status: "retry" | "deferred",
  job: SummaryJob,
  err: unknown,
): Promise<void> {
  try {
    const existing = await env.SUMMARY_CACHE.get<Record<string, unknown>>(ISSUE_KEY, "json");
    const sameIssue = existing?.status === status && existing?.url === job.url;
    const repeatCount =
      sameIssue && typeof existing?.repeatCount === "number" && Number.isFinite(existing.repeatCount)
        ? existing.repeatCount + 1
        : 1;
    await env.SUMMARY_CACHE.put(
      ISSUE_KEY,
      JSON.stringify({
        ok: status === "deferred" || repeatCount < ERROR_REPEAT_THRESHOLD,
        status,
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
      const issue = await env.SUMMARY_CACHE.get<Record<string, unknown>>(ISSUE_KEY, "json");
      const issueAt = typeof issue?.at === "string" ? Date.parse(issue.at) : Number.NaN;
      const recentIssue = Number.isFinite(issueAt) && Date.now() - issueAt <= RECENT_ISSUE_MS;
      const issueStatus = typeof issue?.status === "string" ? issue.status : null;
      const repeatCount =
        typeof issue?.repeatCount === "number" && Number.isFinite(issue.repeatCount)
          ? issue.repeatCount
          : recentIssue && issueStatus === "retry"
          ? 1
          : 0;
      const issueSeverity =
        recentIssue && issueStatus === "retry" && repeatCount >= ERROR_REPEAT_THRESHOLD
          ? "error"
          : recentIssue
          ? "warn"
          : "ok";
      const ok = Boolean(env.SUMMARY_CACHE) && Boolean(env.COPILOT_PAT) && issueSeverity !== "error";
      return Response.json(
        {
          ok,
          role: "queue-consumer",
          model: env.SUMMARIZE_MODEL || "claude-sonnet-4.6",
          timeoutMs: Number(env.SUMMARIZE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
          maxTokens: Number(env.SUMMARIZE_MAX_TOKENS ?? DEFAULT_MAX_TOKENS),
          cacheBinding: Boolean(env.SUMMARY_CACHE),
          copilotSecretConfigured: Boolean(env.COPILOT_PAT),
          recentIssue,
          issueSeverity,
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
