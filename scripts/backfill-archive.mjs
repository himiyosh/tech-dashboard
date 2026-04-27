#!/usr/bin/env node
/**
 * One-shot backfill: stamp halfLife + archiveTier on every entry in
 * data/index.json (using current registry rules) and seed the per-month
 * archive at data/archive/{YYYY-MM}.json.
 *
 * Idempotent. Safe to re-run. Pass --dry-run to preview.
 *
 * Usage:
 *   npx tsx scripts/backfill-archive.mjs
 *   npx tsx scripts/backfill-archive.mjs --dry-run
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveHalfLife, decideTier } from "../harness/half-life.ts";
import { REGISTRY } from "../harness/registry.ts";
import { writeArchive } from "../harness/publishers/archive-builder.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const INDEX_PATH = resolve(DATA_DIR, "index.json");
const DRY = process.argv.includes("--dry-run");
const NOW = new Date();

const raw = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const entries = Array.isArray(raw) ? raw : (raw.entries ?? []);

const tierCounts = { hot: 0, warm: 0, cold: 0, dropped: 0 };

const stamped = entries.map((e) => {
  const def = REGISTRY[e.source];
  const halfLife = resolveHalfLife({
    category: e.category,
    sourceType: e.sourceType,
    sourceId: e.source,
    sourceOverride: def?.halfLifeOverride,
  });
  const archiveTier = decideTier({ publishedAt: e.publishedAt, halfLife }, NOW);
  tierCounts[archiveTier]++;
  return { ...e, halfLife, archiveTier };
});

console.log(`[backfill] stamped ${stamped.length} entries`);
console.log(`[backfill] tier distribution:`, tierCounts);

if (DRY) {
  console.log("[backfill] dry-run: no files written");
  process.exit(0);
}

// Drop "dropped" entries from index, keep hot+warm+cold.
const live = stamped.filter((e) => e.archiveTier !== "dropped");
const newIndex = {
  ...(Array.isArray(raw) ? {} : raw),
  count: live.length,
  entries: live,
};
writeFileSync(INDEX_PATH, JSON.stringify(newIndex, null, 2) + "\n", "utf8");
console.log(`[backfill] rewrote ${INDEX_PATH} (${live.length} entries)`);

// Seed the per-month archive.
const stats = await writeArchive(stamped, DATA_DIR);
console.log(
  `[backfill] archive: months=${stats.monthsTouched} archived=${stats.entriesArchived} ` +
    `dropped=${stats.entriesDropped} hot-skipped=${stats.entriesSkippedHot}`,
);
