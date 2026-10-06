import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAuditArgs, runAudit } from "../.claude/skills/quality-audit/run.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = join(repoRoot, ".claude", "skills", "quality-audit", "run.ts");
const now = Date.parse("2026-10-06T12:00:00.000Z");
const reportName = "audit-2026-10-06T12-00-00-000Z.md";
const fixtureRoots: string[] = [];

function createFixture(existingReport = false): string {
  const root = mkdtempSync(join(tmpdir(), "techdb-quality-audit-"));
  fixtureRoots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "index.json"), JSON.stringify({
    generatedAt: "2026-10-06T11:00:00.000Z",
    count: 2,
    health: {
      lastRunAt: "2026-10-06T11:00:00.000Z",
      copilotOk: true,
      sourcesAttempted: 2,
      sourcesOk: 2,
      sourcesFailed: [],
      queueMode: "enabled",
      summaryQueueBacklog: 1,
      summaryQueueEnqueued: 1,
      bodyQueueMode: "enabled",
      bodyBacklog: 0,
      bodyEnqueued: 0,
      enrichmentEnqueueCap: 2,
      enrichmentEnqueued: 1,
    },
    entries: [
      {
        id: "guide",
        source: "anthropic-engineering",
        url: "https://example.com/guide",
        title: "A model evaluation guide",
        summaryJa: "モデル評価の手順と注意点を説明するガイドです。",
        summaryEn: "The guide describes how to evaluate models.",
        publishedAt: "2026-10-06T10:00:00.000Z",
        collectedAt: "2026-10-06T11:00:00.000Z",
        tags: ["llm"],
        category: "research",
        importance: 2,
        evergreen: true,
        contentSnippet: "A guide to evaluating models",
      },
      {
        id: "pending",
        source: "zenn-ai",
        url: "https://example.com/pending",
        title: "A pending summary",
        summaryJa: "このエントリは AI 要約未生成です。",
        summaryEn: "AI summary not yet available.",
        publishedAt: "2026-10-05T10:00:00.000Z",
        collectedAt: "2026-10-06T11:00:00.000Z",
        tags: ["LLM"],
        category: "local-llm",
        importance: 1,
      },
    ],
  }));
  if (existingReport) {
    mkdirSync(join(dataDir, "_runs"));
    writeFileSync(join(dataDir, "_runs", "audit-existing.md"), "previous report\n");
  }
  return root;
}

function snapshotTree(root: string) {
  const snapshot: Array<{ path: string; kind: string; mode: number; mtimeMs: number; sha256: string | null }> = [];
  const visit = (relativeDir: string) => {
    for (const entry of readdirSync(join(root, relativeDir), { withFileTypes: true })) {
      const path = join(relativeDir, entry.name);
      const absolutePath = join(root, path);
      const stats = statSync(absolutePath);
      snapshot.push({
        path,
        kind: entry.isDirectory() ? "directory" : "file",
        mode: stats.mode,
        mtimeMs: stats.mtimeMs,
        sha256: entry.isFile()
          ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
          : null,
      });
      if (entry.isDirectory()) visit(path);
    }
  };
  visit("");
  return snapshot.sort((a, b) => a.path.localeCompare(b.path));
}

async function captureLogs(args: readonly string[], root: string): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  try {
    await runAudit(args, root, now);
  } finally {
    spy.mockRestore();
  }
  return logs;
}

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true });
  fixtureRoots.length = 0;
});

describe("quality-audit CLI output", () => {
  it.each([false, true])("prints the complete report without changing any file (existing _runs: %s)", async (existingReport) => {
    const root = createFixture(existingReport);
    const before = snapshotTree(root);
    const [report] = await captureLogs(["--stdout", "--no-write"], root);
    const [repeat] = await captureLogs(["--no-write", "--stdout"], root);

    expect(report).toBe(repeat);
    expect(report).toContain("# 品質監査レポート — 2026-10-06T12:00:00.000Z");
    for (const section of [
      "## 🚦 パイプライン実行状態",
      "## ⚙️ Enrichment Queue snapshot",
      "## 🌲 Knowledge evergreen coverage",
      "## 🧭 ソース整合性",
      "## 🏥 掲載エントリ活動",
      "## 📊 カテゴリ分布",
      "## 📝 要約カバレッジ",
      "## 🏷️ タグ揺れ候補 (top 10)",
      "## 🔗 URL 重複候補 (top 10)",
    ]) {
      expect(report).toContain(section);
    }
    expect(report).toContain("- deterministic fallback: **1** 件 (50%)");
    expect(report).not.toContain("[audit] wrote");
    expect(snapshotTree(root)).toEqual(before);
    expect(existsSync(join(root, "data", "_runs"))).toBe(existingReport);
  });

  it("keeps the default file and summary output, and --stdout alone still writes the same report", async () => {
    const root = createFixture();
    const indexBefore = snapshotTree(root).find((entry) => entry.path === "data/index.json");
    const defaultLogs = await captureLogs([], root);
    const reportPath = join(root, "data", "_runs", reportName);
    const report = readFileSync(reportPath, "utf8");

    expect(defaultLogs).toHaveLength(3);
    expect(defaultLogs[0]).toBe(`[audit] wrote ${reportPath}`);
    expect(defaultLogs[1]).toMatch(/^\[audit\] summary: \d+ issues/);
    expect(defaultLogs[2]).toContain("[audit] summary coverage:");
    expect(report).toContain("## 🌲 Knowledge evergreen coverage");
    expect(snapshotTree(root).find((entry) => entry.path === "data/index.json")).toEqual(indexBefore);

    expect(await captureLogs(["--stdout"], root)).toEqual([report]);
    expect(readFileSync(reportPath, "utf8")).toBe(report);
  });

  it("shows help without reading index.json or changing an empty tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "techdb-quality-audit-help-"));
    fixtureRoots.push(root);
    const before = snapshotTree(root);

    expect((await captureLogs(["--help"], root)).join("\n")).toContain("Usage:");
    expect(snapshotTree(root)).toEqual(before);
  });

  it.each([
    { args: ["--no-write"], error: /--no-write requires --stdout/ },
    { args: ["--unknown"], error: /Unknown audit option: --unknown/ },
    { args: ["--stdout", "--stdout"], error: /Duplicate audit option: --stdout/ },
    { args: ["--help", "--no-write"], error: /--help\/-h cannot be combined/ },
    { args: ["--help", "-h"], error: /--help\/-h cannot be combined/ },
  ])("rejects $args without touching any file", async ({ args, error }) => {
    const root = createFixture(true);
    const before = snapshotTree(root);
    await expect(runAudit(args, root, now)).rejects.toThrow(error);
    expect(snapshotTree(root)).toEqual(before);
  });

  it("preserves a malformed-index error without printing a success-shaped report or writing", async () => {
    const root = createFixture();
    writeFileSync(join(root, "data", "index.json"), "{");
    const before = snapshotTree(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runAudit(["--stdout", "--no-write"], root, now)).rejects.toThrow(SyntaxError);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
    expect(snapshotTree(root)).toEqual(before);
  });

  it("returns nonzero with a clear diagnostic for invalid CLI flags", () => {
    expect(parseAuditArgs([])).toBe("write");
    expect(parseAuditArgs(["--stdout"])).toBe("stdout");
    expect(parseAuditArgs(["--stdout", "--no-write"])).toBe("stdout-no-write");
    expect(parseAuditArgs(["--help"])).toBe("help");

    for (const [args, diagnostic] of [
      [["--unknown"], "Unknown audit option: --unknown"],
      [["--no-write"], "--no-write requires --stdout"],
      [["--stdout", "--stdout"], "Duplicate audit option: --stdout"],
    ] as const) {
      const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(diagnostic);
    }
  }, 30_000);
});
