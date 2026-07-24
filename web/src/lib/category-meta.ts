export type Category =
  | "copilot"
  | "claude"
  | "codex"
  | "gemini"
  | "vscode"
  | "cursor"
  | "cline"
  | "aider"
  | "opencode"
  | "local-llm"
  | "agent-fw"
  | "mcp"
  | "research"
  | "tech-news";

export type CategoryGroup =
  | "microsoft"
  | "anthropic"
  | "openai"
  | "google"
  | "coding-tools"
  | "open-models"
  | "agent-tools"
  | "research"
  | "industry";

export interface CategoryMeta {
  slug: Category;
  name: string;
  shortLabel: string;
  searchAliases?: readonly string[];
  color: string;
  initial: string;
  emoji: string;
  group: CategoryGroup;
}

export const CATEGORY_META: ReadonlyArray<CategoryMeta> = [
  { slug: "copilot", name: "GitHub Copilot", shortLabel: "Copilot", color: "#5eead4", initial: "Co", emoji: "\u{1F9E0}", group: "microsoft" },
  { slug: "vscode", name: "VS Code / Dev Env", shortLabel: "VS Code", color: "#63a2ff", initial: "Vs", emoji: "\u{1F537}", group: "microsoft" },
  { slug: "claude", name: "Claude / Claude Code", shortLabel: "Claude Code", color: "#fbbf24", initial: "Cl", emoji: "\u{1F9E1}", group: "anthropic" },
  { slug: "codex", name: "OpenAI / Codex", shortLabel: "Codex", color: "#93c5fd", initial: "Cx", emoji: "\u{1F4D8}", group: "openai" },
  { slug: "gemini", name: "Gemini / Gemma", shortLabel: "Gemini/Gemma", color: "#60a5fa", initial: "Gm", emoji: "\u{2728}", group: "google" },
  { slug: "cursor", name: "AI Editors", shortLabel: "AI Editors", color: "#cbd5e1", initial: "Ed", emoji: "\u{1F5B1}\u{FE0F}", group: "coding-tools" },
  { slug: "cline", name: "Cline / Roo", shortLabel: "Cline/Roo", color: "#c4b5fd", initial: "Cn", emoji: "\u{1F9F5}", group: "coding-tools" },
  { slug: "aider", name: "Aider", shortLabel: "Aider", color: "#d6d3a1", initial: "Ai", emoji: "\u{1F91D}", group: "coding-tools" },
  { slug: "opencode", name: "OpenHands / OpenCode", shortLabel: "OpenHands/OpenCode", color: "#a5b4fc", initial: "Oh", emoji: "\u{1F310}", group: "coding-tools" },
  { slug: "local-llm", name: "Local LLM / Open Models", shortLabel: "Local Models", searchAliases: ["local model", "local models", "local ai", "on-device ai", "open source model", "open source models"], color: "#f87171", initial: "Lm", emoji: "\u{1F3E0}", group: "open-models" },
  { slug: "agent-fw", name: "Agent Frameworks", shortLabel: "Agent Frameworks", color: "#34d399", initial: "Af", emoji: "\u{1F916}", group: "agent-tools" },
  { slug: "mcp", name: "MCP / Tooling", shortLabel: "MCP", color: "#f472b6", initial: "Mc", emoji: "\u{1F517}", group: "agent-tools" },
  { slug: "research", name: "Papers / Benchmarks", shortLabel: "Papers/Benchmarks", searchAliases: ["benchmark", "benchmarks", "paper", "papers", "research"], color: "#fda4af", initial: "Pb", emoji: "\u{1F52C}", group: "research" },
  { slug: "tech-news", name: "Industry & Policy", shortLabel: "News/Policy", color: "#fb923c", initial: "Ip", emoji: "\u{1F4F0}", group: "industry" },
];

export function categoryLabel(
  category: Category,
  variant: "short" | "full" = "short",
): string {
  const meta = CATEGORY_META.find((item) => item.slug === category);
  if (meta) return variant === "full" ? meta.name : meta.shortLabel;
  return category
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export const CATEGORIES_BY_NAME: readonly CategoryMeta[] = [...CATEGORY_META].sort((a, b) =>
  a.name.localeCompare(b.name),
);

export const CATEGORIES_BY_SHORT_LABEL: readonly CategoryMeta[] = [...CATEGORY_META].sort((a, b) =>
  a.shortLabel.localeCompare(b.shortLabel),
);
