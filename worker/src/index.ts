/**
 * Cloudflare Worker — scheduled harness runner.
 *
 * Replaces `.github/workflows/harness-daily.yml`. Cron trigger fires every
 * 6 hours; the Worker fetches RSS sources, normalizes, dedupes, summarizes
 * via Copilot Enterprise, and commits `data/index.json` back to GitHub via
 * the Contents API. Cloudflare Pages (Git-integrated) then picks up the push
 * and auto-deploys.
 *
 * Bindings (see wrangler.toml):
 *   - SUMMARY_CACHE (KV)   replaces data/_summary-cache.json
 *   - COPILOT_PAT (secret) classic GH PAT with Copilot Enterprise
 *   - GH_TOKEN    (secret) fine-grained PAT, Contents: Write on this repo
 *   - GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (vars)
 *   - SUMMARIZE_MODEL, SUMMARIZE_MAX_NEW (vars)
 */
import { listSources } from "../../harness/registry.ts";
import { normalize } from "../../harness/pipeline/normalize.ts";
import { dedupeByUrl } from "../../harness/pipeline/dedupe.ts";
import { applyTags } from "../../harness/pipeline/tag.ts";
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
}

const INDEX_LIMIT = 500;
const SUMMARIZE_CONCURRENCY = 4;
const COPILOT_ENDPOINT = "https://api.githubcopilot.com/chat/completions";
const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
} as const;

interface CacheEntry {
  summaryJa: string;
  summaryEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
  model: string;
  cachedAt: string;
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

async function ghPutFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  sha: string | undefined,
): Promise<void> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: env.GITHUB_BRANCH,
    committer: {
      name: "tech-dashboard-worker",
      email: "bot@users.noreply.github.com",
    },
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "tech-dashboard-worker",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gh put ${path} ${res.status}: ${await res.text()}`);
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

function buildPrompt(e: NormalizedEntry): string {
  return [
    `# 記事`,
    `タイトル: ${e.title}`,
    `カテゴリ: ${e.category}`,
    `ソース: ${e.source} (${e.sourceType})`,
    `URL: ${e.url}`,
    ``,
    `以下の JSON を**余計な文字を付けず**出力してください:`,
    `{`,
    `  "summaryJa": "2〜3 行の日本語要約 (120〜200 文字)",`,
    `  "summaryEn": "1-2 sentence English summary (140-260 chars). Plain English only, no Japanese.",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["英小文字 kebab", ...]`,
    `}`,
    ``,
    `importance 基準: 3=メジャーリリース/重大発表、2=機能追加/重要論文、1=通常更新。`,
    `summaryJa と summaryEn は同じ内容を各言語で表現すること。バージョン番号 (例: 4.7) や固有名詞は正確に保持する。`,
  ].join("\n");
}

function parseResponse(text: string): {
  summaryJa: string;
  summaryEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
} {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { summaryJa: "", summaryEn: "", importance: 1, extraTags: [] };
  try {
    const obj = JSON.parse(match[0]) as {
      summaryJa?: string;
      summaryEn?: string;
      importance?: number;
      extraTags?: string[];
    };
    const imp = Math.max(1, Math.min(3, Number(obj.importance ?? 1))) as 1 | 2 | 3;
    return {
      summaryJa: String(obj.summaryJa ?? "").trim(),
      summaryEn: String(obj.summaryEn ?? "").trim(),
      importance: imp,
      extraTags: Array.isArray(obj.extraTags)
        ? obj.extraTags.filter((t): t is string => typeof t === "string").slice(0, 6)
        : [],
    };
  } catch {
    return { summaryJa: "", summaryEn: "", importance: 1, extraTags: [] };
  }
}

async function callCopilot(token: string, model: string, e: NormalizedEntry): Promise<CacheEntry> {
  const res = await fetch(COPILOT_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...COPILOT_HEADERS,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 400,
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

async function runHarness(env: Env): Promise<{ changed: boolean; stats: Record<string, number> }> {
  const collectedAt = new Date().toISOString();
  // Exclude file-system-backed sources (e.g. user-opml reads data/user-opml.xml).
  const sources = listSources().filter((s) => s.id !== "user-opml");
  console.log(`[worker] run ${collectedAt}, ${sources.length} sources`);

  // 1) Collect
  const settled = await Promise.all(sources.map((s) => runSource(s, collectedAt)));
  const all = settled.flatMap((s) => s.entries);
  const deduped = dedupeByUrl(all);
  const okCount = settled.filter((s) => s.result.ok).length;
  console.log(`[worker] collect ok=${okCount}/${sources.length} entries=${all.length} deduped=${deduped.length}`);

  // 2) Cap per source (prevents arxiv's 400+ daily drop from drowning out
  //    all other sources), then sort newest-first, then cap to INDEX_LIMIT.
  const PER_SOURCE_CAP = 15;
  const bySource = new Map<string, NormalizedEntry[]>();
  for (const e of deduped) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }
  const capped: NormalizedEntry[] = [];
  for (const [, arr] of bySource) {
    arr.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
    capped.push(...arr.slice(0, PER_SOURCE_CAP));
  }
  const sorted = capped
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, INDEX_LIMIT);

  // 3) Resolve Copilot token (skip if PAT absent)
  let token: string | null = null;
  if (env.COPILOT_PAT) {
    try {
      token = await resolveCopilotToken(env.COPILOT_PAT);
    } catch (err) {
      console.warn(`[worker] copilot token exchange failed: ${err}`);
    }
  }

  // 4) Summarize — apply KV cache, budget new calls.
  //    Cache stored as a single JSON blob keyed by URL to avoid
  //    hundreds of sequential KV gets (each ~30ms, which exhausts the
  //    Worker wall-time budget of ~30s).
  const model = env.SUMMARIZE_MODEL || "claude-opus-4.7";
  const maxNew = Number(env.SUMMARIZE_MAX_NEW || "25");
  const CACHE_KEY = "cache.v1";
  const cacheBlob =
    (await env.SUMMARY_CACHE.get<Record<string, CacheEntry>>(CACHE_KEY, "json")) ?? {};

  const needsSummary: NormalizedEntry[] = [];
  const afterCache: NormalizedEntry[] = [];
  for (const e of sorted) {
    const hit = cacheBlob[e.url];
    if (hit && hit.summaryJa && hit.summaryEn) {
      afterCache.push({
        ...e,
        summaryJa: hit.summaryJa,
        summaryEn: hit.summaryEn,
        importance: hit.importance,
        tags: dedupeTags([...e.tags, ...hit.extraTags]),
      });
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
        try {
          const r = await callCopilot(token!, model, e);
          cacheBlob[e.url] = r;
          return { url: e.url, entry: r, ok: true as const };
        } catch (err) {
          errors++;
          console.warn(`[worker] summarize err ${e.url}: ${err}`);
          return { url: e.url, ok: false as const };
        }
      },
      SUMMARIZE_CONCURRENCY,
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
          summaryJa: r.summaryJa,
          summaryEn: r.summaryEn || e.summaryEn,
          importance: r.importance,
          tags: dedupeTags([...e.tags, ...r.extraTags]),
        };
      }
    }
    // Persist the updated blob (single KV put).
    if (summarized > 0) {
      await env.SUMMARY_CACHE.put(CACHE_KEY, JSON.stringify(cacheBlob));
    }
  } else if (!token) {
    console.warn("[worker] no Copilot token — skipping summarization");
  }

  // 5) Build payload (cap 500, newest first)
  const finalEntries = afterCache.slice(0, INDEX_LIMIT);
  const payload = {
    generatedAt: new Date().toISOString(),
    count: finalEntries.length,
    entries: finalEntries,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";

  // 6) Compare with existing index.json on GitHub
  const existing = await ghGetFile(env, "data/index.json");
  const existingJson = existing?.content ?? "";
  // Compare ignoring `generatedAt` timestamp so unchanged runs don't churn commits.
  const stripGen = (s: string) => s.replace(/"generatedAt"\s*:\s*"[^"]+",?\s*/, "");
  if (existingJson && stripGen(existingJson) === stripGen(json)) {
    console.log("[worker] no data changes — skipping commit");
    return {
      changed: false,
      stats: {
        sources: sources.length,
        collected: all.length,
        deduped: deduped.length,
        summarized,
        errors,
      },
    };
  }

  // 7) Commit to GitHub
  const failedSources = settled.filter((s) => !s.result.ok).map((s) => s.result.sourceId);
  const message =
    `chore(data): worker run ${collectedAt.slice(0, 16)}Z` +
    (summarized ? ` (+${summarized} summaries)` : "") +
    (failedSources.length ? ` [${failedSources.length} source err]` : "");
  await ghPutFile(env, "data/index.json", json, message, existing?.sha);
  console.log(`[worker] committed: ${message}`);

  return {
    changed: true,
    stats: {
      sources: sources.length,
      collected: all.length,
      deduped: deduped.length,
      summarized,
      errors,
    },
  };
}

// ---------- Worker entry points ---------------------------------------------

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runHarness(env).catch((err) => {
        console.error("[worker] fatal:", err);
        throw err;
      }),
    );
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
    return new Response(
      "tech-dashboard harness worker. POST /run (auth: x-trigger-token) to trigger.",
      { status: 200 },
    );
  },
} satisfies ExportedHandler<Env>;
