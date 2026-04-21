/**
 * index-builder.ts — writes data/index.json for the static site to consume.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NormalizedEntry } from "../types.ts";

const INDEX_LIMIT = 500;

export interface IndexPayload {
  generatedAt: string;
  count: number;
  entries: NormalizedEntry[];
}

export async function writeIndex(
  entries: NormalizedEntry[],
  dataDir: string,
): Promise<string> {
  // Sort newest first, cap at INDEX_LIMIT.
  const sorted = [...entries].sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );
  const capped = sorted.slice(0, INDEX_LIMIT);
  const payload: IndexPayload = {
    generatedAt: new Date().toISOString(),
    count: capped.length,
    entries: capped,
  };
  const outPath = join(dataDir, "index.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return outPath;
}

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
