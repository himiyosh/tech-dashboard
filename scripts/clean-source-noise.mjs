/**
 * clean-source-noise.mjs
 *
 * registry の source filter / category を既存 data に対して再適用する
 * migration。LL-081 / LL-129:
 * - 検出と予防は shared helper (`matchesKeywordFilter`) を単一ソースにする
 * - registry 変更は fresh collect だけでなく prior merged entries と既存
 *   artifact migration にも対称適用する
 * - `hn-ai` のような source category 変更は live/archive の既存 entry も
 *   再 stamp し、古い category を残さない
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { REGISTRY } from "../harness/registry.ts";
import { ALL_CATEGORIES } from "../harness/types.ts";
import { restampEntryFromSource } from "../harness/pipeline/normalize.ts";
import {
  evaluateKeywordFilter,
  keywordFilterEntryFromNormalized,
} from "../harness/pipeline/source-filter.ts";
import { normalizeKnownProductNames } from "../harness/pipeline/product-name.ts";
import { applyTags } from "../harness/pipeline/tag.ts";
import { canonicalUrlKey, normalizeMediaUrl } from "../harness/pipeline/url.ts";
import {
  buildArchiveIndexFile,
  buildArchiveMonthFile,
  mergeArchiveEntries,
  reconcileArchiveMonths,
  synchronizeArchiveTagsFromLive,
} from "../harness/publishers/archive-core.ts";
import { buildStatsPayload } from "../harness/publishers/stats-core.ts";
import {
  isRealBody,
  mergeBodiesWithProductGuard,
  pruneKnownProductBodyConflicts,
} from "../worker/src/bodies-file.ts";
import {
  DEFAULT_BODY_RETENTION_DAYS,
  isBodyRetentionEligible,
  needsBody,
} from "../worker/src/body-queue.ts";
import {
  DEFAULT_BODY_BUDGET_TARGET_BYTES,
  bodyBudgetPriorityRank,
  carryForwardBudgetEvictedIds,
  enforceBodiesBudget,
  serializedByteLength,
} from "../worker/src/bodies-budget.ts";

export { synchronizeArchiveTagsFromLive };

const DATA_DIR = "./data";
export const DATA_ARTIFACT_JOURNAL_PATH = join(DATA_DIR, ".clean-source-noise.transaction.json");
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SOURCE_TYPES = new Set(["blog", "release", "changelog", "paper", "community"]);
const ARCHIVE_TIERS = new Set(["hot", "warm", "cold", "dropped"]);
const HALF_LIVES = new Set(["news", "tutorial", "architecture", "fundamental"]);
const LANGS = new Set(["ja", "en"]);
const IMAGE_SOURCES = new Set(["media", "og", "fallback"]);
const CATEGORIES = new Set(ALL_CATEGORIES);

const USAGE = `Usage:
  npm run noise:clean -- --dry-run
  npm run noise:clean -- --apply
  npm run noise:clean -- --help
  npm run noise:clean -- -h

Notes:
  - explicit mode is required; no args is an error
  - --dry-run previews without writing files
  - only --apply may write files
  - unknown args fail closed and do not apply`;

const TXN_VERSION = 1;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(", ")}`);
  }
  return value;
}

function assertStringField(value, label, { allowBlank = true } = {}) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (!allowBlank && value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function validateOptionalString(entry, key, label) {
  if (entry[key] !== undefined) assertStringField(entry[key], `${label}.${key}`);
}

function validateImageRef(image, label) {
  if (typeof image === "string") {
    assertStringField(image, label, { allowBlank: false });
    return;
  }
  if (!isPlainObject(image)) throw new Error(`${label} must be a plain object`);
  assertStringField(image.src, `${label}.src`, { allowBlank: false });
  if (image.origSrc !== undefined) assertStringField(image.origSrc, `${label}.origSrc`);
  if (image.alt !== undefined) assertStringField(image.alt, `${label}.alt`);
  if (image.source !== undefined) assertEnum(image.source, IMAGE_SOURCES, `${label}.source`);
  if (image.width !== undefined && !Number.isFinite(image.width)) {
    throw new Error(`${label}.width must be a finite number`);
  }
  if (image.height !== undefined && !Number.isFinite(image.height)) {
    throw new Error(`${label}.height must be a finite number`);
  }
}

function validateEntryShape(entry, label) {
  if (!isPlainObject(entry)) throw new Error(`${label} must be an object`);
  const requiredStrings = ["id", "source", "sourceType", "url", "title", "category", "collectedAt"];
  for (const key of requiredStrings) {
    assertStringField(entry[key], `${label}.${key}`, { allowBlank: false });
  }
  assertEnum(entry.sourceType, SOURCE_TYPES, `${label}.sourceType`);
  assertEnum(entry.category, CATEGORIES, `${label}.category`);
  if (![1, 2, 3].includes(entry.importance)) throw new Error(`${label}.importance must be 1, 2, or 3`);
  assertEnum(entry.lang, LANGS, `${label}.lang`);
  if (entry.archiveTier !== undefined) assertEnum(entry.archiveTier, ARCHIVE_TIERS, `${label}.archiveTier`);
  if (entry.halfLife !== undefined) assertEnum(entry.halfLife, HALF_LIVES, `${label}.halfLife`);
  if (!Array.isArray(entry.tags)) throw new Error(`${label}.tags must be an array`);
  for (const [index, tag] of entry.tags.entries()) {
    assertStringField(tag, `${label}.tags[${index}]`, { allowBlank: false });
  }
  validateOptionalString(entry, "titleJa", label);
  validateOptionalString(entry, "titleEn", label);
  validateOptionalString(entry, "summaryJa", label);
  validateOptionalString(entry, "summaryEn", label);
  validateOptionalString(entry, "contentSnippet", label);
  validateOptionalString(entry, "bodyJa", label);
  validateOptionalString(entry, "bodyEn", label);
  if (entry.publishedAt !== null && entry.publishedAt !== undefined) {
    assertIsoTimestamp(entry.publishedAt, `${label}.publishedAt`);
  }
  if (entry.image !== undefined) validateImageRef(entry.image, `${label}.image`);
  assertIsoTimestamp(entry.collectedAt, `${label}.collectedAt`);
  return entry;
}

function assertBilingualSummaries(entry, label) {
  if (!String(entry.summaryJa ?? "").trim()) {
    throw new Error(`${label}.summaryJa must be a non-empty string`);
  }
  if (!String(entry.summaryEn ?? "").trim()) {
    throw new Error(`${label}.summaryEn must be a non-empty string`);
  }
}

export function parseCliArgs(argv) {
  if (argv.length === 0) {
    return {
      kind: "error",
      message: "Explicit mode required: pass --dry-run, --apply, or --help",
    };
  }
  const flags = {
    dryRun: false,
    apply: false,
    help: false,
  };
  const unknown = [];
  for (const arg of argv) {
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--apply") {
      flags.apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    unknown.push(arg);
  }
  if (flags.help) return { kind: "help" };
  if (unknown.length > 0) {
    return {
      kind: "error",
      message: `Unknown argument(s): ${unknown.join(", ")}`,
    };
  }
  if (flags.dryRun && flags.apply) {
    return {
      kind: "error",
      message: "Conflicting flags: --dry-run and --apply cannot be combined",
    };
  }
  return { kind: flags.dryRun ? "dry-run" : "apply" };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stringifyJson(value) {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  JSON.parse(serialized);
  return serialized;
}

function uniqueTxnPath(targetPath, suffix, token) {
  return join(dirname(targetPath), `.${basename(targetPath)}.${token}.${suffix}`);
}

function safeRemovePath(path) {
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
}

function transactionLockPath(journalPath) {
  return `${journalPath}.lock`;
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") return false;
    return null;
  }
}

function readTransactionLock(lockPath) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Transaction lock cannot be verified at ${lockPath}: ${detail}. Preserve it for manual inspection.`,
    );
  }
  if (
    !isPlainObject(lock)
    || lock.version !== TXN_VERSION
    || typeof lock.ownerToken !== "string"
    || !lock.ownerToken
    || !Number.isInteger(lock.pid)
    || lock.pid <= 0
    || typeof lock.createdAt !== "string"
    || Number.isNaN(Date.parse(lock.createdAt))
  ) {
    throw new Error(
      `Transaction lock is invalid at ${lockPath}. Preserve it for manual inspection.`,
    );
  }
  return lock;
}

function assertTransactionLockOwner(journalPath, ownerToken) {
  const lockPath = transactionLockPath(journalPath);
  const lock = readTransactionLock(lockPath);
  if (!isPlainObject(lock) || lock.version !== TXN_VERSION || lock.ownerToken !== ownerToken) {
    throw new Error(
      `Transaction lock ownership changed at ${lockPath}. Refusing to modify journal or backup artifacts.`,
    );
  }
}

function releaseWriteTransactionLock(journalPath, ownerToken) {
  const lockPath = transactionLockPath(journalPath);
  if (!existsSync(lockPath)) return;
  assertTransactionLockOwner(journalPath, ownerToken);
  unlinkSync(lockPath);
}

export function acquireWriteTransactionLock(journalPath, options = {}) {
  if (!journalPath) throw new Error("journalPath is required");
  const lockPath = transactionLockPath(journalPath);
  const ownerToken = `${process.pid}.${Date.now()}.${randomUUID()}`;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  let reclaimedLockPath = null;
  while (true) {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({
          version: TXN_VERSION,
          ownerToken,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" },
      );
      if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
        throw error;
      }

      let existingLock;
      try {
        existingLock = readTransactionLock(lockPath);
      } catch (lockError) {
        if (!existsSync(lockPath)) continue;
        if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
        throw lockError;
      }
      const alive = processIsAlive(existingLock.pid);
      if (alive !== false) {
        if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
        const status = alive === true ? "is still running" : "could not be verified as stopped";
        throw new Error(
          `Another data artifact writer owns ${lockPath}; PID ${existingLock.pid} ${status}. Do not remove the lock until ownership is verified.`,
        );
      }

      const stalePath = `${lockPath}.${randomUUID()}.stale`;
      try {
        renameSync(lockPath, stalePath);
      } catch (renameError) {
        if (renameError && typeof renameError === "object" && renameError.code === "ENOENT") {
          continue;
        }
        if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
        throw renameError;
      }
      if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
      reclaimedLockPath = stalePath;
    }
  }

  if (!existsSync(lockPath)) {
    if (reclaimedLockPath) safeRemovePath(reclaimedLockPath);
    throw new Error(
      `Transaction lock creation could not be verified at ${lockPath}.`,
    );
  }

  let released = false;
  return {
    ownerToken,
    lockPath,
    release() {
      if (released) return;
      releaseWriteTransactionLock(journalPath, ownerToken);
      released = true;
    },
  };
}

function cleanupTxnArtifacts(transaction, ownerToken) {
  assertTransactionLockOwner(transaction.journalPath, ownerToken);
  for (const file of transaction.files) {
    safeRemovePath(file.tempPath);
    if (file.backupTempPath) safeRemovePath(file.backupTempPath);
    safeRemovePath(file.backupPath);
  }
  if (transaction.journalTempPath) safeRemovePath(transaction.journalTempPath);
  if (transaction.stateTempPath) safeRemovePath(transaction.stateTempPath);
  safeRemovePath(transaction.journalPath);
}

function restoreTxnTargets(transaction, renameImpl = renameSync) {
  for (const file of transaction.files) {
    if (file.existed && existsSync(file.backupPath)) {
      renameImpl(file.backupPath, file.path);
      continue;
    }
    if (!file.existed && existsSync(file.path)) {
      unlinkSync(file.path);
    }
  }
}

export function recoverWriteTransaction(journalPath, options = {}) {
  const ownedLock = options.lockToken ? null : acquireWriteTransactionLock(journalPath);
  const ownerToken = options.lockToken ?? ownedLock.ownerToken;
  try {
    assertTransactionLockOwner(journalPath, ownerToken);
    if (!existsSync(journalPath)) return false;
    const renameImpl = options.renameImpl ?? renameSync;
    let transaction;
    try {
      transaction = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Transaction journal is unreadable at ${journalPath}: ${detail}. Automatic recovery was not attempted. Preserve the journal and sibling transaction .bak/.tmp files, restore verified backups manually, then remove the journal before retrying.`,
      );
    }
    const validFiles = isPlainObject(transaction) && Array.isArray(transaction.files)
      && transaction.files.every((file) =>
        isPlainObject(file)
        && typeof file.path === "string"
        && typeof file.tempPath === "string"
        && typeof file.backupPath === "string"
        && typeof file.existed === "boolean"
      );
    if (
      !validFiles
      || transaction.version !== TXN_VERSION
      || !["active", "committed"].includes(transaction.state)
      || transaction.journalPath !== journalPath
    ) {
      throw new Error(
        `Transaction journal is invalid at ${journalPath}. Automatic recovery was not attempted. Preserve the journal and sibling transaction .bak/.tmp files, restore verified backups manually, then remove the journal before retrying.`,
      );
    }
    if (transaction.state !== "committed") {
      try {
        restoreTxnTargets(transaction, renameImpl);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Transaction rollback failed for ${journalPath}: ${detail}. Journal, backups, and temporary files were preserved for the next recovery attempt or manual inspection.`,
          { cause: error },
        );
      }
    }
    cleanupTxnArtifacts(transaction, ownerToken);
    return true;
  } finally {
    ownedLock?.release();
  }
}

export function writeJsonTransaction(files, options = {}) {
  const journalPath = options.journalPath;
  if (!journalPath) throw new Error("journalPath is required");
  const ownedLock = options.lockToken ? null : acquireWriteTransactionLock(journalPath);
  const ownerToken = options.lockToken ?? ownedLock.ownerToken;
  assertTransactionLockOwner(journalPath, ownerToken);
  try {
    recoverWriteTransaction(journalPath, {
      renameImpl: options.renameImpl,
      lockToken: ownerToken,
    });
  } catch (error) {
    ownedLock?.release();
    throw error;
  }

  const token = `${process.pid}.${Date.now()}`;
  const transaction = {
    version: TXN_VERSION,
    state: "active",
    journalPath,
    journalTempPath: uniqueTxnPath(journalPath, "journal.tmp", token),
    stateTempPath: uniqueTxnPath(journalPath, "state.tmp", token),
    files: files.map(({ path, value }, index) => ({
      path,
      tempPath: uniqueTxnPath(path, `txn-${index}.tmp`, token),
      backupTempPath: uniqueTxnPath(path, `txn-${index}.bak.tmp`, token),
      backupPath: uniqueTxnPath(path, `txn-${index}.bak`, token),
      existed: existsSync(path),
      content: stringifyJson(value),
    })),
  };

  const renameImpl = options.renameImpl ?? renameSync;
  const signalHandlers = [];
  const recover = () => {
    if (transaction.state === "active") restoreTxnTargets(transaction, renameImpl);
    cleanupTxnArtifacts(transaction, ownerToken);
  };
  const detachSignals = () => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };

  try {
    for (const file of transaction.files) writeFileSync(file.tempPath, file.content, "utf8");
    writeFileSync(
      transaction.journalTempPath,
      JSON.stringify({
        version: transaction.version,
        state: "active",
        journalPath: transaction.journalPath,
        journalTempPath: transaction.journalTempPath,
        stateTempPath: transaction.stateTempPath,
        files: transaction.files.map(({ path, tempPath, backupTempPath, backupPath, existed }) => ({
          path,
          tempPath,
          backupTempPath,
          backupPath,
          existed,
        })),
      }, null, 2) + "\n",
      "utf8",
    );
    renameImpl(transaction.journalTempPath, journalPath);
    for (const file of transaction.files) {
      if (!file.existed) continue;
      writeFileSync(file.backupTempPath, readFileSync(file.path));
      renameImpl(file.backupTempPath, file.backupPath);
    }

    if (options.registerSignalHandlers !== false) {
      for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
        const handler = () => {
          try {
            recover();
          } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
          } finally {
            releaseWriteTransactionLock(journalPath, ownerToken);
            process.exit(code);
          }
        };
        signalHandlers.push([signal, handler]);
        process.once(signal, handler);
      }
    }

    for (const file of transaction.files) renameImpl(file.tempPath, file.path);
    writeFileSync(
      transaction.stateTempPath,
      JSON.stringify({
        version: transaction.version,
        state: "committed",
        journalPath: transaction.journalPath,
        journalTempPath: transaction.journalTempPath,
        stateTempPath: transaction.stateTempPath,
        files: transaction.files.map(({ path, tempPath, backupTempPath, backupPath, existed }) => ({
          path,
          tempPath,
          backupTempPath,
          backupPath,
          existed,
        })),
      }, null, 2) + "\n",
      "utf8",
    );
    renameImpl(transaction.stateTempPath, journalPath);
    transaction.state = "committed";
    detachSignals();
    cleanupTxnArtifacts(transaction, ownerToken);
  } catch (error) {
    detachSignals();
    try {
      recover();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Transaction failed and rollback was incomplete for ${journalPath}. Recovery artifacts were preserved.`,
      );
    }
    throw error;
  } finally {
    ownedLock?.release();
  }
}

function stripBodies(entry) {
  return {
    ...entry,
    bodyJa: "",
    bodyEn: "",
  };
}

function bump(map, key, inc = 1) {
  map.set(key, (map.get(key) ?? 0) + inc);
}

function pushSample(map, key, value, limit = 4) {
  const list = map.get(key) ?? [];
  if (list.length < limit) list.push(value);
  map.set(key, list);
}

function sortedCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

export function dedupeByCanonical(entries) {
  const retained = entries.filter((entry) => entry.archiveTier !== "dropped");
  const merged = mergeArchiveEntries([], retained);
  const winnersByCanonical = new Map(
    merged.map((entry) => [statsEntryKey(entry), entry.id]),
  );
  const aliases = new Map();
  for (const entry of retained) {
    const winnerId = winnersByCanonical.get(statsEntryKey(entry));
    if (winnerId && winnerId !== entry.id) aliases.set(entry.id, winnerId);
  }
  return { entries: merged, aliases };
}

function statsEntryKey(entry) {
  return canonicalUrlKey(entry.url) ?? entry.url ?? entry.id;
}

export function validateIndexPayload(value, label = "data/index.json") {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const generatedAt = assertIsoTimestamp(value.generatedAt, `${label}.generatedAt`);
  if (!Array.isArray(value.entries)) throw new Error(`${label}.entries must be an array`);
  return {
    ...value,
    generatedAt,
    entries: value.entries.map((entry, index) => {
      const validated = validateEntryShape(entry, `${label}.entries[${index}]`);
      assertBilingualSummaries(validated, `${label}.entries[${index}]`);
      return validated;
    }),
  };
}

function validateArchiveMonthPayloadInternal(value, label, { allowRepairableSummaryGap = false, requireOutputTier = false } = {}) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  assertIsoTimestamp(value.generatedAt, `${label}.generatedAt`);
  if (!Array.isArray(value.entries)) throw new Error(`${label}.entries must be an array`);
  return {
    ...value,
    entries: value.entries.map((entry, index) => {
      const entryLabel = `${label}.entries[${index}]`;
      const validated = validateEntryShape(entry, entryLabel);
      if (requireOutputTier && validated.archiveTier === "dropped") {
        throw new Error(`${entryLabel}.archiveTier must not be dropped in archive output`);
      }
      if (validated.archiveTier === "warm" || validated.archiveTier === "cold") {
        if (allowRepairableSummaryGap && !hasBilingualSummaries(validated)) return validated;
        assertBilingualSummaries(validated, entryLabel);
      }
      return validated;
    }),
  };
}

export function validateArchiveMonthInputPayload(value, label) {
  return validateArchiveMonthPayloadInternal(value, label, { allowRepairableSummaryGap: true });
}

export function validateArchiveMonthPayload(value, label) {
  return validateArchiveMonthPayloadInternal(value, label, { requireOutputTier: true });
}

export function buildMigrationArchiveMonthPayload(
  currentPayload,
  month,
  entries,
  referenceAt,
) {
  const nextPayload = buildArchiveMonthFile(month, entries, referenceAt);
  const { generatedAt: _currentGeneratedAt, ...currentContent } = currentPayload;
  const { generatedAt: _nextGeneratedAt, ...nextContent } = nextPayload;
  return isDeepStrictEqual(currentContent, nextContent)
    ? { ...nextPayload, generatedAt: currentPayload.generatedAt }
    : nextPayload;
}

export function validateBodiesPayload(value, label = "data/bodies.json") {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const generatedAt = assertIsoTimestamp(value.generatedAt, `${label}.generatedAt`);
  if (!isPlainObject(value.bodies)) throw new Error(`${label}.bodies must be an object`);
  if (value.count !== undefined && typeof value.count !== "number") {
    throw new Error(`${label}.count must be a number when present`);
  }
  for (const [id, record] of Object.entries(value.bodies)) {
    if (!isPlainObject(record)) throw new Error(`${label}.bodies.${id} must be an object`);
    assertStringField(record.bodyJa, `${label}.bodies.${id}.bodyJa`, { allowBlank: false });
    assertStringField(record.bodyEn, `${label}.bodies.${id}.bodyEn`, { allowBlank: false });
    assertStringField(record.model, `${label}.bodies.${id}.model`, { allowBlank: false });
    assertIsoTimestamp(record.generatedAt, `${label}.bodies.${id}.generatedAt`);
  }
  return { generatedAt, count: Object.keys(value.bodies).length, bodies: value.bodies };
}

function hasBilingualSummaries(entry) {
  return Boolean(String(entry.summaryJa ?? "").trim()) && Boolean(String(entry.summaryEn ?? "").trim());
}

function archiveSummaryFallback(entry, lang) {
  const title = String(entry.title ?? "").trim();
  const source = String(entry.source ?? "").trim();
  const category = String(entry.category ?? "").trim();
  return lang === "ja"
    ? `${title}（${source}）の${category}関連エントリ。`
    : `${title} is a ${category} entry from ${source}.`;
}

export function repairArchiveSummariesForMigration(entry, preserveArchiveTier = false) {
  if (!preserveArchiveTier) return entry;
  if (entry.archiveTier !== "warm" && entry.archiveTier !== "cold") return entry;
  const summaryJa = String(entry.summaryJa ?? "").trim()
    ? entry.summaryJa
    : archiveSummaryFallback(entry, "ja");
  const summaryEn = String(entry.summaryEn ?? "").trim()
    ? entry.summaryEn
    : archiveSummaryFallback(entry, "en");
  if (summaryJa === entry.summaryJa && summaryEn === entry.summaryEn) return entry;
  return { ...entry, summaryJa, summaryEn };
}

export function applyCurrentRegistryRules(entry, referenceAt, options = {}) {
  const source = REGISTRY[entry.source];
  if (options.preserveArchiveTier && entry.archiveTier === "dropped") {
    return {
      keep: false,
      entry: null,
      source: source ?? null,
      filter: { type: "dropped-tier", keyword: null },
      reclassified: false,
    };
  }
  if (!source) {
    return {
      keep: true,
      entry: options.repairArchiveSummaries === false
        ? entry
        : repairArchiveSummariesForMigration(
            entry,
            options.preserveArchiveTier ?? false,
          ),
      source: null,
      filter: null,
      reclassified: false,
    };
  }
  const tagged = applyTags(
    restampEntryFromSource(entry, source, referenceAt, { preserveArchiveTier: options.preserveArchiveTier ?? false }),
  );
  const restamped = options.repairArchiveSummaries === false
    ? tagged
    : repairArchiveSummariesForMigration(
        tagged,
        options.preserveArchiveTier ?? false,
      );
  const filterDecision = evaluateKeywordFilter(keywordFilterEntryFromNormalized(restamped), source, {
    allowLossyMissingInclude: true,
  });
  if (!filterDecision.keep) {
    return {
      keep: false,
      entry: null,
      source,
      filter: { type: filterDecision.reason, keyword: filterDecision.keyword },
      reclassified: entry.category !== restamped.category,
      restamped,
    };
  }

  return {
    keep: true,
    entry: restamped,
    source,
    filter: filterDecision.reason === "include" || filterDecision.reason === "missing-include-unverified"
      ? { type: filterDecision.reason, keyword: filterDecision.keyword }
      : null,
    reclassified: entry.category !== restamped.category,
  };
}

export function normalizeEntryMediaUrls(entry) {
  if (typeof entry.image === "string") {
    const image = normalizeMediaUrl(entry.image);
    return image === entry.image ? entry : { ...entry, image };
  }
  if (!isPlainObject(entry.image)) return entry;

  const src = normalizeMediaUrl(entry.image.src);
  const origSrc = typeof entry.image.origSrc === "string"
    ? normalizeMediaUrl(entry.image.origSrc)
    : entry.image.origSrc;
  if (src === entry.image.src && origSrc === entry.image.origSrc) return entry;
  return {
    ...entry,
    image: {
      ...entry.image,
      src,
      ...(origSrc !== undefined ? { origSrc } : {}),
    },
  };
}

export function summarizeChanges(label, entries, referenceAt, report, options = {}) {
  const kept = [];
  for (const entry of entries) {
    const normalizedEntry = normalizeEntryMediaUrls(entry);
    const beforeMedia = typeof entry.image === "string"
      ? [entry.image]
      : [entry.image?.src, entry.image?.origSrc];
    const afterMedia = typeof normalizedEntry.image === "string"
      ? [normalizedEntry.image]
      : [normalizedEntry.image?.src, normalizedEntry.image?.origSrc];
    const normalizedMediaCount = beforeMedia.reduce(
      (count, value, index) => count + (typeof value === "string" && value !== afterMedia[index] ? 1 : 0),
      0,
    );
    report.mediaUrlsNormalized = (report.mediaUrlsNormalized ?? 0) + normalizedMediaCount;

    const decision = applyCurrentRegistryRules(normalizedEntry, referenceAt, options);
    if (!decision.keep || !decision.entry) {
      report.removed++;
      bump(report.removedBySource, entry.source);
      bump(report.removedByCategory, entry.category);
      const reason = decision.filter?.type === "exclude"
        ? `exclude:${decision.filter.keyword}`
        : decision.filter?.type === "dropped-tier"
          ? "dropped-tier"
          : decision.filter?.type === "missing-include-unverified"
            ? "missing-include-unverified"
          : "missing-include";
      pushSample(report.dropSamples, entry.source, `${label} | ${reason} | ${entry.category} | ${entry.title}`);
      continue;
    }

    if (decision.reclassified) {
      report.reclassified++;
      bump(report.reclassifiedBySource, entry.source);
      bump(report.reclassifiedPairs, `${entry.category} -> ${decision.entry.category}`);
      pushSample(
        report.reclassSamples,
        entry.source,
        `${label} | ${entry.category} -> ${decision.entry.category} | ${entry.title}`,
      );
    }

    if (decision.source?.includeKeywords?.length || decision.source?.excludeKeywords?.length) {
      pushSample(
        report.keepSamples,
        entry.source,
        `${label} | keep${decision.filter?.keyword ? `:${decision.filter.keyword}` : ""} | ${decision.entry.category} | ${decision.entry.title}`,
      );
    }

    kept.push(normalizeKnownProductNames(decision.entry));
  }
  return kept;
}

export function migrateArchiveEntries(label, entries, referenceAt, report) {
  const kept = summarizeChanges(label, entries, referenceAt, report, {
    preserveArchiveTier: true,
    repairArchiveSummaries: false,
  });
  const dedupe = dedupeByCanonical(kept);
  return {
    entries: dedupe.entries.map((entry) =>
      repairArchiveSummariesForMigration(entry, true)
    ),
    aliases: dedupe.aliases,
    keptCount: kept.length,
  };
}

export function buildOriginalLiveAliases(originalEntries, finalEntries) {
  const winnersByCanonical = new Map(
    finalEntries.map((entry) => [statsEntryKey(entry), entry.id]),
  );
  const aliases = new Map();
  for (const entry of originalEntries) {
    const winnerId = winnersByCanonical.get(statsEntryKey(entry));
    if (winnerId && winnerId !== entry.id) aliases.set(entry.id, winnerId);
  }
  return aliases;
}

export function reconcileBodiesPayload(
  existingBodies,
  liveIds,
  referenceAt,
  aliases = new Map(),
  sourceEntries = [],
) {
  const sanitizedBodies = pruneKnownProductBodyConflicts(
    existingBodies,
    sourceEntries,
    referenceAt,
  );
  const transferredBodies = [];
  for (const [loserId, winnerId] of aliases) {
    const record = sanitizedBodies.payload.bodies[loserId];
    if (!isRealBody(record)) continue;
    transferredBodies.push({
      id: winnerId,
      bodyJa: record.bodyJa,
      bodyEn: record.bodyEn,
      model: record.model,
      cachedAt: record.generatedAt,
    });
  }
  for (const entry of sourceEntries) {
    const targetId = liveIds.has(entry.id) ? entry.id : aliases.get(entry.id);
    if (!targetId || !isRealBody(entry)) continue;
    transferredBodies.push({
      id: targetId,
      bodyJa: entry.bodyJa,
      bodyEn: entry.bodyEn,
      model: "legacy-index-migration",
      cachedAt: referenceAt,
    });
  }
  const merged = mergeBodiesWithProductGuard(
    sanitizedBodies.payload,
    transferredBodies,
    liveIds,
    referenceAt,
    sourceEntries,
  );
  return {
    ...merged,
    pruned: sanitizedBodies.pruned + merged.pruned,
    changed: sanitizedBodies.changed || merged.changed,
  };
}

export function synchronizeBodyHealth(
  health,
  bodyRetentionEligible,
  bodiesTotal,
  bodyBacklog,
  budget = null,
) {
  if (!isPlainObject(health)) return health;
  const next = { ...health };
  const enqueueCap = Number.isFinite(Number(next.bodyEnqueueCap))
    ? Math.max(0, Number(next.bodyEnqueueCap))
    : 0;
  const summaryEnqueued = Number(next.summaryQueueEnqueued);
  const enrichmentEnqueued = Number(next.enrichmentEnqueued);

  if (Object.prototype.hasOwnProperty.call(next, "bodiesTotal")) {
    next.bodiesTotal = bodiesTotal;
  }
  if (Object.prototype.hasOwnProperty.call(next, "bodyCount")) {
    next.bodyCount = bodiesTotal;
  }
  if (Object.prototype.hasOwnProperty.call(next, "bodyRetentionEligible")) {
    next.bodyRetentionEligible = bodyRetentionEligible;
  }
  if (Object.prototype.hasOwnProperty.call(next, "bodyBacklog")) {
    next.bodyBacklog = bodyBacklog;
  }
  if (Object.prototype.hasOwnProperty.call(next, "bodyQueueDrainEstimateHours")) {
    next.bodyQueueDrainEstimateHours = enqueueCap > 0
      ? Math.ceil(bodyBacklog / enqueueCap)
      : 0;
  }
  if (
    !Object.prototype.hasOwnProperty.call(next, "bodyEnqueued")
    && Number.isFinite(summaryEnqueued)
    && summaryEnqueued >= 0
    && Number.isFinite(enrichmentEnqueued)
    && enrichmentEnqueued >= summaryEnqueued
  ) {
    next.bodyEnqueued = enrichmentEnqueued - summaryEnqueued;
  }
  if (budget) {
    // These are brand-new fields being introduced by this rollout (LL-411),
    // unlike the fields above which only refresh EXISTING keys defensively.
    // Always set them so the migration establishes the new health contract
    // rather than silently skipping it because the field wasn't present yet.
    next.bodyBudgetTargetBytes = budget.targetBytes;
    next.bodyBudgetBytes = budget.bytes;
    next.bodyBudgetPruned = budget.pruned;
    next.bodyBudgetEvictedIds = budget.evictedIds;
  }
  return next;
}

export function buildMigrationStatsPayload(liveEntries, archiveEntries, referenceAt) {
  const byKey = new Map();
  for (const entry of liveEntries) byKey.set(statsEntryKey(entry), entry);
  for (const entry of archiveEntries) {
    const key = statsEntryKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return buildStatsPayload([...byKey.values()], referenceAt);
}

function printSection(title, rows) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const [key, value] of rows) console.log(`  ${key}: ${value}`);
}

function printSamples(title, map) {
  console.log(`\n${title}`);
  const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const [key, samples] of rows) {
    console.log(`  ${key}:`);
    for (const sample of samples) console.log(`    - ${sample}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cli = parseCliArgs(argv);
  if (cli.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cli.kind === "error") {
    console.error(`ERROR: ${cli.message}\n\n${USAGE}`);
    return 1;
  }

  const dryRun = cli.kind === "dry-run";
  const indexPath = join(DATA_DIR, "index.json");
  const archiveDir = join(DATA_DIR, "archive");
  const archiveIndexPath = join(archiveDir, "_index.json");
  const statsPath = join(DATA_DIR, "stats.json");
  const bodiesPath = join(DATA_DIR, "bodies.json");
  const journalPath = DATA_ARTIFACT_JOURNAL_PATH;
  if (dryRun && (existsSync(journalPath) || existsSync(transactionLockPath(journalPath)))) {
    console.error(
      `ERROR: Pending or active transaction detected at ${journalPath}; --dry-run is strictly read-only and will not inspect files while another migration may be writing them. Run --apply after the owning process exits to recover any pending transaction.`,
    );
    return 1;
  }
  const writeLock = dryRun ? null : acquireWriteTransactionLock(journalPath);
  try {
  if (!dryRun) {
    recoverWriteTransaction(journalPath, { lockToken: writeLock.ownerToken });
  }
  const index = validateIndexPayload(readJson(indexPath), indexPath);
  const referenceAt = index.generatedAt;
  const report = {
    removed: 0,
    reclassified: 0,
    removedBySource: new Map(),
    removedByCategory: new Map(),
    reclassifiedBySource: new Map(),
    reclassifiedPairs: new Map(),
    keepSamples: new Map(),
    dropSamples: new Map(),
    reclassSamples: new Map(),
    mediaUrlsNormalized: 0,
    archiveTagsSynchronized: 0,
  };

  const liveEntries = summarizeChanges("live", index.entries, referenceAt, report);
  const liveDedupe = dedupeByCanonical(liveEntries);
  const dedupedLive = liveDedupe.entries.map(stripBodies);
  const liveDeduped = liveEntries.length - dedupedLive.length;

  const archiveInputs = [];
  let archiveDeduped = 0;
  for (const fileName of readdirSync(archiveDir).filter((name) => /^\d{4}-\d{2}\.json$/.test(name)).sort()) {
    const monthPath = join(archiveDir, fileName);
    const month = validateArchiveMonthInputPayload(readJson(monthPath), monthPath);
    const migration = migrateArchiveEntries(fileName, month.entries, referenceAt, report);
    archiveDeduped += migration.keptCount - migration.entries.length;
    archiveInputs.push({
      month: fileName.slice(0, 7),
      path: monthPath,
      currentPayload: month,
      entries: migration.entries,
    });
  }

  const reconciledArchive = reconcileArchiveMonths(
    archiveInputs.map(({ month, entries }) => ({ month, entries })),
  );
  const preparedArchiveCount = archiveInputs.reduce(
    (sum, month) => sum + month.entries.length,
    0,
  );
  const reconciledArchiveCount = [...reconciledArchive.values()].reduce(
    (sum, entries) => sum + entries.length,
    0,
  );
  archiveDeduped += preparedArchiveCount - reconciledArchiveCount;

  const archiveMonths = [];
  const archiveStatsEntries = [];
  const archiveInputsByMonth = new Map(
    archiveInputs.map((month) => [month.month, month]),
  );
  const archiveMonthNames = new Set([
    ...archiveInputsByMonth.keys(),
    ...reconciledArchive.keys(),
  ]);
  for (const monthName of [...archiveMonthNames].sort()) {
    const current = archiveInputsByMonth.get(monthName);
    const monthPath = current?.path ?? join(archiveDir, `${monthName}.json`);
    const tagSync = synchronizeArchiveTagsFromLive(
      reconciledArchive.get(monthName) ?? [],
      dedupedLive,
    );
    report.archiveTagsSynchronized += tagSync.changed;
    const entries = tagSync.entries;
    archiveStatsEntries.push(...entries);
    const currentPayload = current?.currentPayload ?? {
      generatedAt: referenceAt,
      month: monthName,
      count: 0,
      entries: [],
    };
    const monthPayload = buildMigrationArchiveMonthPayload(
      currentPayload,
      monthName,
      entries,
      referenceAt,
    );
    validateArchiveMonthPayload(monthPayload, monthPath);
    archiveMonths.push({
      path: monthPath,
      payload: monthPayload,
    });
  }

  const statsPayload = buildMigrationStatsPayload(
    dedupedLive,
    archiveStatsEntries,
    referenceAt,
  );

  let bodiesWrite = null;
  const bodiesExisted = existsSync(bodiesPath);
  const rawBodies = bodiesExisted
    ? readJson(bodiesPath)
    : { generatedAt: referenceAt, count: 0, bodies: {} };
  const bodies = validateBodiesPayload(rawBodies, bodiesPath);
  const referenceMs = Date.parse(referenceAt);
  const bodyRetentionEntries = dedupedLive.filter((entry) =>
    isBodyRetentionEligible(
      entry,
      Number.isFinite(referenceMs) ? referenceMs : Date.now(),
      DEFAULT_BODY_RETENTION_DAYS,
    ),
  );
  const liveIds = new Set(bodyRetentionEntries.map((entry) => entry.id));
  const originalAliases = buildOriginalLiveAliases(index.entries, dedupedLive);
  const bodyAliases = new Map([...originalAliases, ...liveDedupe.aliases]);
  const bodyMerge = reconcileBodiesPayload(
    bodies,
    liveIds,
    referenceAt,
    bodyAliases,
    index.entries,
  );
  const bodyBudgetTargetBytes = Math.max(
    1,
    Number(process.env.BODY_BUDGET_TARGET_BYTES ?? DEFAULT_BODY_BUDGET_TARGET_BYTES),
  );
  // Apply the SAME byte-budget enforcement as the Publisher runtime
  // (worker/src/index.ts's runBodyPipeline) so migration never leaves
  // data/bodies.json above the operational target even if prior runs (or a
  // stale collector) let it drift. Lowest priority (importance 1, oldest
  // first) is pruned first; evergreen is pruned LAST (highest priority) but
  // is NOT exempt -- if every lower tier is already gone and the payload is
  // still over target, evergreen is pruned too, as a last resort (LL-411
  // follow-up 2).
  const bodyBudget = enforceBodiesBudget(
    bodyMerge.payload,
    bodyRetentionEntries,
    bodyBudgetTargetBytes,
  );
  const bodyEntryById = new Map(bodyRetentionEntries.map((entry) => [entry.id, entry]));
  const bodyBudgetPrunedByTier = { evergreen: 0, importance3: 0, importance2: 0, importance1: 0, orphan: 0 };
  for (const id of bodyBudget.prunedIds) {
    const entry = bodyEntryById.get(id);
    if (!entry) {
      bodyBudgetPrunedByTier.orphan += 1;
      continue;
    }
    const rank = bodyBudgetPriorityRank(entry);
    if (rank === 0) bodyBudgetPrunedByTier.evergreen += 1;
    else if (rank === 1) bodyBudgetPrunedByTier.importance3 += 1;
    else if (rank === 2) bodyBudgetPrunedByTier.importance2 += 1;
    else bodyBudgetPrunedByTier.importance1 += 1;
  }
  const reconciledBodyCount = bodyBudget.payload.count;
  const bodyPresentIds = new Set(Object.keys(bodyBudget.payload.bodies));
  const bodyBacklog = bodyRetentionEntries.filter((entry) =>
    needsBody(entry, bodyPresentIds)
  ).length;
  const bodyCountDrift = rawBodies.count !== bodyBudget.payload.count;
  if (!dryRun && (!bodiesExisted || bodyMerge.changed || bodyBudget.changed || bodyCountDrift)) {
    bodiesWrite = { path: bodiesPath, payload: bodyBudget.payload };
  }
  // Carry forward the previously recorded budget-evicted ids (from the
  // existing index.health, before this migration overwrites it) using the
  // SAME persistence contract as the Publisher runtime (LL-411 follow-up):
  // only remembering what THIS run pruned would drop ids that are still
  // missing a body and still budget-doomed, letting them be regenerated and
  // evicted again in an every-other-run waste loop.
  const previousBodyBudgetEvictedIds = Array.isArray(index.health?.bodyBudgetEvictedIds)
    ? index.health.bodyBudgetEvictedIds.filter(
        (id) => typeof id === "string" && id.trim().length > 0,
      )
    : [];
  const persistedBodyBudgetEvictedIds = carryForwardBudgetEvictedIds(
    previousBodyBudgetEvictedIds,
    bodyRetentionEntries,
    bodyPresentIds,
    bodyBudget.prunedIds,
  );

  printSection("Removed by source", sortedCounts(report.removedBySource));
  printSection("Removed by category", sortedCounts(report.removedByCategory));
  printSection("Reclassified by source", sortedCounts(report.reclassifiedBySource));
  printSection("Reclassified pairs", sortedCounts(report.reclassifiedPairs));
  console.log(`\nCanonical dedupe:\n  live: ${liveDeduped}\n  archive: ${archiveDeduped}`);
  console.log(`\nMedia URLs normalized: ${report.mediaUrlsNormalized}`);
  console.log(`\nArchive tags synchronized: ${report.archiveTagsSynchronized}`);
  if (reconciledBodyCount !== null) console.log(`\nBodies retained: ${reconciledBodyCount}`);
  console.log(
    `\nBody budget: bytes=${bodyBudget.bytes}/${bodyBudgetTargetBytes}, pruned=${bodyBudget.prunedIds.length}`
    + ` (importance3=${bodyBudgetPrunedByTier.importance3}, importance2=${bodyBudgetPrunedByTier.importance2},`
    + ` importance1=${bodyBudgetPrunedByTier.importance1}, evergreen=${bodyBudgetPrunedByTier.evergreen},`
    + ` orphan=${bodyBudgetPrunedByTier.orphan}), persisted excluded ids=${persistedBodyBudgetEvictedIds.length}`
    + ` (carried forward=${previousBodyBudgetEvictedIds.length})`,
  );
  printSamples("Representative keep samples", report.keepSamples);
  printSamples("Representative drop samples", report.dropSamples);
  printSamples("Representative reclass samples", report.reclassSamples);

  if (dryRun) {
    console.log(`\nDRY RUN ONLY - no files written (removed=${report.removed}, reclassified=${report.reclassified})`);
    return 0;
  }

  const nextIndex = {
    ...index,
    count: dedupedLive.length,
    entries: dedupedLive,
  };
  if (isPlainObject(nextIndex.health)) {
    nextIndex.health = synchronizeBodyHealth(
      nextIndex.health,
      bodyRetentionEntries.length,
      reconciledBodyCount,
      bodyBacklog,
      {
        targetBytes: bodyBudgetTargetBytes,
        bytes: bodyBudget.bytes,
        pruned: bodyBudget.prunedIds.length,
        evictedIds: persistedBodyBudgetEvictedIds,
      },
    );
  }

  const filesToWrite = [
    { path: indexPath, value: nextIndex },
    ...archiveMonths.map((month) => ({ path: month.path, value: month.payload })),
    {
      path: archiveIndexPath,
      value: buildArchiveIndexFile(
        archiveMonths.map((month) => month.payload),
        referenceAt,
      ),
    },
    { path: statsPath, value: statsPayload },
    ...(bodiesWrite ? [{ path: bodiesWrite.path, value: bodiesWrite.payload }] : []),
  ];
  writeJsonTransaction(filesToWrite, {
    journalPath,
    lockToken: writeLock.ownerToken,
  });

  console.log(`\nAPPLIED - removed=${report.removed}, reclassified=${report.reclassified}`);
  return 0;
  } finally {
    writeLock?.release();
  }
}

const isDirectInvoke = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectInvoke) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
