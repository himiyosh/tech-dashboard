#!/usr/bin/env node
/**
 * Backfill missing `titleEn` for data/index.json entries.
 *
 * Strategy (in priority order):
 *  1. If `titleEn` already has a value → skip
 *  2. If `summaryEn` starts with a real sentence (not a fallback marker) →
 *     extract the first sentence (up to 120 chars) as a descriptive titleEn
 *  3. Fall back to `title` if the entry has an English summaryEn (the article
 *     itself may be in Japanese, but a title stub is better than nothing)
 *
 * Usage:
 *   node scripts/fill-title-en.mjs [--dry-run]
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "data", "index.json");

const DRY_RUN = process.argv.includes("--dry-run");

// Phrases that indicate a placeholder / fallback summary — not a real title.
const FALLBACK_MARKERS = [
  "AI summary",
  "このエントリは",
  "このエントリ",
  "の関連アップデート",
  "関連アップデート。AI 要約未生成",
  "Update related to",
  "AI-generated summary",
];

function isFallbackSummary(text) {
  if (!text) return true;
  return FALLBACK_MARKERS.some((m) => text.includes(m));
}

/**
 * Extract a short descriptive title from an English summary.
 * Grabs up to the first sentence-end (period/exclamation/question) within
 * 120 characters, or the first 80 chars of the first line if no sentence-end.
 */
function extractTitleFromSummary(summary) {
  const line = summary.split("\n")[0].trim();
  // Try first sentence up to 120 chars
  const sentenceEnd = line.search(/[.!?]/);
  if (sentenceEnd > 10 && sentenceEnd <= 120) {
    return line.slice(0, sentenceEnd).trim();
  }
  // Trim to 80 chars at word boundary
  if (line.length <= 80) return line;
  const trimmed = line.slice(0, 80);
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace > 40 ? trimmed.slice(0, lastSpace) + "…" : trimmed + "…";
}

function main() {
  const data = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  const entries = data.entries ?? [];

  let skipped = 0;
  let fromSummary = 0;
  let fromTitle = 0;
  let unchanged = 0;

  for (const entry of entries) {
    // Already has a titleEn → skip
    if ((entry.titleEn ?? "").trim()) {
      unchanged++;
      continue;
    }

    const summaryEn = (entry.summaryEn ?? "").trim();
    const title = (entry.title ?? "").trim();

    if (summaryEn && !isFallbackSummary(summaryEn)) {
      // Good real summary → extract first sentence as title
      const derived = extractTitleFromSummary(summaryEn);
      if (!DRY_RUN) entry.titleEn = derived;
      fromSummary++;
    } else if (title) {
      // Use original title as a stub (might be Japanese, but better than empty)
      if (!DRY_RUN) entry.titleEn = title;
      fromTitle++;
    } else {
      skipped++;
    }
  }

  const total = fromSummary + fromTitle;
  console.log(`📝 fill-title-en${DRY_RUN ? " [dry-run]" : ""}`);
  console.log(`  from summaryEn: ${fromSummary}`);
  console.log(`  from title:     ${fromTitle}`);
  console.log(`  total updated:  ${total}`);
  console.log(`  already set:    ${unchanged}`);
  console.log(`  skipped:        ${skipped}`);

  if (!DRY_RUN && total > 0) {
    writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2));
    console.log(`  💾 Saved ${INDEX_PATH}`);
  } else if (DRY_RUN) {
    console.log("  [dry-run] No files written.");
  }
}

main();
