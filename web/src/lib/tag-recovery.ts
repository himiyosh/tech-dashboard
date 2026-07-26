import { ARCHIVE_WARM_ENTRIES } from "./archive.ts";
import { ALL_ENTRIES, type NormalizedEntry } from "./data.ts";
import { collectAddressableDetailEntries } from "./detail-addressability.ts";
import { normalizeTagKey } from "./tag-normalize.ts";

function indexedDetailEntries(): readonly NormalizedEntry[] {
  return collectAddressableDetailEntries(ALL_ENTRIES, ARCHIVE_WARM_ENTRIES);
}

export const SINGLETON_INDEXED_TAG_ENTRY_IDS: Readonly<Record<string, string>> =
  Object.freeze((() => {
    const entriesByTag = new Map<string, NormalizedEntry[]>();
    for (const entry of indexedDetailEntries()) {
      for (const tag of new Set(entry.tags.map(normalizeTagKey).filter(Boolean))) {
        const matches = entriesByTag.get(tag) ?? [];
        matches.push(entry);
        entriesByTag.set(tag, matches);
      }
    }

    return Object.fromEntries(
      [...entriesByTag.entries()]
        .filter(([, entries]) => entries.length === 1)
        .map(([tag, entries]) => [tag, entries[0]!.id]),
    );
  })());
