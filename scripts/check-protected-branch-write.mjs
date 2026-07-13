import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);
const APPROVAL_ENV = "ALLOW_PROTECTED_BRANCH_WRITE";

export function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.has(branch);
}

export function protectedPushTargets(input) {
  const targets = new Set();
  for (const rawLine of input.split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const remoteRef = fields[2];
    if (!remoteRef.startsWith("refs/heads/")) continue;
    const branch = remoteRef.slice("refs/heads/".length);
    if (isProtectedBranch(branch)) targets.add(branch);
  }
  return [...targets];
}

export function assertProtectedWriteApproved(targets, env = process.env) {
  if (targets.length === 0) return;
  if (env[APPROVAL_ENV] === "1") {
    console.error(
      `[protected-branch] WARN: explicit approval opt-in accepted for ${targets.join(", ")}`,
    );
    return;
  }
  throw new Error(
    `Protected branch write blocked: ${targets.join(", ")}. ` +
    "Use a working branch and PR. Only after the user explicitly approves a direct " +
    `protected-branch write in this session may you set ${APPROVAL_ENV}=1.`,
  );
}

function currentBranch() {
  const result = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return null;
  throw new Error(result.stderr.trim() || "Unable to determine the current Git branch");
}

function run(mode) {
  if (mode === "commit") {
    const branch = currentBranch();
    assertProtectedWriteApproved(branch && isProtectedBranch(branch) ? [branch] : []);
    return;
  }
  if (mode === "push") {
    assertProtectedWriteApproved(protectedPushTargets(readFileSync(0, "utf8")));
    return;
  }
  throw new Error("Usage: node scripts/check-protected-branch-write.mjs <commit|push>");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === invokedPath) {
  try {
    run(process.argv[2]);
  } catch (error) {
    console.error(
      `[protected-branch] ERR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
