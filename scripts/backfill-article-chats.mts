/**
 * scripts/backfill-article-chats.mts
 *
 * Backfills the 記事ディスカッション (article chat) for entries that already
 * carry a real body in data/bodies.json but predate the chat feature.
 *
 * Route: this script NEVER writes data files. It generates a chat per entry
 * (production prompt + validation from worker/src/article-chat.ts, gpt-5.6
 * chain via /responses per R-007) and PUTs a body+chat BodyCacheEntry into
 * the same per-URL `b:` KV keys worker-body uses. The hourly publisher's
 * chat-missing lookup lane (worker/src/index.ts) then reads them back and
 * mergeBodies grafts ONLY the chat onto the existing bodies.json record — so
 * the published prose never churns and no data-file PR can conflict with the
 * hourly data commits (R-001c).
 *
 * Idempotent: an entry whose KV record already holds a valid chat is skipped,
 * so re-runs continue where the last one stopped.
 *
 * Usage:
 *   npx tsx scripts/backfill-article-chats.mts                # dry-run report
 *   npx tsx scripts/backfill-article-chats.mts --limit 25     # dry-run, first 25
 *   npx tsx scripts/backfill-article-chats.mts --apply --limit 25
 *
 * R-028: do not run concurrently with other automation in this checkout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildArticleChatPrompt,
  chatGroundingText,
  parseArticleChat,
  validateArticleChat,
} from "../worker/src/article-chat.ts";
import {
  buildCopilotRequestBody,
  copilotEndpointForModel,
  copilotEndpointUrl,
  parseModelChain,
  extractCopilotText,
} from "../worker/src/copilot-client.ts";
import { hasMaterialBodyGroundingConflict } from "../harness/pipeline/source-grounding.ts";
import { isRealBody, type BodyRecord } from "../worker/src/bodies-file.ts";

const KV_NAMESPACE_ID = "6d67debb991742efadfec473a121f5fc";
/** Same chain as worker-body/wrangler.toml (R-007). */
const MODEL_CHAIN = parseModelChain("gpt-5.6-sol", "gpt-5.6-terra,gpt-5.6-luna");
const MAX_TOKENS = 1600;
const CALL_TIMEOUT_MS = 60_000;
const CHAT_SYSTEM =
  "You are a professional technology editor. Return only the JSON the user requested — no code fences, no preface, no commentary.";

// ------------------------------------------------------------------- args ---
const args = process.argv.slice(2);
let apply = false;
let limit = 10;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--apply") apply = true;
  else if (args[i] === "--limit" && args[i + 1]) limit = Math.max(1, Number(args[++i]));
  else {
    console.error("Usage: npx tsx scripts/backfill-article-chats.mts [--apply] [--limit N]");
    process.exit(1);
  }
}

// ------------------------------------------------------------------ copilot --
const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
const pat = envLocal.match(/^COPILOT_PAT=(.+)$/m)?.[1]?.trim();
if (!pat) {
  console.error("ERR: COPILOT_PAT not found in .env.local (nothing was modified)");
  process.exit(1);
}
const HEADERS: Record<string, string> = {
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "user-agent": "GitHubCopilotChat/0.22.0",
};
let cachedToken: { token: string; expiresAtMs: number } | null = null;
async function copilotToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs - 120_000) return cachedToken.token;
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { ...HEADERS, authorization: `token ${pat}` },
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  const body = (await res.json()) as { token: string; expires_at?: number };
  cachedToken = {
    token: body.token,
    expiresAtMs: typeof body.expires_at === "number" ? body.expires_at * 1000 : Date.now() + 20 * 60_000,
  };
  return body.token;
}

async function generateChat(entry: Record<string, unknown>): Promise<ReturnType<typeof validateArticleChat>> {
  const prompt = buildArticleChatPrompt(entry as never);
  for (const model of MODEL_CHAIN) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      const endpoint = copilotEndpointForModel(model);
      const res = await fetch(copilotEndpointUrl(endpoint), {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...HEADERS,
          authorization: `Bearer ${await copilotToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          buildCopilotRequestBody({
            model,
            systemPrompt: CHAT_SYSTEM,
            userPrompt: prompt,
            maxTokens: MAX_TOKENS,
            temperature: 0.3,
          }),
        ),
      }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`${model} ${res.status}`);
      const turns = parseArticleChat(extractCopilotText(endpoint, await res.json()));
      if (!turns) continue; // structural failure: try the next model once
      const text = chatGroundingText(turns);
      if (hasMaterialBodyGroundingConflict(entry as never, { bodyJa: text.ja, bodyEn: text.en })) {
        return null; // grounding conflict is a content problem, not a model one
      }
      return turns;
    } catch (err) {
      console.warn(`  ${model} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------------- kv ---
function kvKeyArgs(key: string): string[] {
  return ["--namespace-id", KV_NAMESPACE_ID, "--remote", key];
}
async function kvGet(key: string): Promise<Record<string, unknown> | null> {
  const out = spawnSync("npx", ["--yes", "wrangler@4.85.0", "kv", "key", "get", ...kvKeyArgs(key)], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (out.status !== 0) return null; // miss (wrangler exits nonzero on missing key)
  try {
    return JSON.parse(out.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function kvPut(key: string, value: string): boolean {
  const out = spawnSync(
    "npx",
    ["--yes", "wrangler@4.85.0", "kv", "key", "put", ...kvKeyArgs(key), value],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (out.status !== 0) console.error(`  KV put failed: ${out.stderr.slice(0, 200)}`);
  return out.status === 0;
}
async function bodyCacheKeyForUrl(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `b:${hex}`;
}

// -------------------------------------------------------------------- main ---
const index = JSON.parse(readFileSync(join(process.cwd(), "data", "index.json"), "utf8")) as {
  entries: Array<Record<string, unknown> & { id: string; url: string }>;
};
const bodies = JSON.parse(readFileSync(join(process.cwd(), "data", "bodies.json"), "utf8")) as {
  bodies: Record<string, BodyRecord>;
};

const candidates = index.entries.filter((entry) => {
  const record = bodies.bodies[entry.id];
  return record && isRealBody(record) && !validateArticleChat(record.chat);
});
console.log(`bodied entries without a chat: ${candidates.length}`);
const batch = candidates.slice(0, limit);
console.log(`${apply ? "APPLY" : "DRY-RUN"}: processing ${batch.length} (limit ${limit})\n`);

let generated = 0;
let skippedInKv = 0;
let failed = 0;
for (const entry of batch) {
  const label = `${entry.id} ${String(entry.title ?? "").slice(0, 50)}`;
  const key = await bodyCacheKeyForUrl(entry.url);
  if (apply) {
    const existing = await kvGet(key);
    if (existing && validateArticleChat(existing.chat)) {
      skippedInKv++;
      console.log(`SKIP (chat already in KV)  ${label}`);
      continue;
    }
    const chat = await generateChat(entry);
    if (!chat) {
      failed++;
      console.log(`FAIL                       ${label}`);
      continue;
    }
    const record = bodies.bodies[entry.id]!;
    // Body text comes from the published record: mergeBodies grafts only the
    // chat, but keeping the KV entry self-consistent costs nothing.
    const cacheEntry = {
      bodyJa: record.bodyJa,
      bodyEn: record.bodyEn,
      chat,
      model: `chat-backfill:${MODEL_CHAIN[0]}`,
      cachedAt: new Date().toISOString(),
    };
    if (kvPut(key, JSON.stringify(cacheEntry))) {
      generated++;
      console.log(`OK   ${chat.length} turns        ${label}`);
    } else {
      failed++;
    }
  } else {
    console.log(`would process              ${label}`);
  }
}

console.log(
  `\n${apply ? "APPLIED" : "DRY-RUN"}: generated=${generated} skippedInKv=${skippedInKv} failed=${failed} remaining=${candidates.length - batch.length}`,
);
if (!apply) console.log("Re-run with --apply to generate and write to KV.");
