import {
  isAddressableDetailEntry,
  type DetailArchiveTier,
} from "./detail-addressability.ts";
import { detailPath } from "./route-inventory.ts";
import { canonicalSourceUrl } from "./source-meta.ts";

export const EXTERNAL_ENTRY_REL = "noopener noreferrer nofollow" as const;

export interface EntryDestinationInput {
  id: string;
  url: string;
  archiveTier?: DetailArchiveTier;
  /**
   * Build-time publication-gate decision. Carried for shape-compatibility with
   * gated collections; the destination no longer reads it — a held entry still
   * has a built (noindex) /e/ route, so its card links in-site like any other.
   * Only summary-less and cold/dropped entries link out to the source.
   */
  publicationHold?: boolean;
  source?: string;
  title?: string;
  titleJa?: string | null;
  titleEn?: string | null;
  summaryJa?: string | null;
  summaryEn?: string | null;
}

export interface EntryDestination {
  href: string;
  external: boolean;
  target?: "_blank";
  rel?: typeof EXTERNAL_ENTRY_REL;
}

export function entryDestination(
  entry: EntryDestinationInput,
): EntryDestination {
  if (isAddressableDetailEntry(entry)) {
    return {
      href: detailPath(entry.id),
      external: false,
    };
  }
  return {
    href: canonicalSourceUrl(entry.url),
    external: true,
    target: "_blank",
    rel: EXTERNAL_ENTRY_REL,
  };
}
