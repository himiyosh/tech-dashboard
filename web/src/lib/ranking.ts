import type { NormalizedEntry } from "./data.ts";
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

const LAUNCH_INTENT_RE =
  /\b(?:announc(?:e|ed|es|ing|ement)|introduc(?:e|ed|es|ing)|launch(?:ed|es|ing)?|releas(?:e|ed|es|ing)|unveil(?:ed|s|ing)?|debut(?:ed|s|ing)?|available|availability|rollout|ships?)\b|発表|登場|リリース|公開|提供開始|利用可能/iu;

const NON_LAUNCH_INTENT_RE =
  /\b(?:analysis|cost|guide|migration|price|pricing|review|tutorial)\b|分析|価格|ガイド|コスト|使い方|手順|単価|検証|移行|料金|チュートリアル|レビュー/iu;

const MODEL_VARIANT =
  String.raw`(?:pro|flash|ultra|nano|mini|lite|coder|coding|vl|vision|instruct|chat|reasoning|embedding|audio|image|fast|preview|\d+(?:\.\d+)?b|\d+x\d+b)`;

const MODEL_VERSION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  family: (match: RegExpMatchArray) => string;
  variantIndex: number;
  versionIndex: number;
}> = [
  {
    pattern: new RegExp(
      String.raw`\b(?:claude[\s-]+)?(opus|sonnet|haiku)[\s-]+v?(\d+(?:[._-]\d+){0,2}[a-z]?)(?:[\s-]+(${MODEL_VARIANT}))?\b`,
      "iu",
    ),
    family: (match) => `claude-${match[1]!.toLocaleLowerCase()}`,
    variantIndex: 3,
    versionIndex: 2,
  },
  {
    pattern: new RegExp(
      String.raw`\b(chatgpt|gpt|gemini|gemma|llama|qwen|deepseek|grok|kimi|mistral|codex|fable)[\s-]*v?(\d+(?:[._-]\d+){0,2}[a-z]?)(?:[\s-]+(${MODEL_VARIANT}))?\b`,
      "iu",
    ),
    family: (match) => match[1]!.toLocaleLowerCase(),
    variantIndex: 3,
    versionIndex: 2,
  },
];

function normalizeVersion(value: string): string {
  return value.toLocaleLowerCase().replace(/[._-]+/g, ".");
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
  if (!LAUNCH_INTENT_RE.test(text)) return null;

  for (const {
    pattern,
    family,
    variantIndex,
    versionIndex,
  } of MODEL_VERSION_PATTERNS) {
    const match = text.match(pattern);
    const version = match?.[versionIndex];
    if (match && version) {
      const variant = match[variantIndex]?.toLocaleLowerCase();
      return [
        "model-launch",
        family(match),
        normalizeVersion(version),
        variant,
      ].filter(Boolean).join(":");
    }
  }
  return null;
}

export function decisionRankScore(
  entry: Pick<NormalizedEntry, "collectedAt" | "importance" | "publishedAt" | "source" | "sourceType">,
  nowMs: number,
): number {
  const publishedMs = Date.parse(entry.publishedAt || entry.collectedAt);
  const ageHours = Number.isFinite(publishedMs)
    ? Math.max(0, (nowMs - publishedMs) / 3_600_000)
    : 0;
  const authority = sourceAuthority(entry.source, entry.sourceType).kind;
  const sourceTypeBoost =
    entry.sourceType === "release" || entry.sourceType === "changelog" ? -8 : 0;
  return entry.importance * 100 + AUTHORITY_BOOST[authority] - ageHours * 0.6 + sourceTypeBoost;
}

export interface DecisionSelectionOptions {
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
