// Backfill REAL bilingual AI summaries for the "snippet masquerade" entries
// (Issue #1, LL-118). These ~909 live entries were NEVER summarized by any AI
// model: the old normalize.placeholderSummary() sliced a raw RSS snippet at
// 120/200 chars (JA sources: summaryEn = the raw title) and the worker gate
// treated that non-empty/unmarked text as COMPLETE, so they were never queued.
//
// This script regenerates them LOCALLY using the SAME summary-only contract the
// worker queue uses (worker/src/prompt.ts buildSummaryPrompt + parseResponse),
// so the output is byte-compatible with the production pipeline. It defaults to
// model -- which is why running this directly honors the user's "change the
// model" request. The default is claude-opus-4.8 (the highest-quality allowed
// model, chosen by the user for this backfill). The summary-only prompt is
// short, so opus (a reasoning model) finishes within budget locally where it
// would time out on the 30s Worker wall-time (LL-031/106).
//
// AUTH: needs a Copilot credential the runtime does not have by default.
//   export COPILOT_PAT=...    (a ghu_ Copilot PAT; exchanged for a short token)
//   # or: export COPILOT_TOKEN=...  (an already-exchanged Copilot token)
//   # or: npm run auth:setup        (device flow, writes the PAT)
//
// RESUME: every successful generation is written to a gitignored cache
//   data/_summary-backfill-cache.json keyed by entry id, so re-running after an
//   interruption (or token expiry) only regenerates what is missing (LL-117).
//
// DURABILITY: like the migration, real summaries survive re-collection ONLY once
// the FIXED worker is deployed (R-008/LL-073). After deploy, re-collection emits
// an empty summaryJa and entry-merge fillText() keeps the prior real summary.
//
// Usage:
//   npx tsx scripts/backfill-summaries.mjs --dry           # list targets, no API calls
//   COPILOT_PAT=... npx tsx scripts/backfill-summaries.mjs # generate + write
//   COPILOT_PAT=... SUMMARIZE_MODEL=claude-sonnet-4.6 npx tsx scripts/backfill-summaries.mjs
//   ... --limit 20                                         # cap this run (smoke test)

import fs from "node:fs";
import { buildSummaryPrompt, parseResponse } from "../worker/src/prompt.ts";

const DRY = process.argv.includes("--dry");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const FILE = "data/index.json";
const CACHE_FILE = "data/_summary-backfill-cache.json";

const ALLOWED_MODELS = new Set(["claude-sonnet-4.6", "claude-opus-4.7", "claude-opus-4.8", "gpt-5.5"]);
const MODEL = process.env.SUMMARIZE_MODEL ?? "claude-opus-4.8";
if (!ALLOWED_MODELS.has(MODEL)) {
  console.error(`Unsupported SUMMARIZE_MODEL="${MODEL}". Use claude-opus-4.8, claude-opus-4.7, claude-sonnet-4.6, or gpt-5.5 (R-007).`);
  process.exit(1);
}
const ENDPOINT = process.env.SUMMARIZE_ENDPOINT ?? "https://api.githubcopilot.com/chat/completions";
const MAX_TOKENS = Number(process.env.SUMMARIZE_MAX_TOKENS ?? "1600");
const TIMEOUT_MS = Number(process.env.SUMMARIZE_TIMEOUT_MS ?? "120000");
const CONCURRENCY = Number(process.env.SUMMARIZE_CONCURRENCY ?? "8");

// VS Code Copilot Chat 互換ヘッダ (summarize.ts と同一)。
const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
};

// ---- masquerade detector (identical to migrate-stuck-summaries-to-pending.mjs) ----
const FB_JA_PREFIX = "このエントリは ";
const FB_JA_NEEDLE = "AI 要約が未生成";
const FB_EN_NEEDLE = "AI summary not yet available";
const isPending = (s) => {
  s = s || "";
  return s.startsWith(FB_JA_PREFIX) || s.includes(FB_JA_NEEDLE) || s.includes(FB_EN_NEEDLE);
};
const JA_TERMINAL = /[。．.!?！？」』）)\u2026]$/;
const EN_TERMINAL = /[.!?"'\u2019\u201d)\]\u2026]$/;
function isMasquerade(e) {
  const ja = e.summaryJa || "";
  const en = e.summaryEn || "";
  if (isPending(ja) || isPending(en)) return false;
  return (!!en && en === e.title) || (ja.length === 120 && !JA_TERMINAL.test(ja)) || (en.length === 200 && !EN_TERMINAL.test(en));
}

// ---- Copilot auth + call ----
async function exchangePatToCopilotToken(pat) {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${pat}`,
      "user-agent": COPILOT_HEADERS["user-agent"],
      "editor-version": COPILOT_HEADERS["editor-version"],
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`copilot token exchange ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("copilot token exchange: no token in response");
  return data.token;
}

async function resolveToken() {
  if (process.env.COPILOT_TOKEN) return process.env.COPILOT_TOKEN;
  if (process.env.COPILOT_PAT) return exchangePatToCopilotToken(process.env.COPILOT_PAT);
  return null;
}

async function generate(token, entry) {
  const prompt = buildSummaryPrompt(entry);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...COPILOT_HEADERS },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content:
              "あなたは技術記事を日本語と英語の両方で要約するエディターです。指示された JSON 形式のみを返してください。You are an editor who summarises tech articles in both Japanese and English. Return only the requested JSON.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`copilot ${res.status}: ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    const parsed = parseResponse(text);
    if (!parsed.summaryJa.trim() || !parsed.summaryEn.trim()) {
      throw new Error("incomplete summary (empty summaryJa/summaryEn)");
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

// ---- main ----
const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
const targets = data.entries.filter(isMasquerade);
console.log(`total entries: ${data.entries.length}`);
console.log(`masquerade targets: ${targets.length}`);
console.log(`model: ${MODEL} | concurrency: ${CONCURRENCY} | max_tokens: ${MAX_TOKENS}`);

if (DRY) {
  console.log("\n(dry run -- no API calls, no file written)");
  process.exit(0);
}

const token = await resolveToken();
if (!token) {
  console.error(
    "\nNo Copilot credential. Set COPILOT_PAT (ghu_ Copilot PAT) or COPILOT_TOKEN, or run `npm run auth:setup`.\n" +
      "Then re-run. Progress is cached in data/_summary-backfill-cache.json so interrupted runs resume.",
  );
  process.exit(1);
}

const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
const pending = targets.filter((e) => !cache[e.id]).slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`already cached: ${targets.length - targets.filter((e) => !cache[e.id]).length} | to generate now: ${pending.length}\n`);

let ok = 0;
let fail = 0;
let done = 0;
function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

async function worker(queue) {
  for (;;) {
    const entry = queue.shift();
    if (!entry) return;
    try {
      const parsed = await generate(token, entry);
      cache[entry.id] = {
        titleJa: parsed.titleJa,
        summaryJa: parsed.summaryJa,
        summaryEn: parsed.summaryEn,
        importance: parsed.importance,
        extraTags: parsed.extraTags,
        model: MODEL,
        cachedAt: new Date().toISOString(),
      };
      ok++;
    } catch (err) {
      fail++;
      console.warn(`  FAIL ${entry.source} ${entry.id}: ${String(err.message || err).slice(0, 120)}`);
    }
    done++;
    if (done % 10 === 0) {
      saveCache();
      console.log(`  progress ${done}/${pending.length} (ok ${ok}, fail ${fail})`);
    }
  }
}

const queue = [...pending];
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker(queue)));
saveCache();

// Apply every cached summary back into index.json (covers this run + prior runs).
let applied = 0;
for (const e of data.entries) {
  const c = cache[e.id];
  if (!c) continue;
  e.summaryJa = c.summaryJa;
  e.summaryEn = c.summaryEn;
  if (c.titleJa && c.titleJa.trim()) e.titleJa = c.titleJa;
  if (Array.isArray(c.extraTags) && c.extraTags.length) {
    const tags = new Set([...(e.tags || []), ...c.extraTags]);
    e.tags = [...tags].slice(0, 12);
  }
  if (c.importance) e.importance = c.importance;
  applied++;
}
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");

console.log(`\ndone: generated ok ${ok}, fail ${fail}`);
console.log(`applied ${applied} cached summaries to ${FILE}`);
if (fail > 0) console.log(`re-run to retry the ${fail} failures (cache resumes the successful ones).`);
