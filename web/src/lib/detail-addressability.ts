import { summaryForLang, type SummaryDisplayEntry } from "./summary-display.ts";

export type DetailArchiveTier = "hot" | "warm" | "cold" | "dropped";

export interface DetailAddressableEntry {
  id: string;
  archiveTier?: DetailArchiveTier;
  /**
   * Build-time publication-gate decision (publication-gate.ts). True when the
   * entry is not approved yet, or approved but its scheduled release day has
   * not arrived. Optional here so raw stored rows can still be tested against
   * the content policy; `collectAddressableDetailEntries` requires it, because
   * that is the function that actually produces routes.
   */
  publicationHold?: boolean;
  source?: string;
  title?: string;
  titleJa?: string | null;
  titleEn?: string | null;
  summaryJa?: string | null;
  summaryEn?: string | null;
}

/** A detail entry that carries an explicit publication-gate decision. */
export interface GatedDetailEntry extends DetailAddressableEntry {
  publicationHold: boolean;
}

/** Category prefix for gate-annotation failures raised from this module. */
export const PUBLICATION_HOLD_ANNOTATION_ERROR =
  "PUBLICATION_HOLD_ANNOTATION_MISSING";

/**
 * True when the entry carries at least one usable (non-placeholder,
 * non-title-echo) summary in either language. Entries whose summary slots are
 * entirely absent from the input object (legacy snapshots / minimal test
 * fixtures) are treated as usable for backward compatibility; live index and
 * archive entries always carry both slots as strings.
 */
export function hasUsableDetailSummary(entry: DetailAddressableEntry): boolean {
  if (entry.summaryJa === undefined && entry.summaryEn === undefined) {
    return true;
  }
  const displayEntry: SummaryDisplayEntry = {
    source: entry.source ?? "",
    title: entry.title ?? "",
    titleJa: entry.titleJa,
    titleEn: entry.titleEn,
    summaryJa: entry.summaryJa,
    summaryEn: entry.summaryEn,
  };
  return Boolean(
    summaryForLang(displayEntry, "ja") || summaryForLang(displayEntry, "en"),
  );
}

/**
 * Detail routes exist only for current hot/warm content that has a real
 * summary. Untiered entries are accepted for compatibility with older live
 * snapshots; cold/dropped entries are month-only or removed and must never
 * receive an individual route.
 *
 * Summary-absent entries (deterministic pending fallback only) render nothing
 * but the title plus "Summary pending" boilerplate — thousands of such
 * indexable near-empty pages read as mass-generated thin content to search
 * engines and the Google AdSense "low value content" review. They stay in
 * lists and link out to the original source (entry-destination.ts) until a
 * real summary lands, at which point the detail route re-appears.
 *
 * This module intentionally imports no data artifact so route consumers and
 * tests can share the policy without loading JSON.
 */
export function isAddressableDetailEntry(
  entry: DetailAddressableEntry,
): boolean {
  return (
    entry.publicationHold !== true &&
    entry.archiveTier !== "cold" &&
    entry.archiveTier !== "dropped" &&
    hasUsableDetailSummary(entry)
  );
}

/**
 * Collect the entries that receive a real /e/[id]/ route.
 *
 * Every input must carry an explicit `publicationHold`. The annotation is NOT
 * inferred: nothing in this repository typechecks web/src/lib/data.ts,
 * archive.ts or tests/**, so a missing annotation would otherwise pass silently
 * and republish the entire corpus. Missing means "this collection never went
 * through applyPublicationGate", which is a bug, so it fails closed with the
 * offending id as evidence instead of defaulting to released.
 */
export function collectAddressableDetailEntries<
  T extends GatedDetailEntry,
>(
  ...entryGroups: ReadonlyArray<readonly T[]>
): readonly T[] {
  const entriesById = new Map<string, T>();
  for (const entries of entryGroups) {
    for (const entry of entries) {
      if (typeof entry.publicationHold !== "boolean") {
        throw new Error(
          `${PUBLICATION_HOLD_ANNOTATION_ERROR}: entry ${entry.id} reached the`
            + " detail-route collector without a publication-gate decision;"
            + " route it through applyPublicationGate (web/src/lib/data.ts) first",
        );
      }
      if (!isAddressableDetailEntry(entry) || entriesById.has(entry.id)) continue;
      entriesById.set(entry.id, entry);
    }
  }
  return [...entriesById.values()];
}
