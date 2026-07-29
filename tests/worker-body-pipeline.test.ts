/**
 * tests/worker-body-pipeline.test.ts
 *
 * Body-file Phase B (LL-115): body job selection + bodies.json merge logic.
 */
import { describe, it, expect } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  bodyBacklogAfterMerge,
  bodyEnqueueAllowance,
  isBodyRetentionEligible,
  needsBody,
  selectBodyJobBatch,
  selectBodyPipelineJobs,
} from "../worker/src/body-queue.ts";
import {
  buildHeartbeatPayload,
  runBodyPipeline,
  selectBodyJobsToEnqueue,
  type PublisherEnv,
} from "../worker/src/index.ts";
import {
  bodiesPresentSet,
  isRealBody,
  mergeBodies,
  mergeBodiesWithGuards,
  mergeBodiesWithProductGuard,
  parseBodies,
  pruneInvalidBodyRecords,
  pruneKnownProductBodyConflicts,
  serializeBodies,
  type BodiesPayload,
} from "../worker/src/bodies-file.ts";
import type { KeyValueBinding, QueueBatchBinding } from "../worker/src/runtime-bindings.ts";
import type { BodyJob } from "../worker/src/body-generate.ts";

function entry(over: Partial<NormalizedEntry> & { id: string }): NormalizedEntry {
  return {
    id: over.id,
    source: over.source ?? "qiita-llm",
    sourceType: over.sourceType ?? "community",
    url: over.url ?? `https://example.com/${over.id}`,
    title: over.title ?? `Title ${over.id}`,
    titleJa: over.titleJa ?? `タイトル ${over.id}`,
    titleEn: over.titleEn ?? `Title ${over.id}`,
    summaryJa: over.summaryJa ?? "本物の日本語要約です。",
    summaryEn: over.summaryEn ?? "A real English summary.",
    contentSnippet:
      over.contentSnippet ??
      `The source explains the ${over.id} update, its supported behavior, and its impact on developers in concrete detail.`,
    bodyJa: over.bodyJa ?? "",
    bodyEn: over.bodyEn ?? "",
    lang: over.lang ?? "ja",
    publishedAt: over.publishedAt ?? "2026-06-20T00:00:00.000Z",
    collectedAt: over.collectedAt ?? "2026-06-20T01:00:00.000Z",
    tags: over.tags ?? ["llm"],
    category: over.category ?? "local-llm",
    importance: over.importance ?? 2,
    ...over,
  } as NormalizedEntry;
}

const PENDING_JA = "このエントリは qiita-llm から収集した local-llm 領域の最新アップデートです。原題:「X」。AI による日本語要約は次回以降の Worker run で生成されます。";

describe("needsBody (LL-115)", () => {
  it("実要約あり + body 無し → true", () => {
    expect(needsBody(entry({ id: "a" }), new Set())).toBe(true);
  });
  it("既に body がある (bodiesPresent) → false", () => {
    expect(needsBody(entry({ id: "a" }), new Set(["a"]))).toBe(false);
  });
  it("要約が pending fallback → false (先に要約が要る)", () => {
    expect(needsBody(entry({ id: "a", summaryJa: PENDING_JA, summaryEn: "" }), new Set())).toBe(false);
  });
  it("source contextが不足するtitle-only entryは本文生成へ進めない", () => {
    expect(
      needsBody(
        entry({
          id: "sparse",
          title: "Cursor Start",
          titleJa: "Cursor Start",
          titleEn: "Cursor Start",
          contentSnippet: "",
        }),
        new Set(),
      ),
    ).toBe(false);
  });
});

describe("body retention policy", () => {
  const nowMs = Date.parse("2026-07-11T00:00:00.000Z");

  it("keeps evergreen and important entries regardless of age", () => {
    expect(
      isBodyRetentionEligible(
        entry({ id: "evergreen", evergreen: true, importance: 1, publishedAt: "2025-01-01T00:00:00.000Z" }),
        nowMs,
      ),
    ).toBe(true);
    expect(
      isBodyRetentionEligible(
        entry({ id: "important", importance: 2, publishedAt: "2025-01-01T00:00:00.000Z" }),
        nowMs,
      ),
    ).toBe(true);
  });

  describe("known product body invalidation", () => {
    it("prunes a body that introduces Amazon Quick as Amazon QuickSight", () => {
      const result = pruneKnownProductBodyConflicts(
        {
          generatedAt: "2026-07-20T00:00:00.000Z",
          count: 1,
          bodies: {
            quick: {
              bodyJa: "Amazon QuickSightを使ったエージェント基盤を紹介する。",
              bodyEn: "Amazon QuickSight is the featured agent workspace.",
            },
          },
        },
        [
          entry({
            id: "quick",
            source: "aws-ml-blog",
            title: "Build agent workflows with Amazon Quick",
          }),
        ],
        "2026-07-21T00:00:00.000Z",
      );

      expect(result.pruned).toBe(1);
      expect(result.payload.bodies).toEqual({});
    });

    describe("source grounding body invalidation", () => {
      const cursorEntry = entry({
        id: "cursor-start",
        source: "cursor-changelog",
        sourceType: "changelog",
        title: "Cursor Start",
        titleJa: "Cursor Start",
        titleEn: "Cursor Start",
        contentSnippet:
          "We're introducing Cursor Start, a new ₹649 monthly plan for developers in India with local pricing and UPI.",
      });

      it("prunes an existing body that contradicts material source facts", () => {
        const result = pruneInvalidBodyRecords(
          {
            generatedAt: "2026-07-28T00:00:00.000Z",
            count: 1,
            bodies: {
              "cursor-start": {
                bodyJa: "Cursor Startはプロジェクト初期化とオンボーディングを支援する。",
                bodyEn: "Cursor Start streamlines project initialization and onboarding.",
              },
            },
          },
          [cursorEntry],
          "2026-07-29T00:00:00.000Z",
        );

        expect(result.pruned).toBe(1);
        expect(result.payload.bodies).toEqual({});
      });

      it("rejects the same contradiction from an incoming body cache", () => {
        const result = mergeBodiesWithGuards(
          {
            generatedAt: "2026-07-28T00:00:00.000Z",
            count: 0,
            bodies: {},
          },
          [{
            id: "cursor-start",
            bodyJa: "Cursor Startはプロジェクト初期化とオンボーディングを支援する。",
            bodyEn: "Cursor Start streamlines project initialization and onboarding.",
          }],
          new Set(["cursor-start"]),
          "2026-07-29T00:00:00.000Z",
          [cursorEntry],
        );

        expect(result.added).toBe(0);
        expect(result.payload.bodies).toEqual({});
      });
    });

    it("keeps a body that distinguishes Amazon Quick from Quick Sight", () => {
      const payload: BodiesPayload = {
        generatedAt: "2026-07-20T00:00:00.000Z",
        count: 1,
        bodies: {
          quick: {
            bodyJa: "Amazon Quickは、Amazon Quick Sightのダッシュボード文脈を利用する。",
            bodyEn: "Amazon Quick uses dashboard context from Amazon Quick Sight.",
          },
        },
      };
      const result = pruneKnownProductBodyConflicts(
        payload,
        [
          entry({
            id: "quick",
            source: "aws-ml-blog",
            title: "Build agent workflows with Amazon Quick",
          }),
        ],
        "2026-07-21T00:00:00.000Z",
      );

      expect(result.changed).toBe(false);
      expect(result.payload).toBe(payload);
    });

    it("rejects a conflicting incoming cache or legacy body after merge", () => {
      const quickEntry = entry({
        id: "quick",
        source: "aws-ml-blog",
        title: "Build agent workflows with Amazon Quick",
      });
      const result = mergeBodiesWithProductGuard(
        {
          generatedAt: "2026-07-20T00:00:00.000Z",
          count: 0,
          bodies: {},
        },
        [
          {
            id: "quick",
            bodyJa: "Amazon QuickSightを使ったエージェント基盤を紹介する。",
            bodyEn: "Amazon QuickSight is the featured agent workspace.",
            model: "claude-opus-4.8",
          },
        ],
        new Set(["quick"]),
        "2026-07-21T00:00:00.000Z",
        [quickEntry],
      );

      expect(result.added).toBe(0);
      expect(result.payload.bodies).toEqual({});
    });
  });

  it("keeps recent low-importance entries and prunes old ones", () => {
    expect(
      isBodyRetentionEligible(
        entry({ id: "recent", importance: 1, publishedAt: "2026-06-20T00:00:00.000Z" }),
        nowMs,
      ),
    ).toBe(true);
    expect(
      isBodyRetentionEligible(
        entry({ id: "old", importance: 1, publishedAt: "2026-05-01T00:00:00.000Z" }),
        nowMs,
      ),
    ).toBe(false);
  });
});

describe("selectBodyJobBatch (LL-115)", () => {
  const entries = [
    entry({ id: "old1", publishedAt: "2026-06-01T00:00:00.000Z" }),
    entry({ id: "old2", publishedAt: "2026-06-02T00:00:00.000Z" }),
    entry({ id: "new1", publishedAt: "2026-06-27T00:00:00.000Z" }),
    entry({ id: "hasbody", publishedAt: "2026-06-27T00:00:00.000Z" }),
    entry({ id: "pending", summaryJa: PENDING_JA, summaryEn: "" }),
  ];

  it("body 無し・実要約ありのみを eligible にする", () => {
    const batch = selectBodyJobBatch(entries, new Set(["hasbody"]), 10, { nowMs: 0 });
    const ids = batch.jobs.map((j) => j.entry.id).sort();
    expect(ids).toEqual(["new1", "old1", "old2"]);
    expect(batch.eligibleCount).toBe(3);
  });

  it("cap を超えない & newest を優先する", () => {
    const batch = selectBodyJobBatch(entries, new Set(["hasbody"]), 1, { nowMs: 0 });
    // recentSlots = floor(1/2)=0, round-robin から 1 件。cap 厳守。
    expect(batch.jobs.length).toBe(1);
  });

  it("cap=2 で newest(new1) が必ず含まれる", () => {
    const batch = selectBodyJobBatch(entries, new Set(["hasbody"]), 2, { nowMs: 0 });
    expect(batch.jobs.length).toBe(2);
    expect(batch.jobs.some((j) => j.entry.id === "new1")).toBe(true);
  });

  it("重複なし & drainEstimate を返す", () => {
    const batch = selectBodyJobBatch(entries, new Set(), 2, { nowMs: 0 });
    const ids = batch.jobs.map((j) => j.entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(batch.drainEstimateHours).toBeGreaterThan(0);
  });

  it("同じ入力・同じ nowMs では決定的に同じ選択を返す (merge/enqueue 対称性 / LL-116)", () => {
    // The collector body pipeline uses ONE selectBodyJobBatch call for BOTH the
    // `b:` KV merge-lookup and the enqueue. If selection were nondeterministic,
    // the merge would look up different URLs than were enqueued and generated,
    // leaving bodies stranded in KV (the LL-116 bug). Guard determinism.
    const a = selectBodyJobBatch(entries, new Set(["hasbody"]), 3, { nowMs: 123456 });
    const b = selectBodyJobBatch(entries, new Set(["hasbody"]), 3, { nowMs: 123456 });
    expect(a.jobs.map((j) => j.url)).toEqual(b.jobs.map((j) => j.url));
  });

  it("publisher contract fingerprint を body job に伝播する", () => {
    const fingerprint = `sha256:${"c".repeat(64)}`;
    const batch = selectBodyJobBatch(entries, new Set(["hasbody"]), 2, {
      nowMs: 0,
      publisherContractFingerprint: fingerprint,
    });

    expect(batch.jobs).not.toHaveLength(0);
    expect(
      batch.jobs.every(
        (job) => job.publisherContractFingerprint === fingerprint,
      ),
    ).toBe(true);
  });
});

describe("shared enrichment budget and pending body merge", () => {
  const entries = [
    entry({ id: "pending", publishedAt: "2026-06-30T00:00:00.000Z" }),
    entry({ id: "new", publishedAt: "2026-06-29T00:00:00.000Z" }),
    entry({ id: "old", publishedAt: "2026-06-01T00:00:00.000Z" }),
  ];

  it("summary enqueue の未使用枠だけを body へ渡す", () => {
    expect(bodyEnqueueAllowance(35, 1, 35)).toBe(34);
    expect(bodyEnqueueAllowance(35, 35, 35)).toBe(0);
    expect(bodyEnqueueAllowance(35, 10, 8)).toBe(8);
    expect(bodyEnqueueAllowance(0, 0, 35)).toBe(0);
  });

  it("同一 run で merge 済みの本文を backlog から差し引く", () => {
    expect(bodyBacklogAfterMerge(435, 2)).toBe(433);
    expect(bodyBacklogAfterMerge(1, 3)).toBe(0);
  });

  it("heartbeat に body queue と共有生成枠の snapshot を保持する", () => {
    const payload = buildHeartbeatPayload(
      {
        batchIndex: 2,
        batchTotal: 6,
        sourcesOk: 14,
        sourcesAttempted: 14,
        sourcesFailed: [],
        copilotOk: true,
        summaryQueueBacklog: 1,
        summaryQueueEnqueued: 1,
        bodyQueueMode: "enabled",
        bodyBacklog: 433,
        bodyEnqueueCandidates: 8,
        bodyEnqueueCap: 34,
        bodyEnqueued: 8,
        bodyLookupCount: 10,
        bodyMerged: 2,
        bodyQueueDrainEstimateHours: 44,
        bodyMergePendingIds: ["body-a", "body-b"],
        enrichmentEnqueueCap: 35,
        enrichmentEnqueued: 9,
        enrichmentRemaining: 26,
      },
      true,
      1,
      1,
      "published",
      new Date("2026-07-16T00:00:00.000Z"),
    );

    expect(payload).toMatchObject({
      summaryQueueEnqueued: 1,
      bodyQueueMode: "enabled",
      bodyBacklog: 433,
      bodyEnqueued: 8,
      bodyMerged: 2,
      bodyMergePendingIds: ["body-a", "body-b"],
      enrichmentEnqueueCap: 35,
      enrichmentEnqueued: 9,
      enrichmentRemaining: 26,
    });
  });

  it("前回 enqueue 済み ID を候補より先に lookup し、重複させない", () => {
    const selection = selectBodyPipelineJobs(
      entries,
      new Set(),
      ["pending"],
      2,
      { nowMs: 0 },
    );

    expect(selection.pendingJobs.map((job) => job.entry.id)).toEqual(["pending"]);
    expect(selection.candidateJobs.map((job) => job.entry.id)).not.toContain("pending");
    expect(selection.lookupJobs.map((job) => job.entry.id)).toEqual([
      "pending",
      ...selection.candidateJobs.map((job) => job.entry.id),
    ]);
    expect(new Set(selection.lookupJobs.map((job) => job.entry.id)).size).toBe(
      selection.lookupJobs.length,
    );
    expect(selection.lookupJobs).toHaveLength(2);
  });

  it("pending job の不適合 cache は即時再 enqueue し、単純 miss は持ち越さない", () => {
    const fingerprint = `sha256:${"d".repeat(64)}`;
    const quick = entry({
      id: "quick",
      source: "aws-ml-blog",
      title: "Build agent workflows with Amazon Quick",
    });
    const selection = selectBodyPipelineJobs(
      [quick],
      new Set(),
      ["quick"],
      1,
      { nowMs: 0, publisherContractFingerprint: fingerprint },
    );
    expect(selection.pendingJobs.map((job) => job.entry.id)).toEqual([
      "quick",
    ]);
    expect(selection.candidateJobs).toEqual([]);

    const conflictingHits = new Map([
      [
        selection.pendingJobs[0]!.url,
        {
          bodyJa: "Amazon QuickSightを使ったエージェント基盤を紹介する。",
          bodyEn: "Amazon QuickSight is the featured agent workspace.",
          model: "claude-opus-4.8",
          cachedAt: "2026-07-21T00:00:00.000Z",
          publisherContractFingerprint: fingerprint,
        },
      ],
    ]);
    expect(
      selectBodyJobsToEnqueue(
        selection,
        conflictingHits,
        fingerprint,
        1,
      ).map((job) => job.entry.id),
    ).toEqual(["quick"]);
    expect(
      selectBodyJobsToEnqueue(
        selection,
        new Map(),
        fingerprint,
        1,
      ),
    ).toEqual([]);
  });

  it("pending miss は次回 pending 指定がなければ通常候補へ戻る", () => {
    const nextRun = selectBodyPipelineJobs(
      entries,
      new Set(),
      [],
      3,
      { nowMs: 0 },
    );

    expect(nextRun.pendingJobs).toHaveLength(0);
    expect(nextRun.candidateJobs.map((job) => job.entry.id)).toContain("pending");
  });

  it("cap=0 では pending と candidate のどちらも lookup しない", () => {
    const selection = selectBodyPipelineJobs(
      entries,
      new Set(),
      ["pending"],
      0,
      { nowMs: 0 },
    );

    expect(selection.pendingJobs).toHaveLength(0);
    expect(selection.candidateJobs).toHaveLength(0);
    expect(selection.lookupJobs).toHaveLength(0);
  });

  it("pending と通常候補を合わせた lookup 件数を cap 以下に保つ", () => {
    const selection = selectBodyPipelineJobs(
      entries,
      new Set(),
      ["pending", "old"],
      3,
      { nowMs: 0 },
    );

    expect(selection.pendingJobs.map((job) => job.entry.id)).toEqual([
      "pending",
      "old",
    ]);
    expect(selection.candidateJobs).toHaveLength(1);
    expect(selection.lookupJobs).toHaveLength(3);
  });
});

describe("isRealBody / parseBodies / bodiesPresentSet (LL-115)", () => {
  it("実 body は true、空/片方/filler は false", () => {
    expect(isRealBody({ bodyJa: "あ".repeat(200), bodyEn: "a".repeat(200) })).toBe(true);
    expect(isRealBody({ bodyJa: "", bodyEn: "a" })).toBe(false);
    expect(isRealBody({ bodyJa: "元記事の要約と収集時のメタデータから補完", bodyEn: "x" })).toBe(false);
    expect(isRealBody({ bodyJa: "ok", bodyEn: "completed from the existing summary and collection metadata" })).toBe(false);
    expect(isRealBody(null)).toBe(false);
  });

  it("parseBodies は壊れた JSON で空 payload を返す", () => {
    expect(parseBodies("not json").bodies).toEqual({});
    expect(parseBodies("").count).toBe(0);
  });

  it("bodiesPresentSet は実 body の id のみ集める", () => {
    const payload: BodiesPayload = {
      generatedAt: "",
      count: 2,
      bodies: {
        real: { bodyJa: "あ".repeat(200), bodyEn: "a".repeat(200) },
        filler: { bodyJa: "元記事の要約と収集時のメタデータから", bodyEn: "x" },
      },
    };
    expect([...bodiesPresentSet(payload)]).toEqual(["real"]);
  });
});

describe("mergeBodies (LL-115)", () => {
  const existing: BodiesPayload = {
    generatedAt: "2026-06-26T00:00:00.000Z",
    count: 1,
    bodies: { keep: { bodyJa: "あ".repeat(200), bodyEn: "a".repeat(200), model: "legacy" } },
  };

  it("新規 body を追加する", () => {
    const r = mergeBodies(
      existing,
      [{ id: "fresh", bodyJa: "い".repeat(200), bodyEn: "b".repeat(200), model: "claude-opus-4.8" }],
      new Set(["keep", "fresh"]),
      "2026-06-27T00:00:00.000Z",
    );
    expect(r.added).toBe(1);
    expect(r.payload.bodies.fresh?.model).toBe("claude-opus-4.8");
    expect(r.changed).toBe(true);
  });

  it("既存の実 body は上書きしない", () => {
    const r = mergeBodies(
      existing,
      [{ id: "keep", bodyJa: "別".repeat(200), bodyEn: "c".repeat(200) }],
      new Set(["keep"]),
      "2026-06-27T00:00:00.000Z",
    );
    expect(r.added).toBe(0);
    expect(r.payload.bodies.keep?.model).toBe("legacy");
  });

  it("live でない id を prune する", () => {
    const r = mergeBodies(existing, [], new Set([]), "2026-06-27T00:00:00.000Z");
    expect(r.pruned).toBe(1);
    expect(r.payload.bodies.keep).toBeUndefined();
    expect(r.changed).toBe(true);
  });

  it("filler の新規 body は無視する", () => {
    const r = mergeBodies(
      existing,
      [{ id: "junk", bodyJa: "元記事の要約と収集時のメタデータから", bodyEn: "x" }],
      new Set(["keep", "junk"]),
      "2026-06-27T00:00:00.000Z",
    );
    expect(r.added).toBe(0);
    expect(r.payload.bodies.junk).toBeUndefined();
  });

  it("変更なしなら changed=false", () => {
    const r = mergeBodies(existing, [], new Set(["keep"]), "2026-06-27T00:00:00.000Z");
    expect(r.changed).toBe(false);
    expect(r.added).toBe(0);
    expect(r.pruned).toBe(0);
  });
});

describe("selectBodyPipelineJobs: excludeBudgetEvictedIds (LL-411)", () => {
  const entries = [
    entry({ id: "pending", publishedAt: "2026-06-30T00:00:00.000Z" }),
    entry({ id: "new", publishedAt: "2026-06-29T00:00:00.000Z" }),
    entry({ id: "old", publishedAt: "2026-06-01T00:00:00.000Z" }),
  ];

  it("budget-evicted な id は候補選定から除外される", () => {
    const withoutExclusion = selectBodyPipelineJobs(
      entries,
      new Set(),
      [],
      3,
      { nowMs: 0 },
    );
    expect(withoutExclusion.candidateJobs.map((job) => job.entry.id)).toContain("old");

    const withExclusion = selectBodyPipelineJobs(
      entries,
      new Set(),
      [],
      3,
      { nowMs: 0, excludeBudgetEvictedIds: ["old"] },
    );
    expect(withExclusion.candidateJobs.map((job) => job.entry.id)).not.toContain("old");
  });

  it("pending lookup 対象は budget exclusion の影響を受けない (別枠)", () => {
    const selection = selectBodyPipelineJobs(
      entries,
      new Set(),
      ["pending"],
      3,
      { nowMs: 0, excludeBudgetEvictedIds: ["pending"] },
    );
    // "pending" is explicitly a previous-run enqueue target; budget exclusion
    // only prevents it from being picked again as a fresh CANDIDATE, but since
    // it's already in previousPendingIds it is looked up via the pending path
    // (the exclusion only applies to `selectBodyJobBatch`'s candidate window).
    expect(selection.pendingJobs.map((job) => job.entry.id)).toEqual(["pending"]);
  });

  it("既存 opts (excludeBudgetEvictedIds なし) は従来どおり動作する (後方互換)", () => {
    const selection = selectBodyPipelineJobs(
      entries,
      new Set(),
      ["pending"],
      2,
      { nowMs: 0 },
    );
    expect(selection.pendingJobs.map((job) => job.entry.id)).toEqual(["pending"]);
    expect(selection.lookupJobs).toHaveLength(2);
  });
});

function bodyGeneratedRecordText(seed: string): { bodyJa: string; bodyEn: string } {
  return {
    bodyJa: `本文${seed}`.repeat(150),
    bodyEn: `body ${seed} `.repeat(150),
  };
}

function stubKv(): KeyValueBinding {
  return {
    async get() {
      return null;
    },
    async put() {
      /* no-op */
    },
  };
}

function stubQueue(): QueueBatchBinding<BodyJob> {
  return {
    async sendBatch() {
      /* no-op */
    },
  };
}

function baseEnv(overrides: Partial<PublisherEnv> = {}): PublisherEnv {
  return {
    GH_TOKEN: "x",
    GITHUB_OWNER: "himiyosh",
    GITHUB_REPO: "tech-dashboard",
    GITHUB_BRANCH: "main",
    SUMMARY_CACHE: stubKv(),
    COPILOT_PAT: "",
    SUMMARIZE_MODEL: "claude-sonnet-4.6",
    SUMMARIZE_MAX_NEW: "0",
    ENABLE_BODY_QUEUE: "1",
    BODY_QUEUE: stubQueue(),
    BODY_ENQUEUE_MAX_NEW: "35",
    BODY_LOOKUP_CAP: "35",
    BODY_RETENTION_DAYS: "30",
    ...overrides,
  };
}

describe("runBodyPipeline: budget enforcement integration (LL-411)", () => {
  const GENERATED_AT = "2026-07-25T00:00:00.000Z";
  const pipelineEntries: NormalizedEntry[] = [
    entry({
      id: "ever",
      evergreen: true,
      importance: 1,
      publishedAt: "2020-01-01T00:00:00.000Z",
      collectedAt: "2020-01-01T00:00:00.000Z",
    }),
    entry({
      id: "imp3",
      importance: 3,
      publishedAt: "2026-07-01T00:00:00.000Z",
      collectedAt: "2026-07-01T00:00:00.000Z",
    }),
    entry({
      id: "imp2",
      importance: 2,
      publishedAt: "2026-06-01T00:00:00.000Z",
      collectedAt: "2026-06-01T00:00:00.000Z",
    }),
    entry({
      id: "imp1-new",
      importance: 1,
      publishedAt: "2026-07-20T00:00:00.000Z",
      collectedAt: "2026-07-20T00:00:00.000Z",
    }),
    entry({
      id: "imp1-old",
      importance: 1,
      publishedAt: "2026-07-02T00:00:00.000Z",
      collectedAt: "2026-07-02T00:00:00.000Z",
    }),
  ];

  function fullExistingBodies(): string {
    const bodies: BodiesPayload["bodies"] = {};
    for (const e of pipelineEntries) {
      bodies[e.id] = {
        ...bodyGeneratedRecordText(e.id),
        model: "claude-opus-4.8",
        generatedAt: "2026-07-24T00:00:00.000Z",
      };
    }
    return serializeBodies({ generatedAt: "2026-07-24T00:00:00.000Z", count: pipelineEntries.length, bodies });
  }

  it("target を超えた分だけ最古の importance-1 を budget prune し、telemetry に反映する", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    // Target between "4 records" and "5 records" worth of bytes, forcing
    // exactly one (the oldest importance-1) removal.
    const fourOnly: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 4,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id !== "imp1-old"),
      ),
    };
    const target = Math.round(
      (new TextEncoder().encode(serializeBodies(fourOnly)).byteLength
        + new TextEncoder().encode(existingContent).byteLength) / 2,
    );

    const env = baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) });
    const result = await runBodyPipeline(
      env,
      pipelineEntries,
      existingContent,
      GENERATED_AT,
      `sha256:${"a".repeat(64)}`,
    );

    expect(result.health.bodyBudgetTargetBytes).toBe(target);
    expect(result.health.bodyBudgetPruned).toBe(1);
    expect(result.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);
    expect(result.health.bodyBudgetBytes).toBeLessThanOrEqual(target);
    expect(result.health.bodiesTotal).toBe(4);
    expect(result.bodiesFileContent).not.toBeNull();

    const finalPayload = parseBodies(result.bodiesFileContent);
    expect(finalPayload.bodies.ever).toBeDefined();
    expect(finalPayload.bodies.imp3).toBeDefined();
    expect(finalPayload.bodies.imp2).toBeDefined();
    expect(finalPayload.bodies["imp1-new"]).toBeDefined();
    expect(finalPayload.bodies["imp1-old"]).toBeUndefined();
  });

  it("前回 budget-evicted な id は次回 run で再 enqueue されない", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    const fourOnly: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 4,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id !== "imp1-old"),
      ),
    };
    const target = Math.round(
      (new TextEncoder().encode(serializeBodies(fourOnly)).byteLength
        + new TextEncoder().encode(existingContent).byteLength) / 2,
    );

    const run1 = await runBodyPipeline(
      baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) }),
      pipelineEntries,
      existingContent,
      GENERATED_AT,
      `sha256:${"a".repeat(64)}`,
    );
    expect(run1.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);

    // Run 2: imp1-old is still retention-eligible (importance 1, within 30
    // days) and now lacks a body -- it WOULD be the only enqueue candidate.
    // With the previous run's eviction fed back in, it must be excluded.
    const run2 = await runBodyPipeline(
      baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) }),
      pipelineEntries,
      run1.bodiesFileContent,
      "2026-07-25T01:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: run1.health.bodyBudgetEvictedIds },
    );

    expect(run2.enqueued).toBe(0);
    expect(run2.health.bodyMergePendingIds).toEqual([]);
    expect(run2.health.bodyBudgetPruned).toBe(0); // already at/under target, nothing new to prune
  });

  it("previousBudgetEvictedIds を渡さない場合は従来どおり再候補化される (後方互換)", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    const fourOnly: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 4,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id !== "imp1-old"),
      ),
    };
    const bodiesWithoutOld = serializeBodies(fourOnly);

    const run = await runBodyPipeline(
      baseEnv({ BODY_ENQUEUE_MAX_NEW: "5", BODY_LOOKUP_CAP: "5" }),
      pipelineEntries,
      bodiesWithoutOld,
      "2026-07-25T02:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
    );
    // No exclusion supplied: imp1-old (missing body, retention-eligible) is a
    // legitimate candidate and gets enqueued.
    expect(run.health.bodyEnqueueCandidates).toBeGreaterThan(0);
  });

  it("run1 で prune された id は run2 で新規 prune が 0 件でも telemetry へ持ち越され、run3 でも再候補化されない (LL-411 follow-up: cross-run state loss)", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    const fourOnly: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 4,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id !== "imp1-old"),
      ),
    };
    const target = Math.round(
      (new TextEncoder().encode(serializeBodies(fourOnly)).byteLength
        + new TextEncoder().encode(existingContent).byteLength) / 2,
    );
    const env = baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) });

    // Run 1: imp1-old gets pruned by budget for the first time.
    const run1 = await runBodyPipeline(
      env,
      pipelineEntries,
      existingContent,
      GENERATED_AT,
      `sha256:${"a".repeat(64)}`,
    );
    expect(run1.health.bodyBudgetPruned).toBe(1);
    expect(run1.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);

    // Run 2: reads run1's persisted evicted ids and excludes imp1-old from
    // candidates, so nothing new is generated/merged/pruned THIS run (the
    // 4-record payload is already at/under target). A naive implementation
    // that only reports THIS run's fresh prunedIds would write back an EMPTY
    // evicted-ids list here, silently forgetting imp1-old. The fix must
    // still report it (carried forward), because it is still live,
    // retention-eligible, missing a body, and still the lowest-priority tier.
    // `run1.bodiesFileContent` (not run2's, which is expected to be null
    // since nothing changed) is what a real commit-on-change publisher would
    // have persisted and what the next run would read back.
    const run2 = await runBodyPipeline(
      env,
      pipelineEntries,
      run1.bodiesFileContent,
      "2026-07-25T01:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: run1.health.bodyBudgetEvictedIds },
    );
    expect(run2.enqueued).toBe(0);
    expect(run2.health.bodyMergePendingIds).toEqual([]);
    expect(run2.health.bodyBudgetPruned).toBe(0); // nothing NEW pruned this run
    expect(run2.bodiesFileContent).toBeNull(); // nothing changed, no new commit
    expect(run2.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]); // still persisted, not emptied

    // Run 3: reads run2's (correctly non-empty) evicted ids and still
    // excludes imp1-old. Without the fix, run2 would have hand run3 an empty
    // list, imp1-old would become a fresh candidate again, get enqueued,
    // regenerated, merged, and evicted again -- the every-other-run waste
    // loop the parent review flagged.
    const run3 = await runBodyPipeline(
      env,
      pipelineEntries,
      run1.bodiesFileContent, // still the last actually-committed content
      "2026-07-25T02:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: run2.health.bodyBudgetEvictedIds },
    );
    expect(run3.enqueued).toBe(0);
    expect(run3.health.bodyMergePendingIds).toEqual([]);
    expect(run3.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);
  });

  it("disabled/missing-binding/error mode でも previousBudgetEvictedIds を持ち越す", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    const fourOnly: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 4,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id !== "imp1-old"),
      ),
    };
    const withoutOld = serializeBodies(fourOnly);

    const disabledRun = await runBodyPipeline(
      baseEnv({ ENABLE_BODY_QUEUE: "0" }),
      pipelineEntries,
      withoutOld,
      "2026-07-25T03:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: ["imp1-old"] },
    );
    expect(disabledRun.health.bodyQueueMode).toBe("disabled");
    // A transient mode flip (e.g. ENABLE_BODY_QUEUE briefly "0") must not
    // silently forget imp1-old: it is still live, retention-eligible,
    // missing a body, and still lowest-priority.
    expect(disabledRun.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);

    const missingBindingRun = await runBodyPipeline(
      { ...baseEnv({}), BODY_QUEUE: undefined },
      pipelineEntries,
      withoutOld,
      "2026-07-25T04:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: ["imp1-old"] },
    );
    expect(missingBindingRun.health.bodyQueueMode).toBe("missing-binding");
    expect(missingBindingRun.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);
  });

  it("stale/promoted な previousBudgetEvictedIds は disabled/error mode でも掃除される", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    const withoutOld: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 4,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id !== "imp1-old"),
      ),
    };
    const disabledRun = await runBodyPipeline(
      baseEnv({ ENABLE_BODY_QUEUE: "0" }),
      pipelineEntries,
      serializeBodies(withoutOld),
      "2026-07-25T05:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      {
        previousBudgetEvictedIds: [
          "imp1-old", // still valid: keep
          "no-such-entry", // no longer live/eligible: drop
          "ever", // present, still evergreen: not lowest-rank, drop (promotion)
        ],
      },
    );
    expect(disabledRun.health.bodyBudgetEvictedIds).toEqual(["imp1-old"]);
  });

  it("importance 1 の prune だけでは足りず importance 2 まで prune しても importance 3 / evergreen は保持される (tier fallback, LL-411 follow-up 2)", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    // Removing only imp1-old + imp1-new (leaving imp2+imp3+ever) is NOT
    // enough; the target sits strictly between "3 records left" and
    // "2 records left" bytes, forcing imp2 to be pruned too -- but imp3 and
    // evergreen (both higher priority than imp2) must survive untouched.
    const threeRemain: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 3,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id === "imp2" || id === "imp3" || id === "ever"),
      ),
    };
    const twoRemain: BodiesPayload = {
      generatedAt: full.generatedAt,
      count: 2,
      bodies: Object.fromEntries(
        Object.entries(full.bodies).filter(([id]) => id === "imp3" || id === "ever"),
      ),
    };
    const target = Math.round(
      (new TextEncoder().encode(serializeBodies(threeRemain)).byteLength
        + new TextEncoder().encode(serializeBodies(twoRemain)).byteLength) / 2,
    );

    const run = await runBodyPipeline(
      baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) }),
      pipelineEntries,
      existingContent,
      GENERATED_AT,
      `sha256:${"a".repeat(64)}`,
    );

    expect(run.health.bodyBudgetPruned).toBe(3);
    expect([...run.health.bodyBudgetEvictedIds].sort()).toEqual(["imp1-new", "imp1-old", "imp2"]);
    expect(run.health.bodyBudgetBytes).toBeLessThanOrEqual(target);
    const finalPayload = parseBodies(run.bodiesFileContent);
    expect(finalPayload.bodies.imp3).toBeDefined();
    expect(finalPayload.bodies.ever).toBeDefined();
    expect(finalPayload.bodies.imp2).toBeUndefined();
    expect(finalPayload.bodies["imp1-new"]).toBeUndefined();
    expect(finalPayload.bodies["imp1-old"]).toBeUndefined();
  });

  it("evergreen が last-resort として prune された場合も 3-run 分 telemetry へ persist され、再候補化されない (evergreen eviction, LL-411 follow-up 2)", async () => {
    const existingContent = fullExistingBodies();
    const full = parseBodies(existingContent);
    const emptyPayload: BodiesPayload = { generatedAt: full.generatedAt, count: 0, bodies: {} };
    const emptyBytes = new TextEncoder().encode(serializeBodies(emptyPayload)).byteLength;
    // Far below even a single record's byte size -- forces ALL 5 entries
    // (including "ever", the evergreen record) to be pruned as a last resort.
    const target = emptyBytes + 10;

    // Run 1: everything, including evergreen, is pruned for the first time.
    const run1 = await runBodyPipeline(
      baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) }),
      pipelineEntries,
      existingContent,
      GENERATED_AT,
      `sha256:${"a".repeat(64)}`,
    );
    expect(run1.health.bodyBudgetPruned).toBe(5);
    expect([...run1.health.bodyBudgetEvictedIds].sort()).toEqual(
      ["ever", "imp1-new", "imp1-old", "imp2", "imp3"],
    );
    expect(run1.health.bodiesTotal).toBe(0);

    // Run 2: with run1's eviction fed back in, every entry (including "ever")
    // is already excluded, so nothing new is generated/merged/pruned.
    const run2 = await runBodyPipeline(
      baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) }),
      pipelineEntries,
      run1.bodiesFileContent,
      "2026-07-25T06:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: run1.health.bodyBudgetEvictedIds },
    );
    expect(run2.enqueued).toBe(0);
    expect(run2.health.bodyBudgetPruned).toBe(0);
    expect([...run2.health.bodyBudgetEvictedIds].sort()).toEqual(
      ["ever", "imp1-new", "imp1-old", "imp2", "imp3"],
    );

    // Run 3: "ever" is STILL excluded. A fixed "rank !== 3 releases" carry
    // forward check (round 2's original design) would have released "ever"
    // (rank 0, always !== 3) unconditionally every run, re-admitting it as a
    // fresh candidate and recreating the every-other-run waste loop this
    // fix exists to prevent -- just for the evergreen tier instead of
    // importance==1.
    const run3 = await runBodyPipeline(
      baseEnv({ BODY_BUDGET_TARGET_BYTES: String(target) }),
      pipelineEntries,
      run1.bodiesFileContent,
      "2026-07-25T07:00:00.000Z",
      `sha256:${"a".repeat(64)}`,
      { previousBudgetEvictedIds: run2.health.bodyBudgetEvictedIds },
    );
    expect(run3.enqueued).toBe(0);
    expect([...run3.health.bodyBudgetEvictedIds].sort()).toEqual(
      ["ever", "imp1-new", "imp1-old", "imp2", "imp3"],
    );
  });
});
