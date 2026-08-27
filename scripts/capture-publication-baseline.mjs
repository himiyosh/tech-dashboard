#!/usr/bin/env node
/**
 * Capture the set of /e/[id]/ routes a build ALREADY produces, and write it
 * into data/approved-entries.json as the publication-gate baseline.
 *
 * Run against a build of the commit BEFORE the gate is wired in:
 *
 *   npm run build:web
 *   node scripts/capture-publication-baseline.mjs --dist web/dist \
 *     --out data/approved-entries.json --limit 12
 *
 * Reading web/dist instead of re-deriving the policy means the baseline is
 * exactly what was live, with no second implementation to drift. Verified on
 * the current develop head: web/dist/e contains 2824 directories, all 16-hex,
 * and no files.
 */
import { existsSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ENTRY_ID_RE = /^[0-9a-f]{16}$/;

function parseArgs(argv) {
  const args = { dist: "web/dist", out: "data/approved-entries.json", limit: 12 };
  if (argv.length % 2 !== 0) throw new Error("ERR: arguments must be --flag value pairs");
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dist") args.dist = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--limit") args.limit = Number.parseInt(value, 10);
    else throw new Error(`ERR: unknown argument ${flag}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25) {
    throw new Error(`ERR: --limit must be an integer in 1..25, got ${args.limit}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const detailRoot = resolve(process.cwd(), args.dist, "e");
if (!existsSync(detailRoot)) {
  throw new Error(`ERR: ${detailRoot} does not exist; run npm run build:web first`);
}

// Fail closed on ANY unexpected entry, files included: a stray name would mean
// the built route shape changed and the baseline can no longer be trusted.
const ids = readdirSync(detailRoot, { withFileTypes: true }).map((entry) => {
  if (!entry.isDirectory() || !ENTRY_ID_RE.test(entry.name)) {
    throw new Error(
      `ERR: ${args.dist}/e/${entry.name} is not a 16-hex detail-route directory`,
    );
  }
  return entry.name;
}).sort();

if (ids.length === 0) throw new Error("ERR: the build produced no /e/ routes");

const manifest = {
  version: 1,
  dailyReleaseLimit: args.limit,
  baseline: { capturedAt: new Date().toISOString(), ids },
  approvals: [],
};

const outPath = resolve(process.cwd(), args.out);
const tempPath = `${outPath}.tmp-${process.pid}`;
try {
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tempPath, outPath);
} finally {
  if (existsSync(tempPath)) unlinkSync(tempPath);
}

console.log(`OK: captured ${ids.length} baseline detail routes into ${args.out}`);
console.log(`OK: dailyReleaseLimit=${args.limit}`);
