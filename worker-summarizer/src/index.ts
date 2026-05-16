/**
 * tech-dashboard-summarizer — Cloudflare Worker Queue consumer.
 *
 * Receives one entry per invocation from the SUMMARY_QUEUE producer
 * (tech-dashboard-harness). For each message:
 *   1. Resolve Copilot token from COPILOT_PAT.
 *   2. Call Copilot /chat/completions with the bilingual JSON prompt.
 *   3. Parse the response.
 *   4. Write the result into SUMMARY_CACHE KV under the entry URL.
 *
 * Why a separate Worker (LL-037):
 *   The harness Worker hit Cloudflare's 30 s/invocation CPU cap when running
 *   summarize alongside publishHistoryFiles. Splitting summarize into its
 *   own Queue consumer gives every entry its own 30 s budget.
 *
 * Failure handling:
 *   - Copilot timeout / token error: throw -> Cloudflare Queues retries
 *     with exponential backoff (max_retries=2, see wrangler.toml).
 *   - parseResponse empty (model returned non-JSON or empty summaryJa):
 *     skip cache write but ack (don't burn retries on the same message).
 *   - After max_retries, message goes to the DLQ for manual triage.
 */
import type { NormalizedEntry } from "../../harness/types.ts";
import { buildPrompt, parseResponse } from "../../worker/src/prompt.ts";
import { type CacheEntry, putCacheEntry } from "../../worker/src/kv-cache.ts";

interface Env {
  SUMMARY_CACHE: KVNamespace;
  COPILOT_PAT: string;
  SUMMARIZE_MODEL: string;
  SUMMARIZE_TIMEOUT_MS?: string;
}

/**
 * Shape of a queue message produced by the harness Worker. Keep small —
 * Queues caps message size and we only need what buildPrompt reads.
 */
export interface SummaryJob {
  url: string;
  // The full NormalizedEntry would be more than we need; we only ship the
  // fields buildPrompt uses. Avoids bloating the queue payload.
  entry: Pick<
    NormalizedEntry,
    "id" | "url" | "title" | "category" | "source" | "sourceType"
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

const DEFAULT_TIMEOUT_MS = 25_000;

async function resolveCopilotToken(pat: string): Promise<string> {
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
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function callCopilot(
  token: string,
  model: string,
  entry: SummaryJob["entry"],
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
        // 2400 in the harness Worker was tuned for offline batch; in the
        // Worker's 28s CPU/wall budget, sonnet long-form often timed out
        // before finishing. 1500 keeps bilingual bodies meaningful (~500
        // chars JA, ~300 words EN) while letting the model finish in time.
        max_tokens: 1500,
        messages: [
          {
            role: "system",
            content:
              "You are a bilingual technical editor. Always return only the JSON object the user requested. Do not include code fences, prose preface, or commentary. Use natural Japanese for *Ja fields and native English for *En fields.",
          },
          {
            role: "user",
            content: buildPrompt(entry as NormalizedEntry),
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

async function processJob(env: Env, job: SummaryJob): Promise<void> {
  // Per-URL KV (LL-038): single KV.put per entry, no read-modify-write.
  // The producer (harness Worker) already filters out cached entries before
  // enqueuing, so duplicate work is rare. Each key is independent so parallel
  // consumer invocations can never clobber each other's writes.

  const token = await resolveCopilotToken(env.COPILOT_PAT);
  const model = env.SUMMARIZE_MODEL || "claude-sonnet-4.6";
  const timeoutMs = Number(env.SUMMARIZE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  const entry = await callCopilot(token, model, job.entry, timeoutMs);

  // Empty summaryJa indicates the model returned malformed JSON. Don't
  // poison the cache — let the message hit the DLQ for triage.
  if (!entry.summaryJa || !entry.summaryEn) {
    throw new Error(`empty summary for ${job.url}`);
  }

  await putCacheEntry(env.SUMMARY_CACHE, job.url, entry);
}

export default {
  async queue(batch: MessageBatch<SummaryJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processJob(env, msg.body);
        msg.ack();
      } catch (err) {
        const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.warn(`[summarizer] retry ${msg.body.url}: ${summary}`);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, SummaryJob>;
