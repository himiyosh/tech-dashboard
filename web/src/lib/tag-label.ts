import { normalizeTagKey } from "./tag-normalize.ts";

const WORD_LABELS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  arxiv: "arXiv",
  aws: "AWS",
  cli: "CLI",
  css: "CSS",
  github: "GitHub",
  gpt: "GPT",
  html: "HTML",
  ios: "iOS",
  javascript: "JavaScript",
  llm: "LLM",
  mcp: "MCP",
  ml: "ML",
  macos: "macOS",
  openai: "OpenAI",
  sdk: "SDK",
  typescript: "TypeScript",
  ui: "UI",
  url: "URL",
  vram: "VRAM",
  vscode: "VS Code",
  whatsapp: "WhatsApp",
  youtube: "YouTube",
};

const TAG_LABELS: Readonly<Record<string, string>> = {
  "artificial-intelligence": "Artificial intelligence",
  "claude-code": "Claude Code",
  "github-copilot": "GitHub Copilot",
  "model-context-protocol": "Model Context Protocol",
  "sha-1": "SHA-1",
};

/** Reader-facing text only: routing and search continue to use the original tag. */
export function tagLabel(tag: string): string {
  const value = tag.trim();
  if (!value) throw new Error("Cannot label an empty tag");
  const exact = TAG_LABELS[normalizeTagKey(value)];
  if (exact) return exact;

  const versioned = value.match(/^([a-z]+)[-_](\d[\w.+-]*)$/i);
  if (versioned) {
    const product = versioned[1]!.toLowerCase();
    return `${WORD_LABELS[product] ?? product[0]!.toUpperCase() + product.slice(1)}-${versioned[2]}`;
  }

  return value
    .split(/[-_\s]+/)
    .map((word, index) => {
      const known = WORD_LABELS[word.toLowerCase()];
      if (known) return known;
      return index === 0
        ? word[0]!.toUpperCase() + word.slice(1)
        : word.toLowerCase();
    })
    .join(" ");
}
