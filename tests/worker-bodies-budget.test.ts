/**
 * tests/worker-bodies-budget.test.ts
 *
 * Body-file byte-budget enforcement (LL-411): a deterministic prune policy
 * that keeps data/bodies.json under an operational target, separate from and
 * additional to the boolean isBodyRetentionEligible() gate.
 */
import { describe, it, expect } from "vitest";
import {
  bodyBudgetPriorityRank,
  bodyBudgetPruneOrder,
  carryForwardBudgetEvictedIds,
  DEFAULT_BODY_BUDGET_TARGET_BYTES,
  enforceBodiesBudget,
  serializedByteLength,
  type BodyBudgetPriorityInput,
} from "../worker/src/bodies-budget.ts";
import { serializeBodies, type BodiesPayload, type BodyRecord } from "../worker/src/bodies-file.ts";

function record(seed: string, len = 200): BodyRecord {
  return {
    bodyJa: `本文${seed}`.repeat(Math.max(1, Math.ceil(len / 4))).slice(0, len),
    bodyEn: `body ${seed} `.repeat(Math.max(1, Math.ceil(len / 6))).slice(0, len),
    model: "claude-opus-4.8",
    generatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function payloadFrom(ids: string[], len = 200): BodiesPayload {
  const bodies: Record<string, BodyRecord> = {};
  for (const id of ids) bodies[id] = record(id, len);
  return { generatedAt: "2026-07-25T00:00:00.000Z", count: ids.length, bodies };
}

function priorityEntry(over: Partial<BodyBudgetPriorityInput> & { id: string }): BodyBudgetPriorityInput {
  return {
    evergreen: false,
    importance: 1,
    publishedAt: "2026-06-01T00:00:00.000Z",
    collectedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("bodyBudgetPriorityRank (LL-411)", () => {
  it("evergreen は importance に関わらず rank 0", () => {
    expect(bodyBudgetPriorityRank({ evergreen: true, importance: 1 })).toBe(0);
    expect(bodyBudgetPriorityRank({ evergreen: true, importance: 3 })).toBe(0);
  });
  it("importance>=3 (非 evergreen) は rank 1", () => {
    expect(bodyBudgetPriorityRank({ evergreen: false, importance: 3 })).toBe(1);
  });
  it("importance==2 は rank 2", () => {
    expect(bodyBudgetPriorityRank({ evergreen: false, importance: 2 })).toBe(2);
  });
  it("importance==1 (未指定含む) は rank 3", () => {
    expect(bodyBudgetPriorityRank({ evergreen: false, importance: 1 })).toBe(3);
    expect(bodyBudgetPriorityRank({ evergreen: false })).toBe(3);
  });
});

describe("bodyBudgetPruneOrder (LL-411): 優先順位", () => {
  it("importance 1 が最初、次に 2、次に 3 の順で prune 対象になる", () => {
    const candidates = [
      priorityEntry({ id: "imp3", importance: 3 }),
      priorityEntry({ id: "imp1", importance: 1 }),
      priorityEntry({ id: "imp2", importance: 2 }),
    ];
    expect(bodyBudgetPruneOrder(candidates)).toEqual(["imp1", "imp2", "imp3"]);
  });

  it("evergreen は prune order の最後 (last-resort) に位置し、除外はされない", () => {
    const candidates = [
      priorityEntry({ id: "ever", evergreen: true, importance: 1 }),
      priorityEntry({ id: "imp1", importance: 1 }),
    ];
    // Evergreen is still in the returned order (it CAN be pruned as a last
    // resort) -- it just sorts to the very end, after every other tier.
    expect(bodyBudgetPruneOrder(candidates)).toEqual(["imp1", "ever"]);
  });

  it("evergreen 同士でも古い順に prune 対象になる (last-resort 内のタイブレーク)", () => {
    const candidates = [
      priorityEntry({ id: "ever-new", evergreen: true, publishedAt: "2026-06-01T00:00:00.000Z" }),
      priorityEntry({ id: "ever-old", evergreen: true, publishedAt: "2020-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1", importance: 1 }),
    ];
    expect(bodyBudgetPruneOrder(candidates)).toEqual(["imp1", "ever-old", "ever-new"]);
  });

  it("同じ tier では古い publishedAt が先に prune される", () => {
    const candidates = [
      priorityEntry({ id: "new", importance: 2, publishedAt: "2026-07-01T00:00:00.000Z" }),
      priorityEntry({ id: "old", importance: 2, publishedAt: "2026-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "mid", importance: 2, publishedAt: "2026-04-01T00:00:00.000Z" }),
    ];
    expect(bodyBudgetPruneOrder(candidates)).toEqual(["old", "mid", "new"]);
  });

  it("publishedAt 欠落時は collectedAt にフォールバックする", () => {
    const candidates = [
      priorityEntry({ id: "a", importance: 2, publishedAt: null, collectedAt: "2026-05-01T00:00:00.000Z" }),
      priorityEntry({ id: "b", importance: 2, publishedAt: null, collectedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(bodyBudgetPruneOrder(candidates)).toEqual(["b", "a"]);
  });

  it("rank と日時が同一のときは id 昇順で決定論的にタイブレークする", () => {
    const sameDate = "2026-06-01T00:00:00.000Z";
    const candidates = [
      priorityEntry({ id: "zzz", importance: 1, publishedAt: sameDate }),
      priorityEntry({ id: "aaa", importance: 1, publishedAt: sameDate }),
      priorityEntry({ id: "mmm", importance: 1, publishedAt: sameDate }),
    ];
    const order = bodyBudgetPruneOrder(candidates);
    expect(order).toEqual(["aaa", "mmm", "zzz"]);
    // Re-running with the same input (including a different array order) must
    // yield the exact same result every time -- no reliance on insertion
    // order or unstable sort behavior.
    const shuffled = [candidates[2]!, candidates[0]!, candidates[1]!];
    expect(bodyBudgetPruneOrder(shuffled)).toEqual(order);
  });
});

describe("serializedByteLength (LL-411): 正確なバイト計測", () => {
  it("multibyte UTF-8 (日本語) は string.length よりバイト数が大きい", () => {
    const payload = payloadFrom(["a"], 0);
    payload.bodies.a = {
      bodyJa: "これは日本語の本文です。",
      bodyEn: "This is an English body.",
      model: "claude-opus-4.8",
      generatedAt: "2026-07-20T00:00:00.000Z",
    };
    const serialized = serializeBodies(payload);
    const bytes = serializedByteLength(payload);
    // Each JA character in bodyJa is 3 bytes in UTF-8; string.length counts
    // code units, so byte length must exceed raw JS string length whenever
    // multibyte characters are present.
    expect(bytes).toBeGreaterThan(serialized.length);
    expect(bytes).toBe(new TextEncoder().encode(serialized).byteLength);
  });

  it("envelope (generatedAt/count/インデント/改行) もバイト数に含まれる", () => {
    const empty: BodiesPayload = { generatedAt: "2026-07-25T00:00:00.000Z", count: 0, bodies: {} };
    const withOne = payloadFrom(["a"], 50);
    const emptyBytes = serializedByteLength(empty);
    const oneBytes = serializedByteLength(withOne);
    // The empty envelope alone (braces, generatedAt string, count, bodies:{})
    // must be non-trivial and strictly less than a payload with one record.
    expect(emptyBytes).toBeGreaterThan(20);
    expect(oneBytes).toBeGreaterThan(emptyBytes);
  });

  it("2 レコード分の差分は JSON.stringify の実出力と一致する (概算しない)", () => {
    const one = payloadFrom(["a"], 300);
    const two = payloadFrom(["a", "b"], 300);
    const diff = serializedByteLength(two) - serializedByteLength(one);
    // The diff must equal exactly what JSON.stringify actually adds for
    // record "b" plus its comma -- not an approximation.
    const expectedDiff =
      new TextEncoder().encode(serializeBodies(two)).byteLength
      - new TextEncoder().encode(serializeBodies(one)).byteLength;
    expect(diff).toBe(expectedDiff);
  });
});

describe("DEFAULT_BODY_BUDGET_TARGET_BYTES vs hard ceiling (LL-411)", () => {
  const HARD_CEILING_BYTES = 10_000_000; // tests/data-schema.test.ts, unchanged safety net
  it("target は hard ceiling より十分小さい (1MB 以上の余裕)", () => {
    expect(DEFAULT_BODY_BUDGET_TARGET_BYTES).toBeLessThan(HARD_CEILING_BYTES);
    expect(HARD_CEILING_BYTES - DEFAULT_BODY_BUDGET_TARGET_BYTES).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe("enforceBodiesBudget (LL-411)", () => {
  it("target 以下なら何もしない (changed=false)", () => {
    const payload = payloadFrom(["a", "b", "c"], 100);
    const before = serializedByteLength(payload);
    const entries = [
      priorityEntry({ id: "a", importance: 1 }),
      priorityEntry({ id: "b", importance: 1 }),
      priorityEntry({ id: "c", importance: 1 }),
    ];
    const result = enforceBodiesBudget(payload, entries, before + 1000);
    expect(result.changed).toBe(false);
    expect(result.prunedIds).toEqual([]);
    expect(result.payload).toBe(payload);
    expect(result.bytes).toBe(before);
  });

  it("target を超えると importance 1 の最古から prune し、evergreen と高優先度を保持する", () => {
    const ids = ["ever", "imp3", "imp2-new", "imp1-new", "imp1-mid", "imp1-old"];
    const payload = payloadFrom(ids, 500);
    const entries = [
      priorityEntry({ id: "ever", evergreen: true, importance: 1, publishedAt: "2020-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp3", importance: 3, publishedAt: "2026-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp2-new", importance: 2, publishedAt: "2026-06-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1-new", importance: 1, publishedAt: "2026-07-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1-mid", importance: 1, publishedAt: "2026-05-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1-old", importance: 1, publishedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const full = serializedByteLength(payload);
    // Target just under the full size, forcing exactly one removal (the
    // lowest priority = oldest importance-1 record).
    const oneRecordBytes = full - serializedByteLength(payloadFrom(ids.slice(1), 500));
    const target = full - Math.ceil(oneRecordBytes / 2);
    const result = enforceBodiesBudget(payload, entries, target);
    expect(result.changed).toBe(true);
    expect(result.prunedIds).toEqual(["imp1-old"]);
    expect(result.payload.bodies.ever).toBeDefined();
    expect(result.payload.bodies.imp3).toBeDefined();
    expect(result.bytes).toBeLessThanOrEqual(target);
  });

  it("evergreen も non-evergreen を全て prune した後は last-resort として prune される", () => {
    const ids = ["ever-old", "ever-new", "imp1"];
    const entries = [
      priorityEntry({ id: "ever-old", evergreen: true, publishedAt: "2020-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "ever-new", evergreen: true, publishedAt: "2024-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1", importance: 1, publishedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const payload = payloadFrom(ids, 300);
    // Prune order is imp1 (rank 3) first, then the OLDER evergreen record,
    // then the newer one. A target that fits only one record forces removing
    // BOTH imp1 and ever-old, leaving only ever-new -- proving evergreen is
    // not exempt once every other tier is already gone.
    const oneRecordOnly = payloadFrom(["ever-new"], 300);
    const twoRecords = payloadFrom(["ever-old", "ever-new"], 300);
    const target = Math.round(
      (serializedByteLength(oneRecordOnly) + serializedByteLength(twoRecords)) / 2,
    );
    const result = enforceBodiesBudget(payload, entries, target);
    expect(result.changed).toBe(true);
    expect(result.prunedIds).toEqual(["imp1", "ever-old"]);
    expect(result.payload.bodies["ever-new"]).toBeDefined();
    expect(result.payload.bodies["ever-old"]).toBeUndefined();
    expect(result.payload.bodies["imp1"]).toBeUndefined();
    expect(result.bytes).toBeLessThanOrEqual(target);
  });

  it("evergreen だけが残っても target 超過なら古い evergreen からさらに prune し、必ず target 以下にする", () => {
    const ids = ["ever-a", "ever-b", "ever-c"];
    const entries = [
      priorityEntry({ id: "ever-a", evergreen: true, publishedAt: "2018-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "ever-b", evergreen: true, publishedAt: "2020-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "ever-c", evergreen: true, publishedAt: "2022-01-01T00:00:00.000Z" }),
    ];
    // Large records so even a single one exceeds the tiny target below.
    const payload = payloadFrom(ids, 5000);
    const emptyBytes = serializedByteLength({ generatedAt: payload.generatedAt, count: 0, bodies: {} });
    const target = emptyBytes + 50; // just above the minimal possible envelope
    const result = enforceBodiesBudget(payload, entries, target);
    // "Protected" means pruned LAST, not exempt: in this extreme scenario
    // (no lower tier exists to absorb the cut), evergreen is pruned down to
    // whatever is strictly necessary to guarantee the target -- here, all of
    // it, since even one 5000-char record does not fit.
    expect(result.bytes).toBeLessThanOrEqual(target);
    expect(Object.keys(result.payload.bodies)).toEqual([]);
    expect([...result.prunedIds].sort()).toEqual(["ever-a", "ever-b", "ever-c"]);
  });

  it("target が最小envelopeサイズより小さい病的な誤設定でも、クラッシュ・無限ループせず全件 prune した実バイト数を返す", () => {
    // Documents the one theoretical exception to the "always fits under
    // target" guarantee: a targetBytes smaller than the minimal possible
    // JSON envelope itself ({"generatedAt":...,"count":0,"bodies":{}})
    // cannot be satisfied by any amount of pruning -- there is nothing left
    // to remove below the envelope. This never happens with the production
    // DEFAULT_BODY_BUDGET_TARGET_BYTES (9,000,000), which is many orders of
    // magnitude larger than the envelope, but a misconfigured
    // BODY_BUDGET_TARGET_BYTES override should still behave safely (prune
    // everything, report the real byte count, no crash/hang) rather than
    // silently claiming an unmet guarantee.
    const ids = ["ever-a", "imp1"];
    const entries = [
      priorityEntry({ id: "ever-a", evergreen: true }),
      priorityEntry({ id: "imp1", importance: 1 }),
    ];
    const payload = payloadFrom(ids, 300);
    const emptyBytes = serializedByteLength({ generatedAt: payload.generatedAt, count: 0, bodies: {} });
    const target = Math.max(1, emptyBytes - 10); // strictly below the minimal envelope
    const result = enforceBodiesBudget(payload, entries, target);
    expect(result.changed).toBe(true);
    expect(Object.keys(result.payload.bodies)).toEqual([]);
    expect([...result.prunedIds].sort()).toEqual(["ever-a", "imp1"]);
    // The best-effort result is the (tiny) empty-envelope size, which is the
    // true minimum achievable -- it may still exceed this unrealistic target,
    // but only by the envelope's own fixed overhead, never by a full record.
    expect(result.bytes).toBe(emptyBytes);
    expect(result.bytes).toBeLessThan(target + 20);
  });

  it("既に present だが entries に見つからない孤立 record は最優先で prune される", () => {
    const ids = ["orphan", "imp1"];
    const payload = payloadFrom(ids, 400);
    // Only "imp1" has matching priority info; "orphan" is present in the
    // payload but absent from `entries` (defensive-only scenario -- normal
    // operation prunes non-live ids via mergeBodies before this runs).
    const entries = [priorityEntry({ id: "imp1", importance: 1 })];
    const full = serializedByteLength(payload);
    const oneRecordBytes = full - serializedByteLength(payloadFrom(["imp1"], 400));
    const target = full - Math.ceil(oneRecordBytes / 2);
    const result = enforceBodiesBudget(payload, entries, target);
    expect(result.prunedIds).toEqual(["orphan"]);
    expect(result.payload.bodies.imp1).toBeDefined();
  });

  it("大きなペイロードでも決定論的な minimal-removal で target 以下に収める (実データ規模)", () => {
    // Simulate a realistic-scale payload (hundreds of records at varying
    // sizes) similar to the production bodies.json distribution: mostly
    // importance-2, some importance-3, some evergreen, some recent
    // importance-1.
    const ids: string[] = [];
    const entries: BodyBudgetPriorityInput[] = [];
    for (let i = 0; i < 200; i += 1) {
      const id = `e${i}`;
      ids.push(id);
      const importance = i % 10 === 0 ? 3 : i % 3 === 0 ? 1 : 2;
      entries.push(
        priorityEntry({
          id,
          importance,
          evergreen: i % 50 === 0,
          publishedAt: new Date(2026, 0, 1 + (i % 180)).toISOString(),
        }),
      );
    }
    const payload = payloadFrom(ids, 6000); // large records to force pruning
    const target = 400_000; // force meaningful pruning
    const result = enforceBodiesBudget(payload, entries, target);
    expect(result.bytes).toBeLessThanOrEqual(target);
    // All evergreen ids must survive.
    for (const entry of entries) {
      if (entry.evergreen) expect(result.payload.bodies[entry.id]).toBeDefined();
    }
    // Removing one fewer record (if any were removed) would NOT fit -- proves
    // the removal count is minimal, not overly aggressive.
    if (result.prunedIds.length > 0) {
      const oneLess = result.prunedIds.slice(0, -1);
      const drop = new Set(oneLess);
      const bodies: Record<string, BodyRecord> = {};
      for (const [id, rec] of Object.entries(payload.bodies)) {
        if (!drop.has(id)) bodies[id] = rec;
      }
      const withOneLess: BodiesPayload = {
        generatedAt: payload.generatedAt,
        count: Object.keys(bodies).length,
        bodies,
      };
      expect(serializedByteLength(withOneLess)).toBeGreaterThan(target);
    }
  });

  it("idempotent: 一度 target 以下にした結果を再度実行しても変化しない", () => {
    const ids = ["ever", "imp3", "imp2", "imp1-a", "imp1-b", "imp1-c"];
    const payload = payloadFrom(ids, 800);
    const entries = [
      priorityEntry({ id: "ever", evergreen: true }),
      priorityEntry({ id: "imp3", importance: 3, publishedAt: "2026-06-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp2", importance: 2, publishedAt: "2026-05-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1-a", importance: 1, publishedAt: "2026-04-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1-b", importance: 1, publishedAt: "2026-03-01T00:00:00.000Z" }),
      priorityEntry({ id: "imp1-c", importance: 1, publishedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const target = 2500;
    const first = enforceBodiesBudget(payload, entries, target);
    const remainingEntries = entries.filter((e) => first.payload.bodies[e.id]);
    const second = enforceBodiesBudget(first.payload, remainingEntries, target);
    expect(second.changed).toBe(false);
    expect(second.prunedIds).toEqual([]);
    expect(second.payload.count).toBe(first.payload.count);
  });

  it("既存の body 転送 (mergeBodies 由来の payload) にもそのまま適用できる", async () => {
    const { mergeBodies } = await import("../worker/src/bodies-file.ts");
    const existing = payloadFrom(["keep-a"], 200);
    const merge = mergeBodies(
      existing,
      [
        { id: "new-a", bodyJa: "新規A".repeat(200) + "。", bodyEn: "new a ".repeat(200).trim() + "." },
        { id: "new-b", bodyJa: "新規B".repeat(200) + "。", bodyEn: "new b ".repeat(200).trim() + "." },
      ],
      new Set(["keep-a", "new-a", "new-b"]),
      "2026-07-25T00:00:00.000Z",
    );
    expect(merge.payload.bodies["keep-a"]).toBeDefined();
    expect(merge.payload.bodies["new-a"]).toBeDefined();
    expect(merge.payload.bodies["new-b"]).toBeDefined();

    const entries = [
      priorityEntry({ id: "keep-a", evergreen: true }),
      priorityEntry({ id: "new-a", importance: 1, publishedAt: "2026-01-01T00:00:00.000Z" }),
      priorityEntry({ id: "new-b", importance: 1, publishedAt: "2026-07-01T00:00:00.000Z" }),
    ];
    const mergedBytes = serializedByteLength(merge.payload);
    const budget = enforceBodiesBudget(merge.payload, entries, mergedBytes - 10);
    // Forced to prune something; the evergreen transferred body must survive
    // and the older non-evergreen transferred body is pruned before the newer.
    expect(budget.payload.bodies["keep-a"]).toBeDefined();
    if (budget.prunedIds.length > 0) {
      expect(budget.prunedIds[0]).toBe("new-a");
    }
  });
});

describe("carryForwardBudgetEvictedIds (LL-411 follow-up: cross-run state loss)", () => {
  it("依然として live・retention-eligible・body 無し・最低優先度のままの id を carry forward する", () => {
    const entries = [priorityEntry({ id: "stuck", importance: 1 })];
    const result = carryForwardBudgetEvictedIds(["stuck"], entries, new Set(), []);
    expect(result).toEqual(["stuck"]);
  });

  it("新規 prune と過去の carry-forward を union し、重複なく決定論的にソートする", () => {
    const entries = [
      priorityEntry({ id: "old-evicted", importance: 1 }),
      priorityEntry({ id: "new-evicted", importance: 1 }),
    ];
    const result = carryForwardBudgetEvictedIds(
      ["old-evicted"],
      entries,
      new Set(),
      ["new-evicted", "old-evicted"], // duplicate on purpose
    );
    expect(result).toEqual(["new-evicted", "old-evicted"]);
  });

  it("live/retention-eligible でなくなった id は除外する (stale cleanup)", () => {
    // "gone" is no longer present in `entries` at all (aged out / no longer live).
    const entries: BodyBudgetPriorityInput[] = [];
    const result = carryForwardBudgetEvictedIds(["gone"], entries, new Set(), []);
    expect(result).toEqual([]);
  });

  it("既に real body を持つ id は除外する", () => {
    const entries = [priorityEntry({ id: "has-body-now", importance: 1 })];
    const result = carryForwardBudgetEvictedIds(
      ["has-body-now"],
      entries,
      new Set(["has-body-now"]),
      [],
    );
    expect(result).toEqual([]);
  });

  it("evergreen へ昇格した id は除外する (promotion recovery)", () => {
    const entries = [
      priorityEntry({ id: "promoted", evergreen: true }),
      // "survivor" still sits at the worst tier (importance 1, rank 3) but
      // currently HAS a real body -- i.e. the budget has room even for the
      // worst tier right now, so an id that improved to a much better tier
      // (evergreen, rank 0) no longer belongs among excluded candidates.
      priorityEntry({ id: "survivor", importance: 1 }),
    ];
    const result = carryForwardBudgetEvictedIds(
      ["promoted"],
      entries,
      new Set(["survivor"]),
      [],
    );
    expect(result).toEqual([]);
  });

  it("importance が 2/3 へ昇格した id も除外する (promotion recovery)", () => {
    const entries = [
      priorityEntry({ id: "promoted-2", importance: 2 }),
      priorityEntry({ id: "promoted-3", importance: 3 }),
      priorityEntry({ id: "survivor", importance: 1 }),
    ];
    const result = carryForwardBudgetEvictedIds(
      ["promoted-2", "promoted-3"],
      entries,
      new Set(["survivor"]),
      [],
    );
    expect(result).toEqual([]);
  });

  it("worst surviving tier と同じ rank (tie) では release されない (保守的に除外継続)", () => {
    // "still-worst" is at the exact same rank (importance 1, rank 3) as the
    // worst tier that currently survives -- nothing about its situation has
    // actually improved, so it must stay excluded; otherwise it would be
    // re-admitted, regenerated, and re-evicted every other run.
    const entries = [
      priorityEntry({ id: "still-worst", importance: 1 }),
      priorityEntry({ id: "survivor", importance: 1 }),
    ];
    const result = carryForwardBudgetEvictedIds(
      ["still-worst"],
      entries,
      new Set(["survivor"]),
      [],
    );
    expect(result).toEqual(["still-worst"]);
  });

  it("evergreen が last-resort として prune された場合、evergreen のみが生き残っていても再導入されない", () => {
    // Only evergreen entries currently have a real body (worstSurvivingRank
    // is therefore 0, evergreen's own rank). An evergreen id that got evicted
    // must stay excluded -- rank 0 is NOT strictly less than worstSurvivingRank
    // (also 0) -- otherwise this would recreate the exact waste loop this
    // function exists to prevent, just for the evergreen tier.
    const entries = [
      priorityEntry({ id: "evicted-evergreen", evergreen: true }),
      priorityEntry({ id: "surviving-evergreen", evergreen: true }),
    ];
    const result = carryForwardBudgetEvictedIds(
      ["evicted-evergreen"],
      entries,
      new Set(["surviving-evergreen"]),
      [],
    );
    expect(result).toEqual(["evicted-evergreen"]);
  });

  it("previousIds が空でも新規 prune だけは反映する", () => {
    const entries = [priorityEntry({ id: "fresh", importance: 1 })];
    const result = carryForwardBudgetEvictedIds([], entries, new Set(), ["fresh"]);
    expect(result).toEqual(["fresh"]);
  });

  it("同じ入力に対して常に同じ出力を返す (決定論的)", () => {
    const entries = [
      priorityEntry({ id: "zzz", importance: 1 }),
      priorityEntry({ id: "aaa", importance: 1 }),
    ];
    const a = carryForwardBudgetEvictedIds(["zzz"], entries, new Set(), ["aaa"]);
    const b = carryForwardBudgetEvictedIds(["zzz"], entries, new Set(), ["aaa"]);
    expect(a).toEqual(b);
    expect(a).toEqual(["aaa", "zzz"]);
  });
});

