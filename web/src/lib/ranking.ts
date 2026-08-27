import type { NormalizedEntry } from "./data.ts";
import { isRoutineReleaseEntry } from "./release-signal.ts";
import { sourceAuthority } from "./source-meta.ts";

const AUTHORITY_BOOST = {
  official: 20,
  paper: 16,
  community: 8,
  news: 4,
  source: 2,
  aggregator: 0,
} as const;

type DecisionTopicEntry = Pick<
  NormalizedEntry,
  "clusterId" | "title"
>;

const LAUNCH_INTENT_SOURCE =
  String.raw`\b(?:announc(?:e|ed|es|ing|ement)|introduc(?:e|ed|es|ing)|launch(?:ed|es|ing)?|releas(?:e|ed|es|ing)|unveil(?:ed|s|ing)?|debut(?:ed|s|ing)?|available|availability|rollout|ships?)\b|発表|登場|リリース|公開|提供開始|利用可能`;

const LAUNCH_FILLER_TOKENS = new Set([
  "a",
  "an",
  "are",
  "general",
  "is",
  "its",
  "latest",
  "model",
  "models",
  "new",
  "now",
  "our",
  "the",
  "updated",
  "was",
  "が",
  "の",
  "は",
  "を",
  "モデル",
  "新型",
  "最新",
]);

const LAUNCH_TRAILING_TOKENS = new Set([
  "globally",
  "now",
  "officially",
  "today",
  "worldwide",
  "一般提供",
  "正式提供",
  "本日",
]);

const NON_LAUNCH_INTENT_RE =
  /\b(?:analysis|comparison|cost|explainer|guide|how-to|migration|overview|price|pricing|review|tutorial)\b|分析|価格|ガイド|コスト|使い方|手順|単価|解説|検証|比較|移行|料金|チュートリアル|レビュー/iu;

const FEATURE_OR_PLATFORM_SUFFIX_RE =
  /\b(?:api|audio|coding agent|computer use|feature|function calling|github copilot|integration|native audio|plugin|support|tool use|availability in|available in|comes to|now in)\b|機能|統合|対応|提供先|で利用可能|に対応|で提供開始/iu;

const MODEL_VERSION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  family: (match: RegExpMatchArray) => string;
  versionIndex: number;
}> = [
  {
    pattern: /\b(?:claude[\s-]+)?(opus|sonnet|haiku)[\s-]+v?(\d+(?:[._-]\d+){0,2}[a-z]?)\b/iu,
    family: (match) => `claude-${match[1]!.toLocaleLowerCase()}`,
    versionIndex: 2,
  },
  {
    pattern: /\b(chatgpt|gpt|gemini|gemma|llama|qwen|deepseek|grok|kimi|mistral|codex|fable)[\s-]*v?(\d+(?:[._-]\d+){0,2}[a-z]?)\b/iu,
    family: (match) => match[1]!.toLocaleLowerCase(),
    versionIndex: 2,
  },
];

const MODEL_VARIANT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "available",
  "availability",
  "announced",
  "announces",
  "announcing",
  "by",
  "capabilities",
  "capability",
  "comes",
  "for",
  "from",
  "in",
  "introduced",
  "introduces",
  "introducing",
  "is",
  "launched",
  "launches",
  "model",
  "models",
  "now",
  "of",
  "on",
  "released",
  "releasing",
  "releases",
  "rolled",
  "rollout",
  "shipped",
  "ships",
  "the",
  "to",
  "with",
  "発表",
  "登場",
  "公開",
  "提供開始",
  "が",
  "で",
  "と",
  "に",
  "の",
  "は",
  "へ",
  "を",
  "モデル",
]);

function normalizeVersion(value: string): string {
  return value.toLocaleLowerCase().replace(/[._-]+/g, ".");
}

function normalizeVariant(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

function parseModelVariantSuffix(
  text: string,
  modelEnd: number,
): { end: number; variant: string | null } {
  let cursor = modelEnd;
  const separator = text.slice(cursor).match(/^[\s_-]+/u)?.[0] ?? "";
  if (!separator) return { end: modelEnd, variant: null };
  cursor += separator.length;

  const tokens: string[] = [];
  let variantEnd = modelEnd;
  for (let index = 0; index < 3; index += 1) {
    const tokenMatch = text.slice(cursor).match(
      /^([\p{Letter}\p{Number}]+)(?=$|[\s_:;,()[\]/{}/-])/u,
    );
    const token = tokenMatch?.[1];
    if (!token || MODEL_VARIANT_STOP_WORDS.has(token.toLocaleLowerCase())) break;
    tokens.push(token);
    cursor += token.length;
    variantEnd = cursor;
    const nextSeparator = text.slice(cursor).match(/^[\s_-]+/u)?.[0] ?? "";
    if (!nextSeparator) break;
    cursor += nextSeparator.length;
  }

  return {
    end: tokens.length > 0 ? variantEnd : modelEnd,
    variant: tokens.length > 0 ? normalizeVariant(tokens.join("-")) : null,
  };
}

function normalizedWords(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function isLaunchFiller(value: string): boolean {
  const tokens = normalizedWords(value);
  return tokens.length <= 4
    && tokens.every((token) => LAUNCH_FILLER_TOKENS.has(token));
}

function isLaunchTrailingFiller(value: string): boolean {
  const tokens = normalizedWords(value);
  return tokens.length <= 2
    && tokens.every((token) => LAUNCH_TRAILING_TOKENS.has(token));
}

function hasLaunchIntentNearModel(
  text: string,
  modelStart: number,
  modelEnd: number,
  modelCoreEnd: number,
): boolean {
  const launchIntent = new RegExp(LAUNCH_INTENT_SOURCE, "giu");
  for (const match of text.matchAll(launchIntent)) {
    const intentStart = match.index;
    const intentEnd = intentStart + match[0].length;
    if (intentEnd <= modelStart && isLaunchFiller(text.slice(intentEnd, modelStart))) {
      return !FEATURE_OR_PLATFORM_SUFFIX_RE.test(text.slice(modelCoreEnd));
    }
    if (
      intentStart >= modelEnd
      && isLaunchFiller(text.slice(modelEnd, intentStart))
      && isLaunchTrailingFiller(text.slice(intentEnd))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns a conservative cross-source topic key for decision-critical slots.
 * Explicit publisher clusters win. The fallback only groups versioned model
 * launch/availability headlines, leaving pricing, tutorials, and analysis
 * about the same model independently eligible.
 */
export function decisionTopicKey(entry: DecisionTopicEntry): string | null {
  const clusterId = entry.clusterId?.normalize("NFKC").trim().toLocaleLowerCase();
  if (clusterId) return `cluster:${clusterId}`;

  // Use the source title only. Generated title translations can paraphrase
  // analysis as an announcement and would make the fallback over-cluster.
  const text = entry.title.normalize("NFKC").toLocaleLowerCase();
  if (NON_LAUNCH_INTENT_RE.test(text)) return null;

  for (const {
    pattern,
    family,
    versionIndex,
  } of MODEL_VERSION_PATTERNS) {
    const match = text.match(pattern);
    const version = match?.[versionIndex];
    const matchStart = match?.index;
    if (match && version && matchStart !== undefined) {
      const modelCoreEnd = matchStart + match[0].length;
      const { end: modelEnd, variant } = parseModelVariantSuffix(text, modelCoreEnd);
      if (!hasLaunchIntentNearModel(text, matchStart, modelEnd, modelCoreEnd)) continue;
      return [
        "model-launch",
        family(match),
        normalizeVersion(version),
        variant ? normalizeVariant(variant) : null,
      ].filter(Boolean).join(":");
    }
  }
  return null;
}

export function decisionRankScore(
  entry: Pick<
    NormalizedEntry,
    | "collectedAt"
    | "importance"
    | "publishedAt"
    | "source"
    | "sourceType"
    | "title"
    | "titleEn"
    | "titleJa"
  >,
  nowMs: number,
): number {
  const publishedMs = Date.parse(entry.publishedAt || entry.collectedAt);
  const ageHours = Number.isFinite(publishedMs)
    ? Math.max(0, (nowMs - publishedMs) / 3_600_000)
    : 0;
  const authority = sourceAuthority(entry.source, entry.sourceType).kind;
  const sourceTypeBoost =
    entry.sourceType === "release" || entry.sourceType === "changelog" ? -8 : 0;
  // Routine patch/prerelease builds rank as importance 1 regardless of the
  // stored value: older snapshots carry over-scored importance (the collector
  // once matched "v3." as a major keyword) and the max-merge ratchet keeps it.
  const importance = isRoutineReleaseEntry(entry)
    ? Math.min(entry.importance, 1)
    : entry.importance;
  return importance * 100 + AUTHORITY_BOOST[authority] - ageHours * 0.6 + sourceTypeBoost;
}

export interface DecisionSelectionOptions {
  candidateLimit?: number;
  featured?: NormalizedEntry;
  limit?: number;
  maxPerCategory?: number;
  nowMs: number;
}

/**
 * Selects a compact decision list with source, category, and event diversity.
 * Topic diversity is never relaxed during fallback, so one model launch cannot
 * consume Spotlight and multiple Top entries merely because sources differ.
 */
export function selectDiverseDecisionEntries(
  candidates: readonly NormalizedEntry[],
  {
    candidateLimit = 120,
    featured,
    limit = 3,
    maxPerCategory = 2,
    nowMs,
  }: DecisionSelectionOptions,
): NormalizedEntry[] {
  const featuredTopic = featured ? decisionTopicKey(featured) : null;
  const ranked = candidates
    .filter((entry) => entry.id !== featured?.id && entry.source !== featured?.source)
    .filter((entry) => {
      const topic = decisionTopicKey(entry);
      return !topic || topic !== featuredTopic;
    })
    .slice(0, candidateLimit)
    .map((entry) => ({ entry, score: decisionRankScore(entry, nowMs) }))
    .sort((left, right) =>
      right.score - left.score
      || right.entry.publishedAt.localeCompare(left.entry.publishedAt)
      || left.entry.id.localeCompare(right.entry.id)
    );

  const picked: NormalizedEntry[] = [];
  const pickedIds = new Set<string>();
  const usedTopics = new Set<string>(featuredTopic ? [featuredTopic] : []);
  const sourceCount = new Map<string, number>();
  const categoryCount = new Map<string, number>();

  const addIfTopicIsNew = (entry: NormalizedEntry): boolean => {
    const topic = decisionTopicKey(entry);
    if (topic && usedTopics.has(topic)) return false;
    picked.push(entry);
    pickedIds.add(entry.id);
    if (topic) usedTopics.add(topic);
    return true;
  };

  for (const { entry } of ranked) {
    if ((sourceCount.get(entry.source) ?? 0) >= 1) continue;
    if ((categoryCount.get(entry.category) ?? 0) >= maxPerCategory) continue;
    if (!addIfTopicIsNew(entry)) continue;
    sourceCount.set(entry.source, (sourceCount.get(entry.source) ?? 0) + 1);
    categoryCount.set(entry.category, (categoryCount.get(entry.category) ?? 0) + 1);
    if (picked.length === limit) return picked;
  }

  for (const { entry } of ranked) {
    if (pickedIds.has(entry.id)) continue;
    if (!addIfTopicIsNew(entry)) continue;
    if (picked.length === limit) break;
  }
  return picked;
}
