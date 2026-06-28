/**
 * tests/worker-body-pipeline.test.ts
 *
 * Body-file Phase B (LL-115): body job selection + bodies.json merge logic.
 */
import { describe, it, expect } from "vitest";
import type { NormalizedEntry } from "../harness/types.ts";
import { needsBody, selectBodyJobBatch } from "../worker/src/body-queue.ts";
import {
  bodiesPresentSet,
  isRealBody,
  mergeBodies,
  parseBodies,
  type BodiesPayload,
} from "../worker/src/bodies-file.ts";

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
