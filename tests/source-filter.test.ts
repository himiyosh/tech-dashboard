import { describe, expect, it } from "vitest";
import { matchesKeywordFilter } from "../harness/pipeline/source-filter.ts";
import { REGISTRY } from "../harness/registry.ts";
import type { SourceDefinition } from "../harness/types.ts";

const source: SourceDefinition = {
  id: "qiita-vscode",
  displayName: "Qiita VSCode tag",
  category: "vscode",
  sourceType: "blog",
  defaultLang: "ja",
  autoTags: ["qiita", "vscode"],
  feedUrl: "https://qiita.com/tags/vscode/feed.atom",
  tier: 2,
  includeKeywords: ["vscode", "vs code", "visual studio code", "extension", "拡張機能"],
  excludeKeywords: ["makefile:2", "missing separator"],
  keywordFilterScope: "title",
  collect: async () => [],
};

describe("matchesKeywordFilter", () => {
  it("applies title-only include filters to old merged entries", () => {
    expect(matchesKeywordFilter({
      title: "C言語のコンパイル時に文字化けが発生する",
      url: "https://qiita.com/example/items/1",
      contentSnippet: "This entry came from a vscode tag feed but is not about VS Code.",
    }, source)).toBe(false);

    expect(matchesKeywordFilter({
      title: "VSCode 拡張機能の設定を整理する",
      url: "https://qiita.com/example/items/2",
      contentSnippet: "",
    }, source)).toBe(true);
  });
});

describe("Google Cloud Blog knowledge filter (R-017)", () => {
  const gcloud = REGISTRY["google-cloud-blog"];
  const check = (title: string) =>
    matchesKeywordFilter({ title, url: "", contentSnippet: "" }, gcloud);

  it("keeps AI / data / developer engineering knowledge", () => {
    expect(check("What's new in data agents: Supercharging your AI workflows")).toBe(true);
    expect(check("How the open knowledge format can improve data sharing")).toBe(true);
    expect(check("Architecting a trusted agentic platform with graph technologies")).toBe(true);
    expect(check("How I learned Go in a Day with Antigravity 2.0")).toBe(true);
    expect(check("BigQuery ML: training models at scale")).toBe(true);
  });

  it("drops threat-intel / sector / roundup noise", () => {
    expect(check("Public and Private Medical Community Targeted by China-Nexus threat")).toBe(false);
    expect(check("What's new with Google Cloud")).toBe(false);
    expect(check("Cloud CISO Perspectives on ransomware")).toBe(false);
    expect(check("Our retail partner program expands")).toBe(false);
  });
});

describe("knowledge evergreen sources (R-022)", () => {
  it("Microsoft Foundry and Google Cloud blogs are configured as evergreen", () => {
    for (const id of ["anthropic-engineering", "github-copilot", "microsoft-foundry", "google-cloud-blog", "aws-ml-blog", "meta-engineering", "netflix-techblog"]) {
      const src = REGISTRY[id];
      expect(src, `${id} is registered`).toBeTruthy();
      expect(src.evergreen, `${id} is evergreen`).toBe(true);
      expect(src.sourceType, `${id} is a blog`).toBe("blog");
    }
  });

  it("the broad Google Cloud feed has relevance + noise filters", () => {
    const gcloud = REGISTRY["google-cloud-blog"];
    expect(gcloud.includeKeywords?.length ?? 0).toBeGreaterThan(0);
    expect(gcloud.excludeKeywords?.length ?? 0).toBeGreaterThan(0);
    expect(gcloud.keywordFilterScope).toBe("title");
    expect(gcloud.maxEntriesPerRun).toBeGreaterThan(0);
  });
});
