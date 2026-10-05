import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHarness, type PublisherCommitFile, type PublisherEnv } from "../worker/src/index.ts";
import { readBodyStorage, type BodiesPayload } from "../worker/src/bodies-file.ts";
import { BODY_SHARD_PATHS, serializeBodyShards } from "../web/src/lib/body-shards.ts";
import { bodyShardDigests } from "../web/src/lib/body-shard-integrity.ts";

const SHA = "a".repeat(40);
const ADVANCED = "b".repeat(40);
const AT = "2026-10-05T02:30:47.117Z";
const BODY_ID = "0000000000000001";
const EVICTED_ID = "0000000000000002";
const body: BodiesPayload = {
  generatedAt: AT,
  count: 1,
  bodies: {
    [BODY_ID]: {
      bodyJa: "元記事の実際の日本語本文。",
      bodyEn: "This is the actual English article.",
      model: "claude-opus-4.8",
      generatedAt: AT,
      chat: Array.from({ length: 6 }, (_, index) => ({
        s: index % 2 === 0 ? "a" as const : "b" as const,
        ja: `質問と返答 ${index}。`,
        en: `Question and answer ${index}.`,
      })),
    },
  },
};
const legacyIndex = {
  generatedAt: AT,
  count: 2,
  health: {
    bodyStorageMode: "legacy",
    bodyBudgetTargetBytes: 9_000_000,
    bodyBudgetBytes: 500,
    bodyBudgetPruned: 0,
    bodyBudgetEvictedIds: [EVICTED_ID],
  },
  entries: [
    { id: BODY_ID, bodyJa: "", bodyEn: "" },
    { id: EVICTED_ID, bodyJa: "", bodyEn: "" },
  ],
};
const digest = (record: unknown) =>
  createHash("sha256").update(JSON.stringify(record)).digest("hex");
const env: PublisherEnv = {
  GH_TOKEN: "test-token",
  GITHUB_OWNER: "himiyosh",
  GITHUB_REPO: "tech-dashboard",
  GITHUB_BRANCH: "main",
  SUMMARY_CACHE: { get: async () => null, put: async () => {} },
  COPILOT_PAT: "",
  SUMMARIZE_MODEL: "",
  SUMMARIZE_MAX_NEW: "0",
};

function mockRepository(options: {
  shards?: readonly (string | null)[];
  legacy?: BodiesPayload;
  index?: unknown;
  advanceBeforeCommit?: boolean;
} = {}) {
  const shardValues = options.shards ?? [null, null, null, null];
  const contract = readFileSync("worker/publisher-contract.json", "utf8");
  const calls: string[] = [];
  let headReads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      headReads += 1;
      return Response.json({
        object: { sha: options.advanceBeforeCommit && headReads > 1 ? ADVANCED : SHA },
      });
    }
    if (url.pathname.endsWith("/contents/worker/publisher-contract.json")) {
      expect(url.searchParams.get("ref")).toBe(SHA);
      return Response.json({
        sha: SHA,
        encoding: "base64",
        content: Buffer.from(contract).toString("base64"),
      });
    }
    if (url.host !== "raw.githubusercontent.com" || !url.pathname.includes(`/${SHA}/data/`)) {
      throw new Error(`unexpected publisher fetch: ${url.pathname}`);
    }
    const path = url.pathname.split(`/${SHA}/`)[1]!;
    const shardIndex = BODY_SHARD_PATHS.indexOf(path as typeof BODY_SHARD_PATHS[number]);
    const contents = path === "data/index.json"
      ? JSON.stringify(options.index ?? legacyIndex)
      : path === "data/bodies.json"
        ? JSON.stringify(options.legacy ?? body)
        : shardIndex >= 0 ? shardValues[shardIndex] : null;
    return contents === null
      ? new Response(null, { status: 404 })
      : new Response(contents, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("first Publisher body migration from one immutable main SHA", () => {
  it("commits four lossless shards and the digest manifest atomically; never writes legacy", async () => {
    const { calls } = mockRepository();
    const commit = vi.fn(async (
      _env: PublisherEnv,
      _message: string,
      changes: PublisherCommitFile[],
      parentSha: string,
    ) => {
      expect(parentSha).toBe(SHA);
      expect(changes.map(({ path }) => path)).toEqual([...BODY_SHARD_PATHS, "data/index.json"]);
      const assembled = readBodyStorage(
        null,
        changes.slice(0, 4).map(({ content }) => content),
      ).payload;
      expect(Object.keys(assembled.bodies)).toEqual(Object.keys(body.bodies));
      expect(digest(assembled.bodies[BODY_ID])).toBe(digest(body.bodies[BODY_ID]));
      expect(assembled.generatedAt).toBe(body.generatedAt);
      const index = JSON.parse(changes[4]!.content);
      expect(index.entries).toEqual(legacyIndex.entries);
      expect(index.generatedAt).toBe(legacyIndex.generatedAt);
      expect(index.health).toMatchObject({
        bodyStorageMode: "shards-v1",
        bodyBudgetTargetBytes: 18_000_000,
        bodyBudgetEvictedIds: [],
        bodyShardDigests: bodyShardDigests(changes.slice(0, 4).map(({ content }) => content)),
      });
      expect(index.health.bodyShardBytes).toEqual(changes.slice(0, 4)
        .map(({ content }) => Buffer.byteLength(content)));
      return SHA;
    });
    const result = await runHarness(env, { commitFiles: commit });
    expect(result.changed).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.includes("/data/bodies-"))).toHaveLength(4);
    expect(calls.filter((call) => call.includes("/data/bodies.json"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("POST "))).toBe(false);
  });

  it("rejects one missing shard, even while an intact legacy file is available", async () => {
    mockRepository({ shards: [serializeBodyShards(body)[0]!.content, null, null, null] });
    const commit = vi.fn();
    await expect(runHarness(env, { commitFiles: commit }))
      .rejects.toThrow(/incomplete body shard set: 1\/4/);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects all four missing shards once the index declares sharded storage", async () => {
    mockRepository({ index: {
      ...legacyIndex,
      health: { ...legacyIndex.health, bodyStorageMode: "shards-v1" },
    } });
    const commit = vi.fn();
    await expect(runHarness(env, { commitFiles: commit }))
      .rejects.toThrow(/body shards required by the index/);
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects a shard mixed from another snapshot before collection or commit", async () => {
    const files = serializeBodyShards(body).map(({ content }) => content);
    const index = { ...legacyIndex, health: {
      ...legacyIndex.health,
      bodyStorageMode: "shards-v1",
      bodyShardDigests: bodyShardDigests(files),
    } };
    const mixed = [...files];
    const changed = JSON.parse(mixed[0]!) as BodiesPayload;
    changed.generatedAt = "2026-10-05T03:00:00.000Z";
    mixed[0] = `${JSON.stringify(changed, null, 2)}\n`;
    mockRepository({ shards: mixed, index });
    const commit = vi.fn();
    await expect(runHarness(env, { commitFiles: commit }))
      .rejects.toThrow(/body shard digest mismatch/);
    expect(commit).not.toHaveBeenCalled();
  });

  it("refuses the first migration when main advances before the CAS commit", async () => {
    const { calls } = mockRepository({ advanceBeforeCommit: true });
    await expect(runHarness(env))
      .rejects.toThrow(/publisher snapshot changed: expected parent/);
    expect(calls.filter((call) => call.includes("/git/ref/heads/main"))).toHaveLength(2);
    expect(calls.some((call) => call.startsWith("POST "))).toBe(false);
  });
});
