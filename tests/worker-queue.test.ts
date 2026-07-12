import { describe, expect, it, vi } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import type { CacheEntry } from "../worker/src/kv-cache.ts";
import { evaluateHarnessHealth } from "../worker/src/index.ts";
import {
  needsGeneratedContent,
  orderSummaryCandidates,
  roundRobinStart,
  selectSummaryJobBatch,
  selectSummaryJobs,
  selectSummaryLookupEntries,
} from "../worker/src/summary-queue.ts";
import summarizerWorker, { isCompleteCacheEntry, isSummaryComplete } from "../worker-summarizer/src/index.ts";

const baseEntry: NormalizedEntry = {
  id: "entry-1",
  source: "arxiv-cs-ai",
  sourceType: "paper",
  url: "https://example.com/paper",
  title: "Example Paper",
  titleJa: "",
  titleEn: "Example Paper",
  summaryJa: "このエントリは arxiv-cs-ai から収集した research 領域の最新アップデートです。",
  summaryEn: "AI summary not yet available.",
  bodyJa: "このエントリは arxiv-cs-ai から収集した research 領域の最新アップデートです。",
  bodyEn: "This long-form note is completed from the existing summary and collection metadata.",
  lang: "en",
  publishedAt: "2026-05-23T00:00:00.000Z",
  collectedAt: "2026-05-23T01:00:00.000Z",
  tags: ["ai"],
  category: "research",
  importance: 1,
};

const realCache: CacheEntry = {
  titleJa: "Example Paper",
  summaryJa: "実 AI 要約です。",
  summaryEn: "Real AI summary.",
  bodyJa: "実 AI 本文です。",
  bodyEn: "Real AI body.",
  importance: 2,
  extraTags: [],
  model: "claude-sonnet-4.6",
  cachedAt: "2026-05-23T01:30:00.000Z",
};

// Summary-only KV entry: the queue summarizer (LL-106) writes real bilingual
// summaries but EMPTY bodies on purpose. These must count as a real cache hit
// so the entry is not re-enqueued forever (LL-107).
const summaryOnlyCache: CacheEntry = {
  titleJa: "要約のみキャッシュ",
  summaryJa: "実 AI 日本語要約 (本文なし)。",
  summaryEn: "Real AI summary with no long-form body.",
  bodyJa: "",
  bodyEn: "",
  importance: 2,
  extraTags: [],
  model: "claude-sonnet-4.6",
  cachedAt: "2026-06-21T00:08:00.000Z",
};

const contaminatedCache: CacheEntry = {
  ...summaryOnlyCache,
  summaryEn:
    "Left some junk in the readme and forgot to remove oopsies Release Notes: N/A or Added/Fixed/Improved",
};

function mockKv(json: unknown = null): KVNamespace {
  return {
    get: vi.fn(async () => json),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as KVNamespace;
}

describe("worker summary queue selection", () => {
  it("deterministic fallback entries are treated as needing generated content", () => {
    expect(needsGeneratedContent(baseEntry)).toBe(true);
  });

  it("does not enqueue entries that were not looked up because they already have real content", () => {
    const jobs = selectSummaryJobs([baseEntry], new Map(), new Set(), 30);
    expect(jobs).toEqual([]);
  });

  it("enqueues looked-up fallback entries with KV miss", () => {
    const jobs = selectSummaryJobs([baseEntry], new Map(), new Set([baseEntry.url]), 30);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.url).toBe(baseEntry.url);
    expect(jobs[0]!.entry.summaryEn).toBe(baseEntry.summaryEn);
    expect(jobs[0]!.entry.tags).toEqual(baseEntry.tags);
  });

  it("enqueues known fallback entries even when they were skipped by KV lookup cap", () => {
    const jobs = selectSummaryJobs(
      [baseEntry],
      new Map(),
      new Set(),
      30,
      new Set([baseEntry.url]),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.url).toBe(baseEntry.url);
  });

  it("skips entries with a complete non-fallback cache hit", () => {
    const jobs = selectSummaryJobs(
      [baseEntry],
      new Map([[baseEntry.url, realCache]]),
      new Set([baseEntry.url]),
      30,
    );
    expect(jobs).toEqual([]);
  });

  it("treats a summary-only cache hit (no body) as real and does not re-enqueue (LL-107)", () => {
    const jobs = selectSummaryJobs(
      [baseEntry],
      new Map([[baseEntry.url, summaryOnlyCache]]),
      new Set([baseEntry.url]),
      30,
    );
    expect(jobs).toEqual([]);
  });

  it("enqueues a contaminated entry and does not accept a contaminated KV cache hit", () => {
    const contaminatedEntry = {
      ...baseEntry,
      summaryJa: "編集予測の品質計測を改善した。",
      summaryEn: contaminatedCache.summaryEn,
    };
    expect(needsGeneratedContent(contaminatedEntry)).toBe(true);
    const jobs = selectSummaryJobs(
      [contaminatedEntry],
      new Map([[contaminatedEntry.url, contaminatedCache]]),
      new Set([contaminatedEntry.url]),
      30,
    );
    expect(jobs.map((job) => job.url)).toEqual([contaminatedEntry.url]);
    expect(isSummaryComplete(contaminatedCache)).toBe(false);
  });

  it("needsGeneratedContent is summary-only: real summary + deterministic body is complete (LL-107)", () => {
    const realSummaryDeterministicBody: NormalizedEntry = {
      ...baseEntry,
      summaryJa: "実 AI 日本語要約です。",
      summaryEn: "Real English summary.",
      // Body stays deterministic (R-012) and must NOT keep the entry in the
      // enqueue pool now that the summarizer is summary-only (LL-107).
      bodyJa: "このエントリは arxiv-cs-ai から収集した research 領域の最新アップデートです。",
      bodyEn:
        "This long-form note is completed from the existing summary and collection metadata.",
    };
    expect(needsGeneratedContent(realSummaryDeterministicBody)).toBe(false);
  });

  it("prioritizes the newest entry, then round-robins the backlog (LL-074 + LL-076)", () => {
    // Distinct publishedAt so "newest" is meaningful: paper-0 newest .. paper-9 oldest.
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ...baseEntry,
      id: `entry-${i}`,
      url: `https://example.com/paper-${i}`,
      publishedAt: new Date(Date.UTC(2026, 4, 23) - i * 3_600_000).toISOString(),
    }));
    const lookedUp = new Set(entries.map((entry) => entry.url));

    const first = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs: 0 });
    const second = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs: 3_600_000 });
    const fourth = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs: 3 * 3_600_000 });

    // The newest un-summarized entry is always queued first so fresh articles
    // get a real summary fast (cap 3 -> floor(3/2)=1 reserved recent slot).
    expect(first.jobs[0]!.url).toBe("https://example.com/paper-0");
    expect(second.jobs[0]!.url).toBe("https://example.com/paper-0");
    expect(fourth.jobs[0]!.url).toBe("https://example.com/paper-0");

    expect(first.eligibleCount).toBe(10);
    expect(first.drainEstimateHours).toBe(4);

    // The remaining slots are a fair round-robin window that advances each hour
    // so the older backlog still drains predictably (no starvation).
    expect(first.jobs.map((j) => j.url)).toEqual([
      "https://example.com/paper-0",
      "https://example.com/paper-1",
      "https://example.com/paper-2",
    ]);
    expect(second.jobs.map((j) => j.url)).toEqual([
      "https://example.com/paper-0",
      "https://example.com/paper-3",
      "https://example.com/paper-4",
    ]);
    expect(fourth.jobs.map((j) => j.url)).toEqual([
      "https://example.com/paper-0",
      "https://example.com/paper-9",
      "https://example.com/paper-1",
    ]);

    // No duplicates within a batch.
    for (const batch of [first, second, fourth]) {
      expect(new Set(batch.jobs.map((j) => j.url)).size).toBe(batch.jobs.length);
    }
  });

  it("prioritizes evergreen (Knowledge) entries ahead of the news backlog (LL-098)", () => {
    // 8 news entries + 2 evergreen entries scattered in the list. With cap 3,
    // the evergreen entries must always be picked first regardless of the
    // hourly round-robin offset, so Knowledge sources surface fast.
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => ({
        ...baseEntry,
        id: `news-${i}`,
        url: `https://example.com/news-${i}`,
      })),
      { ...baseEntry, id: "ev-0", url: "https://example.com/evergreen-0", evergreen: true },
      { ...baseEntry, id: "ev-1", url: "https://example.com/evergreen-1", evergreen: true },
    ];
    const lookedUp = new Set(entries.map((entry) => entry.url));

    for (const nowMs of [0, 3_600_000, 5 * 3_600_000]) {
      const batch = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs });
      const urls = batch.jobs.map((job) => job.url);
      // Both evergreen entries always come first.
      expect(urls.slice(0, 2)).toEqual([
        "https://example.com/evergreen-0",
        "https://example.com/evergreen-1",
      ]);
      // The remaining slot is a news entry (fills from the round-robin window).
      expect(urls).toHaveLength(3);
      expect(urls[2]).toMatch(/\/news-\d+$/);
      // No duplicates.
      expect(new Set(urls).size).toBe(3);
    }
  });

  it("queues the newest eligible entry even when it is last in the input (LL-074)", () => {
    // Older entries first, newest LAST, to prove the recency slot sorts by
    // publishedAt rather than relying on input order.
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => ({
        ...baseEntry,
        id: `old-${i}`,
        url: `https://example.com/old-${i}`,
        publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
      })),
      {
        ...baseEntry,
        id: "fresh",
        url: "https://example.com/fresh",
        publishedAt: new Date(Date.UTC(2026, 5, 1)).toISOString(),
      },
    ];
    const lookedUp = new Set(entries.map((entry) => entry.url));
    // cap 4 -> floor(4/2)=2 recent slots; the freshest URL must be queued first.
    const batch = selectSummaryJobBatch(entries, new Map(), lookedUp, 4, new Set(), { nowMs: 0 });
    expect(batch.jobs[0]!.url).toBe("https://example.com/fresh");
    expect(batch.jobs).toHaveLength(4);
    expect(new Set(batch.jobs.map((j) => j.url)).size).toBe(4);
  });

  it("skips recently failing summary URLs while keeping other jobs moving", () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({
      ...baseEntry,
      id: `entry-${i}`,
      url: `https://example.com/paper-${i}`,
    }));
    const lookedUp = new Set(entries.map((entry) => entry.url));

    const batch = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), {
      nowMs: 0,
      skipUrls: new Set(["https://example.com/paper-1"]),
    });

    expect(batch.cooldownCount).toBe(1);
    expect(batch.eligibleCount).toBe(3);
    expect(batch.jobs.map((job) => job.url)).toEqual([
      "https://example.com/paper-0",
      "https://example.com/paper-2",
      "https://example.com/paper-3",
    ]);
  });

  it("keeps lookup and all-miss enqueue URL order symmetric", () => {
    const entries = [
      ...Array.from({ length: 8 }, (_, i) => ({
        ...baseEntry,
        id: `news-${i}`,
        url: `https://example.com/news-${i}`,
        publishedAt: new Date(Date.UTC(2026, 5, 10) - i * 86_400_000).toISOString(),
      })),
      { ...baseEntry, id: "evergreen", url: "https://example.com/evergreen", evergreen: true },
    ];
    const nowMs = 4 * 3_600_000;
    const cap = 5;
    const lookup = selectSummaryLookupEntries(entries, cap, { nowMs });
    const lookedUp = new Set(lookup.entries.map((entry) => entry.url));
    const unchecked = new Set(
      entries.filter((entry) => !lookedUp.has(entry.url)).map((entry) => entry.url),
    );
    const enqueue = selectSummaryJobBatch(entries, new Map(), lookedUp, cap, unchecked, { nowMs });

    expect(lookup.entries.map((entry) => entry.url)).toEqual(
      enqueue.jobs.map((job) => job.url),
    );
  });

  it("applies the same cooldown exclusion to lookup and enqueue selection", () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({
      ...baseEntry,
      id: `cooldown-${i}`,
      url: `https://example.com/cooldown-${i}`,
      publishedAt: new Date(Date.UTC(2026, 5, 10) - i * 86_400_000).toISOString(),
    }));
    const skipUrls = new Set(["https://example.com/cooldown-0"]);
    const nowMs = 2 * 3_600_000;
    const lookup = selectSummaryLookupEntries(entries, 4, { nowMs, skipUrls });
    const lookedUp = new Set(lookup.entries.map((entry) => entry.url));
    const unchecked = new Set(
      entries.filter((entry) => !lookedUp.has(entry.url)).map((entry) => entry.url),
    );
    const enqueue = selectSummaryJobBatch(entries, new Map(), lookedUp, 4, unchecked, {
      nowMs,
      skipUrls,
    });

    expect(lookup.entries.map((entry) => entry.url)).toEqual(
      enqueue.jobs.map((job) => job.url),
    );
    expect(lookup.entries.map((entry) => entry.url)).not.toContain(
      "https://example.com/cooldown-0",
    );
    expect(lookup.cooldownCount).toBe(1);
    expect(enqueue.cooldownCount).toBe(1);
  });

  it("shared ordering prioritizes evergreen, reserves recent work, and removes duplicate URLs", () => {
    const duplicate = { ...baseEntry, id: "duplicate", url: "https://example.com/news-0" };
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => ({
        ...baseEntry,
        id: `news-${i}`,
        url: `https://example.com/news-${i}`,
        publishedAt: new Date(Date.UTC(2026, 5, 10) - i * 86_400_000).toISOString(),
      })),
      duplicate,
      { ...baseEntry, id: "evergreen", url: "https://example.com/evergreen", evergreen: true },
    ];

    const ordered = orderSummaryCandidates(entries, 5, { nowMs: 0 });
    const urls = ordered.entries.map((entry) => entry.url);
    expect(urls[0]).toBe("https://example.com/evergreen");
    expect(urls[1]).toBe("https://example.com/news-0");
    expect(urls).toHaveLength(5);
    expect(new Set(urls).size).toBe(urls.length);
    expect(ordered.eligibleCount).toBe(7);
  });
});

describe("roundRobinStart (shared enqueue + KV-lookup window, LL-102)", () => {
  const H = 3_600_000;
  it("advances by a FULL cap each hour, not one item", () => {
    // 627 fallbacks, cap 80: the window must jump 80 per hour so the merge-back
    // window cycles in ~8h, not 627h. The old 1/hour bug returned hour%627.
    expect(roundRobinStart(0 * H, 627, 80)).toBe(0);
    expect(roundRobinStart(1 * H, 627, 80)).toBe(80);
    expect(roundRobinStart(2 * H, 627, 80)).toBe(160);
    // Definitely NOT the old 1/hour behaviour.
    expect(roundRobinStart(1 * H, 627, 80)).not.toBe(1);
  });
  it("wraps around the total", () => {
    expect(roundRobinStart(8 * H, 627, 80)).toBe((8 * 80) % 627); // 13
    expect(roundRobinStart(100 * H, 627, 80)).toBe((100 * 80) % 627);
  });
  it("returns 0 when the backlog fits in one window", () => {
    expect(roundRobinStart(5 * H, 40, 80)).toBe(0);
    expect(roundRobinStart(5 * H, 80, 80)).toBe(0);
  });
  it("cycles the whole backlog within ceil(total/cap) hours", () => {
    const total = 627, cap = 80;
    const covered = new Set<number>();
    const hours = Math.ceil(total / cap);
    for (let h = 0; h < hours; h++) {
      const start = roundRobinStart(h * H, total, cap);
      for (let i = 0; i < cap; i++) covered.add((start + i) % total);
    }
    // Every fallback entry is looked up at least once within ceil(627/80)=8 hours.
    expect(covered.size).toBe(total);
  });
});

describe("worker harness health evaluation", () => {
  const nowMs = Date.parse("2026-05-29T00:00:00.000Z");

  it("marks pre-publish heartbeats as failed when they are stuck too long", () => {
    const health = evaluateHarnessHealth(
      {
        ok: true,
        status: "pre-publish",
        lastCronAt: "2026-05-28T23:20:00.000Z",
        queueMode: "enabled",
        copilotOk: true,
        sourcesAttempted: 10,
        sourcesOk: 10,
        sourcesFailed: [],
      },
      nowMs,
    );

    expect(health.ok).toBe(false);
    expect(health.errors.join("\n")).toContain("stuck after pre-publish");
  });

  it("fails closed when cron is stale or the summary queue is not enabled", () => {
    const health = evaluateHarnessHealth(
      {
        ok: true,
        status: "checked",
        lastCronAt: "2026-05-28T21:00:00.000Z",
        queueMode: "disabled",
        copilotOk: true,
        sourcesAttempted: 10,
        sourcesOk: 10,
        sourcesFailed: [],
      },
      nowMs,
    );

    expect(health.ok).toBe(false);
    expect(health.errors.join("\n")).toContain("cron heartbeat is stale");
    expect(health.errors.join("\n")).toContain("summary queue is disabled");
  });

  it("keeps non-fatal collection issues as warnings", () => {
    const health = evaluateHarnessHealth(
      {
        ok: true,
        status: "published",
        lastCronAt: "2026-05-28T23:50:00.000Z",
        queueMode: "enabled",
        copilotOk: true,
        sourcesAttempted: 10,
        sourcesOk: 9,
        sourcesFailed: ["example-source"],
      },
      nowMs,
    );

    expect(health.ok).toBe(true);
    expect(health.status).toBe("warn");
    expect(health.warnings.join("\n")).toContain("source collection error");
  });
});

describe("worker summarizer health endpoint", () => {
  it("responds to /health instead of throwing a missing fetch handler error", async () => {
    const response = await summarizerWorker.fetch!(
      new Request("https://tech-dashboard-summarizer.example/health"),
      {
        SUMMARY_CACHE: mockKv(),
        COPILOT_PAT: "configured",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
        SUMMARIZE_TIMEOUT_MS: "180000",
        SUMMARIZE_MAX_TOKENS: "6000",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      role: "queue-consumer",
      model: "claude-sonnet-4.6",
      cacheBinding: true,
      copilotSecretConfigured: true,
    });
  });

  it("keeps a single recent retry as a warning", async () => {
    const response = await summarizerWorker.fetch!(
      new Request("https://tech-dashboard-summarizer.example/health"),
      {
        SUMMARY_CACHE: mockKv({
          status: "retry",
          at: new Date().toISOString(),
          url: "https://example.com/failing-entry",
          error: "Error: Copilot timeout",
        }),
        COPILOT_PAT: "configured",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      recentIssue: true,
      issueSeverity: "warn",
      issue: {
        status: "retry",
        url: "https://example.com/failing-entry",
      },
    });
  });

  it("returns 503 when the queue consumer repeats the same retry issue", async () => {
    const response = await summarizerWorker.fetch!(
      new Request("https://tech-dashboard-summarizer.example/health"),
      {
        SUMMARY_CACHE: mockKv({
          status: "retry",
          at: new Date().toISOString(),
          url: "https://example.com/failing-entry",
          repeatCount: 3,
          error: "Error: Copilot timeout",
        }),
        COPILOT_PAT: "configured",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      recentIssue: true,
      issueSeverity: "error",
      issue: {
        status: "retry",
        url: "https://example.com/failing-entry",
        repeatCount: 3,
      },
    });
  });

  it("keeps repeated entry-specific parse failures visible without failing global health", async () => {
    const response = await summarizerWorker.fetch!(
      new Request("https://tech-dashboard-summarizer.example/health"),
      {
        SUMMARY_CACHE: mockKv({
          status: "retry",
          at: new Date().toISOString(),
          url: "https://example.com/malformed-entry",
          repeatCount: 3,
          error: "Error: incomplete summary for https://example.com/malformed-entry",
        }),
        COPILOT_PAT: "configured",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      recentIssue: true,
      issueSeverity: "warn",
      issueScope: "entry",
      issue: {
        status: "retry",
        repeatCount: 3,
      },
    });
  });

  it("fails closed with JSON health when the cache binding is missing", async () => {
    const response = await summarizerWorker.fetch!(
      new Request("https://tech-dashboard-summarizer.example/health"),
      {
        SUMMARY_CACHE: undefined as unknown as KVNamespace,
        COPILOT_PAT: "configured",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
      },
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      cacheBinding: false,
      copilotSecretConfigured: true,
    });
  });
});

describe("worker summarizer queue consumer", () => {
  it("resets the retry count when the same URL changes from entry to runtime failure", async () => {
    let issue: Record<string, unknown> = {
      status: "retry",
      scope: "entry",
      at: new Date().toISOString(),
      url: baseEntry.url,
      repeatCount: 3,
      error: `Error: incomplete summary for ${baseEntry.url}`,
    };
    const put = vi.fn(async (key: string, value: string) => {
      if (key === "summarizer.issue.v1") {
        issue = JSON.parse(value) as Record<string, unknown>;
      }
    });
    const kv = {
      get: vi.fn(async () => issue),
      put,
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const ack = vi.fn();
    const retry = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 500 })),
    );

    await summarizerWorker.queue!(
      {
        messages: [
          {
            body: {
              url: baseEntry.url,
              entry: {
                id: baseEntry.id,
                url: baseEntry.url,
                title: baseEntry.title,
                category: baseEntry.category,
                source: baseEntry.source,
                sourceType: baseEntry.sourceType,
              },
            },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      {
        SUMMARY_CACHE: kv,
        COPILOT_PAT: "test-pat-scope-reset",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
      },
      {} as ExecutionContext,
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(issue).toMatchObject({
      ok: true,
      status: "retry",
      scope: "runtime",
      repeatCount: 1,
    });

    vi.unstubAllGlobals();
  });

  it("generates a summary from the summary-only prompt without requesting a body (LL-106)", async () => {
    const put = vi.fn(async () => undefined);
    const del = vi.fn(async () => undefined);
    const kv = {
      get: vi.fn(async () => ({
        status: "retry",
        at: new Date().toISOString(),
        url: baseEntry.url,
      })),
      put,
      delete: del,
    } as unknown as KVNamespace;
    const ack = vi.fn();
    const retry = vi.fn();
    let requestedBody = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("api.github.com/copilot_internal/v2/token")) {
        return Response.json({
          token: "copilot-token",
          expires_at: Math.floor(Date.now() / 1000) + 1200,
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const prompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
      // LL-106: the queue prompt must NOT request a long bilingual body.
      if (/bodyJa|bodyEn/.test(prompt)) requestedBody = true;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                titleJa: "Example Paper",
                summaryJa: "短い日本語要約です。",
                summaryEn: "A concise English summary.",
                bodyJa: "",
                bodyEn: "",
                importance: 2,
                extraTags: ["example"],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await summarizerWorker.queue!(
      {
        messages: [
          {
            body: {
              url: baseEntry.url,
              entry: {
                id: baseEntry.id,
                url: baseEntry.url,
                title: baseEntry.title,
                category: baseEntry.category,
                source: baseEntry.source,
                sourceType: baseEntry.sourceType,
                summaryEn: baseEntry.summaryEn,
              },
            },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      {
        SUMMARY_CACHE: kv,
        COPILOT_PAT: "test-pat-summary-only",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
        SUMMARIZE_TIMEOUT_MS: "180000",
        SUMMARIZE_MAX_TOKENS: "6000",
      },
      {} as ExecutionContext,
    );

    expect(requestedBody).toBe(false);
    // token exchange + a single chat call (no recovery/field-repair chain).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith("summarizer.issue.v1");

    vi.unstubAllGlobals();
  });

  it("force-refreshes the IDE token and retries once on a 401 (LL-105)", async () => {
    const put = vi.fn(async () => undefined);
    const del = vi.fn(async () => undefined);
    const kv = {
      get: vi.fn(async () => null),
      put,
      delete: del,
    } as unknown as KVNamespace;
    const ack = vi.fn();
    const retry = vi.fn();
    let tokenExchanges = 0;
    let chatCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("api.github.com/copilot_internal/v2/token")) {
        tokenExchanges += 1;
        return Response.json({
          token: `copilot-token-${tokenExchanges}`,
          expires_at: Math.floor(Date.now() / 1000) + 1200,
        });
      }
      chatCalls += 1;
      // First chat call: the cached IDE token expired mid-batch -> 401.
      if (chatCalls === 1) {
        return new Response("unauthorized: token expired", { status: 401 });
      }
      // Retry after a forced token refresh succeeds with a complete summary.
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                titleJa: "Example Paper",
                summaryJa: "短い日本語要約です。",
                summaryEn: "A concise English summary.",
                bodyJa: "日本語本文です。\\n\\n背景も含めて説明します。",
                bodyEn: "This is an English body with useful context and cautious framing.",
                importance: 2,
                extraTags: ["example"],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await summarizerWorker.queue!(
      {
        messages: [
          {
            body: {
              url: baseEntry.url,
              entry: {
                id: baseEntry.id,
                url: baseEntry.url,
                title: baseEntry.title,
                category: baseEntry.category,
                source: baseEntry.source,
                sourceType: baseEntry.sourceType,
                summaryEn: baseEntry.summaryEn,
              },
            },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      {
        SUMMARY_CACHE: kv,
        COPILOT_PAT: "test-pat-401",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
        SUMMARIZE_TIMEOUT_MS: "180000",
        SUMMARIZE_MAX_TOKENS: "6000",
      },
      {} as ExecutionContext,
    );

    // 401 on first chat -> force a second token exchange -> retry chat succeeds.
    expect(tokenExchanges).toBe(2);
    expect(chatCalls).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("retries the summary-only prompt once when the first output is empty (LL-106)", async () => {
    const put = vi.fn(async () => undefined);
    const kv = {
      get: vi.fn(async () => null),
      put,
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace;
    const ack = vi.fn();
    const retry = vi.fn();
    let chatCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("api.github.com/copilot_internal/v2/token")) {
        return Response.json({
          token: "copilot-token",
          expires_at: Math.floor(Date.now() / 1000) + 1200,
        });
      }
      chatCalls += 1;
      // First chat call mirrors the reasoning-exhausted response: HTTP 200 with
      // an empty choices array (LL-106). The retry then succeeds.
      if (chatCalls === 1) {
        return Response.json({ choices: [] });
      }
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                titleJa: "Example Paper",
                summaryJa: "短い日本語要約です。",
                summaryEn: "A concise English summary.",
                bodyJa: "",
                bodyEn: "",
                importance: 2,
                extraTags: ["example"],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await summarizerWorker.queue!(
      {
        messages: [
          {
            body: {
              url: baseEntry.url,
              entry: {
                id: baseEntry.id,
                url: baseEntry.url,
                title: baseEntry.title,
                category: baseEntry.category,
                source: baseEntry.source,
                sourceType: baseEntry.sourceType,
                summaryEn: baseEntry.summaryEn,
              },
            },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      {
        SUMMARY_CACHE: kv,
        COPILOT_PAT: "test-pat-summary-retry",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
        SUMMARIZE_TIMEOUT_MS: "180000",
        SUMMARIZE_MAX_TOKENS: "6000",
      },
      {} as ExecutionContext,
    );

    expect(chatCalls).toBe(2);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(String(put.mock.calls[0]?.[1] ?? "{}")) as CacheEntry;
    expect(stored.summaryJa).toBe("短い日本語要約です。");
    expect(stored.summaryEn).toBe("A concise English summary.");

    vi.unstubAllGlobals();
  });

  it("identifies missing body fields as incomplete cache entries", () => {
    expect(isCompleteCacheEntry({ ...realCache, bodyEn: "" })).toBe(false);
    expect(isCompleteCacheEntry(realCache)).toBe(true);
  });

  it("treats title+JA/EN summary as a complete summary even without a body (LL-104)", () => {
    expect(isSummaryComplete({ ...realCache, bodyJa: "", bodyEn: "" })).toBe(true);
    expect(isSummaryComplete({ ...realCache, summaryEn: "" })).toBe(false);
    expect(isSummaryComplete({ ...realCache, titleJa: "" })).toBe(false);
  });

  it("persists a complete summary even if the body stays empty after all attempts (LL-104)", async () => {
    const put = vi.fn(async () => undefined);
    const del = vi.fn(async () => undefined);
    const kv = {
      get: vi.fn(async () => null),
      put,
      delete: del,
    } as unknown as KVNamespace;
    const ack = vi.fn();
    const retry = vi.fn();
    // Every generation attempt returns a complete summary but an empty body.
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("api.github.com/copilot_internal/v2/token")) {
        return Response.json({ token: "copilot-token", expires_at: Math.floor(Date.now() / 1000) + 1200 });
      }
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                titleJa: "完全な日本語タイトル",
                summaryJa: "本物の日本語要約です。",
                summaryEn: "A real English summary.",
                bodyJa: "",
                bodyEn: "",
                importance: 2,
                extraTags: ["example"],
              }),
            },
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await summarizerWorker.queue!(
      {
        messages: [
          {
            body: {
              url: baseEntry.url,
              entry: {
                id: baseEntry.id,
                url: baseEntry.url,
                title: baseEntry.title,
                category: baseEntry.category,
                source: baseEntry.source,
                sourceType: baseEntry.sourceType,
                summaryEn: baseEntry.summaryEn,
              },
            },
            ack,
            retry,
          },
        ],
      } as unknown as MessageBatch,
      {
        SUMMARY_CACHE: kv,
        COPILOT_PAT: "test-pat-summary-only",
        SUMMARIZE_MODEL: "claude-sonnet-4.6",
        SUMMARIZE_TIMEOUT_MS: "180000",
        SUMMARIZE_MAX_TOKENS: "6000",
      },
      {} as ExecutionContext,
    );

    // Summary is written (not thrown away), the job is acked, and no retry.
    expect(put).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const stored = JSON.parse(String(put.mock.calls[0]?.[1] ?? "{}")) as CacheEntry;
    expect(stored.summaryJa).toBe("本物の日本語要約です。");
    expect(stored.summaryEn).toBe("A real English summary.");

    vi.unstubAllGlobals();
  });
});
