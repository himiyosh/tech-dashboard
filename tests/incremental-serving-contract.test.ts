import { describe, expect, it } from "vitest";
import {
  MAX_ROUTE_OBJECT_BYTES,
  MAX_SHARD_BYTES,
  MAX_SHARDS,
  MAX_SHELL_BYTES,
  INCREMENTAL_SERVE_IMPLEMENTED,
  REQUIRED_CUTOVER_ROUTE_FAMILIES,
  R2_CLASS_A_MONTHLY_LIMIT,
  R2_CLASS_B_MONTHLY_LIMIT,
  R2_READS_PER_SERVED_REQUEST,
  R2_STORAGE_LIMIT_BYTES,
  SAFE_DYNAMIC_DAILY_REQUESTS,
  SAFE_R2_CLASS_A_MONTHLY,
  SAFE_R2_CLASS_B_MONTHLY,
  SAFE_R2_STORAGE_BYTES,
  WORKERS_CPU_LIMIT_MS,
  WORKERS_DAILY_REQUEST_LIMIT,
  WORKERS_MEMORY_LIMIT_BYTES,
  assertIncrementalServingBudget,
  boundedPassthroughStream,
  boundedContentLength,
  contentKeyForDigest,
  evaluateIncrementalServingBudget,
  isServeReady,
  parseActivationRequest,
  parseContentKey,
  parseRouteShard,
  parseServingGenerationState,
  readBoundedStream,
  type IncrementalServingBudgetInput,
} from "../worker/src/incremental-serving-contract.ts";
import { DEPLOYED_PUBLISHER_FINGERPRINT } from "../worker/src/publisher-contract.ts";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function budget(
  overrides: Partial<IncrementalServingBudgetInput> = {},
): IncrementalServingBudgetInput {
  return {
    measuredDailyRequests: SAFE_DYNAMIC_DAILY_REQUESTS,
    projectedDailyPublisherRequests: 100,
    currentRouteCount: 3_213,
    currentFileCount: 7_710,
    currentStorageBytes: 500_000_000,
    largestRouteObjectBytes: 200_000,
    shellBytes: 1_024,
    largestShardBytes: 32_000,
    shardCount: 2,
    projectedMonthlyClassAOperations: 100_000,
    projectedMonthlyPublisherClassBOperations: 1_000,
    ...overrides,
  };
}

describe("incremental serving budget contract", () => {
  it("pins the provider and safety budgets", () => {
    expect(INCREMENTAL_SERVE_IMPLEMENTED).toBe(false);
    expect(WORKERS_DAILY_REQUEST_LIMIT).toBe(100_000);
    expect(WORKERS_CPU_LIMIT_MS).toBe(10);
    expect(WORKERS_MEMORY_LIMIT_BYTES).toBe(128 * 1024 * 1024);
    expect(SAFE_DYNAMIC_DAILY_REQUESTS).toBe(80_000);
    expect(R2_STORAGE_LIMIT_BYTES).toBe(10_000_000_000);
    expect(R2_CLASS_A_MONTHLY_LIMIT).toBe(1_000_000);
    expect(R2_CLASS_B_MONTHLY_LIMIT).toBe(10_000_000);
    expect(R2_READS_PER_SERVED_REQUEST).toBe(2);
    expect(SAFE_R2_STORAGE_BYTES).toBe(8_000_000_000);
    expect(SAFE_R2_CLASS_A_MONTHLY).toBe(900_000);
    expect(SAFE_R2_CLASS_B_MONTHLY).toBe(8_000_000);
  });

  it("accepts caller-provided current measurements inside every safe budget", () => {
    const result = assertIncrementalServingBudget(budget());
    expect(result.ok).toBe(true);
    expect(result.projectedMonthlyClassBOperations).toBe(4_961_000);
  });

  it.each([
    [
      { measuredDailyRequests: 80_001 },
      "measuredDailyRequests exceeds safe dynamic budget",
    ],
    [
      { projectedMonthlyClassAOperations: 900_001 },
      "projected Class A operations exceed safe budget",
    ],
    [
      { projectedDailyPublisherRequests: 10_001 },
      "combined public and Publisher Worker requests exceed safe daily budget",
    ],
    [
      { projectedMonthlyPublisherClassBOperations: 3_040_001 },
      "projected Class B operations exceed safe budget",
    ],
    [
      { currentStorageBytes: 8_000_000_001 },
      "currentStorageBytes exceeds safe storage budget",
    ],
    [
      { largestRouteObjectBytes: MAX_ROUTE_OBJECT_BYTES + 1 },
      "largestRouteObjectBytes exceeds",
    ],
    [{ shellBytes: MAX_SHELL_BYTES + 1 }, "shellBytes exceeds"],
    [{ largestShardBytes: MAX_SHARD_BYTES + 1 }, "largestShardBytes exceeds"],
    [{ shardCount: MAX_SHARDS + 1 }, "shardCount exceeds"],
    [{ currentFileCount: 1 }, "currentFileCount must be at least"],
  ])("fails closed when measurement %j exceeds policy", (overrides, message) => {
    const result = evaluateIncrementalServingBudget(budget(overrides));
    expect(result.ok).toBe(false);
    expect(result.failures.join("; ")).toContain(message);
    expect(() => assertIncrementalServingBudget(budget(overrides))).toThrow(
      message,
    );
  });

  it("fails closed for absent or non-finite current measurements", () => {
    const missing = {
      ...budget(),
      currentStorageBytes: undefined,
    } as unknown as IncrementalServingBudgetInput;
    const nonFinite = budget({ largestRouteObjectBytes: Number.NaN });
    expect(evaluateIncrementalServingBudget(missing).ok).toBe(false);
    expect(evaluateIncrementalServingBudget(nonFinite).ok).toBe(false);
  });
});

describe("incremental content-addressing contract", () => {
  it("accepts only exact lowercase SHA-256 keys", () => {
    const key = contentKeyForDigest("objects", digest("a"));
    expect(key).toBe(`objects/sha256/${"a".repeat(64)}`);
    expect(parseContentKey(key, "objects")).toEqual({
      kind: "objects",
      digest: digest("a"),
      key,
    });
    for (const invalid of [
      `objects/sha256/${"A".repeat(64)}`,
      `objects/sha256/${"a".repeat(63)}`,
      `objects/sha256/${"a".repeat(64)}/extra`,
      `objects/../shards/sha256/${"a".repeat(64)}`,
      `sha256/${"a".repeat(64)}`,
    ]) {
      expect(() => parseContentKey(invalid)).toThrow(/content key/);
    }
    expect(() => parseContentKey(key, "shards")).toThrow(
      /must use shards/,
    );
  });

  it("rejects invalid route paths, object keys, and malformed tombstones", () => {
    const valid = {
      schemaVersion: 1,
      revision: digest("b"),
      shardIndex: 0,
      shardCount: 1,
      routes: {
        "/e/aaaaaaaaaaaaaaaa/": {
          status: "object",
          variants: {
            ja: contentKeyForDigest("objects", digest("c")),
            en: contentKeyForDigest("objects", digest("d")),
          },
          variantBytes: { ja: 100, en: 120 },
          contentType: "text/html; charset=utf-8",
        },
      },
    };
    expect(parseRouteShard(valid).routes["/e/aaaaaaaaaaaaaaaa/"]?.status).toBe(
      "object",
    );
    expect(() =>
      parseRouteShard({
        ...valid,
        routes: { "https://example.com/e/a/": Object.values(valid.routes)[0] },
      })
    ).toThrow(/root-relative path/);
    expect(() =>
      parseRouteShard({
        ...valid,
        routes: {
          "/e/aaaaaaaaaaaaaaaa/": {
            ...Object.values(valid.routes)[0],
            variants: {
              ja: "objects/sha256/not-a-hash",
              en: contentKeyForDigest("objects", digest("d")),
            },
          },
        },
      })
    ).toThrow(/content key/);
    expect(() =>
      parseRouteShard({
        ...valid,
        routes: {
          "/e/aaaaaaaaaaaaaaaa/": {
            status: "tombstone",
            reason: "unknown",
            tombstonedAt: "not-a-date",
          },
        },
      })
    ).toThrow(/tombstone reason/);
  });

  it("enforces declared and actual bounded body sizes", async () => {
    expect(() =>
      boundedContentLength(
        new Request("https://worker.test/upload", {
          method: "PUT",
          headers: { "content-length": String(MAX_SHELL_BYTES + 1) },
        }),
        MAX_SHELL_BYTES,
      )
    ).toThrow(/exceeds/);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    await expect(readBoundedStream(stream, 4)).rejects.toThrow(/exceeds/);

    const mismatched = boundedPassthroughStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
          controller.close();
        },
      }),
      10,
      4,
    );
    await expect(new Response(mismatched).arrayBuffer()).rejects.toThrow(
      /exceeds its 4-byte declaration/,
    );
  });
});

describe("activation and readiness contracts", () => {
  it("requires measured sizes, matching shard count, and a shell-addressed revision", () => {
    const shellDigest = digest("e");
    const activation = parseActivationRequest({
      revision: digest("9"),
      expectedActiveRevision: null,
      sourceCommit: "a".repeat(40),
      publisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      shellKey: contentKeyForDigest("shells", shellDigest),
      shardKeys: [
        contentKeyForDigest("shards", digest("f")),
        contentKeyForDigest("shards", digest("1")),
      ],
      coverage: {
        complete: true,
        routeFamilies: [...REQUIRED_CUTOVER_ROUTE_FAMILIES],
      },
      measuredDailyRequests: 80_000,
      trafficVerifiedAt: "2026-08-13T00:00:00.000Z",
      budget: budget(),
    });
    expect(activation.budget.currentRouteCount).toBe(3_213);

    expect(activation.revision).not.toBe(shellDigest);
    expect(() =>
      parseActivationRequest({
        ...activation,
        shardKeys: activation.shardKeys.slice(0, 1),
      })
    ).toThrow(/shardKeys length must equal/);
    expect(() =>
      parseActivationRequest({
        ...activation,
        measuredDailyRequests: 79_999,
      })
    ).toThrow(/must equal budget/);
    expect(() =>
      parseActivationRequest({
        ...activation,
        coverage: { complete: true, routeFamilies: ["detail-pages"] },
      })
    ).toThrow(/every cutover route family/);
  });

  it("requires complete, approved, current, measured serving state", () => {
    const nowMs = Date.parse("2026-08-13T12:00:00.000Z");
    const shellDigest = digest("2");
    const state = parseServingGenerationState({
      active_revision: shellDigest,
      previous_revision: digest("3"),
      source_commit: "b".repeat(40),
      publisher_fingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
      shell_key: contentKeyForDigest("shells", shellDigest),
      shard_keys_json: JSON.stringify([
        contentKeyForDigest("shards", digest("4")),
        contentKeyForDigest("shards", digest("5")),
      ]),
      coverage_complete: 1,
      coverage_json: JSON.stringify(REQUIRED_CUTOVER_ROUTE_FAMILIES),
      measured_daily_requests: 80_000,
      traffic_verified_at: "2026-08-13T11:00:00.000Z",
      activated_at: "2026-08-13T11:01:00.000Z",
      budget_json: JSON.stringify(budget()),
    });
    expect(
      isServeReady(state, {
        cutoverApproved: "1",
        expectedPublisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        nowMs,
      }),
    ).toBe(true);
    expect(
      isServeReady(state, {
        cutoverApproved: "0",
        expectedPublisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
        nowMs,
      }),
    ).toBe(false);
    expect(
      isServeReady(
        { ...state, trafficVerifiedAt: "2026-08-12T11:59:59.999Z" },
        {
          cutoverApproved: "1",
          expectedPublisherFingerprint: DEPLOYED_PUBLISHER_FINGERPRINT,
          nowMs,
        },
      ),
    ).toBe(false);
  });
});
