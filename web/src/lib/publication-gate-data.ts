/**
 * Binds publication-gate.ts to the committed artifacts.
 *
 * Both imports are static: a missing or malformed manifest must fail the build
 * with the module path in the message, never fall back to "publish everything".
 * Vite dedupes data/index.json with the copy web/src/lib/data.ts already
 * imports, so this costs no extra memory at build time.
 */
import approvalsJson from "../../../data/approved-entries.json";
import indexJson from "../../../data/index.json";
import {
  buildPublicationGate,
  parsePublicationApprovalManifest,
  type PublicationApprovalManifest,
  type PublicationGate,
} from "./publication-gate.ts";

const generatedAt = (indexJson as { generatedAt?: unknown }).generatedAt;

export const PUBLICATION_MANIFEST: PublicationApprovalManifest =
  parsePublicationApprovalManifest(approvalsJson as unknown);

/**
 * The clock is data/index.json `generatedAt`, not `Date.now()`: the release
 * schedule must be a pure function of the committed data so two builds of the
 * same commit produce the same route set. A non-string value falls through to
 * the gate's GATE_CLOCK rejection rather than being defaulted.
 */
export const SITE_PUBLICATION_GATE: PublicationGate = buildPublicationGate({
  manifest: PUBLICATION_MANIFEST,
  now: typeof generatedAt === "string" ? generatedAt : "",
});
