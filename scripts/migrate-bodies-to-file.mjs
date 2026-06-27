#!/usr/bin/env node
/**
 * scripts/migrate-bodies-to-file.mjs
 *
 * Body-file architecture migration (LL-113). The long-form per-entry body is
 * moved OUT of data/index.json into a dedicated data/bodies.json so the index
 * stays well under the CI size budget (LL-112) while full article bodies can
 * still grow without bound. The detail page reads bodies from data/bodies.json.
 *
 * What it does:
 *   - For every index entry with a REAL body (non-empty, not the legacy
 *     deterministic filler), copy bodyJa/bodyEn into data/bodies.json keyed by
 *     entry id, then blank bodyJa/bodyEn on the index entry.
 *   - Legacy filler bodies are dropped (not migrated) — they were never real.
 *   - Pre-existing data/bodies.json entries are preserved/merged (idempotent).
 *
 * Usage: node scripts/migrate-bodies-to-file.mjs [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JA_FILLER_NEEDLE = "元記事の要約と収集時のメタデータから";
const EN_FILLER_NEEDLE = "completed from the existing summary and collection metadata";

function isFiller(bodyJa, bodyEn) {
  return (bodyJa ?? "").includes(JA_FILLER_NEEDLE) || (bodyEn ?? "").includes(EN_FILLER_NEEDLE);
}

const dryRun = process.argv.includes("--dry-run");
const root = process.cwd();
const indexPath = join(root, "data", "index.json");
const bodiesPath = join(root, "data", "bodies.json");

const index = JSON.parse(readFileSync(indexPath, "utf8"));
const entries = Array.isArray(index.entries) ? index.entries : [];

const existingBodies = existsSync(bodiesPath)
  ? JSON.parse(readFileSync(bodiesPath, "utf8"))
  : { generatedAt: index.generatedAt, count: 0, bodies: {} };
const bodies = existingBodies.bodies ?? {};

let migrated = 0;
let fillerDropped = 0;
let alreadyEmpty = 0;
for (const entry of entries) {
  const ja = typeof entry.bodyJa === "string" ? entry.bodyJa.trim() : "";
  const en = typeof entry.bodyEn === "string" ? entry.bodyEn.trim() : "";
  if (!ja && !en) {
    alreadyEmpty++;
    continue;
  }
  if (isFiller(entry.bodyJa, entry.bodyEn)) {
    // Drop legacy filler; never store it as a real body.
    entry.bodyJa = "";
    entry.bodyEn = "";
    fillerDropped++;
    continue;
  }
  // Move the real body into the bodies file.
  bodies[String(entry.id)] = {
    bodyJa: entry.bodyJa ?? "",
    bodyEn: entry.bodyEn ?? "",
    model: entry.bodyModel ?? "legacy-import",
    generatedAt: existingBodies.bodies?.[entry.id]?.generatedAt ?? index.generatedAt,
  };
  entry.bodyJa = "";
  entry.bodyEn = "";
  migrated++;
}

const bodiesOut = {
  generatedAt: index.generatedAt,
  count: Object.keys(bodies).length,
  bodies,
};

const indexRaw = readFileSync(indexPath, "utf8");
const indexJson = JSON.stringify(index, null, 2) + "\n";
const bodiesJson = JSON.stringify(bodiesOut, null, 2) + "\n";

console.log(`index entries: ${entries.length}`);
console.log(`bodies migrated: ${migrated}`);
console.log(`filler dropped: ${fillerDropped}`);
console.log(`already empty: ${alreadyEmpty}`);
console.log(`bodies.json total: ${bodiesOut.count}`);
console.log(
  `index size: ${(Buffer.byteLength(indexRaw, "utf8") / 1e6).toFixed(2)}MB -> ${(Buffer.byteLength(indexJson, "utf8") / 1e6).toFixed(2)}MB`,
);
console.log(`bodies.json size: ${(Buffer.byteLength(bodiesJson, "utf8") / 1e6).toFixed(2)}MB`);

if (dryRun) {
  console.log("(dry-run: no files written)");
} else {
  writeFileSync(indexPath, indexJson, "utf8");
  writeFileSync(bodiesPath, bodiesJson, "utf8");
  console.log(`wrote ${indexPath}`);
  console.log(`wrote ${bodiesPath}`);
}
