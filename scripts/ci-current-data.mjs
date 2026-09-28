import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ARCHIVE_PATH_RE = /^data\/archive\/(?:_index|\d{4}-\d{2})\.json$/;
const SNAPSHOT_PATH_RE = /^data\/(?:index|bodies|stats|approved-entries)\.json$/;
const REQUIRED_PATHS = [
  "data/approved-entries.json",
  "data/archive/_index.json",
  "data/bodies.json",
  "data/index.json",
  "data/stats.json",
];
export const MAX_DATA_AGE_HOURS = 36;

function git(root, args, buffer = false) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX"]) {
    delete env[key];
  }
  return execFileSync("git", args, {
    cwd: root,
    env,
    encoding: buffer ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new Error(`CI data snapshot: invalid ${label}`);
  }
  return value;
}

function snapshotPath(path) {
  return SNAPSHOT_PATH_RE.test(path) || ARCHIVE_PATH_RE.test(path);
}

export function assertFreshIndex(contents, now = Date.now()) {
  let data;
  try {
    data = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error("CI data snapshot: invalid main data/index.json");
  }
  const generatedAt = data?.generatedAt;
  const timestamp = typeof generatedAt === "string" ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== generatedAt) {
    throw new Error("CI data snapshot: main index is missing a UTC generatedAt");
  }
  const ageHours = (now - timestamp) / 3_600_000;
  if (ageHours > MAX_DATA_AGE_HOURS || ageHours < -5 / 60) {
    throw new Error(`CI data snapshot: remote main index is stale or future-dated (${ageHours.toFixed(2)} hours)`);
  }
  return generatedAt;
}

export function assertSnapshotPaths(paths) {
  if (new Set(paths).size !== paths.length
    || paths.some((path) => !snapshotPath(path))
    || REQUIRED_PATHS.some((path) => !paths.includes(path))) {
    throw new Error("CI data snapshot: incomplete or unexpected main data paths");
  }
  return [...paths].sort();
}

export function assertNoGeneratedEdits(paths) {
  const conflicts = paths.filter((path) => snapshotPath(path) || path.startsWith("data/archive/"));
  if (conflicts.length) {
    throw new Error(`CI data snapshot: refusing to replace PR-modified data: ${conflicts.join(", ")}`);
  }
}

function listGitPaths(root, ref, pathspecs) {
  return git(root, ["ls-tree", "-r", "-z", "--name-only", ref, "--", ...pathspecs])
    .split("\0").filter(Boolean);
}

function readGitFile(root, ref, path) {
  const mode = git(root, ["ls-tree", ref, "--", path]).trim().split(/\s+/)[0];
  if (mode !== "100644") {
    throw new Error(`CI data snapshot: ${path} is not a regular tracked JSON file`);
  }
  return git(root, ["show", `${ref}:${path}`], true);
}

function walkFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((item) => {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) return walkFiles(root, path);
    if (!item.isFile() || item.isSymbolicLink()) {
      throw new Error(`CI data snapshot: non-regular artifact member ${path}`);
    }
    return [path];
  });
}

function readSnapshot(root, expectedMainSha, now) {
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error("CI data snapshot: artifact directory is missing or unsafe");
  }
  const manifestPath = join(root, "snapshot.json");
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()
    || lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error("CI data snapshot: artifact manifest is missing or unsafe");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schemaVersion !== 1 || !SHA_RE.test(manifest.headSha)
    || manifest.mainSha !== assertSha(expectedMainSha, "expected main SHA")
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("CI data snapshot: artifact identity is invalid");
  }
  const paths = assertSnapshotPaths(Object.keys(manifest.files));
  const actual = walkFiles(root).sort();
  if (JSON.stringify(actual) !== JSON.stringify(["snapshot.json", ...paths].sort())) {
    throw new Error("CI data snapshot: artifact file inventory differs from manifest");
  }
  for (const path of paths) {
    if (!DIGEST_RE.test(manifest.files[path])
      || digest(readFileSync(join(root, path))) !== manifest.files[path]) {
      throw new Error(`CI data snapshot: digest mismatch for ${path}`);
    }
  }
  if (assertFreshIndex(readFileSync(join(root, "data/index.json")), now) !== manifest.generatedAt) {
    throw new Error("CI data snapshot: generatedAt differs from manifest");
  }
  return { manifest, paths };
}

export function prepareCurrentData(root, snapshotRoot, baseSha, now = Date.now()) {
  const base = assertSha(baseSha, "base SHA");
  const destination = resolve(snapshotRoot);
  if (!isAbsolute(snapshotRoot) || destination === root || relative(root, destination) === ""
    || (!relative(root, destination).startsWith(`..${sep}`) && relative(root, destination) !== "..")
    || existsSync(destination)) {
    throw new Error("CI data snapshot: output must be a new directory outside the checkout");
  }
  const headSha = assertSha(git(root, ["rev-parse", "HEAD"]).trim(), "checkout HEAD");
  git(root, ["cat-file", "-e", `${base}^{commit}`]);
  const changedPaths = git(root, ["diff", "--name-only", base, headSha, "--", "data"])
    .split("\n").filter(Boolean);
  assertNoGeneratedEdits(changedPaths);
  git(root, ["fetch", "--quiet", "--no-tags", "origin", "main"]);
  const mainSha = assertSha(git(root, ["rev-parse", "FETCH_HEAD"]).trim(), "remote main SHA");
  const archivePaths = listGitPaths(root, mainSha, ["data/archive"]);
  const paths = assertSnapshotPaths([...REQUIRED_PATHS.filter((path) => path !== "data/archive/_index.json"), ...archivePaths]);
  const contents = new Map(paths.map((path) => [path, readGitFile(root, mainSha, path)]));
  const generatedAt = assertFreshIndex(contents.get("data/index.json"), now);
  const manifest = {
    schemaVersion: 1,
    headSha,
    mainSha,
    generatedAt,
    files: Object.fromEntries(paths.map((path) => [path, digest(contents.get(path))])),
  };
  mkdirSync(destination);
  for (const [path, value] of contents) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value, { flag: "wx" });
  }
  writeFileSync(join(destination, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  readSnapshot(destination, mainSha, now);
  return manifest;
}

export function applyCurrentData(root, snapshotRoot, expectedMainSha, now = Date.now()) {
  const { manifest, paths } = readSnapshot(resolve(snapshotRoot), expectedMainSha, now);
  if (git(root, ["rev-parse", "HEAD"]).trim() !== manifest.headSha) {
    throw new Error("CI data snapshot: checkout HEAD changed after snapshot capture");
  }
  const trackedPaths = ["data/index.json", "data/bodies.json", "data/stats.json", "data/approved-entries.json", "data/archive"];
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...trackedPaths]).trim()) {
    throw new Error("CI data snapshot: checkout generated data was edited before hydration");
  }
  const archiveDir = join(root, "data/archive");
  const existingArchive = readdirSync(archiveDir, { withFileTypes: true }).map((item) => {
    if (!item.isFile() || item.isSymbolicLink() || !ARCHIVE_PATH_RE.test(`data/archive/${item.name}`)) {
      throw new Error(`CI data snapshot: unsafe checkout archive member ${item.name}`);
    }
    return `data/archive/${item.name}`;
  });
  const required = new Set(paths);
  for (const path of existingArchive) {
    if (!required.has(path)) rmSync(join(root, path));
  }
  for (const path of paths) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(snapshotRoot, path)));
    if (digest(readFileSync(target)) !== manifest.files[path]) {
      throw new Error(`CI data snapshot: hydration failed for ${path}`);
    }
  }
  const finalArchive = readdirSync(archiveDir).map((name) => `data/archive/${name}`).sort();
  if (JSON.stringify(finalArchive) !== JSON.stringify(paths.filter((path) => path.startsWith("data/archive/")))) {
    throw new Error("CI data snapshot: hydrated archive is not the pinned main archive");
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, snapshotRoot, revision] = process.argv.slice(2);
    if (process.argv.length !== 5 || !["prepare", "apply"].includes(mode)) {
      throw new Error("usage: node scripts/ci-current-data.mjs <prepare|apply> <artifact-dir> <base-SHA|main-SHA>");
    }
    const manifest = mode === "prepare"
      ? prepareCurrentData(ROOT, snapshotRoot, revision)
      : applyCurrentData(ROOT, snapshotRoot, revision);
    if (mode === "prepare" && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `main_sha=${manifest.mainSha}\n`);
    }
    console.log(`CI data snapshot: ${mode} ${manifest.mainSha} (${Object.keys(manifest.files).length} files, ${manifest.generatedAt})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
