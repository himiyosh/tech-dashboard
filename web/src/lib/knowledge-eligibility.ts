import { isSourceTextUnverifiable, sourceOwnedSnippet } from "./feed-snippet.ts";

export interface KnowledgeEligibilityEntry {
  /** "article" once contentSnippet holds fetched article prose (see feed-snippet.ts). */
  excerptOrigin?: string;
  /** The feed description as collected; evaluated instead of article prose. */
  feedSnippet?: string;
  source: string;
  title: string;
  contentSnippet?: string;
  evergreen?: boolean;
  knowledgeEligible?: boolean;
}

export type KnowledgeEligibilityReason =
  | "eligible"
  | "not-evergreen"
  | "stored-exclusion"
  | "unverifiable-source-text"
  | "durable-title"
  | "durable-snippet"
  | "announcement-title"
  | "availability-context";

export interface KnowledgeEligibilityDecision {
  eligible: boolean;
  reason: KnowledgeEligibilityReason;
}

const ASCII_ALNUM_CLASS = "A-Za-z0-9";
const ASCII_SEPARATOR_RE = "[\\s/._:+-]+";

const DURABLE_TITLE_PATTERNS = [
  /^(?:automate|automating|build|building|deploy|deploying|detect|detecting|evaluate|evaluating|explore|exploring|fine-tune|implement|monitor|monitoring|scale|scaling|use|using)\b/i,
  /^get started\b/i,
  /\bbest practices?\b/i,
  /\bdeveloper(?:'s|s')? guide\b/i,
  /\bguide to\b/i,
  /\bhands-on\b/i,
  /\bhow (?:to|we)\b/i,
  /\bpractical (?:approaches?|guidance|patterns?|tutorial)\b/i,
  /\bwalkthrough\b/i,
];

const DURABLE_SNIPPET_PATTERNS = [
  /\b(?:this|in this) post\b.{0,180}\bhow (?:to|you)\b/i,
  /\bapi\b.{0,120}\bprogrammatic access\b.{0,120}\bparameters? to set\b/i,
  /\bazd deploy\b.{0,80}\bproduction-ready\b/i,
];

const ANNOUNCEMENT_TITLE_PATTERNS = [
  /^announc(?:e|es|ed|ing|ement)\b/i,
  /(?:^|[:;|/\u2013\u2014-]\s*)introduc(?:e|es|ed|ing)\b/i,
  /^launch(?:es|ed|ing)\b/i,
  /^now in (?:public |private )?preview\b/i,
  /^register now\b/i,
  /(?:^|[:;|/\u2013\u2014-]\s*)what(?:['’]s| is) new\b/i,
  /^what .+ announced\b/i,
  /\bnew (?:capabilit(?:y|ies)|features?) announced\b/i,
  /\b(?:named|recognized as) (?:(?:a|the) )?(?:commander|leader|challenger|visionary)\b/i,
  /\b(?:is|remains) (?:a|the) (?:leader|challenger|visionary)\b/i,
  /\b(?:Gartner(?:®)? )?Magic Quadrant\b/i,
];

const ANNOUNCEMENT_SNIPPET_COUNTER_PATTERNS = [
  /^(?:today,?\s+)?we(?:['’]re| are)?\s+announc(?:e|es|ed|ing)\b/i,
  /^this post covers\b.{0,240}\bhow you access(?:\s+(?:it|them))?\b/i,
];

const AVAILABILITY_PHRASES = [
  "general availability",
  "generally available",
  "now available",
] as const;
const AVAILABILITY_ACRONYMS = ["GA"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalized(value: string | undefined): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function matchesAsciiPhrase(
  value: string,
  phrase: string,
  caseSensitive = false,
): boolean {
  const parts = phrase.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const body = parts.map(escapeRegExp).join(ASCII_SEPARATOR_RE);
  return new RegExp(
    `(^|[^${ASCII_ALNUM_CLASS}])${body}(?=$|[^${ASCII_ALNUM_CLASS}])`,
    caseSensitive ? "" : "i",
  ).test(value);
}

function hasDurableTitleSignal(title: string): boolean {
  return DURABLE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function hasDurableSnippetSignal(contentSnippet: string): boolean {
  return DURABLE_SNIPPET_PATTERNS.some((pattern) => pattern.test(contentSnippet));
}

function hasAnnouncementSnippetCounterSignal(contentSnippet: string): boolean {
  return ANNOUNCEMENT_SNIPPET_COUNTER_PATTERNS.some((pattern) =>
    pattern.test(contentSnippet)
  );
}

function hasAvailabilitySignal(value: string): boolean {
  return (
    AVAILABILITY_PHRASES.some((phrase) => matchesAsciiPhrase(value, phrase)) ||
    AVAILABILITY_ACRONYMS.some((phrase) =>
      matchesAsciiPhrase(value, phrase, true)
    )
  );
}

export function knowledgeEligibility(
  entry: KnowledgeEligibilityEntry,
): KnowledgeEligibilityDecision {
  if (entry.evergreen !== true) {
    return { eligible: false, reason: "not-evergreen" };
  }
  const title = normalized(entry.title);
  // Eligibility is a collection-time contract on the feed text, never on an
  // article excerpt swapped in later for the model. When that feed text is
  // gone (enriched before feedSnippet existed) the stored decision stands.
  if (isSourceTextUnverifiable(entry)) {
    return entry.knowledgeEligible === false
      ? { eligible: false, reason: "stored-exclusion" }
      : { eligible: true, reason: "unverifiable-source-text" };
  }
  const contentSnippet = normalized(sourceOwnedSnippet(entry));

  if (hasDurableTitleSignal(title)) {
    return { eligible: true, reason: "durable-title" };
  }
  if (
    hasDurableSnippetSignal(contentSnippet) &&
    !hasAnnouncementSnippetCounterSignal(contentSnippet)
  ) {
    return { eligible: true, reason: "durable-snippet" };
  }
  if (entry.knowledgeEligible === false) {
    return { eligible: false, reason: "stored-exclusion" };
  }
  if (ANNOUNCEMENT_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    return { eligible: false, reason: "announcement-title" };
  }
  if (hasAvailabilitySignal(`${title} ${contentSnippet}`)) {
    return { eligible: false, reason: "availability-context" };
  }
  return { eligible: true, reason: "eligible" };
}

export function isKnowledgeEligibleEntry(
  entry: KnowledgeEligibilityEntry,
): boolean {
  return knowledgeEligibility(entry).eligible;
}
