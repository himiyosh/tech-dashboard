/**
 * scripts/rescore-release-importance.ts
 *
 * One-time migration companion to the release-signal importance fix
 * (web/src/lib/release-signal.ts + harness/pipeline/normalize.ts).
 *
 * The collector's previous major-keyword list contained the substrings
 * "v1." / "v2." / "v3.", so routine patch tags ("Cline CLI v3.0.58",
 * "Zed Editor Releases v1.16.2") were stored with importance 3, and the
 * Worker's preserveImportance restamp keeps that inflated value forever.
 * This script re-scores stored release/changelog entries with the corrected
 * classifier and only ever LOWERS importance (min(stored, rescored)), so an
 * AI-upgraded non-release entry or a legitimately major release is never
 * demoted below the deterministic score.
 *
 * Scope: data/index.json and every data/archive/YYYY-MM.json.
 *
 * Usage:
 *   npx tsx scripts/rescore-release-importance.ts            # dry-run report
 *   npx tsx scripts/rescore-release-importance.ts --apply    # write files
 *
 * Fail-closed argument parsing: anything other than no-args or exactly
 * "--apply" prints usage and exits non-zero without touching data.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyReleaseTitleSignal } from "../web/src/lib/release-signal.ts";

type Importance = 1 | 2 | 3;

interface StoredEntry {
  id: string;
  sourceType?: string;
  title?: string;
  titleEn?: string;
  titleJa?: string;
  importance?: Importance;
}

const args = process.argv.slice(2);
const apply = args.length === 1 && args[0] === "--apply";
if (args.length > 0 && !apply) {
  console.error(
    "Usage: npx tsx scripts/rescore-release-importance.ts [--apply]\n" +
      `Unrecognized arguments: ${args.join(" ")} (nothing was modified)`,
  );
  process.exit(1);
}

function rescoredImportance(entry: StoredEntry): Importance | null {
  if (entry.sourceType !== "release" && entry.sourceType !== "changelog") {
    return null;
  }
  const titles = [entry.title, entry.titleEn, entry.titleJa].filter(
    (title): title is string => !!title,
  );
  if (titles.length === 0) return null;
  const signals = titles.map(classifyReleaseTitleSignal);
  if (signals.some((s) => s === "low" || s === "patch")) return 1;
  if (signals.some((s) => s === "minor")) return 2;
  return null; // major / descriptive titles keep their stored importance
}

function rescoreFile(path: string): { changed: number; total: number } {
  const raw = readFileSync(path, "utf8");
  const payload = JSON.parse(raw) as { entries?: StoredEntry[] };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  let changed = 0;
  for (const entry of entries) {
    const stored = entry.importance;
    if (stored !== 1 && stored !== 2 && stored !== 3) continue;
    const rescored = rescoredImportance(entry);
    if (rescored === null || rescored >= stored) continue;
    entry.importance = rescored;
    changed++;
  }
  if (changed > 0 && apply) {
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }
  return { changed, total: entries.length };
}

const root = process.cwd();
const targets = [
  join(root, "data", "index.json"),
  ...readdirSync(join(root, "data", "archive"))
    .filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
    .sort()
    .map((name) => join(root, "data", "archive", name)),
];

let totalChanged = 0;
for (const path of targets) {
  const { changed, total } = rescoreFile(path);
  totalChanged += changed;
  if (changed > 0) {
    console.log(`${path}: demoted ${changed} of ${total} entries`);
  }
}
console.log(
  `${apply ? "APPLIED" : "DRY-RUN"}: ${totalChanged} release/changelog entries would be demoted to their deterministic score`,
);
if (!apply && totalChanged > 0) {
  console.log("Re-run with --apply to write the files.");
}
