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
