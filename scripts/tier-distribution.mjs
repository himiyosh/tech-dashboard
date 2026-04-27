#!/usr/bin/env node
/**
 * Dry-run: classify every entry in data/index.json by half-life + archive tier
 * using the rules in harness/half-life.ts, and print a distribution report.
 *
 * No files are written. Use this to sanity-check the half-life mapping
 * before turning on the actual archive pipeline.
 *
 * Usage:
 *   node scripts/tier-distribution.mjs
 *   node scripts/tier-distribution.mjs --by-source
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveHalfLife, decideTier, TIER_THRESHOLDS } from "../harness/half-life.ts";
import { REGISTRY } from "../harness/registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "../data/index.json");
const NOW = new Date();
const SHOW_BY_SOURCE = process.argv.includes("--by-source");

const raw = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const entries = Array.isArray(raw) ? raw : (raw.entries ?? raw.items ?? []);

const tally = {
  tier:       { hot: 0, warm: 0, cold: 0, dropped: 0 },
  halfLife:   { news: 0, tutorial: 0, architecture: 0, fundamental: 0 },
  bySource:   new Map(),  // sourceId -> { halfLife, hot, warm, cold, dropped, total }
  unknownSrc: 0,
  noPubDate:  0,
};

for (const e of entries) {
  if (!e.publishedAt) tally.noPubDate++;

  const def = REGISTRY[e.source];
  if (!def) tally.unknownSrc++;

  const halfLife = resolveHalfLife({
    category: e.category,
    sourceType: e.sourceType,
    sourceId: e.source,
    sourceOverride: def?.halfLifeOverride,
  });

  const tier = decideTier({ publishedAt: e.publishedAt, halfLife }, NOW);

  tally.tier[tier]++;
  tally.halfLife[halfLife]++;

  let s = tally.bySource.get(e.source);
  if (!s) {
    s = { halfLife, hot: 0, warm: 0, cold: 0, dropped: 0, total: 0 };
    tally.bySource.set(e.source, s);
  }
  s[tier]++;
  s.total++;
}

const total = entries.length;
const pct = (n) => ((n / total) * 100).toFixed(1).padStart(5) + "%";

console.log("");
console.log("=".repeat(72));
console.log(`Tier distribution dry-run  (now=${NOW.toISOString()})`);
console.log(`Source: data/index.json   entries=${total}`);
console.log("=".repeat(72));

console.log("\n[Archive Tier]");
for (const [k, v] of Object.entries(tally.tier)) {
  console.log(`  ${k.padEnd(8)} ${String(v).padStart(4)}  ${pct(v)}`);
}

console.log("\n[Half-life classification]");
for (const [k, v] of Object.entries(tally.halfLife)) {
  console.log(`  ${k.padEnd(13)} ${String(v).padStart(4)}  ${pct(v)}`);
}

console.log("\n[Threshold reference (days)]");
for (const [hl, t] of Object.entries(TIER_THRESHOLDS)) {
  const cold = t.cold === Infinity ? "infinity" : String(t.cold);
  console.log(`  ${hl.padEnd(13)} hot<${t.hot}  warm<${t.warm}  cold<${cold}`);
}

console.log("\n[Sanity]");
console.log(`  entries with no publishedAt : ${tally.noPubDate}`);
console.log(`  entries from unknown source : ${tally.unknownSrc}`);

if (SHOW_BY_SOURCE) {
  console.log("\n[By source]  (sorted by total desc)");
  console.log(
    "  " +
      "source".padEnd(28) +
      "halfLife".padEnd(14) +
      "hot".padStart(5) +
      "warm".padStart(6) +
      "cold".padStart(6) +
      "drop".padStart(6) +
      "total".padStart(7),
  );
  const rows = [...tally.bySource.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [src, s] of rows) {
    console.log(
      "  " +
        src.padEnd(28) +
        s.halfLife.padEnd(14) +
        String(s.hot).padStart(5) +
        String(s.warm).padStart(6) +
        String(s.cold).padStart(6) +
        String(s.dropped).padStart(6) +
        String(s.total).padStart(7),
    );
  }
}
console.log("");
