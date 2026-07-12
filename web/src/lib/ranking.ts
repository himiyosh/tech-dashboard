import type { NormalizedEntry } from "./data.ts";
import { sourceAuthority } from "./source-meta.ts";

const AUTHORITY_BOOST = {
  official: 20,
  paper: 16,
  community: 8,
  news: 4,
  source: 2,
  aggregator: 0,
} as const;

export function decisionRankScore(
  entry: Pick<NormalizedEntry, "collectedAt" | "importance" | "publishedAt" | "source" | "sourceType">,
  nowMs: number,
): number {
  const publishedMs = Date.parse(entry.publishedAt || entry.collectedAt);
  const ageHours = Number.isFinite(publishedMs)
    ? Math.max(0, (nowMs - publishedMs) / 3_600_000)
    : 0;
  const authority = sourceAuthority(entry.source, entry.sourceType).kind;
  const sourceTypeBoost =
    entry.sourceType === "release" || entry.sourceType === "changelog" ? -8 : 0;
  return entry.importance * 100 + AUTHORITY_BOOST[authority] - ageHours * 0.6 + sourceTypeBoost;
}
