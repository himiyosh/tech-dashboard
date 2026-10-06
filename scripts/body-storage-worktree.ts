import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BODY_SHARD_PATHS,
  BODY_TOTAL_TARGET_BYTES,
  LEGACY_BODY_PATH,
  assertBodyStorageMode,
  serializeBodyShards,
  type BodyStorageMode,
} from "../web/src/lib/body-shards.ts";
import { assertBodyShardDigests, bodyShardDigests } from "../web/src/lib/body-shard-integrity.ts";
import { readBodyStorage, serializeBodies, type BodiesPayload } from "../worker/src/bodies-file.ts";
import {
  LEGACY_BODY_BUDGET_TARGET_BYTES,
  bodyBudgetTarget,
  enforceBodiesBudget,
  enforceShardedBodiesBudget,
  type BodyBudgetPriorityInput,
  type EnforceBodiesBudgetResult,
} from "../worker/src/bodies-budget.ts";

export interface BodyStorageWorktree {
  mode: BodyStorageMode;
  payload: BodiesPayload;
  legacyContent: string | null;
  shardContents: Array<string | null>;
}

export function readBodyStorageWorktree(
  root: string,
  indexHealth: unknown,
): BodyStorageWorktree {
  const legacyPath = join(root, LEGACY_BODY_PATH);
  if (!existsSync(legacyPath)) throw new Error(`frozen legacy body file is missing: ${LEGACY_BODY_PATH}`);
  const legacyContent = readFileSync(legacyPath, "utf8");
  const shardContents = BODY_SHARD_PATHS.map((path) =>
    existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null
  );
  const { mode, payload } = readBodyStorage(legacyContent, shardContents);
  assertBodyStorageMode(mode, indexHealth);
  if (mode === "shards-v1") {
    const expected = indexHealth !== null && typeof indexHealth === "object"
      && "bodyShardDigests" in indexHealth
      ? indexHealth.bodyShardDigests
      : undefined;
    assertBodyShardDigests(shardContents.map((content) => content!), expected);
  }
  return { mode, payload, legacyContent, shardContents };
}

export function enforceWorktreeBodyBudget(
  storage: BodyStorageWorktree,
  payload: BodiesPayload,
  entries: readonly BodyBudgetPriorityInput[],
  targetOverride?: string,
): { targetBytes: number; result: EnforceBodiesBudgetResult } {
  const targetBytes = bodyBudgetTarget(
    targetOverride,
    storage.mode === "shards-v1" ? BODY_TOTAL_TARGET_BYTES : LEGACY_BODY_BUDGET_TARGET_BYTES,
  );
  return {
    targetBytes,
    result: storage.mode === "shards-v1"
      ? enforceShardedBodiesBudget(payload, entries, targetBytes)
      : enforceBodiesBudget(payload, entries, targetBytes),
  };
}

export function planBodyStorageWrites(
  root: string,
  storage: BodyStorageWorktree,
  payload: BodiesPayload,
): {
  writes: Array<{ path: string; value: BodiesPayload }>;
  fileBytes: number[];
  digests: string[];
} {
  if (storage.mode === "legacy") {
    const legacyPath = join(root, LEGACY_BODY_PATH);
    const existing = storage.legacyContent
      ? readBodyStorage(storage.legacyContent, [null, null, null, null]).payload
      : null;
    const changed = !existsSync(legacyPath) || !existing || !isDeepStrictEqual(
      { count: existing.count, bodies: existing.bodies },
      { count: payload.count, bodies: payload.bodies },
    );
    return {
      writes: changed ? [{ path: legacyPath, value: payload }] : [],
      fileBytes: [],
      digests: [],
    };
  }

  const writes: Array<{ path: string; value: BodiesPayload }> = [];
  const nextFiles = serializeBodyShards(payload);
  const actualContents = BODY_SHARD_PATHS.map((path, index) => {
    const next = nextFiles[index]!.content;
    const old = storage.shardContents[index];
    const nextPayload = JSON.parse(next) as BodiesPayload;
    if (old !== null) {
      const oldPayload = JSON.parse(old) as BodiesPayload;
      if (isDeepStrictEqual(
        { count: oldPayload.count, bodies: oldPayload.bodies },
        { count: nextPayload.count, bodies: nextPayload.bodies },
      )) return old;
    }
    writes.push({ path: join(root, path), value: nextPayload });
    return next;
  });
  return {
    writes,
    fileBytes: actualContents.map((content) => Buffer.byteLength(content)),
    digests: bodyShardDigests(actualContents),
  };
}
