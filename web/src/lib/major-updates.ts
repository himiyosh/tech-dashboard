import type { NormalizedEntry } from "./entry-types.ts";
import { canonicalArchiveSearchKey } from "./cold-archive-search-core.ts";
import { isAddressableDetailEntry } from "./detail-addressability.ts";
import { isPublishableEntry } from "./entry-publication.ts";
import { isOffTopicForHero } from "./hero-relevance.ts";
import { decisionTopicKey } from "./ranking.ts";
import { effectiveImportance } from "./release-signal.ts";

/** Select RSS candidates from a single published snapshot, newest first. */
export function selectMajorUpdates<T extends NormalizedEntry>(
  entries: readonly T[],
  generatedAt: string,
): T[] {
  const snapshotTime = Date.parse(generatedAt);
  if (!Number.isFinite(snapshotTime)) {
    throw new Error(`Invalid major-updates snapshot time: ${generatedAt}`);
  }

  const seenTopics = new Set<string>();
  const seenSources = new Set<string>();
  return entries
    .filter((entry) => {
      const publishedTime = Date.parse(entry.publishedAt);
      return entry.archiveTier !== "cold"
        && entry.archiveTier !== "dropped"
        && effectiveImportance(entry) === 3
        && !isOffTopicForHero(entry)
        && isPublishableEntry(entry)
        && isAddressableDetailEntry(entry)
        && Number.isFinite(publishedTime)
        && publishedTime <= snapshotTime;
    })
    .sort((left, right) =>
      Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
      || left.id.localeCompare(right.id)
    )
    .filter((entry) => {
      const sourceUrl = canonicalArchiveSearchKey(entry.url);
      if (!sourceUrl || seenSources.has(sourceUrl)) return false;
      const topic = decisionTopicKey(entry);
      if (topic) {
        if (seenTopics.has(topic)) return false;
        seenTopics.add(topic);
      }
      seenSources.add(sourceUrl);
      return true;
    });
}
