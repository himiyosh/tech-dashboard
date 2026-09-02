/**
 * web/src/lib/source-snippet.ts
 *
 * One source of truth for "does this entry carry a real source excerpt?".
 *
 * Three places need the same answer:
 *   - harness/pipeline/source-grounding.ts  (the generation gate)
 *   - web/src/lib/bodies.ts                 (the build-time render guard)
 *   - tests/e2e/smoke.spec.ts               (body fixture derivation)
 *
 * The web build must stay self-contained and must not import repo-root runtime
 * code (R-005), so the shared predicate lives on the web side and the pipeline
 * imports it - the same direction harness/pipeline/normalize.ts already uses
 * for release-signal.ts and knowledge-eligibility.ts. Duplicating the logic
 * instead would let the stored bodies and the rendered pages drift apart, which
 * is exactly the failure this module exists to prevent.
 *
 * The module intentionally imports nothing, so the Astro build, the Node
 * harness, and all three Workers bundles can each use it unchanged. It uses no
 * DOM and no Node API, so it type-checks under the Workers tsconfigs whose
 * `lib` is ES2022 only.
 */

export interface SourceSnippetInput {
  title?: string | null;
  contentSnippet?: string | null;
}

/**
 * An excerpt must clear the character floor AND carry either enough word
 * tokens or enough CJK characters to be a sentence rather than a fragment.
 *
 * Calibration, measured over the 1,301 entries that currently hold a generated
 * body in data/bodies.json. Excerpt length distribution: min 0, p10 82, p25
 * 139, median 279, p75 280, p90 280, max 801 - the collector caps a normal
 * excerpt at 280 characters and an evergreen one at 800
 * (harness/pipeline/normalize.ts:92-93), which is why the distribution piles up
 * at 280.
 *
 * 48 therefore sits far below the 10th percentile: it removes the degenerate
 * tail and nothing else. Sensitivity over the 1,281 body-carrying entries that
 * have a detail route: a 48-char floor drops 65, an 80-char floor drops 103, a
 * 120-char floor drops 188, a 160-char floor drops 500. There is no evidence
 * that the 82-139 char band is fabricated - its median amplification is in line
 * with the corpus - so raising the floor would be discarding grounded pages on
 * a hunch.
 *
 * The character floor is also the least load-bearing part of the rule: at a
 * floor of 0 the word/CJK minimum alone already rejects 64 of those 65. What
 * actually disqualifies an entry is having no sentence, not having a short one.
 * Keeping the constants at their existing pipeline values (48/8/20) means the
 * gate and the guard agree by construction and no new magic number enters the
 * codebase.
 */
export const SOURCE_SNIPPET_MIN_CHARS = 48;
export const SOURCE_SNIPPET_MIN_WORDS = 8;
export const SOURCE_SNIPPET_MIN_CJK = 20;

function decodeHtmlEntities(value: string): string {
  const named = value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'");
  return named.replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (match, hex, decimal) => {
    const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return match;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  });
}

function compact(value: string | null | undefined): string {
  return decodeHtmlEntities(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function normalized(value: string | null | undefined): string {
  return compact(value).toLocaleLowerCase("en-US");
}

function wordTokens(value: string): string[] {
  return compact(value).match(/[\p{L}\p{N}][\p{L}\p{N}+'’._/-]*/gu) ?? [];
}

function cjkCount(value: string): number {
  return [...compact(value)].filter((character) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)
  ).length;
}

/**
 * True when the entry carries a source excerpt substantial enough to support
 * generated prose. An excerpt that merely echoes the title carries no
 * information the title did not already give, so it is rejected too.
 */
/**
 * Feed chrome that some sources ship INSTEAD of a description: "The post X
 * appeared first on Y.", "Read the full article", GitHub release scaffolding.
 * Measured on the live index it produced 151 explainer bodies grounded on
 * nothing but this boilerplate (site audit), so it is removed before the
 * excerpt is measured — a snippet that is only chrome is no material at all.
 */
export const SOURCE_SNIPPET_BOILERPLATE_RE =
  /\bthe post\b.*?\bappeared first on\b.*?(?:\.|$)|\bread the full article\b.*?(?:\.|$)|\bwhat's changed\b|\bfull changelog\b.*?(?:\.|$)|\bnew contributors\b.*?(?:\.|$)/giu;

export function stripSourceSnippetBoilerplate(value: string | null | undefined): string {
  return compact((value ?? "").replace(SOURCE_SNIPPET_BOILERPLATE_RE, " "));
}

export function hasMeaningfulSourceSnippet(input: SourceSnippetInput): boolean {
  const snippet = stripSourceSnippetBoilerplate(input.contentSnippet);
  if (!snippet || normalized(snippet) === normalized(input.title)) return false;
  return (
    snippet.length >= SOURCE_SNIPPET_MIN_CHARS &&
    (
      wordTokens(snippet).length >= SOURCE_SNIPPET_MIN_WORDS ||
      cjkCount(snippet) >= SOURCE_SNIPPET_MIN_CJK
    )
  );
}
