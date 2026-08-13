import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluatePullRequestBranchFlow,
} from "../scripts/check-pr-branch-flow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/check-pr-branch-flow.mjs");

function repoFilesUnder(path: string): string[] {
  const absolutePath = join(ROOT, path);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return [path];
  return readdirSync(absolutePath).flatMap((name) =>
    repoFilesUnder(join(path, name)),
  );
}

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

  it("keeps objective CI gates without session-bound merge clearance", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const agent = readFileSync(
      join(ROOT, ".github/agents/TechDBAgent.agent.md"),
      "utf8",
    );
    const removedSlug = ["independent", "review"].join("-");
    const removedPaths = [
      `.github/instructions/${removedSlug}-gate.instructions.md`,
      `scripts/check-${removedSlug}.mjs`,
      `tests/${removedSlug}-gate.test.ts`,
      `tests/${removedSlug}-ci-wiring.test.ts`,
    ];
    const removedTokens = [
      `check:${removedSlug}`,
      `check-${removedSlug}.mjs`,
      ["INDEPENDENT", "REVIEW", ""].join("_"),
      ["--reviewer", "session"].join("-"),
      ["--merger", "session"].join("-"),
      `<!-- ${removedSlug} `,
      `${["exact", "head"].join("-")} ${["independent", "review"].join(" ")}`,
    ];
    const operationalFiles = [
      "README.md",
      "package.json",
      ".github/copilot-instructions.md",
      ...repoFilesUnder(".github/agents"),
      ...repoFilesUnder(".github/instructions"),
      ...repoFilesUnder(".github/knowledge"),
      ...repoFilesUnder(".github/workflows"),
      ...repoFilesUnder(".claude/knowledge"),
      ...repoFilesUnder("docs"),
      ...repoFilesUnder("scripts"),
    ];
    const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
    const ciJobNames = [
      ...jobsSection.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm),
    ].map((match) => match[1]);

    expect(ciJobNames).toEqual(["branch-flow", "unit", "web-build", "e2e"]);
    for (const job of ciJobNames) {
      expect(workflow).toContain(`\n  ${job}:\n`);
    }
    expect(workflow).toContain("needs: [unit, web-build]");
    expect(workflow).toContain("run: npm run typecheck");
    expect(workflow).toContain("run: npm run typecheck:worker");
    expect(workflow).toContain("run: npm test");
    expect(workflow).toContain("run: npm run build:web");
    expect(workflow).toContain("run: npm run test:e2e");
    expect(workflow).not.toMatch(/wrangler\s+(?:pages\s+)?deploy/);
    expect(packageJson.scripts?.["secrets:scan"]).toBeDefined();
    expect(packageJson.scripts?.["secrets:scan:worktree"]).toBeDefined();
    expect(agent).toContain("optional code or security review");

    for (const path of removedPaths) {
      expect(
        existsSync(join(ROOT, path)),
        `${path} must stay deleted`,
      ).toBe(false);
    }
    for (const path of operationalFiles) {
      const contents = readFileSync(join(ROOT, path), "utf8");
      for (const token of removedTokens) {
        expect(
          contents,
          `${path} contains removed clearance token ${token}`,
        ).not.toContain(token);
      }
    }
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
