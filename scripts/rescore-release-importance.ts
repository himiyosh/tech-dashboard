/**
 * scripts/rescore-release-importance.ts
 *
 * One-time migration companion to the release-signal importance fix
 * (web/src/lib/release-signal.ts + harness/pipeline/normalize.ts).
 *
 * The collector's previous major-keyword list contained the substrings
 * "v1." / "v2." / "v3.", so routine patch tags ("Cline CLI v3.0.58",
 * "Zed Editor Releases v1.16.2") were stored with importance 3, and the
 * Worker's preserveImportance restamp keeps that inflated value forever.
 * This script re-scores stored release/changelog entries with the corrected
 * classifier and only ever LOWERS importance (min(stored, rescored)), so an
 * AI-upgraded non-release entry or a legitimately major release is never
 * demoted below the deterministic score.
 *
 * Scope: data/index.json and every data/archive/YYYY-MM.json.
 *
 * DERIVED ARTIFACTS (why this script writes more than the two above):
 * `importance` is an INPUT to two other committed artifacts, so rewriting it
 * alone leaves the data set internally inconsistent and fails
 * tests/data-schema.test.ts (which `ci.yml`'s `npm test` runs with no path
 * filter, and `scripts/git-hooks/pre-push` runs before every push):
 *   1. data/bodies.json - isBodyRetentionEligible() keeps a body when the
 *      entry is evergreen OR importance >= 2 OR published within the
 *      retention window. Demoting importance to 1 can therefore strip an
 *      entry's retention eligibility, and its body must be pruned in the same
 *      change or bodies.json retains a body the contract forbids.
 *   2. data/index.json's `health` body telemetry (bodiesTotal /
 *      bodyRetentionEligible / bodyBacklog / bodyQueueDrainEstimateHours /
 *      bodyBudget*) - all recomputed from the pruned bodies payload.
 *   3. data/stats.json - byImportance is a direct roll-up of the same field.
 * So the reconciliation below is not extra scope: it is what makes the
 * importance rewrite a single atomic, committable change.
 *
 * The reconciliation deliberately reuses the SAME helpers the Publisher
 * runtime and tests/data-schema.test.ts use (isBodyRetentionEligible,
 * needsBody, enforceBodiesBudget, carryForwardBudgetEvictedIds,
 * buildStatsPayloadFromArtifacts, synchronizeBodyHealth) instead of
 * reimplementing the rules, so this script cannot drift from the contract it
 * has to satisfy.
 *
 * Usage:
 *   npx tsx scripts/rescore-release-importance.ts            # dry-run report
 *   npx tsx scripts/rescore-release-importance.ts --apply    # write files
 *
 * Fail-closed argument parsing: anything other than no-args or exactly
 * "--apply" prints usage and exits non-zero without touching data.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { classifyReleaseTitleSignal } from "../web/src/lib/release-signal.ts";
import { buildStatsPayloadFromArtifacts } from "../harness/publishers/stats-core.ts";
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
// The data-artifact write transaction (journal + lock) is owned by
// clean-source-noise.mjs. Reusing its journal path is intentional: both
// scripts rewrite the same data/ artifacts, so they must be mutually
// exclusive rather than each holding a private lock.
import {
  DATA_ARTIFACT_JOURNAL_PATH,
  synchronizeBodyHealth,
  validateBodiesPayload,
  writeJsonTransaction,
} from "./clean-source-noise.mjs";

type Importance = 1 | 2 | 3;

interface StoredEntry {
  id: string;
  sourceType?: string;
  title?: string;
  titleEn?: string;
  titleJa?: string;
  importance?: Importance;
  evergreen?: boolean;
  publishedAt?: string | null;
  collectedAt?: string;
  url?: string;
  source?: string;
  category?: string;
}

interface IndexPayload {
  generatedAt?: unknown;
  entries?: StoredEntry[];
  health?: Record<string, unknown>;
}

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";
if (args.length > 0 && !apply) {
  console.error(
    "Usage: npx tsx scripts/rescore-release-importance.ts [--apply]\n" +
      `Unrecognized arguments: ${args.join(" ")} (nothing was modified)`,
  );
  process.exit(1);
}

function fail(message: string): never {
  console.error(`ERR: ${message} (nothing was modified)`);
  process.exit(1);
}

function rescoredImportance(entry: StoredEntry): Importance | null {
  if (entry.sourceType !== "release" && entry.sourceType !== "changelog") {
    return null;
  }
  const titles = [entry.title, entry.titleEn, entry.titleJa].filter(
    (title): title is string => !!title,
  );
  if (titles.length === 0) return null;
  const signals = titles.map(classifyReleaseTitleSignal);
  if (signals.some((s) => s === "low" || s === "patch")) return 1;
  if (signals.some((s) => s === "minor")) return 2;
  return null; // major / descriptive titles keep their stored importance
}

/** Demotes in place and returns how many entries changed. */
function rescoreEntries(entries: readonly StoredEntry[]): number {
  let changed = 0;
  for (const entry of entries) {
    const stored = entry.importance;
    if (stored !== 1 && stored !== 2 && stored !== 3) continue;
    const rescored = rescoredImportance(entry);
    if (rescored === null || rescored >= stored) continue;
    entry.importance = rescored;
    changed++;
  }
  return changed;
}

/**
 * buildStatsPayloadFromArtifacts reads publishedAt/collectedAt, category,
 * source and url straight off the stored entry, while
 * tests/data-schema.test.ts feeds it entries passed through its own
 * `asNormalizedEntry` coercion. Those two agree only while every entry
 * actually carries these fields. Assert that instead of silently emitting a
 * stats payload the test would then reject.
 */
function assertStatsInputs(entries: readonly StoredEntry[], label: string): void {
  for (const [position, entry] of entries.entries()) {
    const where = `${label}.entries[${position}]`;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      fail(`${where}.id must be a non-empty string`);
    }
    if (typeof entry.url !== "string") fail(`${where}.url must be a string`);
    if (typeof entry.source !== "string") fail(`${where}.source must be a string`);
    if (typeof entry.category !== "string") fail(`${where}.category must be a string`);
    if (typeof entry.publishedAt !== "string" && typeof entry.collectedAt !== "string") {
      fail(`${where} must carry publishedAt or collectedAt`);
    }
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`${label} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = process.cwd();
const dataDir = join(root, "data");
const indexPath = join(dataDir, "index.json");
const bodiesPath = join(dataDir, "bodies.json");
const statsPath = join(dataDir, "stats.json");
const archiveDir = join(dataDir, "archive");

// ---------------------------------------------------------------- load ----
const index = readJson(indexPath, "data/index.json") as IndexPayload;
if (!Array.isArray(index.entries)) fail("data/index.json.entries must be an array");
if (typeof index.generatedAt !== "string" || !Number.isFinite(Date.parse(index.generatedAt))) {
  fail("data/index.json.generatedAt must be an ISO timestamp");
}
const liveEntries = index.entries;
const referenceMs = Date.parse(index.generatedAt);

const archiveFiles = existsSync(archiveDir)
  ? readdirSync(archiveDir)
    .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
    .sort()
  : [];
const archives = archiveFiles.map((name) => {
  const path = join(archiveDir, name);
  const payload = readJson(path, `data/archive/${name}`) as { entries?: StoredEntry[] };
  if (!Array.isArray(payload.entries)) fail(`data/archive/${name}.entries must be an array`);
  return { name, path, payload, entries: payload.entries };
});

assertStatsInputs(liveEntries, "data/index.json");
for (const archive of archives) {
  assertStatsInputs(archive.entries, `data/archive/${archive.name}`);
}

// ------------------------------------------------------------- rescore ----
const perFile: { label: string; changed: number; total: number }[] = [];
const liveChanged = rescoreEntries(liveEntries);
perFile.push({ label: "data/index.json", changed: liveChanged, total: liveEntries.length });
let totalChanged = liveChanged;
for (const archive of archives) {
  const changed = rescoreEntries(archive.entries);
  totalChanged += changed;
  perFile.push({
    label: `data/archive/${archive.name}`,
    changed,
    total: archive.entries.length,
  });
}

// -------------------------------------------- reconcile derived artifacts --
const retentionEntries = liveEntries.filter((entry) =>
  isBodyRetentionEligible(
    entry as Pick<NormalizedEntry, "evergreen" | "importance" | "publishedAt" | "collectedAt">,
    referenceMs,
    DEFAULT_BODY_RETENTION_DAYS,
  )
);
const retentionIds = new Set(retentionEntries.map((entry) => entry.id));

const bodiesExisted = existsSync(bodiesPath);
const storedBodies = validateBodiesPayload(
  bodiesExisted
    ? readJson(bodiesPath, "data/bodies.json")
    : { generatedAt: index.generatedAt, count: 0, bodies: {} },
) as { generatedAt: string; count: number; bodies: Record<string, unknown> };

// A demoted entry can lose retention eligibility; its body must go with it.
const retainedBodies: Record<string, unknown> = {};
const retentionPrunedIds: string[] = [];
for (const [id, record] of Object.entries(storedBodies.bodies)) {
  if (retentionIds.has(id)) retainedBodies[id] = record;
  else retentionPrunedIds.push(id);
}

// Same byte-budget enforcement as the Publisher runtime. Pruning by retention
// only shrinks the payload, so this is normally a no-op here -- it is kept so
// the script cannot leave bodies.json over target if the input already was.
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
const nextIndex = { ...index, entries: liveEntries, health: nextHealth };

// stats.generatedAt is preserved: it is the aggregation reference (day-bucket
// retention cutoff), and tests/data-schema.test.ts rebuilds with the STORED
// generatedAt. Re-stamping it here would silently move the cutoff.
const storedStats = readJson(statsPath, "data/stats.json") as { generatedAt?: unknown };
if (typeof storedStats.generatedAt !== "string") {
  fail("data/stats.json.generatedAt must be a string");
}
const nextStats = buildStatsPayloadFromArtifacts(
  liveEntries as unknown as NormalizedEntry[],
  archives.flatMap((archive) => archive.entries) as unknown as NormalizedEntry[],
  storedStats.generatedAt,
);

// --------------------------------------------------------------- report ----
for (const file of perFile) {
  if (file.changed > 0) {
    console.log(`${file.label}: demoted ${file.changed} of ${file.total} entries`);
  }
}
console.log(
  `${apply ? "APPLIED" : "DRY-RUN"}: ${totalChanged} release/changelog entries would be demoted to their deterministic score`,
);
console.log(
  `derived: bodies retention-pruned=${retentionPrunedIds.length}, budget-pruned=${budget.prunedIds.length},`
  + ` bodies retained=${nextBodies.count}, bytes=${budget.bytes}/${budgetTargetBytes},`
  + ` retentionEligible=${retentionEntries.length}, backlog=${bodyBacklog},`
  + ` budgetEvictedIds=${evictedIds.length} (carried in=${previousEvictedIds.length})`,
);

const writes: { path: string; value: unknown }[] = [];
if (liveChanged > 0 || !isDeepStrictEqual(index.health, nextHealth)) {
  writes.push({ path: indexPath, value: nextIndex });
}
for (const archive of archives) {
  const entry = perFile.find((file) => file.label === `data/archive/${archive.name}`);
  if ((entry?.changed ?? 0) > 0) writes.push({ path: archive.path, value: archive.payload });
}
if (!bodiesExisted || retentionPrunedIds.length > 0 || budget.changed
  || storedBodies.count !== nextBodies.count) {
  writes.push({ path: bodiesPath, value: nextBodies });
}
if (!isDeepStrictEqual(storedStats, nextStats)) {
  writes.push({ path: statsPath, value: nextStats });
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

// One transaction so index/archives/bodies/stats can never land partially:
// a half-applied set is exactly the inconsistent state this script exists to
// avoid producing.
writeJsonTransaction(writes, { journalPath: DATA_ARTIFACT_JOURNAL_PATH });
console.log(`APPLIED: wrote ${writes.length} file(s) in one transaction.`);
