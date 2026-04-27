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
const missing = idx.entries.filter((e) => !(e.summaryJa || "").trim()).length;
console.log(`[resummarize] total=${before} missing-ja=${missing}`);

const { entries, stats } = await summarize(idx.entries, "data");
console.log("[resummarize] stats", stats);

idx.entries = entries;
idx.generatedAt = new Date().toISOString();
fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2) + "\n");

const after = idx.entries.filter((e) => !(e.summaryJa || "").trim()).length;
console.log(`[resummarize] missing-ja: ${missing} -> ${after}`);
