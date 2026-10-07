import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Plain Node entry points (including the protected approval workflow) cannot
// depend on tsx. Keep the ID hash aligned with body-shards.ts.
export const BODY_SHARD_FILES = Array.from({ length: 4 }, (_, index) => `data/bodies-${index}.json`);

function parsePayload(contents, path) {
  if (typeof contents !== "string") throw new Error(`body storage file is missing: ${path}`);
  let payload;
  try {
    payload = JSON.parse(contents);
  } catch {
    throw new Error(`invalid body storage JSON at ${path}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !payload.bodies || typeof payload.bodies !== "object" || Array.isArray(payload.bodies)
    || !Number.isSafeInteger(payload.count)
    || payload.count !== Object.keys(payload.bodies).length) {
    throw new Error(`invalid body storage payload at ${path}`);
  }
  const date = typeof payload.generatedAt === "string" ? Date.parse(payload.generatedAt) : NaN;
  if (!Number.isFinite(date) || new Date(date).toISOString() !== payload.generatedAt) {
    throw new Error(`invalid body storage generatedAt at ${path}`);
  }
  for (const [id, record] of Object.entries(payload.bodies)) {
    if (!id || !record || typeof record !== "object" || Array.isArray(record)
      || typeof record.bodyJa !== "string" || typeof record.bodyEn !== "string") {
      throw new Error(`invalid body storage record at ${path}:${id}`);
    }
  }
  return payload;
}

function shardForId(id) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(id, "utf8")) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0) % BODY_SHARD_FILES.length;
}

export function readBodyStorageSnapshot(index, legacyContent, shardContents) {
  if (shardContents.length !== BODY_SHARD_FILES.length) {
    throw new Error("body storage requires exactly four shard slots");
  }
  const legacy = parsePayload(legacyContent, "data/bodies.json");
  const present = shardContents.filter((content) => content !== null).length;
  const mode = index?.health?.bodyStorageMode;
  if (present === 0) {
    if (mode === "shards-v1" || index?.health?.bodyShardDigests !== undefined) {
      throw new Error("body shards required by the index are missing");
    }
    if (mode !== undefined && mode !== "legacy") throw new Error("invalid body storage mode in index");
    return { mode: "legacy", ...legacy };
  }
  if (present !== BODY_SHARD_FILES.length) {
    throw new Error(`incomplete body shard set: ${present}/${BODY_SHARD_FILES.length}`);
  }
  if (mode !== "shards-v1") throw new Error("body shard set is missing the matching index storage mode");
  const expected = index?.health?.bodyShardDigests;
  if (!Array.isArray(expected) || expected.length !== BODY_SHARD_FILES.length
    || expected.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("body shard digest inventory is missing or invalid");
  }
  const bodies = Object.create(null);
  let count = 0;
  let generatedAt = "";
  for (const [partIndex, path] of BODY_SHARD_FILES.entries()) {
    const contents = shardContents[partIndex];
    const actual = createHash("sha256").update(contents).digest("hex");
    if (actual !== expected[partIndex]) throw new Error(`body shard digest mismatch: ${path}`);
    const part = parsePayload(contents, path);
    if (part.generatedAt > generatedAt) generatedAt = part.generatedAt;
    count += part.count;
    for (const [id, record] of Object.entries(part.bodies)) {
      if (shardForId(id) !== partIndex || Object.hasOwn(bodies, id)) {
        throw new Error(`invalid body shard assignment or duplicate: ${id}`);
      }
      bodies[id] = record;
    }
  }
  return { mode: "shards-v1", generatedAt, count, bodies };
}

export function readBodyStorageFromDisk(root = ".") {
  const legacyContent = readFileSync(join(root, "data/bodies.json"), "utf8");
  const shardContents = BODY_SHARD_FILES.map((path) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null
  );
  const indexPath = join(root, "data/index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : null;
  return readBodyStorageSnapshot(index, legacyContent, shardContents);
}
