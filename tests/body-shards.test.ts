import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BODY_SHARD_PATHS,
  BODY_SHARD_TARGET_BYTES,
  BODY_TOTAL_TARGET_BYTES,
  assertBodyStorageMode,
  bodyShardIndex,
  combineBodyShards,
  loadBodyStorage,
  serializeBodyShards,
  splitBodyShards,
} from "../web/src/lib/body-shards.ts";
import { readBodyStorage, type BodyRecord, type BodiesPayload } from "../worker/src/bodies-file.ts";
import { assertBodyShardDigests, bodyShardDigests } from "../web/src/lib/body-shard-integrity.ts";

const AT = "2026-10-05T02:30:47.117Z";
const entry = (id: string): BodyRecord => ({
  bodyJa: `日本語本文 ${id}。`,
  bodyEn: `English article ${id}.`,
  model: "claude-opus-4.8",
  generatedAt: AT,
  chat: Array.from({ length: 6 }, (_, index) => ({
    s: index % 2 === 0 ? "a" as const : "b" as const,
    ja: `発言 ${index}。`,
    en: `Turn ${index}.`,
  })),
});
const source: BodiesPayload = {
  generatedAt: AT,
  count: 4,
  bodies: Object.fromEntries(["a", "b", "c", "d"].map((id) => [id, entry(id)])),
};
const recordDigest = (record: BodyRecord) =>
  createHash("sha256").update(JSON.stringify(record)).digest("hex");

describe("four deterministic body shards", () => {
  it("splits by UTF-8 article ID and preserves the exact record digest and fields", () => {
    const files = serializeBodyShards(source);
    expect(files.map(({ path }) => path)).toEqual(BODY_SHARD_PATHS);
    const assembled = combineBodyShards<BodyRecord>(
      files.map(({ content }) => JSON.parse(content) as unknown),
    );
    expect(assembled.count).toBe(source.count);
    expect(assembled.generatedAt).toBe(source.generatedAt);
    for (const [id, record] of Object.entries(source.bodies)) {
      expect(recordDigest(assembled.bodies[id]!)).toBe(recordDigest(record));
      expect(splitBodyShards(source)[bodyShardIndex(id)]?.bodies[id]).toEqual(record);
    }
    expect(serializeBodyShards(assembled)).toEqual(files);
  });

  it("does not confuse a frozen legacy snapshot with the complete newer shards", () => {
    const shards = splitBodyShards(source);
    const legacy = { ...source, count: 0, bodies: {} };
    expect(loadBodyStorage<BodyRecord>(source, [null, null, null, null]))
      .toEqual({ mode: "legacy", payload: source });
    expect(loadBodyStorage<BodyRecord>(legacy, shards))
      .toMatchObject({ mode: "shards-v1", payload: { count: source.count } });
    expect(() => loadBodyStorage(source, [shards[0], null, null, null]))
      .toThrow(/incomplete body shard set/);
    expect(() => loadBodyStorage(null, [null, null, null, null]))
      .toThrow(/invalid body storage payload/);
    expect(() => assertBodyStorageMode("legacy", {
      bodyStorageMode: "shards-v1",
    })).toThrow(/body shards required/);
    expect(() => assertBodyStorageMode("legacy", {
      bodyShardDigests: ["stale"],
    })).toThrow(/body shards required/);
    expect(() => assertBodyStorageMode("shards-v1", {
      bodyStorageMode: "legacy",
    })).toThrow(/matching index storage mode/);
    expect(() => assertBodyStorageMode("shards-v1", {
      bodyStorageMode: "shards-v1",
    })).not.toThrow();
  });

  it("rejects a misplaced, duplicate, truncated, or malformed shard", () => {
    const shards = splitBodyShards(source);
    const id = "a";
    const home = bodyShardIndex(id);
    const other = (home + 1) % 4;
    const misplaced = structuredClone(shards);
    misplaced[other]!.bodies[id] = misplaced[home]!.bodies[id]!;
    misplaced[other]!.count += 1;
    expect(() => combineBodyShards(misplaced)).toThrow(/assignment or duplicate/);
    expect(() => combineBodyShards([...shards, shards[0]])).toThrow(/exactly four/);
    const badCount = structuredClone(shards);
    badCount[home]!.count += 1;
    expect(() => combineBodyShards(badCount)).toThrow(/invalid body storage count/);
    const badRecord = structuredClone(shards);
    badRecord[home]!.bodies[id] = { ...entry(id), bodyEn: undefined } as unknown as BodyRecord;
    expect(() => combineBodyShards(badRecord)).toThrow(/invalid body storage record/);
    expect(() => readBodyStorage('{"not":"json"', [null, null, null, null]))
      .toThrow(/invalid body storage JSON/);
  });

  it("rejects a valid-looking shard from a different snapshot via index SHA-256", () => {
    const original = serializeBodyShards(source).map((file) => file.content);
    const digests = bodyShardDigests(original);
    const mixed = [...original];
    const index = bodyShardIndex("a");
    const changed = JSON.parse(mixed[index]!) as BodiesPayload;
    changed.bodies.a!.bodyEn = "An article from a different generation.";
    mixed[index] = `${JSON.stringify(changed, null, 2)}\n`;
    expect(() => readBodyStorage(null, mixed)).not.toThrow();
    expect(() => assertBodyShardDigests(mixed, digests))
      .toThrow(/body shard digest mismatch/);
    expect(() => assertBodyShardDigests(original, digests)).not.toThrow();
    expect(() => assertBodyShardDigests(original, ["not-a-hash"]))
      .toThrow(/digest inventory/);
    const reformatted = [...original];
    reformatted[index] += "\n";
    expect(() => combineBodyShards(reformatted.map((part) => JSON.parse(part)))).not.toThrow();
    expect(() => assertBodyShardDigests(reformatted, digests))
      .toThrow(/body shard digest mismatch/);
  });

  it("rehydrates the tracked legacy corpus losslessly before the first Publisher migration", () => {
    const legacy = readFileSync("data/bodies.json", "utf8");
    const active = BODY_SHARD_PATHS.map((path) =>
      existsSync(path) ? readFileSync(path, "utf8") : null);
    const { mode, payload } = readBodyStorage(legacy, active);
    const legacyPayload = readBodyStorage(legacy, [null, null, null, null]).payload;
    if (mode === "legacy") {
      expect(payload.count).toBeGreaterThan(0);
      expect(statSync("data/bodies.json").size).toBeLessThanOrEqual(BODY_SHARD_TARGET_BYTES);
      const projected = serializeBodyShards(payload);
      expect(projected.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0))
        .toBeLessThanOrEqual(BODY_TOTAL_TARGET_BYTES);
      for (const file of projected) {
        expect(Buffer.byteLength(file.content)).toBeLessThanOrEqual(BODY_SHARD_TARGET_BYTES);
      }
      const reassembled = readBodyStorage(null, projected.map((file) => file.content)).payload;
      expect(Object.keys(reassembled.bodies).sort())
        .toEqual(Object.keys(payload.bodies).sort());
      for (const [id, record] of Object.entries(payload.bodies)) {
        expect(recordDigest(reassembled.bodies[id]!)).toBe(recordDigest(record));
      }
    } else {
      // The old source remains tracked for rollback, but current shards may
      // have newer records. It must not be the reader's fallback in this mode.
      expect(active.every((content) => content !== null)).toBe(true);
      expect(payload.count).toBe(Object.keys(payload.bodies).length);
      expect(legacyPayload.count).toBe(Object.keys(legacyPayload.bodies).length);
    }
  });
});
