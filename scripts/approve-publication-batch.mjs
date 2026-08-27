#!/usr/bin/env node
/**
 * Append up to `dailyReleaseLimit` approvals to data/approved-entries.json.
 *
 * This is the write half of the human approval gate. It selects candidates but
 * it does NOT decide: it only runs from .github/workflows/approve-publication.yml,
 * whose job is bound to a protected GitHub Environment, so a person has to
 * approve the run in GitHub before this script executes. The approving account
 * is recorded as the `reviewer` of every appended row and as the git AUTHOR of
 * the commit, which is what scripts/check-approval-authorship.mjs verifies
 * (it reads %an/%ae, so a bot committer with a human author is accepted while
 * a bot-authored commit is not).
 *
 * Candidates must already be publishable on every other axis: addressable
 * (hot/warm tier with a real bilingual summary) AND carrying a real,
 * source-grounded body. Approving an entry does not override any other gate;
 * it only lifts the publication hold.
 *
 * Usage:
 *   node scripts/approve-publication-batch.mjs --reviewer <login> [--limit N]
 *                                              [--now <iso>] [--dry-run]
 */
import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST = "data/approved-entries.json";
const INDEX = "data/index.json";
const BODIES = "data/bodies.json";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`ERR: APPROVE_ARG: --${name} needs a value`);
    process.exit(1);
  }
  return value;
}

const reviewer = arg("reviewer");
if (!reviewer) {
  console.error("ERR: APPROVE_REVIEWER: --reviewer <login> is required");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const manifestRaw = readFileSync(MANIFEST, "utf8");
const manifest = JSON.parse(manifestRaw);
const limit = Number(arg("limit", String(manifest.dailyReleaseLimit)));
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`ERR: APPROVE_LIMIT: --limit must be a positive integer, got ${limit}`);
  process.exit(1);
}

const index = JSON.parse(readFileSync(INDEX, "utf8"));
const bodies = JSON.parse(readFileSync(BODIES, "utf8")).bodies ?? {};

// The approval clock must move forward: the manifest is append-only and the
// parser rejects an approvedAt that precedes the previous row.
const lastApprovedAt = manifest.approvals.at(-1)?.approvedAt ?? null;
const nowArg = arg("now");
const now = nowArg ?? new Date().toISOString();
if (lastApprovedAt && Date.parse(now) < Date.parse(lastApprovedAt)) {
  console.error(
    `ERR: APPROVE_CLOCK: ${now} precedes the last approval ${lastApprovedAt};`
      + ` ${MANIFEST} is append-only`,
  );
  process.exit(1);
}

const decided = new Set([
  ...manifest.baseline.ids,
  ...manifest.approvals.map((row) => row.id),
]);

function hasRealBody(id) {
  const record = bodies[id];
  if (!record) return false;
  return Boolean((record.bodyJa ?? "").trim() || (record.bodyEn ?? "").trim());
}

function isUsable(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const candidates = index.entries
  .filter((entry) => !decided.has(entry.id))
  .filter((entry) => entry.archiveTier === "hot" || entry.archiveTier === "warm")
  .filter((entry) => isUsable(entry.summaryJa) && isUsable(entry.summaryEn))
  .filter((entry) => hasRealBody(entry.id))
  .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")))
  .slice(0, limit);

if (candidates.length === 0) {
  console.log(`OK: no undecided entry is eligible for approval (limit ${limit})`);
  process.exit(0);
}

for (const entry of candidates) {
  manifest.approvals.push({
    id: entry.id,
    approvedAt: now,
    reviewer,
    note: entry.title ?? "",
  });
  console.log(`APPROVE ${entry.id}  ${entry.publishedAt ?? "?"}  ${entry.title ?? ""}`);
}

console.log(`OK: ${candidates.length} approval(s) by ${reviewer} at ${now}`);
if (dryRun) {
  console.log("DRY-RUN: manifest not written");
  process.exit(0);
}
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`OK: wrote ${MANIFEST}`);
