/**
 * normalize.ts — deterministic raw→NormalizedEntry conversion (NO LLM).
 * Pure functions. See docs/04-site-spec.md §1.1 for category rules.
 */
import { createHash } from "node:crypto";
import type {
  Category,
  HalfLife,
  Importance,
  Lang,
  NormalizedEntry,
  RawEntry,
  SourceDefinition,
} from "../types.ts";
import { decideTier, resolveHalfLife } from "../half-life.ts";
import { isKnowledgeEligibleEntry } from "../../web/src/lib/knowledge-eligibility.ts";
import { classifyReleaseTitleSignal } from "../../web/src/lib/release-signal.ts";
import { normalizeTags } from "./tag.ts";

function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Crude but effective: treat entries as Japanese if >10% of signal chars are CJK. */
export function detectLang(text: string, defaultLang: Lang): Lang {
  if (!text) return defaultLang;
  let cjk = 0;
  let signal = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x3040 && code <= 0x30ff) || // Hiragana+Katakana
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0xff66 && code <= 0xff9f); // Halfwidth Katakana
    if (
      isCjk ||
      (code >= 0x30 && code <= 0x39) || // ASCII digits
      (code >= 0x41 && code <= 0x5a) || // ASCII uppercase
      (code >= 0x61 && code <= 0x7a) // ASCII lowercase
    ) {
      signal++;
      if (isCjk) cjk++;
    }
  }
  return cjk / Math.max(signal, 1) > 0.1 ? "ja" : "en";
}

/**
 * Heuristic importance: 3 = major release/critical announcement, 2 = notable
 * update, 1 = routine. Deterministic fallback scoring. The summarizer may
 * override importance for entries it enhances.
 *
 * Release/changelog entries are scored by their version shape
 * (web/src/lib/release-signal.ts): patch builds and low-signal builds
 * (nightly, pre-release, RC, beta/alpha, internal staging) are routine
 * (importance 1), minor releases are 2, and x.0.0-style majors are 3.
 * The previous keyword list contained "v1."/"v2."/"v3." substrings, which
 * scored every patch tag like "Cline CLI v3.0.58" as importance 3 and let
 * fast-releasing feeds flood the Featured/Top decision slots. See
 * isLowSignalRelease in web/src/lib/data.ts and isRoutineReleaseEntry in
 * release-signal.ts for the matching display-side guards.
 */
const MAJOR_SIGNAL_KEYWORDS = [
  "announcing",
  "released",
  "general availability",
  " ga ",
  "major update",
] as const;

export function scoreImportance(raw: RawEntry, source: SourceDefinition): Importance {
  const hay = `${raw.title} ${raw.contentSnippet ?? ""}`.toLowerCase();
  const hasMajorKeyword = MAJOR_SIGNAL_KEYWORDS.some((k) => hay.includes(k));
  if (source.sourceType === "release" || source.sourceType === "changelog") {
    switch (classifyReleaseTitleSignal(raw.title)) {
      case "low":
      case "patch":
        return 1;
      case "major":
        return 3;
      case "minor":
        return 2;
      case "none":
        // Descriptive changelog headlines without a version token.
        return hasMajorKeyword ? 3 : 2;
    }
  }
  if (hasMajorKeyword) return 2;
  return 1;
}

// 900 aligns with the body generator's own excerpt budget
// (worker/src/body-generate.ts sourceBudgetChars compacts to 900): the
// scaled length band (bodyLengthPlan) asks for prose proportional to the
// REAL material collected, so a richer excerpt is the honest way to longer
// bodies. Raised from 280/800 after gpt-5.6 followed the band literally and
// bodies for feed-capped excerpts came out at ~330 JA chars.
const DEFAULT_SNIPPET_CONTEXT_MAX = 900;
const EVERGREEN_SNIPPET_CONTEXT_MAX = 900;

/**
 * Extract the raw RSS/Atom snippet to keep as AI input context for the
 * summarizer (NOT for display).
 *
 * A raw snippet must never be written into summaryJa/summaryEn. Doing so
 * (the previous behavior) had two failure modes that the user reported as
 * "summaries are always truncated and aren't real summaries":
 *   1. Slicing the snippet to a fixed length (120/200 chars) cuts it
 *      mid-sentence, so the UI shows a truncated excerpt, not a summary.
 *   2. A non-empty summaryJa/summaryEn makes the "needs generation" gates
 *      (harness summarize.ts + worker summary-queue.ts) treat the entry as
 *      already summarized, so it is never queued for a real AI summary and
 *      stays stuck on the truncated excerpt forever (snippet-masquerade).
 *
 * Instead we leave summaryJa/summaryEn empty so the gates flag the entry, the
 * deterministic bilingual pending fallback fills them before publish
 * (R-013/LL-028), and the AI queue replaces them with a real summary. The raw
 * snippet is preserved separately in `contentSnippet` and fed to the prompt
 * builders as collected context to improve summary quality (especially for the
 * terse Japanese release/Q&A titles this most affects).
 */
function snippetContext(raw: RawEntry, maxLength: number): string {
  return (raw.contentSnippet ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * GitHub release feeds (and many changelogs) publish entries whose <title> is
 * just the version number (e.g. "v3.8.0", "1.104.0", "Release 2026.04.21").
 * Such titles are useless on the dashboard because the reader cannot tell
 * which product the release belongs to. Prefix them with the source's
 * display name so the card reads e.g. "Cline Releases v3.8.0".
 */
const VERSION_ONLY_RE = /^(?:release\s+)?(?:v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.\-]+)?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/i;
/** Bare version with a trailing release date, e.g. "1.7.0 - 2026-05-01". */
const VERSION_DATE_RE = /^v?\d+(?:\.\d+){1,3}\s*[-–]\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/i;
/** Any embedded semantic-ish version token (used to detect component tags). */
const HAS_VERSION_RE = /v?\d+(?:\.\d+){1,3}/;
/** "Word v1.2.3" or "Word: 1.2.3" — a component name plus a version, nothing else. */
const WORD_VERSION_RE = /^[A-Za-z][\w.+-]*[:\s]\s*v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.\-]+)?$/;
/** Nightly/dev tags embed a 14-digit YYYYMMDDHHMMSS stamp, e.g.
 * "nightly-main-20260622175622-ee59f8170698". */
const NIGHTLY_TS_RE = /(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}/;

/**
 * Strip a trailing "Releases"/"Changelog"/"Blog" noun from a source's display
 * name so it can be used as a short product brand prefix ("Cline Releases" →
 * "Cline"). Falls back to the full display name when nothing remains.
 */
function brandName(source: SourceDefinition): string {
  const stripped = source.displayName.replace(/\s+(?:releases?|changelog|blog)$/i, "").trim();
  return stripped || source.displayName;
}

/** "sdk/core/v0.0.53" → "sdk/core v0.0.53"; "cloud: 1.40.0" → "cloud 1.40.0". */
function prettyComponentTag(tag: string): string {
  const slash = tag.match(/^(.*)\/(v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.\-]+)?)$/);
  if (slash) return `${slash[1]} ${slash[2]}`;
  const colon = tag.match(/^([A-Za-z][\w.+-]*):\s*(v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.\-]+)?)$/);
  if (colon) return `${colon[1]} ${colon[2]}`;
  return tag;
}

/**
 * Make release/changelog titles identify their product. Monorepo release feeds
 * (e.g. cline/cline) publish raw git tags such as "CLI v3.0.31",
 * "sdk/core/v0.0.53" or "nightly-main-20260622175622-…" that give the reader no
 * idea which product (or even which CLI) the entry is about. We prefix a short
 * brand and tidy the tag, while leaving descriptive release notes
 * ("ui: Fix … (#123)") and already-branded titles ("langchain-core==1.4.0")
 * untouched. Pure idempotent: re-running on branded output is a no-op.
 */
export function decorateReleaseTitle(rawTitle: string, source: SourceDefinition): string {
  if (source.sourceType !== "release" && source.sourceType !== "changelog") {
    return rawTitle;
  }
  const trimmed = rawTitle.trim();
  if (!trimmed) return rawTitle;
  const brand = brandName(source);
  // Already identifies the product (full display name or short brand) → leave.
  if (
    trimmed.toLowerCase().includes(source.displayName.toLowerCase()) ||
    trimmed.toLowerCase().includes(brand.toLowerCase())
  ) {
    return rawTitle;
  }
  // Nightly/dev build tag → "Brand Nightly (YYYY-MM-DD HH:MM)".
  if (/\bnightly\b/i.test(trimmed)) {
    const ts = trimmed.match(NIGHTLY_TS_RE);
    if (ts) {
      const [, y, mo, da, h, mi] = ts;
      return `${brand} Nightly (${y}-${mo}-${da} ${h}:${mi})`;
    }
  }
  // Bare version (optionally with a release date) → "Display Name v1.2.3".
  if (VERSION_ONLY_RE.test(trimmed) || VERSION_DATE_RE.test(trimmed)) {
    return `${source.displayName} ${trimmed}`;
  }
  // Clean component tag (single token, or "Word v1.2.3") → prefix the brand.
  const singleToken = !/\s/.test(trimmed);
  const isComponentTag =
    (singleToken && HAS_VERSION_RE.test(trimmed)) || WORD_VERSION_RE.test(trimmed);
  if (isComponentTag) {
    return `${brand} ${prettyComponentTag(trimmed)}`;
  }
  return rawTitle;
}

type CategorySignal =
  & Pick<RawEntry, "title" | "contentSnippet" | "publishedAt">
  & Pick<NormalizedEntry, "knowledgeEligible">;

const HUGGINGFACE_MCP_RE = /\bmcp\b|model context protocol/i;
const HUGGINGFACE_LIBRARY_RELEASE_RE = /\b(?:lerobot|trl)\s+v\d+(?:\.\d+){1,3}\b/i;
const HUGGINGFACE_AGENT_INTEGRATION_RE =
  /\bstrands\s+agents?\b[\s\S]*\blerobot\b|\blerobot\b[\s\S]*\bstrands\s+agents?\b/i;
const HUGGINGFACE_RESEARCH_RE =
  /\b(?:benchmark(?:s|ing)?|leaderboard|evaluat(?:e|ion|ing)|research|papers?|competitions?|datasets?|train(?:ing|ed)?|fine[- ]?tun(?:e|ing)|reinforcement learning|diffusion|computer vision|object detection|lerobot|robots?|robotics)\b/i;
const HUGGINGFACE_AGENT_RE = /\b(?:agents?|agentic|multi-agent)\b/i;
const HUGGINGFACE_PLATFORM_RE =
  /\b(?:enterprise (?:deployment|hub|platform|inference)|cloud|deployment|inference endpoint|managed compute|sagemaker|foundry|azure|aws|google cloud)\b/i;

// github.blog/changelog covers the entire GitHub platform, not just GitHub
// Copilot: Projects, Actions, Dependabot, secret scanning, Code Quality, GHES,
// npm, and Enterprise admin settings are all published to the same feed.
// Blanket source.category="copilot" therefore misclassified a large share of
// generic GitHub platform news as Copilot coverage. Require an explicit
// Copilot/AI signal (product/model name, agent terminology, or a Copilot-only
// billing term) to stay "copilot"; everything else is generic GitHub platform
// news and belongs in "tech-news" (docs/04-site-spec.md §1.1: copilot covers
// "GitHub Copilot / Workspace / Copilot CLI / Copilot Enterprise" only).
// Verified against the full live+archive corpus (192 unique entries, 2026-07):
// 107 stay "copilot", 85 move to "tech-news". See tests/normalize.test.ts
// for actual-title keep/drop fixtures.
const GITHUB_CHANGELOG_RELEVANT_RE =
  /\b(?:copilot|gpt(?:-[\d.]+)?|gemini|gemma|claude|kimi|grok|openai|anthropic|mai-code|chatgpt|mcp|model context protocol|agents?|agentic|llm|large language model|opus|sonnet|haiku|ai credit|ai usage|ai adoption|model selection|models? in auto)\b/;

// developers.googleblog.com is Google's general developer blog: overwhelmingly
// Gemini/GenAI content, but it also covers a handful of unrelated Google
// platform features (Google Pay checkout/payment, Sign in with Google session
// metadata, Google Account changes, event logistics). Exclude those known
// non-AI topics; everything else stays "gemini" (the source default).
// Deliberately narrow/anchored phrases so an MCP-integration story that
// happens to mention "Google Pay" (an AI/agent topic) is not excluded.
// Verified against the full live+archive corpus (58 unique entries, 2026-07):
// 6 move to "tech-news", 52 stay "gemini". See tests/normalize.test.ts.
const GOOGLE_DEVELOPERS_GENERIC_RE =
  /sign in with google|the latest updates to google pay|enhancing android checkout|merchant initiated transactions|supporting google account username change|get ready for google i\/o/;

function resolveCategory(raw: CategorySignal, source: SourceDefinition): Category {
  const signal = `${raw.title} ${raw.contentSnippet ?? ""}`.toLowerCase();
  if (source.id === "huggingface-blog") {
    if (HUGGINGFACE_MCP_RE.test(signal)) return "mcp";
    if (HUGGINGFACE_LIBRARY_RELEASE_RE.test(raw.title)) return "local-llm";
    if (HUGGINGFACE_AGENT_INTEGRATION_RE.test(raw.title)) return "agent-fw";
    if (HUGGINGFACE_RESEARCH_RE.test(signal)) return "research";
    if (HUGGINGFACE_AGENT_RE.test(signal)) return "agent-fw";
    if (HUGGINGFACE_PLATFORM_RE.test(signal)) return "tech-news";
    return source.category;
  }
  if (source.id === "github-changelog") {
    return GITHUB_CHANGELOG_RELEVANT_RE.test(signal) ? "copilot" : "tech-news";
  }
  if (source.id === "google-developers") {
    return GOOGLE_DEVELOPERS_GENERIC_RE.test(signal) ? "tech-news" : "gemini";
  }
  if (source.id !== "qiita-vscode") return source.category;

  if (/\b(cursor|zed)\b/.test(signal)) return "cursor";
  if (/(claude|anthropic)/.test(signal)) return "claude";
  if (/(gemini|antigravity)/.test(signal)) return "gemini";
  if (/(codex|openai|chatgpt)/.test(signal)) return "codex";
  if (/(copilot|github copilot)/.test(signal)) return "copilot";
  if (/(ollama|local llm|ローカルllm|gemma|continue)/i.test(signal)) return "local-llm";
  if (/\bmcp\b|model context protocol/.test(signal)) return "mcp";
  return source.category;
}

interface SourceOwnedFields {
  sourceType: SourceDefinition["sourceType"];
  category: Category;
  importance: Importance;
  halfLife: HalfLife;
  archiveTier: NormalizedEntry["archiveTier"];
  evergreen?: true;
  knowledgeEligible?: false;
}

function sourceOwnedFields(
  signal: CategorySignal,
  source: SourceDefinition,
  referenceAt: string,
): SourceOwnedFields {
  const category = resolveCategory(signal, source);
  const importance = scoreImportance(
    {
      externalId: signal.title,
      url: "",
      title: signal.title,
      contentSnippet: signal.contentSnippet,
      publishedAt: signal.publishedAt,
    },
    source,
  );
  const halfLife = resolveHalfLife({
    category,
    sourceType: source.sourceType,
    sourceId: source.id,
    sourceOverride: source.halfLifeOverride,
  });
  const evergreen = source.evergreen ?? false;
  const knowledgeEligible = isKnowledgeEligibleEntry({
    source: source.id,
    title: signal.title,
    contentSnippet: signal.contentSnippet,
    evergreen,
    knowledgeEligible: signal.knowledgeEligible,
  });
  const archiveTier = decideTier(
    { publishedAt: signal.publishedAt, halfLife, evergreen },
    new Date(referenceAt),
  );
  return {
    sourceType: source.sourceType,
    category,
    importance,
    halfLife,
    archiveTier,
    ...(evergreen ? { evergreen: true as const } : {}),
    ...(evergreen && !knowledgeEligible ? { knowledgeEligible: false as const } : {}),
  };
}

export function restampEntryFromSource(
  entry: NormalizedEntry,
  source: SourceDefinition,
  referenceAt: string,
  options: { preserveImportance?: boolean; preserveArchiveTier?: boolean } = {},
): NormalizedEntry {
  const metadata = sourceOwnedFields(
    {
      title: entry.title,
      contentSnippet: entry.contentSnippet,
      publishedAt: entry.publishedAt,
      knowledgeEligible: entry.knowledgeEligible,
    },
    source,
    referenceAt,
  );
  const {
    evergreen: _priorEvergreen,
    knowledgeEligible: _priorKnowledgeEligible,
    ...base
  } = entry;
  const tags = normalizeTags([...source.autoTags, ...entry.tags]);
  const preserveImportance = options.preserveImportance ?? true;
  const preserveArchiveTier = options.preserveArchiveTier ?? false;
  return {
    ...base,
    ...metadata,
    importance: preserveImportance ? entry.importance : metadata.importance,
    archiveTier: preserveArchiveTier ? entry.archiveTier : metadata.archiveTier,
    tags,
  };
}

export function normalize(
  raw: RawEntry,
  source: SourceDefinition,
  collectedAt: string,
): NormalizedEntry {
  const id = sha256Short(`${source.id}::${raw.url}`);
  const decoratedTitle = decorateReleaseTitle(raw.title, source);
  const decoratedRaw: RawEntry = decoratedTitle === raw.title ? raw : { ...raw, title: decoratedTitle };
  raw = decoratedRaw;
  const lang = detectLang(`${raw.title} ${raw.contentSnippet ?? ""}`, source.defaultLang);
  const contentSnippet = snippetContext(
    raw,
    source.evergreen
      ? EVERGREEN_SNIPPET_CONTEXT_MAX
      : DEFAULT_SNIPPET_CONTEXT_MAX,
  );
  const image = raw.mediaThumbnail
    ? {
      src: raw.mediaThumbnail,
      origSrc: raw.mediaThumbnail,
      alt: raw.title,
      width: 0,
      height: 0,
      source: "media" as const,
    }
    : undefined;

  // Archive classification (Phase A/B). Computed deterministically on every
  // run so a registry override flip-flop is reflected next collect.
  // Source-owned metadata must be derived from the same bounded raw context
  // that is persisted. Otherwise a phrase beyond the storage boundary can
  // stamp an exclusion that the artifact gate cannot reproduce.
  const metadata = sourceOwnedFields(
    {
      title: raw.title,
      contentSnippet: contentSnippet || undefined,
      publishedAt: raw.publishedAt,
    },
    source,
    collectedAt,
  );

  return {
    id,
    source: source.id,
    sourceType: metadata.sourceType,
    url: raw.url,
    title: raw.title,
    titleJa: lang === "ja" ? raw.title : "",
    titleEn: lang === "en" ? raw.title : "",
    summaryJa: "",
    summaryEn: "",
    lang,
    publishedAt: raw.publishedAt ?? collectedAt,
    collectedAt,
    tags: normalizeTags(source.autoTags),
    category: metadata.category,
    importance: metadata.importance,
    halfLife: metadata.halfLife,
    archiveTier: metadata.archiveTier,
    ...(metadata.evergreen ? { evergreen: true } : {}),
    ...(metadata.knowledgeEligible === false ? { knowledgeEligible: false } : {}),
    ...(contentSnippet ? { contentSnippet } : {}),
    ...(image ? { image } : {}),
  };
}
