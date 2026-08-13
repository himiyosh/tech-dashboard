import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluatePullRequestBranchFlow,
} from "../scripts/check-pr-branch-flow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-pr-branch-flow.mjs");

describe("pull request branch flow", () => {
  it("allows working branches to integrate into develop", () => {
    expect(evaluatePullRequestBranchFlow("develop", "feature/example")).toMatchObject({
      ok: true,
      mode: "integration",
    });
  });

  it("allows only develop to release into main", () => {
    expect(evaluatePullRequestBranchFlow("main", "develop")).toMatchObject({
      ok: true,
      mode: "release",
    });
    expect(evaluatePullRequestBranchFlow("main", "feature/example")).toEqual({
      ok: false,
      mode: "invalid",
      message: "only develop may target main; retarget this PR to develop",
    });
  });

  it("allows a reviewed main-to-develop backsync without protected self-merges", () => {
    expect(evaluatePullRequestBranchFlow("develop", "main")).toMatchObject({
      ok: true,
      mode: "backsync",
    });
    for (const head of ["develop", "master"]) {
      expect(evaluatePullRequestBranchFlow("develop", head).ok).toBe(false);
    }
  });

  it("fails closed for missing or unsupported branch evidence", () => {
    expect(evaluatePullRequestBranchFlow("", "feature/example").ok).toBe(false);
    expect(evaluatePullRequestBranchFlow("develop", "").ok).toBe(false);
    expect(evaluatePullRequestBranchFlow("release", "feature/example").ok).toBe(false);
  });

  it("runs CI for develop and rechecks edited PR bases", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("branches: [main, develop]");
    expect(workflow).toContain("types: [opened, synchronize, reopened, edited]");
    expect(workflow).toContain("name: feature → develop → main branch flow");
    expect(workflow).toContain("run: node scripts/check-pr-branch-flow.mjs");
  });

  it("enforces the environment-driven CI contract", () => {
    const accepted = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PR_BASE_REF: "develop", PR_HEAD_REF: "feature/example" },
    });
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("feature/example -> develop integration PR");

    const rejected = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PR_BASE_REF: "main", PR_HEAD_REF: "feature/example" },
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("only develop may target main");
  });
});
