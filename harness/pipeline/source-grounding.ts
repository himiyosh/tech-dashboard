import type { Lang, SourceType } from "../types.ts";

/**
 * Bounded, LLM-independent grounding checks for generated summaries and bodies.
 *
 * This intentionally does not attempt general semantic fact checking. It gates
 * new generation on a meaningful source excerpt or a descriptive title, then
 * validates only two high-confidence fact profiles that can be extracted
 * deterministically from official source text:
 * - commercial plans with a region plus pricing/payment evidence
 * - an existing product expanding from one named platform to another
 *
 * Legacy summaries are not rejected merely because an old artifact no longer
 * retains its original snippet. Stored content is invalidated only when one of
 * the material profiles above yields a concrete contradiction.
 */
export interface SourceGroundingInput {
  title?: string | null;
  contentSnippet?: string | null;
  source?: string | null;
  sourceType?: SourceType | null;
  url?: string | null;
  lang?: Lang | null;
}

export interface GeneratedSummaryGroundingInput {
  titleJa?: string | null;
  titleEn?: string | null;
  summaryJa?: string | null;
  summaryEn?: string | null;
}

export interface GeneratedBodyGroundingInput {
  bodyJa?: string | null;
  bodyEn?: string | null;
}

export type GroundingField =
  | "titleJa"
  | "titleEn"
  | "summaryJa"
  | "summaryEn"
  | "bodyJa"
  | "bodyEn";

export type GroundingIssueCode =
  | "commercial-plan-conflict"
  | "platform-expansion-conflict";

export interface GroundingIssue {
  code: GroundingIssueCode;
  field: GroundingField;
}

const SOURCE_SNIPPET_MIN_CHARS = 48;
const SOURCE_SNIPPET_MIN_WORDS = 8;
const SOURCE_SNIPPET_MIN_CJK = 20;
const TITLE_MIN_CHARS = 20;
const TITLE_MIN_WORDS = 4;
const TITLE_MIN_CJK = 12;

const VERSION_TOKEN_RE =
  /^v?\d+(?:\.\d+){1,4}(?:[-+][\p{L}\p{N}._-]+)?$/iu;
const RELEASE_TITLE_NOISE = new Set([
  "release",
  "releases",
  "released",
  "changelog",
  "version",
  "versions",
  "update",
  "updates",
]);

const PLAN_SOURCE_RE =
  /\b(?:plan|subscription|tier)\b|プラン|サブスクリプション/iu;
const PLAN_GENERATED_RE =
  /\b(?:plan|subscription|tier|pricing|price)\b|プラン|サブスクリプション|価格|料金/iu;
const COMMERCIAL_SOURCE_RE =
  /\b(?:pricing|price|monthly|per month|payment)\b|月額|1か月|価格|料金|決済|現地価格|upi/iu;
const COMMERCIAL_DETAIL_RE =
  /\b(?:pricing|price|monthly|per month|payment|cost)\b|月額|価格|料金|決済|現地価格|コスト/iu;
const UPI_RE = /\bupi\b/iu;
const SETUP_TOPIC_RE =
  /\b(?:onboarding|project initialization|project setup|scaffolding|startup flow)\b|オンボーディング|プロジェクト(?:の)?初期|初期セットアップ|起動フロー/iu;

const EXPANSION_RE =
  /\b(?:expand(?:ed|s|ing)?|now available|comes? to|arrives? on|roll(?:ed|s|ing)? out to)\b|展開|対応開始|提供開始|利用可能/iu;
const GENERATED_EXPANSION_RE =
  /\b(?:expand(?:ed|s|ing)?|expansion|now available|comes? to|arrives? on|rollout|rolled out|support(?:ed)? on|windows version|mac(?:os)? version|linux version|android version|ios version)\b|展開|拡大|対応開始|提供開始|利用可能|(?:Windows|macOS|Mac|Linux|Android|iOS)版/iu;

interface NamedAnchor {
  key: string;
  source: RegExp;
  generated: RegExp;
}

const REGIONS: readonly NamedAnchor[] = [
  { key: "india", source: /\bindia\b|インド/iu, generated: /\bindia\b|インド/iu },
  { key: "japan", source: /\bjapan\b|日本/iu, generated: /\bjapan\b|日本/iu },
  {
    key: "united-states",
    source: /\b(?:united states|u\.?s\.?a?)\b|米国|アメリカ/iu,
    generated: /\b(?:united states|u\.?s\.?a?)\b|米国|アメリカ/iu,
  },
  {
    key: "united-kingdom",
    source: /\b(?:united kingdom|u\.?k\.?)\b|英国|イギリス/iu,
    generated: /\b(?:united kingdom|u\.?k\.?)\b|英国|イギリス/iu,
  },
] as const;

const PLATFORMS: readonly NamedAnchor[] = [
  { key: "windows", source: /\bwindows\b/iu, generated: /\bwindows\b/iu },
  {
    key: "mac",
    source: /\b(?:mac|macos)\b/iu,
    generated: /\b(?:mac|macos)\b/iu,
  },
  { key: "linux", source: /\blinux\b/iu, generated: /\blinux\b/iu },
  { key: "android", source: /\bandroid\b/iu, generated: /\bandroid\b/iu },
  { key: "ios", source: /\bios\b/iu, generated: /\bios\b/iu },
] as const;

interface CommercialPlanProfile {
  regions: readonly NamedAnchor[];
  amounts: string[];
}

interface PlatformExpansionProfile {
  targets: readonly NamedAnchor[];
  priorPlatforms: readonly NamedAnchor[];
}

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

function isLowInformationReleaseTitle(value: string): boolean {
  const tokens = wordTokens(value);
  if (!tokens.some((token) => VERSION_TOKEN_RE.test(token))) return false;
  const semantic = tokens.filter((token) =>
    !VERSION_TOKEN_RE.test(token) &&
    !RELEASE_TITLE_NOISE.has(token.toLocaleLowerCase("en-US"))
  );
  return semantic.length <= 2;
}

function hasMeaningfulSnippet(input: SourceGroundingInput): boolean {
  const snippet = compact(input.contentSnippet);
  if (!snippet || normalized(snippet) === normalized(input.title)) return false;
  return (
    snippet.length >= SOURCE_SNIPPET_MIN_CHARS &&
    (
      wordTokens(snippet).length >= SOURCE_SNIPPET_MIN_WORDS ||
      cjkCount(snippet) >= SOURCE_SNIPPET_MIN_CJK
    )
  );
}

function hasDescriptiveTitle(input: SourceGroundingInput): boolean {
  const title = compact(input.title);
  if (!title || isLowInformationReleaseTitle(title)) return false;
  return (
    (title.length >= TITLE_MIN_CHARS && wordTokens(title).length >= TITLE_MIN_WORDS) ||
    (title.length >= 18 && cjkCount(title) >= TITLE_MIN_CJK)
  );
}

export function hasSufficientSourceGrounding(
  input: SourceGroundingInput,
): boolean {
  return hasMeaningfulSnippet(input) || hasDescriptiveTitle(input);
}

function sourceEvidence(input: SourceGroundingInput): string {
  return compact(`${input.title ?? ""} ${input.contentSnippet ?? ""}`);
}

function extractAmounts(value: string): string[] {
  const matches = compact(value).match(
    /(?:[$€£¥₹]\s*\d[\d,.]*|\b(?:usd|eur|gbp|inr|jpy)\s*\d[\d,.]*)/giu,
  ) ?? [];
  return [...new Set(matches.map((match) =>
    match.toLocaleLowerCase("en-US").replace(/[\s,]/g, "")
  ))];
}

function commercialPlanProfile(
  source: SourceGroundingInput,
): CommercialPlanProfile | null {
  const evidence = sourceEvidence(source);
  const regions = REGIONS.filter((region) => region.source.test(evidence));
  const amounts = extractAmounts(evidence);
  const hasStrongCommercialAnchor =
    regions.length > 0 || amounts.length > 0 || UPI_RE.test(evidence);
  if (
    !PLAN_SOURCE_RE.test(evidence) ||
    !COMMERCIAL_SOURCE_RE.test(evidence) ||
    !hasStrongCommercialAnchor
  ) {
    return null;
  }
  return {
    regions,
    amounts,
  };
}

function commercialPlanConflict(
  profile: CommercialPlanProfile,
  generatedText: string,
): boolean {
  const text = compact(generatedText);
  if (!text || !PLAN_GENERATED_RE.test(text)) return true;
  if (
    profile.regions.length > 0 &&
    !profile.regions.some((region) => region.generated.test(text))
  ) {
    return true;
  }

  const generatedAmounts = new Set(extractAmounts(text));
  const hasAmount = profile.amounts.some((amount) => generatedAmounts.has(amount));
  const hasPayment = UPI_RE.test(text);
  const hasCommercialDetail = COMMERCIAL_DETAIL_RE.test(text);
  return !hasAmount && !hasPayment && !hasCommercialDetail;
}

function explicitCommercialTitleConflict(
  profile: CommercialPlanProfile,
  sourceTitle: string | null | undefined,
  generatedTitle: string,
): boolean {
  const title = compact(generatedTitle);
  if (!title || normalized(title) === normalized(sourceTitle)) return false;
  return SETUP_TOPIC_RE.test(title) && commercialPlanConflict(profile, title);
}

function expansionPhraseTargets(evidence: string): NamedAnchor[] {
  return PLATFORMS.filter((platform) => {
    const flags = platform.source.flags.includes("g")
      ? platform.source.flags
      : `${platform.source.flags}g`;
    const matcher = new RegExp(platform.source.source, flags);
    for (const match of evidence.matchAll(matcher)) {
      if (match.index === undefined) continue;
      const before = evidence.slice(Math.max(0, match.index - 100), match.index);
      if (EXPANSION_RE.test(before)) return true;
    }
    return false;
  });
}

function priorPlatforms(
  evidence: string,
  targets: readonly NamedAnchor[],
): NamedAnchor[] {
  const targetKeys = new Set(targets.map((target) => target.key));
  const priorSignal =
    /\b(?:like the|previously|earlier|after|from)\b|先行|既存|従来|に続いて/iu;
  if (!priorSignal.test(evidence)) return [];
  return PLATFORMS.filter((platform) =>
    !targetKeys.has(platform.key) && platform.source.test(evidence)
  );
}

function platformExpansionProfile(
  source: SourceGroundingInput,
): PlatformExpansionProfile | null {
  const evidence = sourceEvidence(source);
  const targets = expansionPhraseTargets(evidence);
  if (targets.length === 0) return null;
  const previous = priorPlatforms(evidence, targets);
  if (previous.length === 0) return null;
  return {
    targets,
    priorPlatforms: previous,
  };
}

function hasGeneratedExpansionNearTarget(
  text: string,
  targets: readonly NamedAnchor[],
): boolean {
  return targets.some((target) => {
    const flags = target.generated.flags.includes("g")
      ? target.generated.flags
      : `${target.generated.flags}g`;
    const matcher = new RegExp(target.generated.source, flags);
    for (const match of text.matchAll(matcher)) {
      if (match.index === undefined) continue;
      const nearby = text.slice(
        Math.max(0, match.index - 64),
        Math.min(text.length, match.index + match[0].length + 64),
      );
      if (GENERATED_EXPANSION_RE.test(nearby)) return true;
    }
    return false;
  });
}

function platformExpansionConflict(
  profile: PlatformExpansionProfile,
  generatedText: string,
): boolean {
  const text = compact(generatedText);
  if (!text) return true;
  if (profile.targets.some((platform) => !platform.generated.test(text))) {
    return true;
  }
  if (hasGeneratedExpansionNearTarget(text, profile.targets)) return false;
  return !profile.priorPlatforms.some((platform) => platform.generated.test(text));
}

function issuesForGeneratedText(
  source: SourceGroundingInput,
  text: string | null | undefined,
  field: GroundingField,
): GroundingIssue[] {
  const value = compact(text);
  if (!value) return [];
  const issues: GroundingIssue[] = [];
  const commercial = commercialPlanProfile(source);
  if (commercial && commercialPlanConflict(commercial, value)) {
    issues.push({ code: "commercial-plan-conflict", field });
  }
  const expansion = platformExpansionProfile(source);
  if (expansion && platformExpansionConflict(expansion, value)) {
    issues.push({ code: "platform-expansion-conflict", field });
  }
  return issues;
}

export function findSummaryGroundingIssues(
  source: SourceGroundingInput,
  generated: GeneratedSummaryGroundingInput,
): GroundingIssue[] {
  const issues: GroundingIssue[] = [];
  const commercial = commercialPlanProfile(source);
  if (
    commercial &&
    explicitCommercialTitleConflict(commercial, source.title, generated.titleJa ?? "")
  ) {
    issues.push({ code: "commercial-plan-conflict", field: "titleJa" });
  }
  if (
    commercial &&
    explicitCommercialTitleConflict(commercial, source.title, generated.titleEn ?? "")
  ) {
    issues.push({ code: "commercial-plan-conflict", field: "titleEn" });
  }
  issues.push(
    ...issuesForGeneratedText(source, generated.summaryJa, "summaryJa"),
    ...issuesForGeneratedText(source, generated.summaryEn, "summaryEn"),
  );
  return issues;
}

export function findBodyGroundingIssues(
  source: SourceGroundingInput,
  generated: GeneratedBodyGroundingInput,
): GroundingIssue[] {
  return [
    ...issuesForGeneratedText(source, generated.bodyJa, "bodyJa"),
    ...issuesForGeneratedText(source, generated.bodyEn, "bodyEn"),
  ];
}

export function hasMaterialSummaryGroundingConflict(
  source: SourceGroundingInput,
  generated: GeneratedSummaryGroundingInput,
): boolean {
  return findSummaryGroundingIssues(source, generated).length > 0;
}

export function hasMaterialBodyGroundingConflict(
  source: SourceGroundingInput,
  generated: GeneratedBodyGroundingInput,
): boolean {
  return findBodyGroundingIssues(source, generated).length > 0;
}
