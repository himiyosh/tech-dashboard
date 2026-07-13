import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts/check-protected-branch-write.mjs");
const scratchRoots: string[] = [];

function cleanEnv(overrides: Record<string, string> = {}) {
  const env = { ...process.env, ...overrides };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.ALLOW_PROTECTED_BRANCH_WRITE;
  return env;
}

function createRepository(branch: string) {
  const root = mkdtempSync(join(tmpdir(), "tech-dashboard-protected-branch-"));
  scratchRoots.push(root);
  const result = spawnSync("git", ["init", "-q", "-b", branch], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv(),
  });
  expect(result.status).toBe(0);
  return root;
}

function runGuard(
  cwd: string,
  mode: "commit" | "push",
  input = "",
  env: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [scriptPath, mode], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...cleanEnv(), ...env },
  });
}

function installGuardScript(root: string) {
  const scriptsDir = join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  copyFileSync(scriptPath, join(scriptsDir, "check-protected-branch-write.mjs"));
}

function runHook(
  cwd: string,
  hook: "pre-commit" | "pre-push",
  input = "",
) {
  installGuardScript(cwd);
  return spawnSync("bash", [join(repoRoot, "scripts/git-hooks", hook)], {
    cwd,
    input,
    encoding: "utf8",
    env: cleanEnv(),
  });
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("protected branch write guard", () => {
  it.each(["main", "master", "develop"])("blocks commits on %s", (branch) => {
    const result = runGuard(createRepository(branch), "commit");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Protected branch write blocked: ${branch}`);
  });

  it("allows commits on a working branch", () => {
    const result = runGuard(createRepository("fix/example"), "commit");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("requires the explicit approval opt-in for a protected-branch commit", () => {
    const result = runGuard(createRepository("main"), "commit", "", {
      ALLOW_PROTECTED_BRANCH_WRITE: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("explicit approval opt-in accepted for main");
  });

  it("blocks any push update targeting main", () => {
    const input = [
      "refs/heads/fix/example",
      "1111111111111111111111111111111111111111",
      "refs/heads/main",
      "2222222222222222222222222222222222222222",
    ].join(" ") + "\n";
    const result = runGuard(createRepository("fix/example"), "push", input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Protected branch write blocked: main");
  });

  it("allows pushes that target only a working branch", () => {
    const input = [
      "refs/heads/fix/example",
      "1111111111111111111111111111111111111111",
      "refs/heads/fix/example",
      "2222222222222222222222222222222222222222",
    ].join(" ") + "\n";
    const result = runGuard(createRepository("fix/example"), "push", input);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("requires the explicit approval opt-in for a protected-branch push", () => {
    const input = [
      "refs/heads/main",
      "1111111111111111111111111111111111111111",
      "refs/heads/main",
      "2222222222222222222222222222222222222222",
    ].join(" ") + "\n";
    const result = runGuard(createRepository("main"), "push", input, {
      ALLOW_PROTECTED_BRANCH_WRITE: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("explicit approval opt-in accepted for main");
  });

  it("wires the commit guard before the other pre-commit gates", () => {
    const result = runHook(createRepository("main"), "pre-commit");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Protected branch write blocked: main");
    expect(result.stdout).not.toContain("secret scan を実行");
  });

  it("wires the push guard before the other pre-push gates", () => {
    const input = [
      "refs/heads/fix/example",
      "1111111111111111111111111111111111111111",
      "refs/heads/main",
      "2222222222222222222222222222222222222222",
    ].join(" ") + "\n";
    const result = runHook(createRepository("fix/example"), "pre-push", input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Protected branch write blocked: main");
    expect(result.stdout).not.toContain("secret scan を実行");
  });
});
