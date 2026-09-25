import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCurrentData,
  assertFreshIndex,
  assertNoGeneratedEdits,
  assertSnapshotPaths,
  prepareCurrentData,
} from "../scripts/ci-current-data.mjs";

const required = [
  "data/approved-entries.json",
  "data/archive/_index.json",
  "data/bodies.json",
  "data/index.json",
  "data/stats.json",
];
const cleanGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: cleanGitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root: string, path: string, contents: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function json(root: string, path: string, value: unknown): void {
  write(root, path, `${JSON.stringify(value)}\n`);
}

function setup(mainAgeMs = 60_000) {
  const directory = mkdtempSync(join(tmpdir(), "techdb-ci-data-"));
  const root = join(directory, "repo");
  const remote = join(directory, "remote.git");
  const snapshot = join(directory, "snapshot");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "init", "--bare", "-q", remote);
  git(root, "remote", "add", "origin", remote);

  const oldClock = new Date(Date.now() - 200 * 3_600_000).toISOString();
  json(root, "data/index.json", { generatedAt: oldClock, count: 0, entries: [] });
  json(root, "data/bodies.json", { generatedAt: oldClock, count: 0, bodies: {} });
  json(root, "data/stats.json", { generatedAt: oldClock, totals: {} });
  json(root, "data/approved-entries.json", { version: 1, approvals: [] });
  json(root, "data/archive/_index.json", { generatedAt: oldClock, months: ["2026-08"] });
  json(root, "data/archive/2026-08.json", { month: "2026-08", entries: [] });
  git(root, "add", "data");
  git(root, "commit", "-qm", "old develop data");
  const baseSha = git(root, "rev-parse", "HEAD");
  git(root, "branch", "develop");

  const mainClock = new Date(Date.now() - mainAgeMs).toISOString();
  json(root, "data/index.json", { generatedAt: mainClock, count: 0, entries: [] });
  json(root, "data/bodies.json", { generatedAt: mainClock, count: 0, bodies: {} });
  json(root, "data/stats.json", { generatedAt: mainClock, totals: {} });
  json(root, "data/archive/_index.json", { generatedAt: mainClock, months: ["2026-09"] });
  rmSync(join(root, "data/archive/2026-08.json"));
  json(root, "data/archive/2026-09.json", { month: "2026-09", entries: [] });
  git(root, "add", "-A", "data");
  git(root, "commit", "-qm", "fresh main snapshot");
  const mainSha = git(root, "rev-parse", "HEAD");
  git(root, "push", "-q", "origin", "main");

  git(root, "switch", "-q", "-c", "tracker", "develop");
  const seed = '{"schemaVersion":1,"initializedAt":null}\n';
  write(root, "data/updates/_index.json", seed);
  write(root, "feature.txt", "tracker code\n");
  git(root, "add", "data/updates/_index.json", "feature.txt");
  git(root, "commit", "-qm", "add tracker seed and code");
  return { directory, root, snapshot, baseSha, mainSha, mainClock, seed };
}

describe("immutable main data for feature-branch CI", () => {
  it("keeps the 36-hour freshness gate and rejects malformed or future dates", () => {
    const generatedAt = "2026-09-25T00:00:00.000Z";
    const time = Date.parse(generatedAt);
    const index = JSON.stringify({ generatedAt });
    expect(assertFreshIndex(index, time + 36 * 3_600_000)).toBe(generatedAt);
    expect(() => assertFreshIndex(index, time + 36 * 3_600_000 + 1)).toThrow(/stale/);
    expect(() => assertFreshIndex(index, time - 5 * 60_000 - 1)).toThrow(/future-dated/);
    expect(() => assertFreshIndex('{"generatedAt":"invalid"}', time)).toThrow(/UTC generatedAt/);
  });

  it("only accepts an exact generated-data inventory, leaving the update seed outside it", () => {
    expect(assertSnapshotPaths([...required, "data/archive/2026-09.json"])).toHaveLength(6);
    expect(() => assertSnapshotPaths(required.slice(1))).toThrow(/incomplete/);
    expect(() => assertSnapshotPaths([...required, "data/archive/../updates/_index.json"]))
      .toThrow(/unexpected/);
    expect(() => assertSnapshotPaths([...required, "data/updates/_index.json"]))
      .toThrow(/unexpected/);
    expect(() => assertNoGeneratedEdits(["data/updates/_index.json"])).not.toThrow();
    expect(() => assertNoGeneratedEdits(["data/index.json"])).toThrow(/refusing to replace/);
    expect(() => assertNoGeneratedEdits(["data/approved-entries.json"])).toThrow(/refusing to replace/);
    expect(() => assertNoGeneratedEdits(["data/archive/2026-09.json"])).toThrow(/refusing to replace/);
  });

  it("uses one fresh main SHA across all generated files while preserving the tracker seed", () => {
    const fixture = setup();
    try {
      const manifest = prepareCurrentData(fixture.root, fixture.snapshot, fixture.baseSha);
      expect(manifest.mainSha).toBe(fixture.mainSha);
      expect(manifest.generatedAt).toBe(fixture.mainClock);
      expect(Object.keys(manifest.files)).toEqual([
        "data/approved-entries.json",
        "data/archive/2026-09.json",
        "data/archive/_index.json",
        "data/bodies.json",
        "data/index.json",
        "data/stats.json",
      ]);
      expect(Object.keys(manifest.files)).not.toContain("data/updates/_index.json");

      const applied = applyCurrentData(fixture.root, fixture.snapshot, fixture.mainSha);
      expect(applied.mainSha).toBe(fixture.mainSha);
      expect(readFileSync(join(fixture.root, "data/index.json"), "utf8"))
        .toBe(readFileSync(join(fixture.snapshot, "data/index.json"), "utf8"));
      expect(existsSync(join(fixture.root, "data/archive/2026-08.json"))).toBe(false);
      expect(existsSync(join(fixture.root, "data/archive/2026-09.json"))).toBe(true);
      expect(readFileSync(join(fixture.root, "data/updates/_index.json"), "utf8")).toBe(fixture.seed);
      expect(git(fixture.root, "rev-parse", "HEAD"))
        .not.toBe(fixture.mainSha);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("refuses to mask intentionally changed generated files before capturing a snapshot", () => {
    const fixture = setup();
    try {
      json(fixture.root, "data/index.json", { generatedAt: fixture.mainClock, count: 1, entries: [] });
      git(fixture.root, "add", "data/index.json");
      git(fixture.root, "commit", "-qm", "intentionally change generated data");
      expect(() => prepareCurrentData(fixture.root, fixture.snapshot, fixture.baseSha))
        .toThrow(/refusing to replace PR-modified data: data\/index.json/);
      expect(existsSync(fixture.snapshot)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed when remote main itself is older than 36 hours", () => {
    const fixture = setup(50 * 3_600_000);
    try {
      expect(() => prepareCurrentData(fixture.root, fixture.snapshot, fixture.baseSha))
        .toThrow(/remote main index is stale/);
      expect(existsSync(fixture.snapshot)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a changed HEAD, edited checkout data, and a corrupted artifact before writing", () => {
    const fixture = setup();
    try {
      prepareCurrentData(fixture.root, fixture.snapshot, fixture.baseSha);
      expect(() => applyCurrentData(fixture.root, fixture.snapshot, fixture.baseSha))
        .toThrow(/artifact identity/);
      const checkoutIndex = readFileSync(join(fixture.root, "data/index.json"), "utf8");
      write(fixture.root, "data/index.json", '{"generatedAt":"locally changed"}\n');
      expect(() => applyCurrentData(fixture.root, fixture.snapshot, fixture.mainSha))
        .toThrow(/checkout generated data was edited/);
      expect(readFileSync(join(fixture.root, "data/index.json"), "utf8"))
        .toBe('{"generatedAt":"locally changed"}\n');
      write(fixture.root, "data/index.json", checkoutIndex);
      write(fixture.root, "feature.txt", "new commit\n");
      git(fixture.root, "add", "feature.txt");
      git(fixture.root, "commit", "-qm", "change checkout HEAD");
      expect(() => applyCurrentData(fixture.root, fixture.snapshot, fixture.mainSha))
        .toThrow(/HEAD changed/);
      write(fixture.snapshot, "data/stats.json", "corrupt artifact\n");
      expect(() => applyCurrentData(fixture.root, fixture.snapshot, fixture.mainSha))
        .toThrow(/digest mismatch/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }, 20_000);
});
