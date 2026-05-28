import { describe, expect, it, vi } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import type { CacheEntry } from "../worker/src/kv-cache.ts";
import { evaluateHarnessHealth } from "../worker/src/index.ts";
import { needsGeneratedContent, selectSummaryJobBatch, selectSummaryJobs } from "../worker/src/summary-queue.ts";
import summarizerWorker from "../worker-summarizer/src/index.ts";

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

function mockKv(json: unknown = null): KVNamespace {
  return {
    get: vi.fn(async () => json),
    put: vi.fn(async () => undefined),
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

  it("round-robins by cap-sized windows so large backlogs drain predictably", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ...baseEntry,
      id: `entry-${i}`,
      url: `https://example.com/paper-${i}`,
    }));
    const lookedUp = new Set(entries.map((entry) => entry.url));

    const first = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs: 0 });
    const second = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs: 3_600_000 });
    const fourth = selectSummaryJobBatch(entries, new Map(), lookedUp, 3, new Set(), { nowMs: 3 * 3_600_000 });

    expect(first.jobs.map((job) => job.url)).toEqual([
      "https://example.com/paper-0",
      "https://example.com/paper-1",
      "https://example.com/paper-2",
    ]);
    expect(first.eligibleCount).toBe(10);
    expect(first.drainEstimateHours).toBe(4);
    expect(second.jobs.map((job) => job.url)).toEqual([
      "https://example.com/paper-3",
      "https://example.com/paper-4",
      "https://example.com/paper-5",
    ]);
    expect(fourth.jobs.map((job) => job.url)).toEqual([
      "https://example.com/paper-9",
      "https://example.com/paper-0",
      "https://example.com/paper-1",
    ]);
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
        SUMMARIZE_TIMEOUT_MS: "28000",
        SUMMARIZE_MAX_TOKENS: "1600",
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

  it("returns 503 when the queue consumer has a recent retry issue", async () => {
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

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      recentIssue: true,
      issue: {
        status: "retry",
        url: "https://example.com/failing-entry",
      },
    });
  });
});
