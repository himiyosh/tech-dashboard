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

/** Return epoch ms for sorting; nulls sort to end in descending order. */
function dateMs(iso: string | null): number {
  return iso ? new Date(iso).getTime() : -Infinity;
}
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
  titleJa: string;
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
    `  "titleJa": "日本語タイトル (30〜60文字)。原題が日本語ならそのまま。英語なら自然な日本語に翻訳",`,
    `  "summaryJa": "2〜3 行の日本語要約 (120〜200 文字)",`,
    `  "summaryEn": "1-2 sentence English summary (140-260 chars). Plain English only, no Japanese.",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["英小文字 kebab", ...]`,
    `}`,
    ``,
    `importance 基準: 3=メジャーリリース/重大発表、2=機能追加/重要論文、1=通常更新。`,
    `titleJa: 固有名詞 (製品名・企業名) は英語のまま保持。バージョン番号 (例: 4.7) も正確に保持する。`,
    `summaryJa と summaryEn は同じ内容を各言語で表現すること。`,
  ].join("\n");
}

function parseResponse(text: string): {
  titleJa: string;
  summaryJa: string;
  summaryEn: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
} {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { titleJa: "", summaryJa: "", summaryEn: "", importance: 1, extraTags: [] };
  try {
    const obj = JSON.parse(match[0]) as {
      titleJa?: string;
      summaryJa?: string;
      summaryEn?: string;
      importance?: number;
      extraTags?: string[];
    };
    const imp = Math.max(1, Math.min(3, Number(obj.importance ?? 1))) as 1 | 2 | 3;
    return {
      titleJa: String(obj.titleJa ?? "").trim(),
      summaryJa: String(obj.summaryJa ?? "").trim(),
      summaryEn: String(obj.summaryEn ?? "").trim(),
      importance: imp,
      extraTags: Array.isArray(obj.extraTags)
        ? obj.extraTags.filter((t): t is string => typeof t === "string").slice(0, 6)
        : [],
    };
  } catch {
    return { titleJa: "", summaryJa: "", summaryEn: "", importance: 1, extraTags: [] };
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
    const html = new TextDecoder("utf-8", { fatal: false }).decode(buf);
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
    return new URL(src, base).toString();
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

async function runHarness(env: Env): Promise<{ changed: boolean; stats: Record<string, number> }> {
  const collectedAt = new Date().toISOString();
  // Exclude file-system-backed sources (e.g. user-opml reads data/user-opml.xml).
  const allSources = listSources().filter((s) => s.id !== "user-opml");

  // Cloudflare Free Workers cap subrequests at 50 per invocation, so we cannot
  // fetch all 50 sources in a single run. Rotate sources across SOURCE_BATCHES
  // batches keyed by hour, so each source is refreshed every SOURCE_BATCHES hours.
  // Subrequest budget per run: ~13 sources + 1 GH read + 5 Copilot + 4 OG + 1 GH put = ~24.
  const SOURCE_BATCHES = 4;
  const batchIndex = Math.floor(Date.now() / 3600_000) % SOURCE_BATCHES;
  const sources = allSources.filter((_, i) => i % SOURCE_BATCHES === batchIndex);
  console.log(`[worker] run ${collectedAt}, batch ${batchIndex + 1}/${SOURCE_BATCHES} (${sources.length} of ${allSources.length} sources)`);

  // 0) Read existing index FIRST so we can merge fresh entries from this batch
  //    with prior entries from the other batches (avoids losing data).
  const existing = await ghGetFile(env, "data/index.json");
  let priorEntries: NormalizedEntry[] = [];
  if (existing?.content) {
    try {
      const parsed = JSON.parse(existing.content) as { entries?: NormalizedEntry[] };
      priorEntries = parsed.entries ?? [];
    } catch (err) {
      console.warn(`[worker] failed to parse existing index: ${err}`);
    }
  }

  // 1) Collect (only this batch's sources)
  const settled = await Promise.all(sources.map((s) => runSource(s, collectedAt)));
  const fresh = settled.flatMap((s) => s.entries);
  const okCount = settled.filter((s) => s.result.ok).length;
  console.log(`[worker] collect ok=${okCount}/${sources.length} fresh=${fresh.length} prior=${priorEntries.length}`);

  // 1.5) Merge fresh + prior. Prefer fresh entries on URL collision (newer data).
  const byUrl = new Map<string, NormalizedEntry>();
  for (const e of priorEntries) byUrl.set(e.url, e);
  for (const e of fresh) byUrl.set(e.url, e);
  const merged = [...byUrl.values()];

  // 2) Cap per source then sort newest-first then cap to INDEX_LIMIT.
  const PER_SOURCE_CAP = 15;
  const bySource = new Map<string, NormalizedEntry[]>();
  for (const e of merged) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }
  const capped: NormalizedEntry[] = [];
  for (const [, arr] of bySource) {
    arr.sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt));
    capped.push(...arr.slice(0, PER_SOURCE_CAP));
  }
  const sorted = capped
    .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt))
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
    const cachedTitleJa = hit?.titleJa || e.titleJa;
    if (hit && cachedTitleJa && hit.summaryJa && hit.summaryEn) {
      afterCache.push({
        ...e,
        titleJa: cachedTitleJa,
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
          titleJa: r.titleJa || e.titleJa,
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

  // 4.5) OG image enrichment — fetch <meta property="og:image"> for entries
  //      that still lack a thumbnail. Cached in KV under "og.v1" as a single
  //      blob keyed by URL. Capped per run to stay within Worker subrequest
  //      and CPU budgets.
  const OG_KEY = "og.v1";
  const OG_BUDGET_PER_RUN = 4;
  const ogBlob =
    (await env.SUMMARY_CACHE.get<Record<string, { src: string | null; checkedAt: string }>>(OG_KEY, "json")) ?? {};

  // Apply already-cached og hits.
  for (let i = 0; i < afterCache.length; i++) {
    const e = afterCache[i]!;
    if (e.image) continue;
    const cached = ogBlob[e.url];
    if (cached?.src) {
      afterCache[i] = {
        ...e,
        image: { src: cached.src, origSrc: cached.src, alt: e.title, width: 0, height: 0, source: "og" },
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
      const src = byUrl.get(e.url);
      if (src && !e.image) {
        afterCache[i] = {
          ...e,
          image: { src, origSrc: src, alt: e.title, width: 0, height: 0, source: "og" },
        };
      }
    }
    if (ogTargets.length > 0) {
      await env.SUMMARY_CACHE.put(OG_KEY, JSON.stringify(ogBlob));
    }
  }
  console.log(`[worker] og: cached=${Object.keys(ogBlob).length}, new hits=${ogFound}`);

  // 5) Build payload (cap 500, newest first)
  const finalEntries = afterCache.slice(0, INDEX_LIMIT);
  const payload = {
    generatedAt: new Date().toISOString(),
    count: finalEntries.length,
    entries: finalEntries,
  };
  const json = JSON.stringify(payload, null, 2) + "\n";

  // 6) Compare with existing index.json on GitHub (already loaded at step 0).
  const existingJson = existing?.content ?? "";
  // Compare ignoring `generatedAt` timestamp so unchanged runs don't churn commits.
  const stripGen = (s: string) => s.replace(/"generatedAt"\s*:\s*"[^"]+",?\s*/, "");
  if (existingJson && stripGen(existingJson) === stripGen(json)) {
    console.log("[worker] no data changes — skipping commit");
    return {
      changed: false,
      stats: {
        sources: sources.length,
        collected: fresh.length,
        merged: merged.length,
        summarized,
        errors,
      },
    };
  }

  // 7) Commit to GitHub
  const failedSources = settled.filter((s) => !s.result.ok).map((s) => s.result.sourceId);
  const message =
    `chore(data): worker run ${collectedAt.slice(0, 16)}Z batch ${batchIndex + 1}/${SOURCE_BATCHES}` +
    (summarized ? ` (+${summarized} summaries)` : "") +
    (failedSources.length ? ` [${failedSources.length} source err]` : "");
  await ghPutFile(env, "data/index.json", json, message, existing?.sha);
  console.log(`[worker] committed: ${message}`);

  return {
    changed: true,
    stats: {
      sources: sources.length,
      collected: fresh.length,
      merged: merged.length,
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
        const stack = err instanceof Error && err.stack ? err.stack : String(err);
        console.error("[worker] fatal:", stack);
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
