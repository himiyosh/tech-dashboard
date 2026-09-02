/**
 * reconcile-content-quality.mts — one-off data reconciliation for the site
 * audit's content-quality findings. Dry-run by default; `--apply` writes.
 *
 * What it does (each step is idempotent):
 *   1. Japanese originals keep their headline: for lang=ja live entries,
 *      titleJa := title (whitespace-normalized). The summarizer used to rewrite
 *      an author's Japanese title (113 live entries); the prompt and
 *      applyHeadlinePolicy (worker/src/index.ts) now forbid it, this fixes the
 *      stored corpus.
 *   2. Contaminated summaries regenerate: a summaryJa/summaryEn that carries
 *      feed or git chrome ("Co-authored-by:", "Read the full article", …) or
 *      a foreign script (Hangul in a Japanese title) is cleared to "" so the
 *      pipeline's pending fallback takes over and the summarizer re-queues it.
 *      A foreign-script titleJa falls back to the original title.
 *   3. Bodies that cannot be trusted are pruned so the hourly pipeline
 *      regenerates them under the new prompts: bodies whose entry no longer
 *      passes hasSufficientBodySourceGrounding (feed boilerplate was the only
 *      "excerpt"), and bodies whose prose cites the generation inputs
 *      ("抜粋", "収集元", "既存の英語要約", "記事のタグ", "excerpt", "existing summary").
 *
 * data/index.json health (bodiesTotal / bodyBacklog / budget fields) is
 * resynchronized in the SAME transaction, as in prune-short-model-bodies.mts.
 *
 * Usage:
 *   npx tsx scripts/reconcile-content-quality.mts            # dry-run report
 *   npx tsx scripts/reconcile-content-quality.mts --apply    # write files
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { hasSufficientBodySourceGrounding } from "../harness/pipeline/source-grounding.ts";
import {
  hasForeignScriptContamination,
  isContaminatedSummaryText,
} from "../harness/pipeline/summary-quality.ts";
import { buildFallbackSummary } from "../worker/src/content-fallback.ts";
import type { NormalizedEntry } from "../harness/types.ts";
import {
  DATA_ARTIFACT_JOURNAL_PATH,
  synchronizeBodyHealth,
  validateBodiesPayload,
  writeJsonTransaction,
} from "./clean-source-noise.mjs";

const PROVENANCE_RE =
  /抜粋|収集元|既存の(?:日本語|英語)?要約|記事のタグ|記事情報|収集時のメタデータ|\bthe excerpt\b|\bexisting (?:english )?summary\b|\bcollected context\b|\bthe tags\b/iu;

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";
if (args.length > 0 && !apply) {
  console.error(
    "Usage: npx tsx scripts/reconcile-content-quality.mts [--apply]\n" +
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

type LiveEntry = Record<string, unknown> & {
  id: string;
  title?: string;
  titleJa?: string;
  titleEn?: string;
  summaryJa?: string;
  summaryEn?: string;
  contentSnippet?: string;
  lang?: string;
};

const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
  generatedAt?: unknown;
  entries?: LiveEntry[];
  health?: Record<string, unknown>;
};
if (typeof index.generatedAt !== "string" || !Array.isArray(index.entries)) {
  fail("data/index.json must carry generatedAt and entries");
}
const referenceMs = Date.parse(index.generatedAt);
if (!Number.isFinite(referenceMs)) fail("data/index.json generatedAt is not a date");

const storedBodies = validateBodiesPayload(
  JSON.parse(readFileSync(bodiesPath, "utf8")),
) as {
  generatedAt: string;
  count: number;
  bodies: Record<string, { bodyJa?: unknown; bodyEn?: unknown }>;
};

// ------------------------------------------------------- 1. headlines ----
let titleJaRestored = 0;
let summariesCleared = 0;
let titleJaFallbacks = 0;
const liveEntries = index.entries.map((entry) => {
  const next: LiveEntry = { ...entry };
  const original = (entry.title ?? "").replace(/\s+/g, " ").trim();
  if (entry.lang === "ja" && original && (entry.titleJa ?? "") !== original) {
    next.titleJa = original;
    titleJaRestored += 1;
  }
  // -------------------------------------------- 2. contaminated summaries
  const badJa = isContaminatedSummaryText(entry.summaryJa);
  const badEn = isContaminatedSummaryText(entry.summaryEn);
  const emptyPair = !(entry.summaryJa ?? "").trim() || !(entry.summaryEn ?? "").trim();
  if (badJa || badEn || emptyPair) {
    // The deterministic pending fallback is what the publisher writes before
    // publishing; needsSummaryGeneration treats it as "regenerate", and the
    // data-schema contract requires both summary slots to be non-empty.
    const fallback = buildFallbackSummary({ ...entry, ...next } as never);
    next.summaryJa = fallback.summaryJa;
    next.summaryEn = fallback.summaryEn;
    if (badJa || badEn) summariesCleared += 1;
  }
  if (hasForeignScriptContamination(next.titleJa)) {
    next.titleJa = entry.lang === "ja" ? original : "";
    titleJaFallbacks += 1;
  }
  return next;
});
const liveById = new Map(liveEntries.map((entry) => [entry.id, entry]));

// -------------------------------------------------------- 3. bodies -------
const prunedGrounding: string[] = [];
const prunedProvenance: string[] = [];
const keptBodies: Record<string, unknown> = {};
for (const [id, record] of Object.entries(storedBodies.bodies)) {
  const entry = liveById.get(id);
  const bodyJa = typeof record.bodyJa === "string" ? record.bodyJa : "";
  const bodyEn = typeof record.bodyEn === "string" ? record.bodyEn : "";
  if (entry && !hasSufficientBodySourceGrounding(entry as never)) {
    prunedGrounding.push(id);
    continue;
  }
  if (PROVENANCE_RE.test(bodyJa) || PROVENANCE_RE.test(bodyEn)) {
    prunedProvenance.push(id);
    continue;
  }
  keptBodies[id] = record;
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
const entriesChanged = liveEntries.some((entry, i) => !isDeepStrictEqual(entry, index.entries![i]));
const nextIndex = { ...index, entries: liveEntries, health: nextHealth };

console.log(
  `headlines: titleJa restored for ${titleJaRestored} Japanese originals, ${titleJaFallbacks} foreign-script titles reset;`
  + ` summaries cleared for regeneration: ${summariesCleared}`,
);
console.log(
  `bodies: pruned ${prunedGrounding.length} grounded on feed boilerplate, ${prunedProvenance.length} citing generation inputs;`
  + ` retained=${nextBodies.count} of ${storedBodies.count}, bytes=${budget.bytes}/${budgetTargetBytes}, backlog=${bodyBacklog}`,
);

const writes: { path: string; value: unknown }[] = [];
if (entriesChanged || !isDeepStrictEqual(index.health, nextHealth)) {
  writes.push({ path: indexPath, value: nextIndex });
}
if (storedBodies.count !== nextBodies.count || prunedGrounding.length + prunedProvenance.length > 0 || budget.changed) {
  writes.push({ path: bodiesPath, value: nextBodies });
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
