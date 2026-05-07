/**
 * summarize.ts — GitHub Copilot Enterprise (Chat Completions) による日本語要約.
 *
 * **Copilot Enterprise 前提**。Claude Opus 4.6 / 4.7 など、Copilot で
 * 提供されているモデルを直接呼び出す。GitHub Models (別課金) とは別物。
 *
 * 認証フロー:
 *   1. COPILOT_TOKEN (一時トークン) が既に渡っていればそれを使う
 *   2. そうでなければ COPILOT_PAT (Copilot Enterprise 権限持ちの PAT) から
 *      `https://api.github.com/copilot_internal/v2/token` で交換する
 *   どちらも無ければ要約フェーズをスキップ (ローカル dev での軽量実行)。
 *
 * 環境変数:
 *   COPILOT_TOKEN        … 一時トークン (交換済み)。CI 等で直接注入する場合
 *   COPILOT_PAT          … PAT (classic でよい)。上記より優先度低
 *   SUMMARIZE_MODEL      … 既定 "claude-opus-4.7"
 *                          他例: "claude-opus-4.6" / "claude-sonnet-4.5" / "gpt-4o"
 *   SUMMARIZE_ENDPOINT   … 既定 "https://api.githubcopilot.com/chat/completions"
 *   SUMMARIZE_MAX_NEW    … 1 ラン当たりの新規要約上限 (既定 15)
 *
 * キャッシュ: data/_summary-cache.json (URL キー)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedEntry } from "../types.ts";

interface CacheEntry {
  titleJa: string;
  summaryJa: string;
  summaryEn: string;
  bodyJa: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
  model: string;
  cachedAt: string;
}

type Cache = Record<string, CacheEntry>;

const MODEL = process.env.SUMMARIZE_MODEL ?? "claude-opus-4.7";
const ENDPOINT =
  process.env.SUMMARIZE_ENDPOINT ??
  "https://api.githubcopilot.com/chat/completions";
const MAX_NEW = Number(process.env.SUMMARIZE_MAX_NEW ?? "15");
const CONCURRENCY = 4;

// Copilot Chat API が期待する整合ヘッダ。VS Code 拡張と同一構成を模倣する。
const COPILOT_HEADERS = {
  "copilot-integration-id": "vscode-chat",
  "editor-version": "vscode/1.95.0",
  "editor-plugin-version": "copilot-chat/0.22.0",
  "openai-intent": "conversation-panel",
  "user-agent": "GitHubCopilotChat/0.22.0",
} as const;

async function loadCache(path: string): Promise<Cache> {
  try {
    const txt = await readFile(path, "utf8");
    return JSON.parse(txt) as Cache;
  } catch {
    return {};
  }
}

async function saveCache(path: string, cache: Cache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

/**
 * PAT を Copilot 一時トークンに交換する。
 * 返る token は ~30 分有効 (Copilot 側で発行される短寿命トークン)。
 */
async function exchangePatToCopilotToken(pat: string): Promise<string> {
  const res = await fetch(
    "https://api.github.com/copilot_internal/v2/token",
    {
      headers: {
        authorization: `token ${pat}`,
        "user-agent": COPILOT_HEADERS["user-agent"],
        "editor-version": COPILOT_HEADERS["editor-version"],
      },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `copilot token exchange ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("copilot token exchange: no token in response");
  return data.token;
}

async function resolveCopilotToken(): Promise<string | null> {
  const direct = process.env.COPILOT_TOKEN;
  if (direct) return direct;
  const pat = process.env.COPILOT_PAT;
  if (!pat) return null;
  return exchangePatToCopilotToken(pat);
}

async function callCopilot(
  token: string,
  entry: NormalizedEntry,
): Promise<CacheEntry> {
  const prompt = buildPrompt(entry);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...COPILOT_HEADERS,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1800,
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
    throw new Error(`copilot ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseModelResponse(text);
  return {
    titleJa: parsed.titleJa,
    summaryJa: parsed.summaryJa,
    summaryEn: parsed.summaryEn,
    bodyJa: parsed.bodyJa,
    importance: parsed.importance,
    extraTags: parsed.extraTags,
    model: MODEL,
    cachedAt: new Date().toISOString(),
  };
}

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
    `  "bodyJa": "プロライター視点で書かれた日本語本文 (700〜1100 文字)。以下の構成で、独立した記事として読めるように書くこと:\n· リード文: 主題と重要性を 1、2 文で提示\n· 本文: 元記事の主要ポイント・技術的内容・背景を掛い摩んで説明。複数パラグラフを \\n\\n で区切る\n· 関連知見: キーワードに関わる背景・雑学・周辺ツールや他社動向との関連を含めて読み応えを上げる\n· トーン: 中立、事実ベース。誤った断定や推測の単言は避ける\n· 推測を含める際は「と見られる」「可能性がある」等のヘッジ表現を使う\n· 出力はプレーンテキスト。Markdown 見出しやリスト記号は使わず、改行は \\n\\n のみ",`,
    `  "importance": 1 | 2 | 3,`,
    `  "extraTags": ["英小文字 kebab", ...]`,
    `}`,
    ``,
    `importance 基準: 3=メジャーリリース/重大発表、2=機能追加/重要論文、1=通常更新。`,
    `titleJa: 固有名詞 (製品名・企業名) は英語のまま保持。バージョン番号 (例: 4.7) も正確に保持する。`,
    `summaryJa と summaryEn は同じ内容を各言語で表現すること。`,
    `bodyJa は読んで価値のある独立した記事にすること。要約の重複を避け、背景・関連知見を付加して厚みを出す。`,
  ].join("\n");
}

function parseModelResponse(text: string): {
  titleJa: string;
  summaryJa: string;
  summaryEn: string;
  bodyJa: string;
  importance: 1 | 2 | 3;
  extraTags: string[];
} {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", importance: 1, extraTags: [] };
  try {
    const obj = JSON.parse(match[0]) as {
      titleJa?: string;
      summaryJa?: string;
      summaryEn?: string;
      bodyJa?: string;
      importance?: number;
      extraTags?: string[];
    };
    const imp = Math.max(1, Math.min(3, Number(obj.importance ?? 1))) as 1 | 2 | 3;
    return {
      titleJa: String(obj.titleJa ?? "").trim(),
      summaryJa: String(obj.summaryJa ?? "").trim(),
      summaryEn: String(obj.summaryEn ?? "").trim(),
      bodyJa: String(obj.bodyJa ?? "").trim(),
      importance: imp,
      extraTags: Array.isArray(obj.extraTags)
        ? obj.extraTags.filter((t): t is string => typeof t === "string").slice(0, 6)
        : [],
    };
  } catch {
    return { titleJa: "", summaryJa: "", summaryEn: "", bodyJa: "", importance: 1, extraTags: [] };
  }
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
      const item = items[i]!;
      try {
        results[i] = await fn(item);
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
        results[i] = await fn(item);
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface SummarizeResult {
  entries: NormalizedEntry[];
  stats: {
    cached: number;
    summarized: number;
    skipped: number;
    errors: number;
  };
}

/**
 * Enhances entries with summaryJa/importance/extra tags via Copilot Enterprise.
 * トークンが解決できない場合は no-op で透過 (ローカル dev を妨げない)。
 */
export async function summarize(
  entries: NormalizedEntry[],
  dataDir: string,
): Promise<SummarizeResult> {
  const stats = { cached: 0, summarized: 0, skipped: 0, errors: 0 };

  const cachePath = join(dataDir, "_summary-cache.json");
  const cache = await loadCache(cachePath);

  // 1) Apply cached summaries before token resolution so local preview keeps
  // Japanese titles/summaries even when Copilot auth is temporarily unavailable.
  const needsSummary: NormalizedEntry[] = [];
  const out = entries.map((e) => {
    const hit = cache[e.url];
    const cachedTitleJa = hit?.titleJa || e.titleJa;
    if (hit && cachedTitleJa && hit.summaryJa && hit.summaryEn) {
      // Re-summarize entries cached before bodyJa was introduced.
      if (!hit.bodyJa) {
        needsSummary.push(e);
      } else {
        stats.cached++;
      }
      return {
        ...e,
        titleJa: cachedTitleJa,
        summaryJa: hit.summaryJa,
        summaryEn: hit.summaryEn,
        bodyJa: hit.bodyJa || e.bodyJa,
        importance: hit.importance,
        tags: dedupeTags([...e.tags, ...hit.extraTags]),
      };
    }
    needsSummary.push(e);
    return e;
  });

  let token: string | null;
  try {
    token = await resolveCopilotToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[summarize] token resolve failed — skipping: ${msg}`);
    stats.skipped = needsSummary.length;
    return { entries: out, stats };
  }

  if (!token) {
    console.log(
      "[summarize] COPILOT_TOKEN / COPILOT_PAT not set — skipping",
    );
    stats.skipped = needsSummary.length;
    return { entries: out, stats };
  }

  // 2) Budget-cap newcomers.
  const toSummarize = needsSummary.slice(0, MAX_NEW);
  stats.skipped = needsSummary.length - toSummarize.length;

  if (toSummarize.length === 0) {
    return { entries: out, stats };
  }

  console.log(
    `[summarize] ${toSummarize.length} entries → ${MODEL} (cache=${stats.cached} skipped=${stats.skipped})`,
  );

  const fetched = await runWithConcurrency(
    toSummarize,
    async (e) => {
      try {
        const r = await callCopilot(token, e);
        cache[e.url] = r;
        stats.summarized++;
        return { url: e.url, entry: r, ok: true as const };
      } catch (err) {
        stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[summarize] err ${e.url}: ${msg}`);
        return { url: e.url, ok: false as const };
      }
    },
    CONCURRENCY,
  );

  // 3) Merge fetched summaries into output.
  const mergedByUrl = new Map(
    fetched.filter((f) => f.ok).map((f) => [f.url, f.entry] as const),
  );
  const finalEntries = out.map((e) => {
    const r = mergedByUrl.get(e.url);
    if (!r) return e;
    return {
      ...e,
      titleJa: r.titleJa || e.titleJa,
      summaryJa: r.summaryJa,
      summaryEn: r.summaryEn || e.summaryEn,
      bodyJa: r.bodyJa || e.bodyJa,
      importance: r.importance,
      tags: dedupeTags([...e.tags, ...r.extraTags]),
    };
  });

  await saveCache(cachePath, cache);
  return { entries: finalEntries, stats };
}

function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags)].slice(0, 10);
}
