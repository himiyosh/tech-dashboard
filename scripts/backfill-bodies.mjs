/**
 * backfill-bodies.mjs — local bulk backfill of long-form article bodies.
 *
 * The cloud body pipeline (worker-body, LL-115/LL-116) generates ~20 bodies per
 * hourly cron, so draining a large backlog takes 1-2 days. This script does the
 * same generation LOCALLY with no cron / KV-write-budget / subrequest limits, so
 * the whole backlog finishes in ~1-2 hours.
 *
 * It reuses the EXACT worker contracts so the output is identical to the cloud
 * worker (no drift):
 *   - prompts:   worker/src/body-generate.ts (buildBodyPromptJa/En, cleanBodyText)
 *   - merge:     worker/src/bodies-file.ts   (mergeBodies, isRealBody, ...)
 *   - model:     claude-opus-4.8, reasoning_effort=max, temperature 0.3 (worker-body)
 *
 * Safety vs the live collector (which commits data/bodies.json hourly):
 *   - Generated bodies are written incrementally to a gitignored cache
 *     (data/_body-backfill-cache.json) so an interrupted run resumes.
 *   - bodies.json is rebuilt by MERGING the cache into the CURRENT on-disk
 *     bodies.json (mergeBodies is additive + prunes only non-live ids), so a
 *     cloud-generated body landing during the run is preserved, not clobbered.
 *
 * Env (via `tsx --env-file-if-exists=.env.local`):
 *   COPILOT_PAT (or COPILOT_TOKEN)  — required, same as resummarize.mjs
 *   BODY_CONCURRENCY   default 6
 *   BODY_MAX_NEW       default Infinity (cap entries this run, for smoke tests)
 *   BODY_MODEL         default claude-opus-4.8
 *   BODY_REASONING_EFFORT default max
 *   BODY_MAX_TOKENS    default 4000
 *   BODY_TIMEOUT_MS    default 120000
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildBodyPromptJa,
  buildBodyPromptEn,
  cleanBodyText,
} from "../worker/src/body-generate.ts";
import {
  parseBodies,
  serializeBodies,
  mergeBodies,
  isRealBody,
} from "../worker/src/bodies-file.ts";

const INDEX_PATH = "data/index.json";
const BODIES_PATH = "data/bodies.json";
const CACHE_PATH = "data/_body-backfill-cache.json";

const MODEL = process.env.BODY_MODEL || "claude-opus-4.8";
const REASONING = process.env.BODY_REASONING_EFFORT || "max";
const MAX_TOKENS = Number(process.env.BODY_MAX_TOKENS ?? 4000);
const TIMEOUT_MS = Number(process.env.BODY_TIMEOUT_MS ?? 120_000);
const CONCURRENCY = Math.max(1, Number(process.env.BODY_CONCURRENCY ?? 6));
const MAX_NEW = Number(process.env.BODY_MAX_NEW ?? Infinity);
const MIN_BODY_CHARS = 120;
const FLUSH_EVERY = 8;

const COPILOT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
};

// --- Copilot token (exchange PAT, refresh on age/401) -----------------------
const TOKEN_TTL_MS = 20 * 60 * 1000; // re-exchange well before the ~30min expiry
let cachedToken = null;
let cachedTokenAtMs = 0;

async function exchangePat(pat) {
  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      authorization: `token ${pat}`,
      "user-agent": COPILOT_HEADERS["user-agent"],
      "editor-version": COPILOT_HEADERS["editor-version"],
    },
  });
  if (!res.ok) {
    throw new Error(`copilot token exchange ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("copilot token exchange: no token in response");
  return data.token;
}

async function getToken(force = false) {
  const direct = process.env.COPILOT_TOKEN;
  if (direct) return direct;
  const pat = process.env.COPILOT_PAT;
  if (!pat) throw new Error("COPILOT_PAT (or COPILOT_TOKEN) is required");
  const now = Date.now();
  if (!force && cachedToken && now - cachedTokenAtMs < TOKEN_TTL_MS) return cachedToken;
  cachedToken = await exchangePat(pat);
  cachedTokenAtMs = Date.now();
  return cachedToken;
}

async function callCopilotText(prompt) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const requestBody = {
        model: MODEL,
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: "system",
            content:
              "You are a professional technology editor. Return only the plain-text body the user requested — no JSON, no code fences, no preamble.",
          },
          { role: "user", content: prompt },
        ],
      };
      if (REASONING && REASONING !== "none") requestBody.reasoning_effort = REASONING;
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
        continue; // force token refresh on next attempt
      }
      if (!res.ok) throw new Error(`copilot ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
      const json = await res.json();
      const content = cleanBodyText(json.choices?.[0]?.message?.content ?? "");
      if (content.length < MIN_BODY_CHARS) throw new Error(`empty/short body (${content.length} chars)`);
      return content;
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`copilot timeout after ${TIMEOUT_MS}ms`);
      if (attempt === 1) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}

// --- cache (resume) ---------------------------------------------------------
function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveCache(cache) {
  const tmp = `${CACHE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  fs.renameSync(tmp, CACHE_PATH);
}

// --- bodies.json rebuild from cache (merge into CURRENT on-disk file) --------
function applyCacheToBodies(cache) {
  const existing = parseBodies(fs.readFileSync(BODIES_PATH, "utf8"));
  const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const liveIds = new Set(idx.entries.map((e) => e.id));
  const newBodies = Object.entries(cache)
    .filter(([, b]) => isRealBody(b))
    .map(([id, b]) => ({ id, bodyJa: b.bodyJa, bodyEn: b.bodyEn, model: b.model, cachedAt: b.cachedAt }));
  const merged = mergeBodies(existing, newBodies, liveIds, new Date().toISOString());
  fs.writeFileSync(BODIES_PATH, serializeBodies(merged.payload));
  return merged;
}

// --- main -------------------------------------------------------------------
async function main() {
  const applyOnly = process.argv.includes("--apply-only");
  const cache = loadCache();

  if (applyOnly) {
    const merged = applyCacheToBodies(cache);
    console.log(`[backfill-bodies] apply-only: bodies.json now ${merged.payload.count} (added ${merged.added}, pruned ${merged.pruned})`);
    return;
  }

  const idx = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  const existing = parseBodies(fs.readFileSync(BODIES_PATH, "utf8"));

  const isFallbackSummary = (s) => {
    const t = (s ?? "").trim();
    return !t || t.startsWith("このエントリは ") || t.includes("AI summary not yet available");
  };
  // Eligible = real bilingual summary (publishable) AND no real body yet AND not already cached this run.
  const eligible = idx.entries.filter((e) => {
    if (isFallbackSummary(e.summaryJa) || isFallbackSummary(e.summaryEn)) return false;
    if (isRealBody(existing.bodies[e.id])) return false;
    if (isRealBody(cache[e.id])) return false;
    return true;
  });
  // Newest first so the visible top of the timeline fills in first.
  eligible.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  const targets = Number.isFinite(MAX_NEW) ? eligible.slice(0, MAX_NEW) : eligible;

  console.log(
    `[backfill-bodies] live=${idx.entries.length} existing-bodies=${existing.count} cached=${Object.keys(cache).length} eligible=${eligible.length} targets=${targets.length}`,
  );
  console.log(`[backfill-bodies] model=${MODEL} reasoning=${REASONING} concurrency=${CONCURRENCY} maxTokens=${MAX_TOKENS}`);
  if (targets.length === 0) {
    applyCacheToBodies(cache);
    console.log("[backfill-bodies] nothing to generate; bodies.json refreshed from cache");
    return;
  }

  let done = 0;
  let failed = 0;
  let sinceFlush = 0;
  const startMs = Date.now();
  let cursor = 0;

  async function worker(wid) {
    while (cursor < targets.length) {
      const i = cursor++;
      const e = targets[i];
      const promptEntry = {
        id: e.id,
        title: e.title,
        titleJa: e.titleJa,
        titleEn: e.titleEn,
        category: e.category,
        source: e.source,
        sourceType: e.sourceType,
        url: e.url,
        summaryJa: e.summaryJa,
        summaryEn: e.summaryEn,
        publishedAt: e.publishedAt,
        tags: e.tags,
      };
      try {
        const bodyJa = await callCopilotText(buildBodyPromptJa(promptEntry));
        const bodyEn = await callCopilotText(buildBodyPromptEn(promptEntry));
        if (bodyJa.trim().length < MIN_BODY_CHARS || bodyEn.trim().length < MIN_BODY_CHARS) {
          throw new Error(`incomplete (ja=${bodyJa.length}, en=${bodyEn.length})`);
        }
        cache[e.id] = { bodyJa, bodyEn, model: MODEL, cachedAt: new Date().toISOString() };
        done++;
        sinceFlush++;
      } catch (err) {
        failed++;
        console.warn(`[backfill-bodies] FAIL ${e.id} (${e.source}): ${err instanceof Error ? err.message : err}`);
      }
      if (sinceFlush >= FLUSH_EVERY) {
        sinceFlush = 0;
        saveCache(cache);
        const elapsed = (Date.now() - startMs) / 1000;
        const rate = done / Math.max(elapsed / 60, 0.001);
        const remain = targets.length - (done + failed);
        const eta = rate > 0 ? Math.ceil(remain / rate) : 0;
        console.log(`[backfill-bodies] progress ${done + failed}/${targets.length} (ok=${done} fail=${failed}) ~${rate.toFixed(1)}/min ETA~${eta}min`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  saveCache(cache);
  const merged = applyCacheToBodies(cache);
  console.log(`[backfill-bodies] DONE ok=${done} fail=${failed} in ${((Date.now() - startMs) / 60000).toFixed(1)}min`);
  console.log(`[backfill-bodies] bodies.json now ${merged.payload.count} (added ${merged.added}, pruned ${merged.pruned})`);
}

main().catch((err) => {
  console.error("[backfill-bodies] fatal:", err);
  process.exit(1);
});
