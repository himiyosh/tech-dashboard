/**
 * index-builder.ts — writes data/index.json for the static site to consume.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedEntry } from "../types.ts";

const INDEX_LIMIT = 2000;
const PER_SOURCE_CAP = 50;

/** Return epoch ms for sorting; nulls sort to end in descending order. */
function dateMs(iso: string | null): number {
  return iso ? new Date(iso).getTime() : -Infinity;
}

/**
 * Score for picking which entries to keep when a single source exceeds
 * PER_SOURCE_CAP. We multiply importance (1-3) by a recency factor so that
 * high-volume firehoses (e.g. arxiv with hundreds of papers/day) keep their
 * most important items, while still preferring recent entries among ties.
 */
function pickScore(e: NormalizedEntry): number {
  const recencyDays = e.publishedAt
    ? (Date.now() - new Date(e.publishedAt).getTime()) / 86_400_000
    : 365;
  // importance dominates; recency breaks ties (and decays slowly for ages).
  return (e.importance ?? 1) * 1000 - recencyDays;
}

export interface IndexPayload {
  generatedAt: string;
  count: number;
  entries: NormalizedEntry[];
}

export async function writeIndex(
  entries: NormalizedEntry[],
  dataDir: string,
): Promise<string> {
  // Exclude entries past the cold threshold — they exist only as anchors
  // inside data/archive/{YYYY-MM}.json from this point on.
  const live = entries.filter((e) => e.archiveTier !== "dropped");

  // Cap per source (prevents arxiv's ~400/day dump from drowning out
  // other sources), then sort newest-first, then cap to INDEX_LIMIT.
  const bySource = new Map<string, NormalizedEntry[]>();
  for (const e of live) {
    const arr = bySource.get(e.source) ?? [];
    arr.push(e);
    bySource.set(e.source, arr);
  }
  const capped: NormalizedEntry[] = [];
  for (const [, arr] of bySource) {
    if (arr.length <= PER_SOURCE_CAP) {
      capped.push(...arr);
      continue;
    }
    // High-volume source: select by importance × recency, then re-sort by date.
    const picked = [...arr]
      .sort((a, b) => pickScore(b) - pickScore(a))
      .slice(0, PER_SOURCE_CAP);
    capped.push(...picked);
  }
  const sorted = capped.sort(
    (a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt),
  );
  const final = sorted.slice(0, INDEX_LIMIT);
  const payload: IndexPayload = {
    generatedAt: new Date().toISOString(),
    count: final.length,
    entries: final,
  };
  const outPath = join(dataDir, "index.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return outPath;
}

export { PER_SOURCE_CAP, INDEX_LIMIT };

export async function writeRawSnapshot(
  sourceId: string,
  rawEntries: unknown,
  dataDir: string,
  dateIso: string,
): Promise<string> {
  const date = dateIso.slice(0, 10); // YYYY-MM-DD
  const outPath = join(dataDir, "raw", date, `${sourceId}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(rawEntries, null, 2) + "\n", "utf8");
  return outPath;
}
