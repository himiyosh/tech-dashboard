#!/usr/bin/env node
/**
 * One-time repair: rescue evergreen archive rows that the live-index caps
 * evicted before the retention fix landed.
 *
 * Damage being repaired
 * ---------------------
 * PER_SOURCE_CAP / CATEGORY_CAPS / INDEX_LIMIT (worker/src/index.ts) evict on
 * pickScore alone and ignore `evergreen`. An evicted entry never returns as a
 * live entry, so its archive row froze at whatever `archiveTier` it last held —
 * "hot" — and compactArchiveEntry had already stripped summaryJa/summaryEn from
 * it under LL-044 ("the live index still holds them", which stopped being true
 * at eviction). A hot row without summaries is on no browsable surface: the
 * monthly page filters through isPublishableEntry and the detail route is built
 * from warm rows only. The article was in data/archive/{YYYY-MM}.json and
 * nowhere else.
 *
 * archive-core.ts now keeps evergreen summaries and promotes evicted evergreen
 * rows to warm, so no new rows can enter this state. That fix cannot recreate
 * summaries that were already deleted, which is what this script is for: every
 * affected row was live once, so its summaries are recoverable from an older
 * revision of data/index.json in git history.
 *
 * What it does, per evergreen archive row that is no longer in data/index.json:
 *   1. restores summaryJa/summaryEn from the newest commit of data/index.json
 *      that still carried them (history is sampled one commit per day — the
 *      publisher commits hourly and summaries do not change intra-day);
 *   2. re-stamps archiveTier "hot" → "warm", matching what
 *      promoteEvictedEvergreenEntries would have done at eviction time.
 *
 * Rows it cannot source a summary for are reported and left untouched rather
 * than promoted: warm archive rows must carry bilingual summaries (see
 * validateArchiveMonthPayload in scripts/clean-source-noise.mjs), so promoting
 * a summary-less row would trade an invisible article for an invalid one.
 *
 * Usage: node scripts/restore-evicted-evergreen.mjs [--dry-run]
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_DIR = join(ROOT, "data", "archive");
const INDEX_PATH = join(ROOT, "data", "index.json");
const DRY_RUN = process.argv.includes("--dry-run");

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** One commit per calendar day, newest first — hourly runs repeat the same data. */
function dailyIndexCommits() {
  const log = git(["log", "--format=%H %ad", "--date=short", "--", "data/index.json"]);
  const shas = [];
  let lastDay = null;
  for (const line of log.trim().split("\n")) {
    const [sha, day] = line.split(" ");
    if (!sha || day === lastDay) continue;
    lastDay = day;
    shas.push(sha);
  }
  return shas;
}

const liveIds = new Set();
const liveUrls = new Set();
for (const entry of JSON.parse(readFileSync(INDEX_PATH, "utf8")).entries ?? []) {
  liveIds.add(entry.id);
  if (entry.url) liveUrls.add(entry.url);
}

const files = readdirSync(ARCHIVE_DIR).filter((name) => /^\d{4}-\d{2}\.json$/.test(name));
const months = new Map();
/** id → rows needing a summary (the same id can appear in more than one month). */
const needSummary = new Map();
let evicted = 0;

for (const file of files) {
  const payload = JSON.parse(readFileSync(join(ARCHIVE_DIR, file), "utf8"));
  months.set(file, payload);
  for (const entry of payload.entries ?? []) {
    if (entry.evergreen !== true) continue;
    if (liveIds.has(entry.id) || liveUrls.has(entry.url)) continue;
    evicted += 1;
    if (hasText(entry.summaryJa) && hasText(entry.summaryEn)) continue;
    const rows = needSummary.get(entry.id) ?? [];
    rows.push(entry);
    needSummary.set(entry.id, rows);
  }
}

console.log(
  `evergreen rows no longer live: ${evicted} (missing summaries: ${needSummary.size})`,
);

const recovered = new Map();
if (needSummary.size > 0) {
  const commits = dailyIndexCommits();
  console.log(`scanning up to ${commits.length} daily revisions of data/index.json…`);
  for (const sha of commits) {
    if (recovered.size === needSummary.size) break;
    let snapshot;
    try {
      snapshot = JSON.parse(git(["show", `${sha}:data/index.json`]));
    } catch {
      continue; // revision predates the file or is unparseable — keep walking
    }
    for (const entry of snapshot.entries ?? []) {
      if (!needSummary.has(entry.id) || recovered.has(entry.id)) continue;
      if (!hasText(entry.summaryJa) || !hasText(entry.summaryEn)) continue;
      recovered.set(entry.id, { summaryJa: entry.summaryJa, summaryEn: entry.summaryEn, sha });
    }
  }
  console.log(`recovered summaries for ${recovered.size}/${needSummary.size} entries`);
}

let promoted = 0;
let restored = 0;
const stranded = [];

for (const [file, payload] of months) {
  let touched = false;
  for (const entry of payload.entries ?? []) {
    if (entry.evergreen !== true) continue;
    if (liveIds.has(entry.id) || liveUrls.has(entry.url)) continue;

    const found = recovered.get(entry.id);
    if (found && (!hasText(entry.summaryJa) || !hasText(entry.summaryEn))) {
      entry.summaryJa = found.summaryJa;
      entry.summaryEn = found.summaryEn;
      restored += 1;
      touched = true;
    }
    if (!hasText(entry.summaryJa) || !hasText(entry.summaryEn)) {
      stranded.push(`${file} ${entry.id} ${entry.url}`);
      continue;
    }
    if (entry.archiveTier !== "warm") {
      entry.archiveTier = "warm";
      promoted += 1;
      touched = true;
    }
  }
  if (touched && !DRY_RUN) {
    writeFileSync(join(ARCHIVE_DIR, file), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  if (touched) console.log(`  ${file}: updated`);
}

console.log(
  `\n✅ summaries restored: ${restored}, promoted to warm: ${promoted}${DRY_RUN ? " [dry-run]" : ""}`,
);
if (stranded.length > 0) {
  console.log(`\n⚠️  left as-is (no recoverable summary): ${stranded.length}`);
  for (const line of stranded) console.log(`  ${line}`);
}
