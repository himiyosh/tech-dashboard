#!/usr/bin/env node
/**
 * scripts/kv-migrate.mjs
 *
 * One-shot migration: explode the legacy `cache.v1` KV blob into per-URL keys
 * (LL-038). Idempotent — re-running is safe; existing per-URL keys are
 * overwritten only if --force is passed.
 *
 * Usage:
 *   node scripts/kv-migrate.mjs            # dry-run (count only)
 *   node scripts/kv-migrate.mjs --apply    # write per-URL keys via wrangler
 *   node scripts/kv-migrate.mjs --apply --force  # overwrite existing keys
 *
 * Why a node script (not a Worker route): wrangler `kv key put` is the
 * supported migration path, runs from local with the Wrangler OAuth token,
 * and avoids burning Worker CPU on the migration itself. ~1000 keys total
 * so this finishes in a few minutes.
 *
 * Prerequisites:
 *   - wrangler authenticated (`npx wrangler whoami` shows the himiyosh
 *     account)
 *   - SUMMARY_CACHE namespace id 6d67debb991742efadfec473a121f5fc (matches
 *     worker/wrangler.toml)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAMESPACE_ID = "6d67debb991742efadfec473a121f5fc";
const LEGACY_BLOB_KEY = "cache.v1";
const KEY_PREFIX = "s:";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");
const CONCURRENCY = Number(process.env.MIGRATE_CONCURRENCY ?? "4");

function keyForUrl(url) {
  return KEY_PREFIX + createHash("sha256").update(url).digest("hex");
}

function wrangler(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      cwd: "worker",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`wrangler ${args.join(" ")} exited ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

async function fetchLegacyBlob() {
  const out = await wrangler([
    "kv",
    "key",
    "get",
    "--namespace-id",
    NAMESPACE_ID,
    LEGACY_BLOB_KEY,
    "--remote",
  ]);
  return JSON.parse(out);
}

async function listExistingPerUrlKeys() {
  // wrangler kv key list streams JSON array of { name, expiration?, ... }.
  // Filter by prefix `s:` to count migrated entries.
  const out = await wrangler([
    "kv",
    "key",
    "list",
    "--namespace-id",
    NAMESPACE_ID,
    "--prefix",
    KEY_PREFIX,
    "--remote",
  ]);
  const parsed = JSON.parse(out);
  return new Set(parsed.map((k) => k.name));
}

async function putKey(key, value) {
  // wrangler kv key put expects the value inline or via --path. JSON values
  // with newlines and shell metacharacters survive --path safely.
  const dir = mkdtempSync(join(tmpdir(), "kv-migrate-"));
  const file = join(dir, "value.json");
  writeFileSync(file, value, "utf8");
  try {
    await wrangler([
      "kv",
      "key",
      "put",
      "--namespace-id",
      NAMESPACE_ID,
      key,
      "--path",
      file,
      "--remote",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BULK_CHUNK = 5000;

async function bulkPut(items) {
  // wrangler kv bulk put accepts a JSON array of {key,value} pairs, up to
  // 10000 entries per call. One subprocess invocation per chunk eliminates
  // the ~1 s wrangler startup overhead we'd pay per single put.
  const dir = mkdtempSync(join(tmpdir(), "kv-migrate-"));
  const file = join(dir, "bulk.json");
  writeFileSync(file, JSON.stringify(items), "utf8");
  try {
    await wrangler([
      "kv",
      "bulk",
      "put",
      "--namespace-id",
      NAMESPACE_ID,
      file,
      "--remote",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runWithConcurrency(items, fn, concurrency) {
  let idx = 0;
  let done = 0;
  let failed = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        await fn(items[i]);
        done++;
      } catch (err) {
        failed++;
        console.warn(`  ! failed [${i + 1}/${items.length}]: ${err.message}`);
      }
      if ((done + failed) % 25 === 0) {
        console.log(`  ... ${done + failed}/${items.length} (${failed} failed)`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { done, failed };
}

async function main() {
  console.log(`[kv-migrate] mode=${APPLY ? (FORCE ? "apply+force" : "apply") : "dry-run"}`);
  console.log("[kv-migrate] reading legacy cache.v1 blob ...");
  const blob = await fetchLegacyBlob();
  const urls = Object.keys(blob);
  console.log(`[kv-migrate] legacy entries: ${urls.length}`);

  console.log("[kv-migrate] listing existing per-URL keys ...");
  const existing = await listExistingPerUrlKeys();
  console.log(`[kv-migrate] existing per-URL keys: ${existing.size}`);

  const toWrite = [];
  let skippedExisting = 0;
  for (const url of urls) {
    const key = keyForUrl(url);
    if (existing.has(key) && !FORCE) {
      skippedExisting++;
      continue;
    }
    toWrite.push({ url, key, value: JSON.stringify(blob[url]) });
  }
  console.log(`[kv-migrate] plan: write=${toWrite.length}, skipped(existing)=${skippedExisting}`);

  if (!APPLY) {
    console.log("[kv-migrate] dry-run complete. Re-run with --apply to write.");
    return;
  }

  console.log(`[kv-migrate] writing ${toWrite.length} keys in chunks of ${BULK_CHUNK} ...`);
  let written = 0;
  let failedChunks = 0;
  for (let i = 0; i < toWrite.length; i += BULK_CHUNK) {
    const slice = toWrite.slice(i, i + BULK_CHUNK);
    try {
      await bulkPut(slice.map((it) => ({ key: it.key, value: it.value })));
      written += slice.length;
      console.log(`  ... ${written}/${toWrite.length}`);
    } catch (err) {
      failedChunks++;
      console.warn(`  ! chunk ${i}-${i + slice.length - 1} failed: ${err.message}`);
    }
  }
  console.log(`[kv-migrate] done: written=${written} failedChunks=${failedChunks}`);
  if (failedChunks > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[kv-migrate] fatal:", err);
  process.exit(1);
});
