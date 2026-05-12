/**
 * normalize.ts — deterministic raw→NormalizedEntry conversion (NO LLM).
 * Pure functions. See docs/04-site-spec.md §1.1 for category rules.
 */
import { createHash } from "node:crypto";
import type {
  Importance,
  Lang,
  NormalizedEntry,
  RawEntry,
  SourceDefinition,
} from "../types.ts";
import { decideTier, resolveHalfLife } from "../half-life.ts";

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
 * Heuristic importance: 3 = major release/changelog, 2 = blog with release keywords, 1 = default.
 * Deterministic fallback scoring. The summarizer may override importance for entries it enhances.
 */
export function scoreImportance(raw: RawEntry, source: SourceDefinition): Importance {
  const hay = `${raw.title} ${raw.contentSnippet ?? ""}`.toLowerCase();
  const majorKeywords = [
    "announcing",
    "released",
    "general availability",
    " ga ",
    "v1.",
    "v2.",
    "v3.",
    "major update",
  ];
  if (source.sourceType === "release" || source.sourceType === "changelog") {
    return majorKeywords.some((k) => hay.includes(k)) ? 3 : 2;
  }
  if (majorKeywords.some((k) => hay.includes(k))) return 2;
  return 1;
}

/**
 * Initial summary used before Copilot summarization or cache enrichment runs.
 */
function placeholderSummary(raw: RawEntry, lang: Lang): { ja: string; en: string } {
  const snippet = (raw.contentSnippet ?? "").replace(/\s+/g, " ").trim();
  const title = raw.title.replace(/\s+/g, " ").trim();
  const base = snippet || title;
  const short = base.slice(0, lang === "ja" ? 120 : 200);
  if (lang === "ja") {
    return { ja: short, en: raw.title };
  }
  return { ja: "", en: short };
}

/**
 * GitHub release feeds (and many changelogs) publish entries whose <title> is
 * just the version number (e.g. "v3.8.0", "1.104.0", "Release 2026.04.21").
 * Such titles are useless on the dashboard because the reader cannot tell
 * which product the release belongs to. Prefix them with the source's
 * display name so the card reads e.g. "Cline Releases — v3.8.0".
 */
const VERSION_ONLY_RE = /^(?:release\s+)?(?:v?\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.\-]+)?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/i;

function decorateReleaseTitle(rawTitle: string, source: SourceDefinition): string {
  if (source.sourceType !== "release" && source.sourceType !== "changelog") {
    return rawTitle;
  }
  const trimmed = rawTitle.trim();
  if (!trimmed) return rawTitle;
  // Already contains the source name (case-insensitive) → leave as is.
  if (trimmed.toLowerCase().includes(source.displayName.toLowerCase())) {
    return rawTitle;
  }
  if (!VERSION_ONLY_RE.test(trimmed)) return rawTitle;
  return `${source.displayName} ${trimmed}`;
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
  const summary = placeholderSummary(raw, lang);
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
  const halfLife = resolveHalfLife({
    category: source.category,
    sourceType: source.sourceType,
    sourceId: source.id,
    sourceOverride: source.halfLifeOverride,
  });
  const archiveTier = decideTier(
    { publishedAt: raw.publishedAt, halfLife },
    new Date(collectedAt),
  );

  return {
    id,
    source: source.id,
    sourceType: source.sourceType,
    url: raw.url,
    title: raw.title,
    titleJa: lang === "ja" ? raw.title : "",
    titleEn: lang === "en" ? raw.title : "",
    summaryJa: summary.ja,
    summaryEn: summary.en,
    lang,
    publishedAt: raw.publishedAt ?? collectedAt,
    collectedAt,
    tags: [...source.autoTags],
    category: source.category,
    importance: scoreImportance(raw, source),
    halfLife,
    archiveTier,
    ...(image ? { image } : {}),
  };
}
