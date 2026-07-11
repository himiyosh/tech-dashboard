/**
 * tag.ts — keyword-based tag enrichment.
 *
 * Applies a small allowlist of high-signal tags based on title/snippet.
 * The summarize step can add model-proposed tags before this deterministic pass.
 */
import type { NormalizedEntry } from "../types.ts";

interface TagRule {
  tag: string;
  keywords: RegExp;
}

const TAG_ALIASES = {
  "ai-agent": "ai-agents",
  "ai agent": "ai-agents",
  "ai agents": "ai-agents",
  prerelease: "pre-release",
  "pre release": "pre-release",
  patch: "patch-release",
  "patch release": "patch-release",
  benchmarks: "benchmark",
  "zed-editor": "zed",
  "zed editor": "zed",
  "vs-code": "vscode",
  "open-models": "open-model",
  agents: "agent",
} as const;

export function normalizeTag(tag: string): string {
  const normalized = tag.trim().toLowerCase();
  return TAG_ALIASES[normalized as keyof typeof TAG_ALIASES] ?? normalized;
}

export function normalizeTags(tags: readonly string[], max?: number): string[] {
  const normalized = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  const retained = typeof max === "number" ? normalized.slice(0, max) : normalized;
  return retained.sort();
}

const RULES: readonly TagRule[] = [
  { tag: "release", keywords: /\b(release|released|ga|general availability|launch(?:ed|ing)?)\b/i },
  { tag: "tutorial", keywords: /\b(tutorial|guide|how[- ]to|walkthrough)\b/i },
  { tag: "benchmark", keywords: /\b(benchmark|eval(?:uation)?|swe-?bench|humaneval|gpqa)\b/i },
  { tag: "rag", keywords: /\b(rag|retrieval[- ]augmented)\b/i },
  { tag: "mcp-server", keywords: /\bmcp\b|\bmodel context protocol\b/i },
  { tag: "open-model", keywords: /\b(llama|qwen|deepseek|mistral|gemma|phi[- ]?\d)\b/i },
  { tag: "agent", keywords: /\b(agent|agentic|autonomous)\b/i },
  { tag: "enterprise", keywords: /\b(enterprise|governance|compliance|soc2|iso 27001)\b/i },
];

export function applyTags(entry: NormalizedEntry): NormalizedEntry {
  const hay = `${entry.title} ${entry.summaryEn} ${entry.summaryJa}`.trim();
  const newTags = new Set(normalizeTags(entry.tags));
  for (const rule of RULES) {
    if (rule.keywords.test(hay)) newTags.add(rule.tag);
  }
  return { ...entry, tags: normalizeTags([...newTags]) };
}
