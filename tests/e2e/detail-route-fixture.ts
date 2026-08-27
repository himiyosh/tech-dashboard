import { readFileSync } from "node:fs";
import {
  buildPublicationGate,
  parsePublicationApprovalManifest,
  type PublicationGate,
} from "../../web/src/lib/publication-gate.ts";
import {
  isAddressableDetailEntry,
  type DetailAddressableEntry,
} from "../../web/src/lib/detail-addressability.ts";

/**
 * The exact route policy the preview server was built with: the content rules
 * in detail-addressability.ts AND the publication gate. Every e2e fixture that
 * navigates to /e/{id}/ and expects 200 must select through this, otherwise it
 * can pick a queued (approved-but-not-yet-released) entry and hit a 404.
 *
 * The clock is data/index.json generatedAt, the same value web/src/lib/
 * publication-gate-data.ts feeds the build, so the two agree by construction.
 */
export const SITE_GATE: PublicationGate = buildPublicationGate({
  manifest: parsePublicationApprovalManifest(
    JSON.parse(readFileSync("data/approved-entries.json", "utf8")) as unknown,
  ),
  now: (
    JSON.parse(readFileSync("data/index.json", "utf8")) as { generatedAt: string }
  ).generatedAt,
});

/** True when the build actually produced a /e/{id}/ page for this stored row. */
export function isBuiltDetailEntry(entry: DetailAddressableEntry): boolean {
  return isAddressableDetailEntry({
    ...entry,
    publicationHold: !SITE_GATE.isReleased(entry.id),
  });
}