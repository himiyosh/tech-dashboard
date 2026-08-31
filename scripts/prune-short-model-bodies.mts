/**
 * prune-short-model-bodies.mts — one-off migration for the short gpt-5.6 corpus.
 *
 * The scaled length band (worker/src/body-generate.ts bodyLengthPlan) asks for
 * prose proportional to the collected excerpt. gpt-5.6 follows the band
 * literally, so while the collector capped excerpts at 280 chars the bodies it
 * generated landed at ~330 JA chars (opus-4.8's ~900-char corpus predates the
 * band). With the collector cap raised to 900 (harness/pipeline/normalize.ts)
 * the honest fix for those records is regeneration: delete them so needsBody
 * (worker/src/body-queue.ts) re-enqueues each one, and the hourly pipeline
 * rebuilds it from the richer excerpt. Entries whose feed item has aged out
 * keep a 280-char excerpt and regenerate to a similar honest length once —
 * needsBody sees the new record and never loops.
 *
 * Prune criterion: record.model starts with MODEL_PREFIX (default "gpt-5.6")
 * AND bodyJa is shorter than MIN_JA_CHARS (default 450 — below the 540 floor
 * of the full band, above every legacy opus record, min 539).
 *
 * data/index.json health (bodiesTotal / bodyBacklog / budget fields) is
 * derived from bodies.json, so it is resynchronized in the SAME transaction —
 * a bodies-only commit would fail tests/data-schema.test.ts.
 *
 * Usage:
 *   npx tsx scripts/prune-short-model-bodies.mts            # dry-run report
 *   npx tsx scripts/prune-short-model-bodies.mts --apply    # write files
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import {
  DEFAULT_BODY_RETENTION_DAYS,
  isBodyRetentionEligible,
  needsBody,
} from "../worker/src/body-queue.ts";
import {
  DEFAULT_BODY_BUDGET_TARGET_BYTES,
  carryForwardBudgetEvictedIds,
  enforceBodiesBudget,
} from "../worker/src/bodies-budget.ts";
import type { NormalizedEntry } from "../harness/types.ts";
// Same shared journal as rescore-release-importance.ts / clean-source-noise.mjs:
// every rewriter of the data/ artifacts must be mutually exclusive.
import {
  DATA_ARTIFACT_JOURNAL_PATH,
  synchronizeBodyHealth,
  validateBodiesPayload,
  writeJsonTransaction,
} from "./clean-source-noise.mjs";

const MODEL_PREFIX = "gpt-5.6";
const MIN_JA_CHARS = 450;

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";
if (args.length > 0 && !apply) {
  console.error(
    "Usage: npx tsx scripts/prune-short-model-bodies.mts [--apply]\n" +
      `Unrecognized arguments: ${args.join(" ")} (nothing was modified)`,
  );
  process.exit(1);
}

function fail(message: string): never {
  console.error(`ERR: ${message} (nothing was modified)`);
  process.exit(1);
}

const root = process.cwd();
const dataDir = join(root, "data");
const indexPath = join(dataDir, "index.json");
const bodiesPath = join(dataDir, "bodies.json");
if (!existsSync(indexPath) || !existsSync(bodiesPath)) {
  fail("data/index.json and data/bodies.json are required");
}

const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
  generatedAt?: unknown;
  entries?: Array<Record<string, unknown> & { id: string }>;
  health?: Record<string, unknown>;
};
if (typeof index.generatedAt !== "string" || !Array.isArray(index.entries)) {
  fail("data/index.json must carry generatedAt and entries");
}
const liveEntries = index.entries;
const referenceMs = Date.parse(index.generatedAt);
if (!Number.isFinite(referenceMs)) fail("data/index.json generatedAt is not a date");

const storedBodies = validateBodiesPayload(
  JSON.parse(readFileSync(bodiesPath, "utf8")),
) as {
  generatedAt: string;
  count: number;
  bodies: Record<string, { bodyJa?: unknown; model?: unknown }>;
};

// ----------------------------------------------------------------- prune ---
const prunedIds: string[] = [];
const keptBodies: Record<string, unknown> = {};
for (const [id, record] of Object.entries(storedBodies.bodies)) {
  const model = typeof record.model === "string" ? record.model : "";
  const bodyJa = typeof record.bodyJa === "string" ? record.bodyJa : "";
  if (model.startsWith(MODEL_PREFIX) && bodyJa.length < MIN_JA_CHARS) {
    prunedIds.push(id);
    continue;
  }
  keptBodies[id] = record;
}
console.log(
  `short ${MODEL_PREFIX} bodies (< ${MIN_JA_CHARS} JA chars): ${prunedIds.length} of ${storedBodies.count}`,
);

// -------------------------------------------- reconcile derived artifacts --
const retentionEntries = liveEntries.filter((entry) =>
  isBodyRetentionEligible(
    entry as Pick<NormalizedEntry, "evergreen" | "importance" | "publishedAt" | "collectedAt">,
    referenceMs,
    DEFAULT_BODY_RETENTION_DAYS,
  )
);
const retentionIds = new Set(retentionEntries.map((entry) => entry.id));
const retainedBodies: Record<string, unknown> = {};
for (const [id, record] of Object.entries(keptBodies)) {
  if (retentionIds.has(id)) retainedBodies[id] = record;
}

const budgetTargetBytes = Math.max(
  1,
  Number(process.env.BODY_BUDGET_TARGET_BYTES ?? DEFAULT_BODY_BUDGET_TARGET_BYTES),
);
const budget = enforceBodiesBudget(
  {
    generatedAt: storedBodies.generatedAt,
    count: Object.keys(retainedBodies).length,
    bodies: retainedBodies,
  } as Parameters<typeof enforceBodiesBudget>[0],
  retentionEntries as unknown as Parameters<typeof enforceBodiesBudget>[1],
  budgetTargetBytes,
);
const nextBodies = budget.payload;
const bodyPresentIds = new Set(Object.keys(nextBodies.bodies));
const bodyBacklog = retentionEntries.filter((entry) =>
  needsBody(entry as unknown as NormalizedEntry, bodyPresentIds)
).length;

const previousEvictedIds = Array.isArray(index.health?.bodyBudgetEvictedIds)
  ? (index.health.bodyBudgetEvictedIds as unknown[]).filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  )
  : [];
const evictedIds = carryForwardBudgetEvictedIds(
  previousEvictedIds,
  retentionEntries as unknown as Parameters<typeof carryForwardBudgetEvictedIds>[1],
  bodyPresentIds,
  budget.prunedIds,
);
const nextHealth = synchronizeBodyHealth(
  index.health,
  retentionEntries.length,
  nextBodies.count,
  bodyBacklog,
  {
    targetBytes: budgetTargetBytes,
    bytes: budget.bytes,
    pruned: budget.prunedIds.length,
    evictedIds,
  },
);
const nextIndex = { ...index, health: nextHealth };

console.log(
  `derived: bodies retained=${nextBodies.count}, bytes=${budget.bytes}/${budgetTargetBytes},`
  + ` retentionEligible=${retentionEntries.length}, backlog=${bodyBacklog},`
  + ` budgetEvictedIds=${evictedIds.length} (carried in=${previousEvictedIds.length})`,
);

const writes: { path: string; value: unknown }[] = [];
if (storedBodies.count !== nextBodies.count || prunedIds.length > 0) {
  writes.push({ path: bodiesPath, value: nextBodies });
}
if (!isDeepStrictEqual(index.health, nextHealth)) {
  writes.push({ path: indexPath, value: nextIndex });
}
if (writes.length === 0) {
  console.log("Nothing to write: data is already consistent.");
  process.exit(0);
}
console.log(`files to write: ${writes.map((write) => write.path.slice(root.length + 1)).join(", ")}`);
if (!apply) {
  console.log("Re-run with --apply to write the files.");
  process.exit(0);
}
writeJsonTransaction(writes, { journalPath: DATA_ARTIFACT_JOURNAL_PATH });
console.log(`APPLIED: wrote ${writes.length} file(s) in one transaction.`);
