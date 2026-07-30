export interface KnowledgeEligibilityEntry {
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
  /^introduc(?:e|es|ed|ing)\b/i,
  /^launch(?:es|ed|ing)\b/i,
  /^now in (?:public |private )?preview\b/i,
  /^register now\b/i,
  /^what(?:['’]s| is) new\b/i,
  /^what .+ announced\b/i,
  /\b(?:named|recognized as) (?:a )?(?:commander|leader)\b/i,
];

const AVAILABILITY_PHRASES = [
  "general availability",
  "generally available",
  "now available",
  "GA",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalized(value: string | undefined): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function matchesAsciiPhrase(value: string, phrase: string): boolean {
  const parts = phrase.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const body = parts.map(escapeRegExp).join(ASCII_SEPARATOR_RE);
  return new RegExp(
    `(^|[^${ASCII_ALNUM_CLASS}])${body}(?=$|[^${ASCII_ALNUM_CLASS}])`,
    "i",
  ).test(value);
}

function hasDurableTitleSignal(title: string): boolean {
  return DURABLE_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

function hasDurableSnippetSignal(contentSnippet: string): boolean {
  return DURABLE_SNIPPET_PATTERNS.some((pattern) => pattern.test(contentSnippet));
}

function hasAvailabilitySignal(value: string): boolean {
  return AVAILABILITY_PHRASES.some((phrase) => matchesAsciiPhrase(value, phrase));
}

export function knowledgeEligibility(
  entry: KnowledgeEligibilityEntry,
): KnowledgeEligibilityDecision {
  if (entry.evergreen !== true) {
    return { eligible: false, reason: "not-evergreen" };
  }
  const title = normalized(entry.title);
  const contentSnippet = normalized(entry.contentSnippet);

  if (hasDurableTitleSignal(title)) {
    return { eligible: true, reason: "durable-title" };
  }
  if (hasDurableSnippetSignal(contentSnippet)) {
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
