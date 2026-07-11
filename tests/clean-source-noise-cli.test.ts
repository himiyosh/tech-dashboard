import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts/clean-source-noise.mjs");
const dataRoot = join(repoRoot, "data");

function collectJsonFiles(dir: string): string[] {
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectJsonFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) entries.push(fullPath);
  }
  return entries.sort((a, b) => a.localeCompare(b));
}

function snapshotDataTree() {
  return collectJsonFiles(dataRoot).map((path) => {
    const content = readFileSync(path);
    const stats = statSync(path);
    return {
      path,
      hash: createHash("sha256").update(content).digest("hex"),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    };
  });
}

function runCli(args: string[], cwd = repoRoot) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("clean-source-noise CLI safety", () => {
  it("treats --help as a no-op that prints usage and never applies", () => {
    const before = snapshotDataTree();
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("npm run noise:clean -- --dry-run");
    expect(result.stdout).toContain("npm run noise:clean -- --apply");
    expect(result.stdout).not.toContain("npm run noise:clean\n");
    expect(result.stdout).toContain("explicit mode is required");
    expect(result.stdout).not.toContain("APPLIED");
    expect(result.stderr).toBe("");
    expect(snapshotDataTree()).toEqual(before);
  });

  it("rejects no args without applying or mutating any data file", () => {
    const before = snapshotDataTree();
    const result = runCli([]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("APPLIED");
    expect(result.stderr).toContain("Explicit mode required");
    expect(result.stderr).toContain("--dry-run");
    expect(result.stderr).toContain("--apply");
    expect(snapshotDataTree()).toEqual(before);
  });

  it("rejects unknown arguments without applying or mutating data", () => {
    const before = snapshotDataTree();
    const result = runCli(["--definitely-not-a-real-flag"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("APPLIED");
    expect(result.stderr).toContain("Unknown argument(s)");
    expect(result.stderr).toContain("definitely-not-a-real-flag");
    expect(snapshotDataTree()).toEqual(before);
  });

  it("rejects conflicting flags without applying or mutating data", () => {
    const before = snapshotDataTree();
    const result = runCli(["--dry-run", "--apply"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("APPLIED");
    expect(result.stderr).toContain("Conflicting flags");
    expect(snapshotDataTree()).toEqual(before);
  });

  it("aborts a dry-run without recovering or changing a pending active transaction", () => {
    const scratchRoot = join(repoRoot, `.clean-source-noise-cli-test-${process.pid}-${Date.now()}`);
    const scratchData = join(scratchRoot, "data");
    mkdirSync(scratchData, { recursive: true });
    try {
      const targetPath = join(scratchData, "index.json");
      const backupPath = join(scratchData, ".index.json.pending.bak");
      const tempPath = join(scratchData, ".index.json.pending.tmp");
      const journalPath = join(scratchData, ".clean-source-noise.transaction.json");
      writeFileSync(targetPath, '{"generation":"new"}\n', "utf8");
      writeFileSync(backupPath, '{"generation":"old"}\n', "utf8");
      writeFileSync(tempPath, '{"generation":"new"}\n', "utf8");
      writeFileSync(
        journalPath,
        JSON.stringify({
          version: 1,
          state: "active",
          journalPath,
          files: [{ path: targetPath, tempPath, backupPath, existed: true }],
        }, null, 2) + "\n",
        "utf8",
      );
      const before = new Map(
        [targetPath, backupPath, journalPath].map((path) => [path, readFileSync(path)]),
      );

      const result = runCli(["--dry-run"], scratchRoot);

      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("DRY RUN ONLY");
      expect(result.stderr).toContain("Pending transaction journal detected");
      expect(result.stderr).toContain("--dry-run is strictly read-only");
      expect(result.stderr).toContain("Run --apply to recover");
      for (const [path, bytes] of before) {
        expect(readFileSync(path)).toEqual(bytes);
      }
    } finally {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });
});
