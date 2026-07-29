#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync } from "node:fs";
import { hasUsableGroundedBilingualSummary } from "../harness/pipeline/summary-quality.ts";
import { normalizeTags } from "../harness/pipeline/tag.ts";
import {
  acquireWriteTransactionLock,
  DATA_ARTIFACT_JOURNAL_PATH,
  recoverWriteTransaction,
  writeJsonTransaction,
} from "./clean-source-noise.mjs";

const INDEX = "data/index.json";
const CACHE = "data/_summary-cache.json";
const DRY = process.argv.includes("--dry-run");
const OBSOLETE_BODY_FLAGS = ["--fill-missing-body", "--refresh-fallback-body"]
  .filter((flag) => process.argv.includes(flag));
if (OBSOLETE_BODY_FLAGS.length > 0) {
  throw new Error(
    `${OBSOLETE_BODY_FLAGS.join(", ")} cannot be used with the body-file architecture. `
    + "Apply summaries to data/index.json and manage article bodies through data/bodies.json.",
  );
}
// --force-summary overwrites existing summaries only when the cache passes the
// same bilingual quality gate used by the generation pipeline.
const FORCE_SUMMARY = process.argv.includes("--force-summary");

const transactionLock = acquireWriteTransactionLock(DATA_ARTIFACT_JOURNAL_PATH);
try {
  if (DRY && existsSync(DATA_ARTIFACT_JOURNAL_PATH)) {
    throw new Error(
      `Pending transaction detected at ${DATA_ARTIFACT_JOURNAL_PATH}; dry-run will not recover or inspect a possibly changing artifact.`,
    );
  }
  if (!DRY) {
    recoverWriteTransaction(DATA_ARTIFACT_JOURNAL_PATH, {
      lockToken: transactionLock.ownerToken,
    });
  }

  const index = JSON.parse(readFileSync(INDEX, "utf8"));
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const entries = Array.isArray(index) ? index : index.entries;

  const stats = {
    total: entries.length,
    cacheHits: 0,
    cacheRejected: 0,
    titleApplied: 0,
    summaryApplied: 0,
    importanceApplied: 0,
    tagsApplied: 0,
  };

function text(value) {
  return typeof value === "string" && value.trim() ? value : "";
}

function setIfFilled(entry, key, value) {
  const next = text(value);
  if (!next) return false;
  if (text(entry[key])) return false;
  if (entry[key] === next) return false;
  entry[key] = next;
  return true;
}

function setForce(entry, key, value) {
  const next = text(value);
  if (!next) return false;
  if (entry[key] === next) return false;
  entry[key] = next;
  return true;
}

function dedupeTags(tags) {
  return normalizeTags(tags.filter((tag) => typeof tag === "string"), 10);
}

for (const entry of entries) {
  const hit = cache[entry.url];
  if (!hit) continue;
  stats.cacheHits++;

  const usableSummary =
    hit.model !== "deterministic-fallback"
    && hasUsableGroundedBilingualSummary(
      entry,
      {
        ...hit,
        title: entry.title,
        titleJa: hit.titleJa || entry.titleJa,
        titleEn: entry.titleEn,
      },
      [entry.title, entry.titleJa, entry.titleEn],
    );
  if (!usableSummary) {
    stats.cacheRejected++;
    continue;
  }

  if (setIfFilled(entry, "titleJa", hit.titleJa)) stats.titleApplied++;
  if (FORCE_SUMMARY) {
    if (setForce(entry, "summaryJa", hit.summaryJa)) stats.summaryApplied++;
    if (setForce(entry, "summaryEn", hit.summaryEn)) stats.summaryApplied++;
  } else {
    if (setIfFilled(entry, "summaryJa", hit.summaryJa)) stats.summaryApplied++;
    if (setIfFilled(entry, "summaryEn", hit.summaryEn)) stats.summaryApplied++;
  }

  if (hit.importance && entry.importance !== hit.importance) {
    entry.importance = hit.importance;
    stats.importanceApplied++;
  }

  const mergedTags = dedupeTags([...(entry.tags ?? []), ...(hit.extraTags ?? [])]);
  if (JSON.stringify(entry.tags ?? []) !== JSON.stringify(mergedTags)) {
    entry.tags = mergedTags;
    stats.tagsApplied++;
  }
}

if (!Array.isArray(index)) {
  index.count = entries.length;
  index.entries = entries;
  if (!DRY && (stats.summaryApplied > 0 || stats.titleApplied > 0 || stats.importanceApplied > 0 || stats.tagsApplied > 0)) {
    index.generatedAt = new Date().toISOString();
  }
}

console.log(JSON.stringify({ dryRun: DRY, ...stats }, null, 2));

  if (
    !DRY
    && (stats.summaryApplied > 0 || stats.titleApplied > 0 || stats.importanceApplied > 0 || stats.tagsApplied > 0)
  ) {
    writeJsonTransaction(
      [{ path: INDEX, value: index }],
      {
        journalPath: DATA_ARTIFACT_JOURNAL_PATH,
        lockToken: transactionLock.ownerToken,
        registerSignalHandlers: false,
      },
    );
  }
} finally {
  transactionLock.release();
}
