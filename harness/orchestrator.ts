/**
 * orchestrator.ts — Outer harness loop (Phase 1).
 *
 * Runs collectors in parallel, normalizes, dedupes, tags, and writes
 * data/index.json. Stubs the LLM summarize step — that arrives in Phase 2.
 *
 * Usage:
 *   npm run collect              # full run, writes to data/
 *   npm run collect:dry          # no files written
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listSources } from "./registry.ts";
import { normalize } from "./pipeline/normalize.ts";
import { dedupeByUrl } from "./pipeline/dedupe.ts";
import { applyTags } from "./pipeline/tag.ts";
import { summarize } from "./pipeline/summarize.ts";
import { writeIndex, writeRawSnapshot } from "./publishers/index-builder.ts";
import { writeArchive } from "./publishers/archive-builder.ts";
import { writeStats } from "./publishers/stats-builder.ts";
import type {
  CollectorRunResult,
  NormalizedEntry,
  SourceDefinition,
} from "./types.ts";

interface RunOptions {
  dryRun: boolean;
  dataDir: string;
}

function parseArgs(): RunOptions {
  const argv = process.argv.slice(2);
  return {
    dryRun: argv.includes("--dry-run"),
    dataDir: join(process.cwd(), "data"),
  };
}

async function runSource(
  source: SourceDefinition,
  opts: RunOptions,
  collectedAt: string,
): Promise<{ result: CollectorRunResult; entries: NormalizedEntry[] }> {
  const start = Date.now();
  try {
    const rawList = await source.collect(source);
    if (!opts.dryRun) {
      await writeRawSnapshot(source.id, rawList, opts.dataDir, collectedAt);
    }
    const entries = rawList.map((raw) => applyTags(normalize(raw, source, collectedAt)));
    return {
      result: {
        sourceId: source.id,
        ok: true,
        count: entries.length,
        durationMs: Date.now() - start,
      },
      entries,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        sourceId: source.id,
        ok: false,
        count: 0,
        durationMs: Date.now() - start,
        error: msg,
      },
      entries: [],
    };
  }
}

async function writeRunReport(
  results: CollectorRunResult[],
  dataDir: string,
  collectedAt: string,
): Promise<void> {
  const runDir = join(dataDir, "_runs");
  await mkdir(runDir, { recursive: true });
  const payload = {
    generatedAt: collectedAt,
    totalSources: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    totalEntries: results.reduce((sum, r) => sum + r.count, 0),
    results,
  };
  const path = join(runDir, `${collectedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function formatResult(r: CollectorRunResult): string {
  const status = r.ok ? "OK " : "ERR";
  const detail = r.ok ? `${r.count} entries` : r.error ?? "unknown error";
  return `  ${status} ${r.sourceId.padEnd(24)} ${String(r.durationMs).padStart(5)}ms  ${detail}`;
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const collectedAt = new Date().toISOString();
  const sources = listSources();

  console.log(`[harness] starting run at ${collectedAt}`);
  console.log(`[harness] sources: ${sources.length}${opts.dryRun ? " (dry-run)" : ""}`);

  const settled = await Promise.all(
    sources.map((s) => runSource(s, opts, collectedAt)),
  );

  const allEntries = settled.flatMap((s) => s.entries);
  const deduped = dedupeByUrl(allEntries);

  const results = settled.map((s) => s.result);
  console.log("[harness] per-source results:");
  for (const r of results) console.log(formatResult(r));

  console.log(
    `[harness] collected ${allEntries.length} entries, deduped to ${deduped.length}`,
  );

  if (opts.dryRun) {
    console.log("[harness] dry-run: skipping data/ writes");
    return;
  }

  const { entries: enhanced, stats: sumStats } = await summarize(
    // Sort newest-first so the MAX_NEW budget is spent on the most recent
    // entries (which are the ones writeIndex() will keep).
    [...deduped].sort(
      (a, b) =>
        (b.publishedAt ? new Date(b.publishedAt).getTime() : -Infinity) -
        (a.publishedAt ? new Date(a.publishedAt).getTime() : -Infinity),
    ),
    opts.dataDir,
  );
  console.log(
    `[summarize] cached=${sumStats.cached} summarized=${sumStats.summarized} skipped=${sumStats.skipped} errors=${sumStats.errors}`,
  );

  const indexPath = await writeIndex(enhanced, opts.dataDir);
  const archiveStats = await writeArchive(enhanced, opts.dataDir);
  const statsPath = await writeStats(opts.dataDir);
  await writeRunReport(results, opts.dataDir, collectedAt);
  console.log(`[harness] wrote ${indexPath}`);
  console.log(`[harness] wrote ${statsPath}`);
  console.log(
    `[archive] months=${archiveStats.monthsTouched} archived=${archiveStats.entriesArchived} ` +
      `dropped=${archiveStats.entriesDropped} hot-skipped=${archiveStats.entriesSkippedHot}`,
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`[harness] ${failed.length} source(s) failed (see _runs report)`);
    // Non-zero exit to flag CI, but only if ALL failed.
    if (failed.length === results.length) process.exit(1);
  }
}

main().catch((err) => {
  console.error("[harness] fatal:", err);
  process.exit(1);
});
