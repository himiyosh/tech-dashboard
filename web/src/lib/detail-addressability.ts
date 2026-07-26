export type DetailArchiveTier = "hot" | "warm" | "cold" | "dropped";

export interface DetailAddressableEntry {
  id: string;
  archiveTier?: DetailArchiveTier;
}

/**
 * Detail routes exist only for current hot/warm content. Untiered entries are
 * accepted for compatibility with older live snapshots; cold/dropped entries
 * are month-only or removed and must never receive an individual route.
 *
 * This module intentionally imports no data artifact so route consumers and
 * tests can share the policy without loading JSON.
 */
export function isAddressableDetailEntry(
  entry: DetailAddressableEntry,
): boolean {
  return entry.archiveTier !== "cold" && entry.archiveTier !== "dropped";
}

export function collectAddressableDetailEntries<
  T extends DetailAddressableEntry,
>(
  ...entryGroups: ReadonlyArray<readonly T[]>
): readonly T[] {
  const entriesById = new Map<string, T>();
  for (const entries of entryGroups) {
    for (const entry of entries) {
      if (!isAddressableDetailEntry(entry) || entriesById.has(entry.id)) continue;
      entriesById.set(entry.id, entry);
    }
  }
  return [...entriesById.values()];
}
