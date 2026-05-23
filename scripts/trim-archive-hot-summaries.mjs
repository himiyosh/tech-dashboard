#!/usr/bin/env node
/**
 * One-time migration: strip summaryJa/summaryEn from hot-tier entries in
 * existing archive files (LL-044). Warm/cold entries retain summaries.
 *
 * Usage: node scripts/trim-archive-hot-summaries.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = join(__dirname, "..", "data", "archive");
const DRY_RUN = process.argv.includes("--dry-run");

function trimEntry(entry) {
  if (entry.archiveTier !== "hot") return entry;
  const trimmed = { ...entry };
  delete trimmed.summaryJa;
  delete trimmed.summaryEn;
  return trimmed;
}

const files = readdirSync(ARCHIVE_DIR).filter((f) =>
  /^\d{4}-\d{2}\.json$/.test(f),
);

let totalTrimmed = 0;
for (const file of files) {
  const path = join(ARCHIVE_DIR, file);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const entries = raw.entries ?? [];
  const hotEntries = entries.filter((e) => e.archiveTier === "hot");
  if (hotEntries.length === 0) {
    console.log(`  ${file}: no hot entries, skip`);
    continue;
  }
  const before = statSync(path).size;
  const trimmed = entries.map(trimEntry);
  const out = { ...raw, entries: trimmed };
  const outStr = JSON.stringify(out, null, 2);
  if (!DRY_RUN) writeFileSync(path, outStr);
  const after = Buffer.byteLength(outStr);
  totalTrimmed += hotEntries.length;
  console.log(
    `  ${file}: ${hotEntries.length} hot entries trimmed, ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`,
  );
}
console.log(
  `\n✅ Total hot entries trimmed: ${totalTrimmed}${DRY_RUN ? " [dry-run]" : ""}`,
);
