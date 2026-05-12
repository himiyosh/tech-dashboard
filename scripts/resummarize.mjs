/**
 * resummarize.mjs — run the summarize pipeline against existing data/index.json
 * without re-collecting. Picks entries lacking summaryJa, calls Copilot, and
 * writes back.
 *
 * Env: COPILOT_PAT (or COPILOT_TOKEN). SUMMARIZE_MAX_NEW caps per run.
 */
import fs from "node:fs";
import { summarize } from "../harness/pipeline/summarize.ts";

const INDEX = "data/index.json";
const idx = JSON.parse(fs.readFileSync(INDEX, "utf8"));

const before = idx.entries.length;
const missingSummary = idx.entries.filter((entry) => !(entry.summaryJa || "").trim()).length;
const missingBody = idx.entries.filter(
	(entry) => !(entry.bodyJa || "").trim() && !(entry.bodyEn || "").trim(),
).length;
console.log(`[resummarize] total=${before} missing-ja=${missingSummary} missing-body=${missingBody}`);

const { entries, stats } = await summarize(idx.entries, "data");
console.log("[resummarize] stats", stats);

idx.entries = entries;
idx.generatedAt = new Date().toISOString();
fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + "\n");

const afterSummary = idx.entries.filter((entry) => !(entry.summaryJa || "").trim()).length;
const afterBody = idx.entries.filter(
	(entry) => !(entry.bodyJa || "").trim() && !(entry.bodyEn || "").trim(),
).length;
console.log(`[resummarize] missing-ja: ${missingSummary} -> ${afterSummary}`);
console.log(`[resummarize] missing-body: ${missingBody} -> ${afterBody}`);
