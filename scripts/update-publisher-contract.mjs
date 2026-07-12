#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(ROOT, "worker", "publisher-contract.json");
const HASHED_EXTENSIONS = new Set([".ts", ".json", ".toml"]);

function normalizedRelativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function extension(path) {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot) : "";
}

function assertSafeCriticalPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    throw new Error(`invalid critical path: ${String(path)}`);
  }
}

function collectFiles(root, path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`publisher contract paths must not contain symlinks: ${normalizedRelativePath(root, path)}`);
  }
  if (stat.isFile()) {
    if (!HASHED_EXTENSIONS.has(extension(path))) {
      throw new Error(
        `publisher contract does not support ${normalizedRelativePath(root, path)}; add its extension to HASHED_EXTENSIONS`,
      );
    }
    return [path];
  }
  if (!stat.isDirectory()) return [];

  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => collectFiles(root, join(path, entry.name)));
}

function comparePaths(root, left, right) {
  const a = normalizedRelativePath(root, left);
  const b = normalizedRelativePath(root, right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function calculatePublisherFingerprint(root, criticalPaths) {
  const uniquePaths = [...new Set(criticalPaths)].sort();
  if (uniquePaths.length !== criticalPaths.length) {
    throw new Error("publisher contract criticalPaths must be unique");
  }
  if (uniquePaths.some((path, index) => path !== criticalPaths[index])) {
    throw new Error("publisher contract criticalPaths must be sorted");
  }

  const files = uniquePaths
    .flatMap((path) => {
      assertSafeCriticalPath(path);
      const absolutePath = resolve(root, path);
      if (!existsSync(absolutePath)) throw new Error(`critical path does not exist: ${path}`);
      return collectFiles(root, absolutePath);
    })
    .sort((left, right) => comparePaths(root, left, right));

  if (files.length === 0) throw new Error("publisher contract does not cover any files");

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(normalizedRelativePath(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function parseCliArgs(args) {
  const allowed = new Set(["--dry-run", "--apply", "--help", "-h"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    return { ok: false, exitCode: 1, message: `ERR: unknown argument(s): ${unknown.join(", ")}` };
  }
  if (args.includes("--help") || args.includes("-h")) {
    return args.length === 1
      ? { ok: true, mode: "help" }
      : { ok: false, exitCode: 1, message: "ERR: help cannot be combined with other flags" };
  }
  if (args.includes("--dry-run") && args.includes("--apply")) {
    return { ok: false, exitCode: 1, message: "ERR: choose either --dry-run or --apply, not both" };
  }
  if (args.length !== 1) {
    return { ok: false, exitCode: 1, message: "ERR: use exactly one of --dry-run, --apply, or --help" };
  }
  return args[0] === "--dry-run"
    ? { ok: true, mode: "dry-run" }
    : { ok: true, mode: "apply" };
}

function usage() {
  console.log("Usage: npm run publisher:contract -- --dry-run");
  console.log("       npm run publisher:contract -- --apply");
  console.log("       npm run publisher:contract -- --help");
}

function writeJsonAtomic(path, value) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

export function runCli(args, options = {}) {
  const parsedArgs = parseCliArgs(args);
  if (!parsedArgs.ok) {
    console.error(parsedArgs.message);
    return parsedArgs.exitCode;
  }
  if (parsedArgs.mode === "help") {
    usage();
    return 0;
  }

  const root = options.root ?? ROOT;
  const contractPath = options.contractPath ?? CONTRACT_PATH;
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const fingerprint = calculatePublisherFingerprint(root, contract.criticalPaths);
  const changed = fingerprint !== contract.fingerprint;
  console.log(`Publisher contract: ${changed ? "CHANGED" : "CURRENT"}`);
  console.log(`Computed fingerprint: ${fingerprint}`);

  if (parsedArgs.mode === "apply" && changed) {
    writeJsonAtomic(contractPath, { ...contract, fingerprint });
    console.log(`APPLIED: ${normalizedRelativePath(root, contractPath)}`);
  } else if (parsedArgs.mode === "dry-run") {
    console.log("DRY RUN ONLY: no files written");
  }
  return parsedArgs.mode === "dry-run" && changed ? 2 : 0;
}

const isDirectInvocation =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectInvocation) {
  process.exitCode = runCli(process.argv.slice(2));
}
