/**
 * release-signal.ts — pure release/changelog signal classification shared by
 * the collector (harness/pipeline/normalize.ts scoreImportance) and the web
 * ranking layer (decision slots / featured hero).
 *
 * Why: release feeds publish every patch build ("Cline Desktop v0.0.17",
 * "Zed Editor Releases v1.16.2"), and the previous importance keywords
 * ("v1." / "v2." / "v3." substring match) scored those routine bumps as
 * importance 3, crowding the decision surfaces with low-value entries. This
 * module classifies a release title by its version shape so that:
 *   - patch / prerelease / nightly builds rank as routine (importance 1),
 *   - minor releases stay importance 2,
 *   - major (x.0.0-style) releases keep importance 3.
 *
 * The module intentionally imports no data artifact and no Node API so both
 * the harness (tsx) and the self-contained web build (R-005) can use it.
 */

export type ReleaseSignal = "low" | "patch" | "minor" | "major" | "none";

/**
 * Low-signal builds: nightly snapshots, pre-releases, release candidates,
 * betas/alphas, internal staging builds, and PR-ref release notes.
 * Kept byte-identical with the guards in harness/pipeline/normalize.ts and
 * web/src/lib/data.ts (LOW_SIGNAL_RELEASE_RE).
 */
export const LOW_SIGNAL_RELEASE_TITLE_RE =
  /\b(?:nightly|canary|snapshot)\b|\bcollab-(?:staging|production|prod)\b|[-_.](?:pre|preview|rc|alpha|beta)\d*\b|\(#\d+\)\s*$/i;

/** First dotted version token in a title, e.g. "v3.0.58", "1.104.2", "0.12.0.1". */
const VERSION_TOKEN_RE = /\bv?(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9a-z.\-]+)?\b/i;

/**
 * Classifies one release/changelog title.
 *
 * - "low": prerelease/nightly/RC/staging build markers.
 * - "patch": a version token with a non-zero component after the minor slot
 *   (x.y.Z with Z>0, or a non-zero 4th part). Dotted CalVer builds
 *   ("2026.04.21") land here too — a dated routine build is routine.
 * - "minor": x.Y.0 with Y>0 (also bare x.Y two-part versions).
 * - "major": x.0.0 / x.0 — first stable or a major line bump.
 * - "none": no version token found (descriptive changelog headlines).
 */
export function classifyReleaseTitleSignal(title: string): ReleaseSignal {
  const trimmed = title.trim();
  if (!trimmed) return "none";
  if (LOW_SIGNAL_RELEASE_TITLE_RE.test(trimmed)) return "low";
  const match = trimmed.match(VERSION_TOKEN_RE);
  if (!match) return "none";
  const minor = Number(match[2]);
  const patch = match[3] !== undefined ? Number(match[3]) : 0;
  const fourth = match[4] !== undefined ? Number(match[4]) : 0;
  if (patch > 0 || fourth > 0) return "patch";
  if (minor > 0) return "minor";
  return "major";
}

export interface ReleaseSignalEntry {
  sourceType: string;
  title: string;
  titleEn?: string | null;
  titleJa?: string | null;
}

/**
 * True when a stored entry is a routine (patch/prerelease) release build.
 * Checks every stored title variant so the web layer stays robust to
 * imperfect stored importance even before the corrected collector is
 * redeployed and old entries are re-scored (LL-083/LL-090 style: fix the
 * display, don't depend on the data being perfect).
 */
export function isRoutineReleaseEntry(entry: ReleaseSignalEntry): boolean {
  if (entry.sourceType !== "release" && entry.sourceType !== "changelog") {
    return false;
  }
  const titles = [entry.title, entry.titleEn, entry.titleJa];
  return titles.some((title) => {
    if (!title) return false;
    const signal = classifyReleaseTitleSignal(title);
    return signal === "low" || signal === "patch";
  });
}

/**
 * Display-facing importance: a routine patch/prerelease build always reads
 * as importance 1, regardless of the stored value. Older snapshots carry
 * over-scored importance (the collector once matched "v3." as a major
 * keyword) and the max-merge ratchet keeps it until the data migration
 * (scripts/rescore-release-importance.ts) runs, so every importance badge,
 * HOT accent, and importance-based grouping must read THIS value instead of
 * entry.importance directly.
 */
export function effectiveImportance<T extends 1 | 2 | 3>(
  entry: ReleaseSignalEntry & { importance: T },
): 1 | 2 | 3 {
  return isRoutineReleaseEntry(entry) ? 1 : entry.importance;
}
