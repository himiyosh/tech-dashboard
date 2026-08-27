#!/usr/bin/env node
/**
 * data/approved-entries.json must only ever be modified by a human commit.
 *
 * This checks the boundary, it does not create it: the structural denial lives
 * in PUBLISHER_DATA_PATH_RE (scripts/publisher-impact.ts:15), its two uses in
 * scripts/run-publisher.ts (:374, :525), and the staged-path allowlist in
 * .github/workflows/publisher.yml:164. This script catches a weakening of any
 * of those.
 *
 * Requires full history. actions/checkout defaults to fetch-depth: 1, so a CI
 * job wiring this in must set fetch-depth: 0 (ci.yml is NOT a publisher
 * criticalPath, so editing it does not change the contract fingerprint).
 */
import { execFileSync } from "node:child_process";

const MANIFEST = "data/approved-entries.json";
const BOT_NAMES = new Set(["tech-dashboard-publisher[bot]", "github-actions[bot]"]);
const BOT_EMAILS = new Set(["41898282+github-actions[bot]@users.noreply.github.com"]);
const range = process.argv[2] ?? "origin/main..HEAD";

for (const ref of range.split("..").filter(Boolean)) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    console.error(
      `ERR: APPROVAL_AUTHORSHIP_RANGE: ${ref} is not resolvable; this check needs`
        + " full history (actions/checkout fetch-depth: 0)",
    );
    process.exit(1);
  }
}

const output = execFileSync(
  "git",
  ["log", "--format=%H%x09%an%x09%ae", range, "--", MANIFEST],
  { encoding: "utf8" },
);

const violations = output
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, name, email] = line.split("\t");
    return { sha: sha ?? "", name: name ?? "", email: email ?? "" };
  })
  .filter((commit) => BOT_NAMES.has(commit.name) || BOT_EMAILS.has(commit.email));

if (violations.length > 0) {
  for (const commit of violations) {
    console.error(
      `ERR: APPROVAL_AUTHORSHIP: ${commit.sha} modified ${MANIFEST} as ${commit.name} <${commit.email}>`,
    );
  }
  process.exit(1);
}

console.log(`OK: no automated commit modified ${MANIFEST} in ${range}`);
