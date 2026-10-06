import { createHash } from "node:crypto";
import { BODY_SHARD_PATHS } from "./body-shards.ts";

/** The index records hashes of the exact committed shard files at its SHA. */
export function bodyShardDigests(contents: readonly string[]): string[] {
  if (contents.length !== BODY_SHARD_PATHS.length) {
    throw new Error("body shard digest inventory must contain four files");
  }
  return contents.map((content) => createHash("sha256").update(content, "utf8").digest("hex"));
}

export function assertBodyShardDigests(
  contents: readonly string[],
  expected: unknown,
): void {
  if (!Array.isArray(expected) || expected.length !== BODY_SHARD_PATHS.length
    || expected.some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) {
    throw new Error("body shard digest inventory is missing or invalid");
  }
  const actual = bodyShardDigests(contents);
  for (const [index, digest] of actual.entries()) {
    if (digest !== expected[index]) {
      throw new Error(`body shard digest mismatch: ${BODY_SHARD_PATHS[index]}`);
    }
  }
}
