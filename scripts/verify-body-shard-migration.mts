/**
 * Read-only migration proof pinned to the current remote main SHA.
 * Does not stage, write, or publish any body data.
 *
 * node --import tsx scripts/verify-body-shard-migration.mts --main-sha <40-hex-sha>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BODY_SHARD_PATHS,
  BODY_SHARD_TARGET_BYTES,
  BODY_TOTAL_TARGET_BYTES,
  LEGACY_BODY_PATH,
  assertBodyStorageMode,
  serializeBodyShards,
} from "../web/src/lib/body-shards.ts";
import { assertBodyShardDigests } from "../web/src/lib/body-shard-integrity.ts";
import { isRealBody, readBodyStorage, type BodyRecord, type BodiesPayload } from "../worker/src/bodies-file.ts";
import { validateArticleChat } from "../worker/src/article-chat.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHA_RE = /^[a-f0-9]{40}$/;
const HISTORY_COMMITS = 13;

function git(args: string[], buffer = false, cwd = ROOT, extraEnv: NodeJS.ProcessEnv = {}): string | Buffer {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX",
  ]) {
    delete env[name];
  }
  Object.assign(env, extraEnv);
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: buffer ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function mainRef(): string {
  const line = String(git(["ls-remote", "--heads", "origin", "main"])).trim();
  const [sha, name] = line.split(/\s+/);
  if (!SHA_RE.test(sha ?? "") || name !== "refs/heads/main") {
    throw new Error("unable to verify the current remote main SHA");
  }
  return sha!;
}

function fileAt(sha: string, path: string): string {
  return (git(["show", `${sha}:${path}`], true) as Buffer).toString("utf8");
}

function digest(record: BodyRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function assertBodyRecords(payload: BodiesPayload, liveIds: ReadonlySet<string>): void {
  for (const [id, record] of Object.entries(payload.bodies)) {
    if (!liveIds.has(id) || !isRealBody(record)
      || (record.chat !== undefined && !validateArticleChat(record.chat))) {
      throw new Error(`body migration source has an orphan, filler, or invalid chat: ${id}`);
    }
  }
}

function historyGrowth(sha: string, measurePack = false): {
  commits: number;
  oldest: string;
  latest: string;
  replayedShas: string[];
  legacyBlobBytes: number;
  projectedShardBlobBytes: number;
  changedShardsPerUpdate: number[];
  packReplay?: {
    singleSizePackKiB: number;
    shardsSizePackKiB: number;
    differenceKiB: number;
    ratio: number;
    commitsEach: number;
    emptyShardCommits: number;
  };
} {
  const commits = String(git([
    "log", "--format=%H", "-n", String(HISTORY_COMMITS), sha, "--", LEGACY_BODY_PATH,
  ])).trim().split("\n").filter(Boolean);
  const snapshots = commits.map((revision) => ({
    revision,
    content: fileAt(revision, LEGACY_BODY_PATH),
  }));
  let legacyBlobBytes = 0;
  let projectedShardBlobBytes = 0;
  const changedShardsPerUpdate: number[] = [];
  for (let index = 0; index + 1 < snapshots.length; index++) {
    const after = snapshots[index]!;
    const before = snapshots[index + 1]!;
    const newer = readBodyStorage(after.content, [null, null, null, null]).payload;
    const older = readBodyStorage(before.content, [null, null, null, null]).payload;
    const oldParts = serializeBodyShards(older);
    const newParts = serializeBodyShards(newer);
    let changed = 0;
    for (const [partIndex, part] of newParts.entries()) {
      const previous = JSON.parse(oldParts[partIndex]!.content) as BodiesPayload;
      const next = JSON.parse(part.content) as BodiesPayload;
      if (JSON.stringify(previous.bodies) !== JSON.stringify(next.bodies)) {
        projectedShardBlobBytes += Buffer.byteLength(part.content);
        changed += 1;
      }
    }
    legacyBlobBytes += Buffer.byteLength(after.content);
    changedShardsPerUpdate.push(changed);
  }
  return {
    commits: Math.max(0, snapshots.length - 1),
    oldest: snapshots.at(-1)?.revision ?? sha,
    latest: snapshots[0]?.revision ?? sha,
    replayedShas: snapshots.map((snapshot) => snapshot.revision).reverse(),
    legacyBlobBytes,
    projectedShardBlobBytes,
    changedShardsPerUpdate: changedShardsPerUpdate.reverse(),
    ...(measurePack ? { packReplay: replayPackedHistory(snapshots) } : {}),
  };
}

function replayPackedHistory(snapshots: readonly { revision: string; content: string }[]) {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "techdb-body-pack-replay-"));
  const chronological = [...snapshots].reverse();
  const packed = (kind: "single" | "shards") => {
    const repo = resolve(temporaryRoot, kind);
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], false, repo);
    git(["config", "user.name", "Body projection"], false, repo);
    git(["config", "user.email", "body-projection@example.invalid"], false, repo);
    mkdirSync(resolve(repo, "data"));
    let previous: BodiesPayload | null = null;
    let emptyCommits = 0;
    for (const [index, snapshot] of chronological.entries()) {
      const payload = readBodyStorage(snapshot.content, [null, null, null, null]).payload;
      if (kind === "single") {
        writeFileSync(resolve(repo, LEGACY_BODY_PATH), snapshot.content, "utf8");
      } else {
        const nextFiles = serializeBodyShards(payload);
        const oldParts = previous ? serializeBodyShards(previous) : null;
        for (const [part, file] of nextFiles.entries()) {
          const old = oldParts?.[part];
          if (old && JSON.stringify((JSON.parse(old.content) as BodiesPayload).bodies)
            === JSON.stringify((JSON.parse(file.content) as BodiesPayload).bodies)) continue;
          writeFileSync(resolve(repo, file.path), file.content, "utf8");
        }
      }
      git(["add", "-A", "--", "data"], false, repo);
      const changed = String(git(["diff", "--cached", "--name-only"], false, repo)).trim() !== "";
      if (!changed) emptyCommits += 1;
      // Same timestamps in both disposable histories. The real source
      // revision is recorded in the message, never source content.
      const stamp = String(git(["show", "-s", "--format=%cI", snapshot.revision])).trim();
      git(
        ["commit", "-q", ...(changed ? [] : ["--allow-empty"]), "-m", `body snapshot ${index} ${snapshot.revision}`],
        false,
        repo,
        { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
      );
      previous = payload;
    }
    git(["gc", "--quiet"], false, repo);
    const objects = String(git(["count-objects", "-v"], false, repo));
    const size = Number(objects.match(/^size-pack:\s*(\d+)$/m)?.[1]);
    const commits = Number(String(git(["rev-list", "--count", "HEAD"], false, repo)).trim());
    if (!Number.isFinite(size) || commits !== chronological.length) {
      throw new Error(`incomplete ${kind} packed-history replay`);
    }
    return { size, commits, emptyCommits };
  };
  try {
    const single = packed("single");
    const shards = packed("shards");
    return {
      singleSizePackKiB: single.size,
      shardsSizePackKiB: shards.size,
      differenceKiB: shards.size - single.size,
      ratio: single.size ? Number((shards.size / single.size).toFixed(4)) : 0,
      commitsEach: single.commits,
      emptyShardCommits: shards.emptyCommits,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function verifyBodyShardMigration(sha: string, measurePack = false) {
  if (!SHA_RE.test(sha)) throw new Error("pass an exact lowercase --main-sha");
  if (mainRef() !== sha) throw new Error("remote main advanced before the body migration proof");
  git(["fetch", "--quiet", "--no-tags", "origin", "main"]);
  if (String(git(["rev-parse", "FETCH_HEAD"])).trim() !== sha) {
    throw new Error("remote main advanced during the body migration proof");
  }
  const index = JSON.parse(fileAt(sha, "data/index.json")) as {
    count?: number;
    entries?: Array<{ id?: string }>;
    health?: { bodyShardDigests?: unknown; bodyStorageMode?: unknown };
  };
  if (!Array.isArray(index.entries) || index.count !== index.entries.length
    || index.entries.some((entry) => typeof entry.id !== "string")) {
    throw new Error("captured main index is invalid");
  }
  const legacyContent = fileAt(sha, LEGACY_BODY_PATH);
  const legacy = readBodyStorage(legacyContent, [null, null, null, null]).payload;
  const inventory = String(git([
    "ls-tree", "-r", "--name-only", sha, "--", ...BODY_SHARD_PATHS,
  ])).split("\n").filter(Boolean);
  if (inventory.length !== 0 && inventory.length !== BODY_SHARD_PATHS.length) {
    throw new Error("remote main has a partial body shard inventory");
  }
  const actualShardContents = inventory.length
    ? BODY_SHARD_PATHS.map((path) => fileAt(sha, path))
    : null;
  assertBodyStorageMode(actualShardContents ? "shards-v1" : "legacy", index.health);
  const projected = serializeBodyShards(legacy);
  const projectedPayload = readBodyStorage(
    null,
    projected.map((file) => file.content),
  ).payload;
  const sourceIds = Object.keys(legacy.bodies).sort();
  if (projectedPayload.count !== legacy.count
    || JSON.stringify(Object.keys(projectedPayload.bodies).sort()) !== JSON.stringify(sourceIds)) {
    throw new Error("body shard projection changed the set of article IDs");
  }
  let checked = 0;
  for (const id of sourceIds) {
    if (digest(legacy.bodies[id]!) !== digest(projectedPayload.bodies[id]!)) {
      throw new Error(`body shard projection changed record SHA-256: ${id}`);
    }
    checked += 1;
  }
  const sizes = projected.map((file) => Buffer.byteLength(file.content));
  const totalBytes = sizes.reduce((sum, bytes) => sum + bytes, 0);
  if (totalBytes > BODY_TOTAL_TARGET_BYTES
    || sizes.some((bytes) => bytes > BODY_SHARD_TARGET_BYTES)) {
    throw new Error("lossless body shard projection exceeds the operational target");
  }
  if (!actualShardContents) {
    assertBodyRecords(legacy, new Set(index.entries.map((entry) => entry.id!)));
  } else {
    assertBodyShardDigests(actualShardContents, index.health?.bodyShardDigests);
    const actual = readBodyStorage(null, actualShardContents).payload;
    assertBodyRecords(actual, new Set(index.entries.map((entry) => entry.id!)));
  }
  const history = historyGrowth(sha, measurePack);
  if (mainRef() !== sha) throw new Error("remote main advanced during the body migration proof");
  return {
    mode: "read-only",
    mainSha: sha,
    legacy: { count: legacy.count, bytes: Buffer.byteLength(legacyContent) },
    projection: {
      count: projectedPayload.count,
      recordSha256ParityChecked: checked,
      missingIds: 0,
      changedRecordDigests: 0,
      shardCounts: projected.map((file) => (JSON.parse(file.content) as BodiesPayload).count),
      shardBytes: sizes,
      totalBytes,
    },
    currentStorage: actualShardContents ? "shards-v1" : "legacy",
    history,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (![4, 5].includes(process.argv.length) || process.argv[2] !== "--main-sha"
      || (process.argv.length === 5 && process.argv[4] !== "--measure-pack")) {
      throw new Error("usage: node --import tsx scripts/verify-body-shard-migration.mts --main-sha <40-hex-sha> [--measure-pack]");
    }
    console.log(JSON.stringify(
      verifyBodyShardMigration(process.argv[3]!, process.argv[4] === "--measure-pack"),
      null,
      2,
    ));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
