/**
 * body-sections.ts — split a generated article body into headed sections.
 *
 * Bodies in data/bodies.json are plain text with blank-line paragraph
 * breaks. Newer bodies may carry authored section headings as lines that
 * start with "## " (see worker/src/body-generate.ts); the 1301 bodies
 * generated before that contract have none. This module gives both kinds a
 * section structure the detail page can render as 項目 (h2 headings + TOC):
 *
 * - Authored mode: "## " lines become section headings verbatim.
 * - Derived mode (legacy bodies): position + lexical cues only. The
 *   generation prompt guarantees paragraph 1 is a lead, and 77% of final
 *   paragraphs carry outlook lexemes, so the only headings we synthesize
 *   are structural ones that cannot mislabel content: 概要 (lead), 背景
 *   (only when a middle paragraph literally opens with 背景), 詳細
 *   (remaining middle), 今後の展望 (only when the final paragraph carries
 *   outlook lexemes AND ends with terminal punctuation — truncated bodies
 *   keep their defect out of a highlighted section).
 *
 * Pure module: no DOM, no data imports (R-005). Rendering lives in
 * web/src/pages/e/[id].astro.
 */

export type BodyLang = "ja" | "en";

export interface BodySection {
  /** Heading above the section; null = unheaded (lead-in or short body). */
  heading: string | null;
  /** "authored" = from a "## " line in the body; "derived" = synthesized. */
  source: "authored" | "derived";
  paragraphs: string[];
}

/** Blank-line paragraph split shared with the legacy renderer. */
export function splitBodyParagraphs(body: string): string[] {
  return body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const AUTHORED_HEADING_RE = /^##\s+(.+)$/;

/** Bodies shorter than this stay a single unheaded flow (matches TOC gate). */
const MIN_PARAGRAPHS_FOR_SECTIONS = 3;

const SECTION_LABELS: Record<
  BodyLang,
  { overview: string; background: string; detail: string; outlook: string }
> = {
  ja: { overview: "概要", background: "背景", detail: "詳細", outlook: "今後の展望" },
  en: { overview: "Overview", background: "Background", detail: "In detail", outlook: "Outlook" },
};

const OUTLOOK_RE: Record<BodyLang, RegExp> = {
  ja: /今後|可能性|と見られる|とみられる|だろう|注目|期待|見通し|展望/,
  en: /going forward|outlook|in the coming|expected to|will likely|is likely to|likely to|remains to be seen|could (?:help|become|make|open)|future/i,
};

const BACKGROUND_OPENER_RE: Record<BodyLang, RegExp> = {
  ja: /^背景/,
  en: /^(?:background|for context|historically|to understand)/i,
};

/** Truncation guard: a paragraph that ends mid-sentence must not headline 展望. */
const TERMINAL_PUNCT_RE = /[。．.!?！?」』)"'”’\]]$/;

function parseAuthoredSections(blocks: string[]): BodySection[] | null {
  let sawHeading = false;
  const sections: BodySection[] = [];
  let current: BodySection | null = null;
  const push = (section: BodySection) => {
    sections.push(section);
    current = section;
  };
  for (const block of blocks) {
    const lines = block.split(/\n/);
    const headingMatch = lines[0].match(AUTHORED_HEADING_RE);
    if (headingMatch) {
      sawHeading = true;
      push({
        heading: headingMatch[1].replace(/\s+/g, " ").trim().slice(0, 80),
        source: "authored",
        paragraphs: [],
      });
      // Tolerate a paragraph glued to the heading with a single newline.
      const rest = lines.slice(1).join("\n").trim();
      if (rest) current!.paragraphs.push(rest);
      continue;
    }
    if (!current) {
      push({ heading: null, source: "authored", paragraphs: [] });
    }
    current!.paragraphs.push(block);
  }
  if (!sawHeading) return null;
  return sections.filter((s) => s.paragraphs.length > 0 || s.heading !== null);
}

function deriveSections(paragraphs: string[], lang: BodyLang): BodySection[] {
  if (paragraphs.length === 0) return [];
  if (paragraphs.length < MIN_PARAGRAPHS_FOR_SECTIONS) {
    return [{ heading: null, source: "derived", paragraphs }];
  }
  const labels = SECTION_LABELS[lang];
  const last = paragraphs[paragraphs.length - 1];
  const hasOutlook =
    OUTLOOK_RE[lang].test(last) && TERMINAL_PUNCT_RE.test(last);
  const middles = paragraphs.slice(1, hasOutlook ? -1 : undefined);

  const sections: BodySection[] = [
    { heading: labels.overview, source: "derived", paragraphs: [paragraphs[0]] },
  ];
  const bgIndex = middles.findIndex((p) => BACKGROUND_OPENER_RE[lang].test(p));
  if (bgIndex === 0) {
    sections.push({ heading: labels.background, source: "derived", paragraphs: [middles[0]] });
    if (middles.length > 1) {
      sections.push({ heading: labels.detail, source: "derived", paragraphs: middles.slice(1) });
    }
  } else if (bgIndex > 0) {
    sections.push({ heading: labels.detail, source: "derived", paragraphs: middles.slice(0, bgIndex) });
    sections.push({ heading: labels.background, source: "derived", paragraphs: middles.slice(bgIndex) });
  } else if (middles.length > 0) {
    sections.push({ heading: labels.detail, source: "derived", paragraphs: middles });
  }
  if (hasOutlook) {
    sections.push({ heading: labels.outlook, source: "derived", paragraphs: [last] });
  }
  return sections;
}

/**
 * Section structure for one language's body text. Authored "## " headings
 * win; otherwise structural sections are derived. Total paragraph content
 * is preserved in order across sections.
 */
export function sectionizeBody(body: string, lang: BodyLang): BodySection[] {
  const blocks = splitBodyParagraphs(body);
  if (blocks.length === 0) return [];
  const authored = parseAuthoredSections(blocks);
  if (authored) return authored;
  return deriveSections(blocks, lang);
}
