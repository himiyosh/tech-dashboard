import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, "scripts/apply-summary-cache.mjs");

function scratchDir(label: string): string {
  const root = join(repoRoot, `.apply-summary-cache-test-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

function runCli(cwd: string, args: string[] = []) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function writeFixture(root: string, cacheEntry: Record<string, unknown>) {
  const index = {
    generatedAt: "2026-07-01T00:00:00.000Z",
    count: 1,
    entries: [{
      id: "entry-1",
      url: "https://example.com/release",
      title: "Original release title",
      titleJa: "元のリリースタイトル",
      titleEn: "Original release title",
      summaryJa: "既存の日本語要約。",
      summaryEn: "Existing English summary.",
      importance: 2,
      tags: ["release"],
    }],
  };
  writeFileSync(join(root, "data/index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  writeFileSync(
    join(root, "data/_summary-cache.json"),
    `${JSON.stringify({ "https://example.com/release": cacheEntry }, null, 2)}\n`,
    "utf8",
  );
}

describe("apply-summary-cache CLI", () => {
  it("rejects title-echo cache data even with --force-summary", () => {
    const root = scratchDir("quality");
    try {
      writeFixture(root, {
        titleJa: "キャッシュタイトル",
        summaryJa: "キャッシュが生成した日本語要約。",
        summaryEn: '"Original release title."',
        model: "claude-opus-4.8",
      });
      const indexPath = join(root, "data/index.json");
      const before = readFileSync(indexPath, "utf8");

      const result = runCli(root, ["--force-summary"]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        cacheHits: 1,
        cacheRejected: 1,
        summaryApplied: 0,
      });
      expect(readFileSync(indexPath, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to race another data artifact writer", () => {
    const root = scratchDir("writer-lock");
    try {
      writeFixture(root, {
        titleJa: "キャッシュタイトル",
        summaryJa: "キャッシュが生成した日本語要約。",
        summaryEn: "The cache contains a complete English summary.",
        model: "claude-opus-4.8",
      });
      const lockPath = join(root, "data/.clean-source-noise.transaction.json.lock");
      const lockContent = JSON.stringify({
        version: 1,
        ownerToken: "test-owner",
        pid: process.pid,
        createdAt: "2026-07-01T00:00:00.000Z",
      }, null, 2) + "\n";
      writeFileSync(lockPath, lockContent, "utf8");

      const result = runCli(root);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Another data artifact writer owns");
      expect(readFileSync(lockPath, "utf8")).toBe(lockContent);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects body-in-index compatibility flags", () => {
    const root = scratchDir("body-flag");
    try {
      writeFixture(root, {});

      const result = runCli(root, ["--fill-missing-body"]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("body-file architecture");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
