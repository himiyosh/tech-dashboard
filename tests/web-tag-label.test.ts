import { describe, expect, it } from "vitest";
import { tagLabel } from "../web/src/lib/tag-label.ts";

describe("article topic labels", () => {
  it("renders actual Meta One tags as readable names without changing keys", () => {
    const tags = [
      "artificial-intelligence", "creator-tools", "facebook", "instagram",
      "meta", "news", "subscription", "whatsapp",
    ];
    expect(tags.map(tagLabel)).toEqual([
      "Artificial intelligence", "Creator tools", "Facebook", "Instagram",
      "Meta", "News", "Subscription", "WhatsApp",
    ]);
    expect(tags[0]).toBe("artificial-intelligence");
  });

  it("preserves established brands, acronyms, version syntax and other scripts", () => {
    expect(tagLabel("github-copilot")).toBe("GitHub Copilot");
    expect(tagLabel("mcp-server")).toBe("MCP server");
    expect(tagLabel("vscode-agents")).toBe("VS Code agents");
    expect(tagLabel("gpt-5.6")).toBe("GPT-5.6");
    expect(tagLabel("C++")).toBe("C++");
    expect(tagLabel("日本語")).toBe("日本語");
    expect(() => tagLabel("  ")).toThrow("Cannot label an empty tag");
  });
});
