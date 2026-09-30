import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessDevelopDocsOnlyPush,
  isDocumentationOrPolicyPath,
} from "../scripts/pre-push-data-freshness.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts/pre-push-data-freshness.mjs");
const ZERO_SHA = "0".repeat(40);
const scratchRoots: string[] = [];

function cleanGitEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: cleanGitEnv(),
  });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function write(root: string, path: string, contents: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(root: string, path: string, contents: string) {
  write(root, path, contents);
  git(root, "add", "-A");
  git(root, "commit", "-qm", `fixture: update ${path}`);
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "techdb-develop-freshness-"));
  scratchRoots.push(directory);
  const root = join(directory, "checkout");
  const remote = join(directory, "origin.git");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "init", "--bare", "-q", remote);
  git(root, "remote", "add", "origin", remote);
  write(root, "data/index.json", '{"generatedAt":"2026-09-16T00:00:00.000Z"}\n');
  write(root, "README.md", "Initial documentation\n");
  write(root, "web/src/example.ts", "export const version = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  const commonSha = git(root, "rev-parse", "HEAD");

  commit(root, "data/index.json", '{"generatedAt":"2026-10-01T00:00:00.000Z"}\n');
  const mainSha = git(root, "rev-parse", "HEAD");
  git(root, "push", "-q", "origin", "main");
  git(root, "switch", "-q", "-c", "develop", commonSha);
  commit(root, "web/src/example.ts", "export const version = 2;\n");
  const developSha = git(root, "rev-parse", "HEAD");
  git(root, "push", "-q", "origin", "develop");
  git(root, "fetch", "-q", "origin", "develop");
  git(root, "switch", "-q", "-c", "docs-only");
  commit(root, "README.md", "Initial documentation\nDevelop policy update\n");
  return { directory, root, remote, mainSha, developSha };
}

type Fixture = ReturnType<typeof setup>;

function inputFor(fixture: Fixture, remoteRef = "refs/heads/docs-only") {
  const head = git(fixture.root, "rev-parse", "HEAD");
  const remoteSha = git(fixture.root, "ls-remote", "--heads", "origin", remoteRef)
    .split(/\s+/)[0] || ZERO_SHA;
  return `refs/heads/docs-only ${head} ${remoteRef} ${remoteSha}\n`;
}

function assess(fixture: Fixture, input = inputFor(fixture), remoteName = "origin", remoteUrl = fixture.remote) {
  return assessDevelopDocsOnlyPush(fixture.root, { remoteName, remoteUrl, input });
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("develop-only pre-push index freshness policy", () => {
  it("allows only Markdown documentation and the four exact policy-tooling paths", () => {
    for (const path of [
      "README.md",
      "CHANGELOG.md",
      "docs/policy/stale-data.md",
      ".github/copilot-instructions.md",
      ".github/knowledge/agentic-rules/rules.md",
      ".claude/skills/self-critique/SKILL.md",
      "scripts/git-hooks/pre-push",
      "scripts/pre-push-data-freshness.mjs",
      "tests/data-schema.test.ts",
      "tests/pre-push-data-freshness.test.ts",
    ]) {
      expect(isDocumentationOrPolicyPath(path), path).toBe(true);
    }
    for (const path of [
      "data/index.json",
      "data/updates/_index.json",
      "web/src/pages/index.astro",
      "web/src/content/policy.md",
      "worker/src/index.ts",
      "worker-body/src/index.ts",
      "harness/registry.ts",
      "scripts/run-publisher.ts",
      "scripts/git-hooks/pre-commit",
      ".github/workflows/ci.yml",
      "package.json",
      "tests/other.test.ts",
      "notes.txt",
      "docs/../data/index.md",
      "docs\\policy.md",
      "README\n.md",
    ]) {
      expect(isDocumentationOrPolicyPath(path), path).toBe(false);
    }
  });

  it("warns for a docs-only PR diff against current develop, not the unrelated main-range changes", () => {
    const fixture = setup();
    expect(git(fixture.root, "diff", "--name-only", "origin/main", "HEAD"))
      .toContain("web/src/example.ts");
    const decision = assess(fixture);
    expect(decision.eligible).toBe(true);
    expect(decision.baseSha).toBe(fixture.developSha);
    expect(decision.paths).toEqual(["README.md"]);

    mkdirSync(join(fixture.root, "scripts"), { recursive: true });
    copyFileSync(scriptPath, join(fixture.root, "scripts/pre-push-data-freshness.mjs"));
    const cli = spawnSync(process.execPath, [
      join(fixture.root, "scripts/pre-push-data-freshness.mjs"), "origin", fixture.remote,
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      input: inputFor(fixture),
      env: cleanGitEnv(),
    });
    expect(cli.status).toBe(0);
    expect(cli.stderr).toContain("WARN: verified develop docs/rules/policy-only PR");
    const strictCli = spawnSync(process.execPath, [
      join(fixture.root, "scripts/pre-push-data-freshness.mjs"), "origin", fixture.remote,
    ], {
      cwd: fixture.root,
      encoding: "utf8",
      input: inputFor(fixture, "refs/heads/main"),
      env: cleanGitEnv(),
    });
    expect(strictCli.status).toBe(1);
    expect(strictCli.stderr).toContain("strict <=36h index freshness");
  });

  it("allows subsequent docs-only pushes only if the entire develop PR remains docs-only", () => {
    const fixture = setup();
    git(fixture.root, "push", "-q", "origin", "docs-only");
    commit(fixture.root, "docs/note.md", "Additional documentation\n");
    expect(assess(fixture).eligible).toBe(true);

    commit(fixture.root, "web/src/example.ts", "export const version = 3;\n");
    git(fixture.root, "push", "-q", "origin", "docs-only");
    commit(fixture.root, "README.md", "A later documentation-only push\n");
    expect(assess(fixture).eligible).toBe(false);
    expect(assess(fixture).reason).toContain("data, application, producer");
  });

  it.each([
    ["data/index.json", "different data\n"],
    ["data/updates/_index.json", "new data\n"],
    ["web/src/example.ts", "export const version = 3;\n"],
    ["harness/pipeline/example.ts", "export const producer = true;\n"],
    ["worker/src/example.ts", "export const producer = true;\n"],
    ["scripts/run-publisher.ts", "export const producer = true;\n"],
    [".github/workflows/ci.yml", "name: changed\n"],
    ["notes.txt", "unknown scope\n"],
  ])("keeps strict <=36h freshness for %s", (path, contents) => {
    const fixture = setup();
    commit(fixture.root, path, contents);
    const decision = assess(fixture);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toContain("data, application, producer");
  });

  it("rejects a rename from app code into a documentation path", () => {
    const fixture = setup();
    mkdirSync(join(fixture.root, "docs"));
    git(fixture.root, "mv", "web/src/example.ts", "docs/example.md");
    git(fixture.root, "commit", "-qm", "rename app into docs");
    expect(assess(fixture).eligible).toBe(false);
  });

  it("does not accept a symlink masquerading as a Markdown file", () => {
    const fixture = setup();
    mkdirSync(join(fixture.root, "docs"));
    symlinkSync("../data/index.json", join(fixture.root, "docs/data.md"));
    git(fixture.root, "add", "docs/data.md");
    git(fixture.root, "commit", "-qm", "symlink");
    expect(assess(fixture).reason).toContain("non-regular");
  });

  it("keeps main, develop, release, mismatched refs and ambiguous pushes strict", () => {
    const fixture = setup();
    const input = inputFor(fixture);
    expect(assess(fixture, input, "upstream").eligible).toBe(false);
    expect(assess(fixture, input, "origin", "different-url").eligible).toBe(false);
    expect(assess(fixture, inputFor(fixture, "refs/heads/main")).eligible).toBe(false);
    expect(assess(fixture, input.replaceAll("docs-only", "develop")).eligible).toBe(false);
    expect(assess(fixture, "").eligible).toBe(false);
    expect(assess(fixture, input + input).eligible).toBe(false);
    expect(assess(fixture, "refs/heads/docs-only bad refs/heads/docs-only bad\n").eligible).toBe(false);
    expect(assess(fixture, input.replace(/ [0-9a-f]{40} refs\/heads\//, ` ${ZERO_SHA} refs/heads/`)).eligible).toBe(false);
  });

  it("rejects an unverified or non-ancestor develop base and a dirty tracked checkout", () => {
    const fixture = setup();
    git(fixture.root, "update-ref", "refs/remotes/origin/develop", fixture.mainSha);
    expect(assess(fixture).reason).toContain("origin/develop is missing, outdated");
    git(fixture.root, "fetch", "-q", "origin", "develop");

    git(fixture.root, "switch", "-q", "develop");
    commit(fixture.root, "docs/other.md", "Advanced develop\n");
    git(fixture.root, "push", "-q", "origin", "develop");
    git(fixture.root, "switch", "-q", "docs-only");
    expect(assess(fixture).reason).toContain("cannot verify develop ancestry");

    write(fixture.root, "README.md", "Uncommitted content\n");
    expect(assess(fixture).reason).toContain("tracked checkout differs");
  });

  it("does not let an outer Git hook's repository-pinning environment redirect checks", () => {
    const fixture = setup();
    const original = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(repoRoot, ".git");
      expect(assess(fixture).eligible).toBe(true);
    } finally {
      if (original === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = original;
    }
  });

  it("fails closed if Git cannot read the committed diff", () => {
    const fixture = setup();
    const treeSha = git(fixture.root, "rev-parse", `${fixture.developSha}^{tree}`);
    unlinkSync(join(fixture.root, ".git/objects", treeSha.slice(0, 2), treeSha.slice(2)));
    const decision = assess(fixture);
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("cannot verify develop PR diff");
  });

  it("keeps secret scan, full unit, Web build, Publisher E2E and a final remote recheck wired", () => {
    const hook = readFileSync(join(repoRoot, "scripts/git-hooks/pre-push"), "utf8");
    const schema = readFileSync(join(repoRoot, "tests/data-schema.test.ts"), "utf8");
    expect(hook).toContain('node "$ROOT/scripts/scan-secrets.mjs" --range "$range"');
    expect(hook).toContain('node "$ROOT/scripts/pre-push-data-freshness.mjs" "$remote" "$url"');
    expect(hook).toContain("test_env=(env -u ALLOW_STALE_DATA -u PRE_PUSH_DEVELOP_DOCS_INPUT");
    expect(hook).toContain('if ! "${test_env[@]}" npm --prefix "$ROOT" test; then');
    expect(hook).toContain('npm --prefix "$ROOT" run build:web');
    expect(hook).toContain('test tests/e2e/publisher.spec.ts');
    expect(hook.match(/node "\$ROOT\/scripts\/pre-push-data-freshness\.mjs"/g)).toHaveLength(2);
    expect(schema).toContain("assessDevelopDocsOnlyPush(process.cwd()");
    expect(schema).toContain("expect(ageHours).toBeLessThanOrEqual(STALE_DATA_MAX_AGE_HOURS)");
  });
});
