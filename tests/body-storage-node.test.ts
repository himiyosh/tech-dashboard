import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBodyStorageFromDisk } from "../scripts/body-storage-node.mjs";
import { BODY_SHARD_PATHS, bodyShardIndex, serializeBodyShards } from "../web/src/lib/body-shards.ts";
import { bodyShardDigests } from "../web/src/lib/body-shard-integrity.ts";

const legacy = {
  generatedAt: "2026-10-05T02:30:47.117Z",
  count: 1,
  bodies: {
    "0000000000000001": {
      bodyJa: "実際の日本語本文。",
      bodyEn: "Actual English prose.",
    },
  },
};

describe("plain Node body reader used by approval and browser fixtures", () => {
  it("prefers a complete digest-pinned shard set and rejects missing/mixed data", () => {
    const root = mkdtempSync(join(tmpdir(), "techdb-body-node-"));
    mkdirSync(join(root, "data"));
    try {
      writeFileSync(join(root, "data/bodies.json"), JSON.stringify(legacy));
      expect(readBodyStorageFromDisk(root)).toMatchObject({
        mode: "legacy", count: 1, bodies: legacy.bodies,
      });
      const next = { ...legacy, bodies: {
        ...legacy.bodies,
        "0000000000000002": { bodyJa: "別の記事。", bodyEn: "Another article." },
      }, count: 2 };
      const shards = serializeBodyShards(next);
      writeFileSync(join(root, BODY_SHARD_PATHS[0]!), shards[0]!.content);
      expect(() => readBodyStorageFromDisk(root)).toThrow(/incomplete body shard set/);
      for (const shard of shards.slice(1)) {
        writeFileSync(join(root, shard.path), shard.content);
      }
      writeFileSync(join(root, "data/index.json"), JSON.stringify({
        health: {
          bodyStorageMode: "shards-v1",
          bodyShardDigests: bodyShardDigests(shards.map(({ content }) => content)),
        },
      }));
      expect(readBodyStorageFromDisk(root)).toMatchObject({
        mode: "shards-v1", count: 2, bodies: next.bodies,
      });
      const id = "0000000000000001";
      const home = bodyShardIndex(id);
      const other = (home + 1) % shards.length;
      const misplaced = shards.map(({ content }) => JSON.parse(content));
      misplaced[home].count -= 1;
      delete misplaced[home].bodies[id];
      misplaced[other].count += 1;
      misplaced[other].bodies[id] = next.bodies[id];
      const misplacedContents = misplaced.map((part) => `${JSON.stringify(part, null, 2)}\n`);
      for (const [index, file] of shards.entries()) {
        writeFileSync(join(root, file.path), misplacedContents[index]!);
      }
      writeFileSync(join(root, "data/index.json"), JSON.stringify({
        health: {
          bodyStorageMode: "shards-v1",
          bodyShardDigests: bodyShardDigests(misplacedContents),
        },
      }));
      expect(() => readBodyStorageFromDisk(root)).toThrow(/assignment or duplicate/);
      for (const file of shards) writeFileSync(join(root, file.path), file.content);
      writeFileSync(join(root, "data/index.json"), JSON.stringify({
        health: {
          bodyStorageMode: "shards-v1",
          bodyShardDigests: bodyShardDigests(shards.map(({ content }) => content)),
        },
      }));
      writeFileSync(join(root, BODY_SHARD_PATHS[0]!), `${shards[0]!.content}\n`);
      expect(() => readBodyStorageFromDisk(root)).toThrow(/body shard digest mismatch/);
      writeFileSync(join(root, BODY_SHARD_PATHS[0]!), shards[0]!.content);
      for (const shard of shards) unlinkSync(join(root, shard.path));
      expect(() => readBodyStorageFromDisk(root)).toThrow(/body shards required by the index/);
      unlinkSync(join(root, "data/bodies.json"));
      expect(() => readBodyStorageFromDisk(root)).toThrow(/ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
