/**
 * JSON-only body storage contract shared by the static Web build and the
 * Node Publisher. Keep this module independent of data imports and browser APIs.
 */
export const LEGACY_BODY_PATH = "data/bodies.json";
export const BODY_SHARD_PATHS = [
  "data/bodies-0.json",
  "data/bodies-1.json",
  "data/bodies-2.json",
  "data/bodies-3.json",
] as const;

export const BODY_TOTAL_TARGET_BYTES = 18_000_000;
export const BODY_TOTAL_HARD_BYTES = 20_000_000;
export const BODY_SHARD_TARGET_BYTES = 9_000_000;
export const BODY_SHARD_HARD_BYTES = 10_000_000;

export interface BodyStoragePayload<T> {
  generatedAt: string;
  count: number;
  bodies: Record<string, T>;
}

export type BodyStorageMode = "legacy" | "shards-v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Once the index declares shards, losing all four files must not revive frozen prose. */
export function assertBodyStorageMode(mode: BodyStorageMode, health: unknown): void {
  const storedMode = isRecord(health) ? health.bodyStorageMode : undefined;
  const digests = isRecord(health) ? health.bodyShardDigests : undefined;
  if (mode === "shards-v1") {
    if (storedMode !== "shards-v1") {
      throw new Error("body shard set is missing the matching index storage mode");
    }
  } else if (storedMode === "shards-v1" || digests !== undefined) {
    throw new Error("body shards required by the index are missing");
  } else if (storedMode !== undefined && storedMode !== "legacy") {
    throw new Error("invalid body storage mode in index");
  }
}

export function assertBodyStoragePayload<T>(
  value: unknown,
  path: string,
): BodyStoragePayload<T> {
  if (!isRecord(value) || !isRecord(value.bodies)) {
    throw new Error(`invalid body storage payload: ${path}`);
  }
  const date = typeof value.generatedAt === "string" ? Date.parse(value.generatedAt) : NaN;
  if (!Number.isFinite(date) || new Date(date).toISOString() !== value.generatedAt) {
    throw new Error(`invalid body storage generatedAt: ${path}`);
  }
  const ids = Object.keys(value.bodies);
  if (!Number.isSafeInteger(value.count) || value.count !== ids.length) {
    throw new Error(`invalid body storage count: ${path}`);
  }
  for (const id of ids) {
    const record = value.bodies[id];
    if (!id || !isRecord(record)
      || typeof record.bodyJa !== "string" || typeof record.bodyEn !== "string") {
      throw new Error(`invalid body storage record: ${path}:${id}`);
    }
  }
  return value as unknown as BodyStoragePayload<T>;
}

/** FNV-1a over the UTF-8 bytes of the article ID; unchanged IDs never move. */
export function bodyShardIndex(id: string): number {
  if (!id) throw new Error("body shard requires a non-empty article ID");
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return (hash >>> 0) % BODY_SHARD_PATHS.length;
}

export function splitBodyShards<T>(
  payload: BodyStoragePayload<T>,
): BodyStoragePayload<T>[] {
  assertBodyStoragePayload<T>(payload, "combined bodies");
  const shards = BODY_SHARD_PATHS.map(() => ({
    generatedAt: payload.generatedAt,
    count: 0,
    bodies: Object.create(null) as Record<string, T>,
  }));
  for (const [id, record] of Object.entries(payload.bodies)) {
    const shard = shards[bodyShardIndex(id)]!;
    shard.bodies[id] = record;
    shard.count += 1;
  }
  return shards;
}

export function combineBodyShards<T>(
  values: readonly unknown[],
): BodyStoragePayload<T> {
  if (values.length !== BODY_SHARD_PATHS.length) {
    throw new Error("body storage requires exactly four shards");
  }
  const bodies: Record<string, T> = Object.create(null);
  let generatedAt = "";
  let count = 0;
  for (const [index, value] of values.entries()) {
    const shard = assertBodyStoragePayload<T>(value, BODY_SHARD_PATHS[index]!);
    if (shard.generatedAt > generatedAt) generatedAt = shard.generatedAt;
    count += shard.count;
    for (const [id, record] of Object.entries(shard.bodies)) {
      if (bodyShardIndex(id) !== index || Object.hasOwn(bodies, id)) {
        throw new Error(`invalid body shard assignment or duplicate: ${id}`);
      }
      bodies[id] = record;
    }
  }
  return { generatedAt, count, bodies };
}

export function loadBodyStorage<T>(
  legacy: unknown,
  shards: readonly unknown[],
): { mode: BodyStorageMode; payload: BodyStoragePayload<T> } {
  if (shards.length !== BODY_SHARD_PATHS.length) {
    throw new Error("body storage requires exactly four shard slots");
  }
  const present = shards.filter((value) => value !== null && value !== undefined).length;
  if (present === 0) {
    return {
      mode: "legacy",
      payload: assertBodyStoragePayload<T>(legacy, LEGACY_BODY_PATH),
    };
  }
  if (present !== BODY_SHARD_PATHS.length) {
    throw new Error(`incomplete body shard set: ${present}/${BODY_SHARD_PATHS.length}`);
  }
  return { mode: "shards-v1", payload: combineBodyShards<T>(shards) };
}

export function serializeBodyShards<T>(
  payload: BodyStoragePayload<T>,
): Array<{ path: string; content: string }> {
  return splitBodyShards(payload).map((shard, index) => ({
    path: BODY_SHARD_PATHS[index]!,
    content: `${JSON.stringify(shard, null, 2)}\n`,
  }));
}
