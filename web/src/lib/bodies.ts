/**
 * web/src/lib/bodies.ts
 *
 * Long-form bodies live in four ID-hash JSON shards after migration. Until
 * the first atomic Publisher migration, the frozen data/bodies.json supplies
 * the same article detail routes. A partial shard set fails the build.
 *
 * Bodies are generated separately (Phase B: a dedicated cloud worker using
 * opus-4.8). Entries without a body simply have no key here and the detail page
 * falls back to the summary-first "AI summary digest + read original" view.
 */
import bodiesJson from "../../../data/bodies.json";
import indexJson from "../../../data/index.json";
import {
  BODY_SHARD_PATHS,
  assertBodyStorageMode,
  loadBodyStorage,
} from "./body-shards.ts";
import { assertBodyShardDigests } from "./body-shard-integrity.ts";
import {
  hasMeaningfulSourceSnippet,
  type SourceSnippetInput,
} from "./source-snippet.ts";
import { isRealBodyRecord } from "./body-quality.ts";

export interface BodyRecord {
  bodyJa: string;
  bodyEn: string;
  /** Optional article chat; validated by article-chat.ts before rendering. */
  chat?: unknown;
  model?: string;
  generatedAt?: string;
}

export type ArticleBodyState = "ready" | "queued" | "summary-only";

const shardImports = import.meta.glob<string>("../../../data/bodies-*.json", {
  eager: true,
  query: "?raw",
  import: "default",
});
const shardPaths = new Set(BODY_SHARD_PATHS.map((path) => `../../../${path}`));
for (const path of Object.keys(shardImports)) {
  if (!shardPaths.has(path)) throw new Error(`unexpected body shard: ${path}`);
}
const shardContents = BODY_SHARD_PATHS.map((path) => shardImports[`../../../${path}`] ?? null);
const shardValues = shardContents.map((content, index) => {
  if (content === null) return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`invalid body storage JSON at ${BODY_SHARD_PATHS[index]}`);
  }
});
const { mode: BODIES_STORAGE_MODE, payload: data } = loadBodyStorage<BodyRecord>(
  bodiesJson,
  shardValues,
);
const index = indexJson as { health?: { bodyShardDigests?: unknown; bodyStorageMode?: unknown } };
assertBodyStorageMode(BODIES_STORAGE_MODE, index.health);
if (BODIES_STORAGE_MODE === "shards-v1") {
  assertBodyShardDigests(
    shardContents.map((content) => content!),
    index.health?.bodyShardDigests,
  );
}
export { BODIES_STORAGE_MODE };

export const BODIES: Readonly<Record<string, BodyRecord>> = data.bodies;
export const BODIES_GENERATED_AT = data.generatedAt;
export const BODIES_COUNT = data.count;

/** The minimum an entry must carry for its stored body to be renderable. */
export type BodySourceEntry = SourceSnippetInput & { id: string };

/**
 * Returns the real long-form body for an entry, or null when there is no
 * renderable body: missing, empty, legacy deterministic filler, OR generated
 * from a source that cannot support it.
 *
 * The record-shape rule lives in body-quality.ts, which imports no data
 * artifact, so route policy (detail-indexability.ts), unit tests, and the
 * Playwright publisher spec all apply the identical predicate without loading
 * the multi-megabyte data/bodies.json.
 *
 * The source-grounding rule is the load-bearing addition. 65 already-published
 * /e/ pages hold a body that was generated while the pipeline let a descriptive
 * TITLE alone stand in for source text; 53 of those entries have an entirely
 * empty contentSnippet, so the prose asserts facts no source supplied. The
 * pipeline now refuses to generate them and prunes the stored records, but that
 * needs a publisher run and this build does not - so the guard runs here too
 * and those pages stop rendering prose on the very next deploy.
 *
 * The ENTRY - not just its id - is required on purpose. A call site that only
 * had the id could render a body without ever presenting the source it is
 * supposed to be grounded in; making the source a required argument means the
 * type checker rejects that instead of silently skipping the guard.
 */
export function bodyForEntryIn(
  entry: BodySourceEntry,
  records: Readonly<Record<string, BodyRecord>>,
): BodyRecord | null {
  const record: BodyRecord | undefined = records[entry.id];
  if (!record || !isRealBodyRecord(record)) return null;
  if (!hasMeaningfulSourceSnippet(entry)) return null;
  return record;
}

export function bodyForEntry(entry: BodySourceEntry): BodyRecord | null {
  return bodyForEntryIn(entry, BODIES);
}

/**
 * "queued" promises the reader that a body is on its way. An entry without a
 * usable source excerpt is no longer enqueued at all, so claiming it is queued
 * would be false - and WORKER_HEALTH.bodyMergePendingIds can still carry such
 * an id from the last run before the change. Report summary-only for those.
 */
export function articleBodyState(
  entry: BodySourceEntry,
  body: BodyRecord | null,
  pendingIds: readonly string[] = [],
): ArticleBodyState {
  if (body) return "ready";
  if (!hasMeaningfulSourceSnippet(entry)) return "summary-only";
  return pendingIds.includes(entry.id) ? "queued" : "summary-only";
}

/** True when the entry has a real, renderable, source-grounded body. */
export function hasRealBody(entry: BodySourceEntry): boolean {
  return bodyForEntry(entry) !== null;
}
