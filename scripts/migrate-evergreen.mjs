#!/usr/bin/env node
/**
 * Targeted migration: stamp `evergreen` + re-tier entries from evergreen
 * sources in data/index.json so existing best-practice / knowledge posts
 * accumulate (warm) instead of being archived (cold) or dropped.
 *
 * Only entries whose source is marked `evergreen: true` in the registry are
 * touched; every other entry is left byte-for-byte unchanged to keep the diff
 * minimal. The generator side (harness/pipeline/normalize.ts) stamps the same
 * fields on every fresh collect, so this one-shot only fixes entries that
 * predate the policy and have aged out of their source feed window (R-022).
 *
 * Idempotent. Usage:
 *   npx tsx scripts/migrate-evergreen.mjs            # apply
 *   npx tsx scripts/migrate-evergreen.mjs --dry-run  # preview
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { resolveHalfLife, decideTier } from "../harness/half-life.ts";
import { REGISTRY } from "../harness/registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(__dirname, "../data/index.json");
const DRY = process.argv.includes("--dry-run");
const NOW = new Date();

const doc = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const entries = Array.isArray(doc.entries) ? doc.entries : [];

let changed = 0;
const tierMoves = {};
for (const e of entries) {
  const def = REGISTRY[e.source];
  if (!def?.evergreen) continue;

  const halfLife = resolveHalfLife({
    category: e.category,
    sourceType: e.sourceType,
    sourceId: e.source,
    sourceOverride: def.halfLifeOverride,
  });
  const archiveTier = decideTier(
    { publishedAt: e.publishedAt, halfLife, evergreen: true },
    NOW,
  );

  if (e.evergreen === true && e.halfLife === halfLife && e.archiveTier === archiveTier) {
    continue;
  }
  const move = `${e.archiveTier ?? "(none)"}->${archiveTier}`;
  tierMoves[move] = (tierMoves[move] ?? 0) + 1;
  e.evergreen = true;
  e.halfLife = halfLife;
  e.archiveTier = archiveTier;
  changed += 1;
}

console.log(`[migrate-evergreen] evergreen sources:`, Object.keys(REGISTRY).filter((k) => REGISTRY[k].evergreen));
console.log(`[migrate-evergreen] entries changed: ${changed}`);
console.log(`[migrate-evergreen] tier moves:`, tierMoves);

if (DRY) {
  console.log("[migrate-evergreen] dry-run: no files written");
  process.exit(0);
}
if (changed === 0) {
  console.log("[migrate-evergreen] nothing to change");
  process.exit(0);
}

writeFileSync(INDEX_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");
console.log(`[migrate-evergreen] rewrote ${INDEX_PATH}`);
