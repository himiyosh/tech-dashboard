/**
 * body-highlight.ts — render one generated body paragraph as safe HTML with
 * tag mentions linkified.
 *
 * Contract: the emitted markup's text content is byte-identical to the input
 * paragraph. Every source character is escaped exactly once, no HTML entity is
 * ever split, and no anchor is ever nested inside another anchor.
 *
 * Why the contract is spelled out: the previous implementation (inline in
 * web/src/pages/e/[id].astro) escaped the paragraph first and then ran one
 * regex replace per tag over the growing *markup*. A shorter tag could then
 * match inside the href of an anchor a longer tag had just inserted — e.g. for
 * tags ["pre-release", "release"], `\brelease\b` matched inside
 * `href="/t/pre-release"` — producing
 * `<a class="kw" href="/t/pre-<a class="kw" href="/t/release">release</a>">`.
 * The HTML parser closes the outer href at the inner quote, keeps a truncated
 * `href="/t/pre-<a class="`, and spills the attribute tail into visible prose
 * (`release">pre-release`). Measured on the committed corpus: 211 paragraphs
 * across 64 detail pages.
 *
 * The fix never runs a regex over generated markup. Match ranges are collected
 * from the raw text (longest tag first, overlapping ranges dropped), then the
 * markup is assembled from independently escaped slices.
 *
 * Pure module: no DOM, no data imports (R-005). The caller supplies
 * `hrefForTag` so lib/data.ts stays out of this module.
 */

export interface TagHighlightRange {
  /** Inclusive start offset in the raw paragraph. */
  readonly start: number;
  /** Exclusive end offset in the raw paragraph. */
  readonly end: number;
  /** The tag that claimed this range (not the matched casing). */
  readonly tag: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes the five HTML-significant characters. NOT idempotent by design —
 * call it exactly once per source string, never on text that already contains
 * entities or markup.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Single-character tags are noise inside prose and are never linkified. */
const MIN_HIGHLIGHTABLE_TAG_LENGTH = 2;

/**
 * Non-overlapping, ascending match ranges for the given tags in the raw text.
 * Longer tags are tried first so "pre-release" wins over "release"; a range
 * that overlaps an already-claimed range is dropped rather than nested. The
 * secondary sort key keeps equal-length tags in a deterministic order so the
 * static build is reproducible.
 */
export function collectTagHighlightRanges(
  text: string,
  tags: readonly string[],
): TagHighlightRange[] {
  const candidates = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
    .filter((tag) => tag.length >= MIN_HIGHLIGHTABLE_TAG_LENGTH)
    .sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));

  const ranges: TagHighlightRange[] = [];
  for (const tag of candidates) {
    const pattern = new RegExp(`\\b${escapeRegex(tag)}\\b`, "gi");
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (match[0].length === 0) {
        // A zero-width match cannot advance lastIndex on its own; step past it
        // instead of looping forever.
        pattern.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      if (ranges.some((range) => start < range.end && range.start < end)) continue;
      ranges.push({ start, end, tag });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Escapes `text` and wraps each tag mention in `<a class="kw">`. `hrefForTag`
 * receives the tag (not the matched casing) and its result is escaped before
 * it reaches the attribute.
 */
export function highlightTagsInText(
  text: string,
  tags: readonly string[],
  hrefForTag: (tag: string) => string,
): string {
  const ranges = collectTagHighlightRanges(text, tags);
  if (ranges.length === 0) return escapeHtml(text);

  let html = "";
  let cursor = 0;
  for (const range of ranges) {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<a class="kw" href="${escapeHtml(hrefForTag(range.tag))}">`;
    html += escapeHtml(text.slice(range.start, range.end));
    html += "</a>";
    cursor = range.end;
  }
  return html + escapeHtml(text.slice(cursor));
}
