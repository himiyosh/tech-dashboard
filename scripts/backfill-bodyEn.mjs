/**
 * backfill-bodyEn.mjs — bodyEn のみを生成するバックフィル.
 *
 * 既存の bodyJa を入力コンテキストとして与え、英文記事だけを生成させる。
 * bodyJa + bodyEn を同時に返させるとレスポンスが max_tokens を超えて
 * JSON が途中で切れるため、専用スクリプトで分けている。
 *
 * Usage:
 *   COPILOT_PAT=ghp_... BACKFILL_MAX=50 node scripts/backfill-bodyEn.mjs
 */
import fs from "node:fs";

const INDEX = "data/index.json";
const CACHE = "data/_summary-cache.json";
const DEFAULT_SUMMARIZE_MODEL = "claude-opus-4.7";
const ALLOWED_SUMMARIZE_MODELS = new Set([DEFAULT_SUMMARIZE_MODEL, "gpt-5.5"]);

function resolveSummarizeModel(model = process.env.SUMMARIZE_MODEL) {
  const selected = model ?? DEFAULT_SUMMARIZE_MODEL;
  if (!ALLOWED_SUMMARIZE_MODELS.has(selected)) {
    throw new Error(
      `Unsupported SUMMARIZE_MODEL="${selected}". Use claude-opus-4.7 or gpt-5.5 for article summarization and backfill.`,
    );
  }
  return selected;
}

const MODEL = resolveSummarizeModel();
const ENDPOINT =
  process.env.SUMMARIZE_ENDPOINT ??
  "https://api.githubcopilot.com/chat/completions";
const MAX_NEW = Number(process.env.BACKFILL_MAX ?? "30");
const MAX_TOKENS = Number(process.env.SUMMARIZE_MAX_TOKENS ?? "3000");
const REQUEST_TIMEOUT_MS = Number(process.env.SUMMARIZE_TIMEOUT_MS ?? "180000");
const CONCURRENCY = Number(process.env.SUMMARIZE_CONCURRENCY ?? "4");

const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
};

async function exchangePat(pat) {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${pat}`,
      "user-agent": COPILOT_HEADERS["user-agent"],
      "editor-version": COPILOT_HEADERS["editor-version"],
    },
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  const data = await res.json();
  if (!data.token) throw new Error("no token");
  return data.token;
}

async function resolveToken() {
  if (process.env.COPILOT_TOKEN) return process.env.COPILOT_TOKEN;
  const pat = process.env.COPILOT_PAT;
  if (!pat) throw new Error("COPILOT_PAT required");
  return exchangePat(pat);
}

function buildPrompt(e) {
  return [
    `# Article`,
    `Title: ${e.title}`,
    `Category: ${e.category}`,
    `Source: ${e.source}`,
    `URL: ${e.url}`,
    ``,
    `# Japanese version (already written, for context)`,
    e.bodyJa || "",
    ``,
    `# Task`,
    `Write a native English long-form article (500-800 words) covering the same topic and depth as the Japanese version above.`,
    `Do NOT translate literally — write as a professional tech editor would in English.`,
    `Structure: lead paragraph (1-2 sentences on subject and significance), main body (key points / technical content / background, multiple paragraphs separated by \\n\\n), related context (background, ecosystem references, hedged speculation when appropriate).`,
    `Plain text only. No Markdown headings or list symbols. Paragraphs separated by \\n\\n.`,
    `Tone: neutral, fact-based. Use hedged language ("appears to", "may", "is reportedly") for speculation.`,
    ``,
    `Return ONLY the following JSON, no extra text:`,
    `{ "bodyEn": "..." }`,
  ].join("\n");
}

async function callCopilot(token, entry) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content:
              "You are a professional English-language tech editor. Return only the requested JSON.",
          },
          { role: "user", content: buildPrompt(entry) },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`copilot ${res.status}: ${body.slice(0, 200)}`);
    }
    data = await res.json();
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`copilot request timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const text = data.choices?.[0]?.message?.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in response");
  const obj = JSON.parse(m[0]);
  const bodyEn = String(obj.bodyEn ?? "").trim();
  if (!bodyEn) throw new Error("empty bodyEn");
  return bodyEn;
}

async function runWithConcurrency(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i]) };
      } catch (e) {
        results[i] = { ok: false, err: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// --- Main ---
const idx = JSON.parse(fs.readFileSync(INDEX, "utf8"));
const cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));

const missing = idx.entries.filter(
  (e) => (e.bodyJa || "").trim() && !(e.bodyEn || "").trim(),
);
console.log(
  `[bodyEn] total=${idx.entries.length} has-bodyJa-no-bodyEn=${missing.length}`,
);

const target = missing.slice(0, MAX_NEW);
if (target.length === 0) {
  console.log("[bodyEn] nothing to do");
  process.exit(0);
}

const token = await resolveToken();
console.log(`[bodyEn] fetching ${target.length} entries (concurrency=${CONCURRENCY})...`);

const t0 = Date.now();
const results = await runWithConcurrency(
  target,
  async (e) => {
    const bodyEn = await callCopilot(token, e);
    return { url: e.url, bodyEn };
  },
  CONCURRENCY,
);

let ok = 0,
  err = 0;
const byUrl = new Map();
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.ok) {
    byUrl.set(r.value.url, r.value.bodyEn);
    ok++;
  } else {
    err++;
    console.warn(`[bodyEn] err ${target[i].url}: ${r.err}`);
  }
}

// Write into entries + cache
for (const e of idx.entries) {
  const bodyEn = byUrl.get(e.url);
  if (bodyEn) {
    e.bodyEn = bodyEn;
    if (cache[e.url]) {
      cache[e.url].bodyEn = bodyEn;
      cache[e.url].cachedAt = new Date().toISOString();
    }
  }
}
idx.generatedAt = new Date().toISOString();
fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + "\n");
fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2) + "\n");

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const remaining = idx.entries.filter(
  (e) => (e.bodyJa || "").trim() && !(e.bodyEn || "").trim(),
).length;
console.log(
  `[bodyEn] ok=${ok} err=${err} elapsed=${elapsed}s remaining=${remaining}`,
);
