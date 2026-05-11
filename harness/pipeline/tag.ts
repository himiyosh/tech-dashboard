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
  const newTags = new Set(entry.tags);
  for (const rule of RULES) {
    if (rule.keywords.test(hay)) newTags.add(rule.tag);
  }
  return { ...entry, tags: Array.from(newTags).sort() };
}
