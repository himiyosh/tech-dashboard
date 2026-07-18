#!/usr/bin/env node

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  deriveTitleEnFromEntry,
  extractLegacyTitleFromSummary,
  extractTitleFromSummary,
  fillMissingTitleEnEntries,
  shouldCorrectLegacyDerivedTitle,
} from "../harness/pipeline/title-en.ts";

export {
  deriveTitleEnFromEntry,
  extractLegacyTitleFromSummary,
  extractTitleFromSummary,
  shouldCorrectLegacyDerivedTitle,
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "data", "index.json");

export function fillMissingTitleEn(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const { entries: nextEntries, counts } = fillMissingTitleEnEntries(entries);

  return {
    nextData: { ...data, entries: nextEntries },
    counts,
  };
}

export function parseCliArgs(args) {
  const allowed = new Set(["--dry-run", "--apply", "--help", "-h"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) {
    return { ok: false, exitCode: 1, message: `ERR: unknown argument(s): ${unknown.join(", ")}` };
  }

  if (args.includes("--help") || args.includes("-h")) {
    if (args.length !== 1) {
      return { ok: false, exitCode: 1, message: "ERR: --help/-h cannot be combined with other arguments" };
    }
    return { ok: true, mode: "help" };
  }

  if (args.includes("--dry-run") && args.includes("--apply")) {
    return { ok: false, exitCode: 1, message: "ERR: choose either --dry-run or --apply, not both" };
  }

  if (args.length === 0) {
    return { ok: false, exitCode: 1, message: "ERR: missing mode; use --dry-run, --apply, or --help" };
  }

  if (args.length !== 1) {
    return { ok: false, exitCode: 1, message: "ERR: expected exactly one mode flag" };
  }

  if (args[0] === "--dry-run") return { ok: true, mode: "dry-run" };
  if (args[0] === "--apply") return { ok: true, mode: "apply" };

  return { ok: false, exitCode: 1, message: "ERR: unsupported mode" };
}

function writeJsonAtomically(path, value) {
  const tempPath = `${path}.fill-title-en.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function usage() {
  console.log("Usage: npm run titleen:fill -- --dry-run");
  console.log("       npm run titleen:fill -- --apply");
  console.log("       npm run titleen:fill -- --help");
}

export function runCli(args, options = {}) {
  const parsed = parseCliArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    usage();
    return parsed.exitCode;
  }

  if (parsed.mode === "help") {
    usage();
    return 0;
  }

  const indexPath = options.indexPath ?? INDEX_PATH;
  const raw = readFileSync(indexPath, "utf8");
  const data = JSON.parse(raw);
  const { nextData, counts } = fillMissingTitleEn(data);

  console.log(`fill-title-en [${parsed.mode}]`);
  console.log(`missing titleEn: ${counts.missing}`);
  console.log(`real summaryEn: ${counts.fromSummaryEn}`);
  console.log(`corrected legacy-derived titleEn: ${counts.correctedDerivedTitles}`);
  console.log(`deterministic/pending summaryEn: ${counts.pendingOrFallback}`);
  console.log(`already set: ${counts.alreadySet}`);
  console.log(`total updated: ${counts.totalUpdated}`);

  if (parsed.mode === "apply" && counts.totalUpdated > 0) {
    writeJsonAtomically(indexPath, nextData);
    console.log(`OK: wrote ${indexPath}`);
  } else if (parsed.mode === "apply") {
    console.log("OK: no changes needed");
  } else {
    console.log("OK: dry-run only; no files written");
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  process.exitCode = runCli(process.argv.slice(2));
}
