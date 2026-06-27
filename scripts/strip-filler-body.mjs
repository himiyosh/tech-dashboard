#!/usr/bin/env node
/**
 * scripts/strip-filler-body.mjs
 *
 * Summary-first migration (LL-112). The long-form per-entry body is no longer
 * generated (LL-106 made the summarizer summary-only). The collector used to
 * fill an empty body with deterministic filler ("...は ... 領域の更新です" /
 * "completed from the existing summary and collection metadata"). That filler:
 *   - added ~1.7MB to data/index.json (CI data-size budget overflow),
 *   - was hidden behind a false "本文は近日中に AI が生成" promise on the detail
 *     page (the promise never resolves because body generation was removed),
 *   - flipped real-summary entries to non-publishable (dropping ~43% of entries,
 *     i.e. every recent one, out of Featured / Top-3 / feeds).
 *
 * This one-time migration strips the legacy filler body from data/index.json so
 * the committed artifact matches the new collector output (empty body). Real,
 * model-generated bodies (a minority of older entries) are preserved.
 *
 * Usage: node scripts/strip-filler-body.mjs [--dry-run]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JA_FILLER_NEEDLE = "元記事の要約と収集時のメタデータから";
const EN_FILLER_NEEDLE = "completed from the existing summary and collection metadata";

const dryRun = process.argv.includes("--dry-run");
const indexPath = join(process.cwd(), "data", "index.json");

const raw = readFileSync(indexPath, "utf8");
const payload = JSON.parse(raw);
const entries = Array.isArray(payload.entries) ? payload.entries : [];

let stripped = 0;
for (const entry of entries) {
  const ja = typeof entry.bodyJa === "string" ? entry.bodyJa : "";
  const en = typeof entry.bodyEn === "string" ? entry.bodyEn : "";
  const isFiller = ja.includes(JA_FILLER_NEEDLE) || en.includes(EN_FILLER_NEEDLE);
  if (isFiller) {
    entry.bodyJa = "";
    entry.bodyEn = "";
    stripped++;
  }
}

const before = Buffer.byteLength(raw, "utf8");
const out = JSON.stringify(payload, null, 2) + "\n";
const after = Buffer.byteLength(out, "utf8");

console.log(`entries: ${entries.length}`);
console.log(`filler bodies stripped: ${stripped}`);
console.log(`size: ${(before / 1e6).toFixed(2)}MB -> ${(after / 1e6).toFixed(2)}MB`);

if (dryRun) {
  console.log("(dry-run: no file written)");
} else {
  writeFileSync(indexPath, out, "utf8");
  console.log(`wrote ${indexPath}`);
}
