/**
 * backfill-bodies.mjs — populate `bodyJa` for entries that lack it.
 *
 * Usage:
 *   COPILOT_PAT=ghp_... SUMMARIZE_MAX_NEW=50 node scripts/backfill-bodies.mjs
 *
 * Re-runs the harness summarize pipeline. The pipeline detects cache entries
 * missing `bodyJa` and re-summarizes them (so existing entries get filled in).
 *
 * Tip: do batches of 25-50 to stay within Copilot rate limits and to commit
 * incremental progress.
 */
import fs from "node:fs";
import { summarize } from "../harness/pipeline/summarize.ts";

const INDEX = "data/index.json";
const idx = JSON.parse(fs.readFileSync(INDEX, "utf8"));

const before = idx.entries.length;
const missingBody = idx.entries.filter((e) => !(e.bodyJa || "").trim()).length;
console.log(`[backfill-bodies] total=${before} missing-body=${missingBody}`);

const { entries, stats } = await summarize(idx.entries, "data");
console.log("[backfill-bodies] stats", stats);

idx.entries = entries;
idx.generatedAt = new Date().toISOString();
fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + "\n");

const after = idx.entries.filter((e) => !(e.bodyJa || "").trim()).length;
console.log(`[backfill-bodies] missing-body: ${missingBody} -> ${after}`);
