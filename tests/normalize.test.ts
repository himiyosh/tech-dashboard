import { describe, expect, it } from "vitest";
import { decorateReleaseTitle, detectLang, normalize, restampEntryFromSource } from "../harness/pipeline/normalize.ts";
import { normalizeTag, normalizeTags } from "../harness/pipeline/tag.ts";
import type { RawEntry, SourceDefinition } from "../harness/types.ts";

const releaseSource: SourceDefinition = {
  id: "cline-releases",
  displayName: "Cline Releases",
  category: "cline",
  sourceType: "release",
  defaultLang: "en",
  autoTags: ["cline"],
  feedUrl: "https://example.com/releases.atom",
  collect: async () => [],
  tier: 1,
};

const changelogSource: SourceDefinition = {
  id: "github-changelog",
  displayName: "GitHub Changelog",
  category: "github",
  sourceType: "changelog",
  defaultLang: "en",
  autoTags: ["github"],
  feedUrl: "https://example.com/changelog.atom",
  collect: async () => [],
  tier: 1,
};

function rawEntry(title: string): RawEntry {
  return {
    externalId: title,
    url: `https://example.com/releases/${encodeURIComponent(title)}`,
    title,
    contentSnippet: "Release note",
    publishedAt: "2026-05-10T00:00:00.000Z",
  };
}

describe("detectLang", () => {
  it("記号や区切り文字が多い短文でも日本語シグナルを拾う", () => {
    expect(detectLang("Claude 4 / GPT-5 / MCP / VS Code / 新機能", "en")).toBe("ja");
  });
});

describe("normalize summary fields", () => {
  it("snippet は表示用 summary に入れず contentSnippet に温存する (snippet-masquerade 防止)", () => {
    const raw = { ...rawEntry("Claude Code Auto Mode"), contentSnippet: "Auto Mode lets the agent run unattended." };
    const entry = normalize(raw, releaseSource, "2026-05-10T01:00:00.000Z");
    // 表示用 summary は空にして「要約未生成」ゲートに拾わせる
    expect(entry.summaryJa).toBe("");
    expect(entry.summaryEn).toBe("");
    // 生 snippet は AI 入力 context として温存する
    expect(entry.contentSnippet).toBe("Auto Mode lets the agent run unattended.");
  });

  it("空の contentSnippet では contentSnippet を持たない", () => {
    const raw = { ...rawEntry("Claude Code Auto Mode"), contentSnippet: "" };
    const entry = normalize(raw, releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.summaryJa).toBe("");
    expect(entry.summaryEn).toBe("");
    expect(entry.contentSnippet).toBeUndefined();
  });

  it("長い snippet は context 用に上限まで切り詰める", () => {
    const long = "x".repeat(400);
    const entry = normalize({ ...rawEntry("Long"), contentSnippet: long }, releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.contentSnippet?.length).toBe(280);
  });
});

describe("tag normalization", () => {
  it("collapses known singular, spelling, and release aliases", () => {
    expect(normalizeTag("AI Agent")).toBe("ai-agents");
    expect(normalizeTags([
      "ai-agent",
      "ai-agents",
      "prerelease",
      "pre-release",
      "patch",
      "benchmarks",
      "zed-editor",
      "vs-code",
      "open-models",
      "agents",
      "open-source",
    ])).toEqual([
      "agent",
      "ai-agents",
      "benchmark",
      "open-model",
      "open-source",
      "patch-release",
      "pre-release",
      "vscode",
      "zed",
    ]);
    expect(normalizeTag("open-source")).toBe("open-source");
  });

  it("normalizes source auto tags before publishing a fresh entry", () => {
    const aliasedSource: SourceDefinition = {
      ...releaseSource,
      autoTags: ["ai-agent", "benchmarks", "zed-editor"],
    };
    const entry = normalize(rawEntry("v3.8.0"), aliasedSource, "2026-05-10T01:00:00.000Z");
    expect(entry.tags).toEqual(["ai-agents", "benchmark", "zed"]);
  });

  it("applies the tag cap before display sorting so later tags cannot displace authoritative tags", () => {
    const authoritative = [
      "source-z",
      "source-y",
      "source-x",
      "source-w",
      "source-v",
      "source-u",
      "source-t",
      "source-s",
      "source-r",
      "source-q",
    ];
    expect(normalizeTags([...authoritative, "aaa-model-extra"], 10)).toEqual(
      [...authoritative].sort(),
    );
  });
});

describe("normalize release title decoration", () => {
  it("version-only release title に source 名を前置する", () => {
    const entry = normalize(rawEntry("v3.8.0"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases v3.8.0");
  });

  it("date-only release title に source 名を前置する", () => {
    const entry = normalize(rawEntry("Release 2026-05-10"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases Release 2026-05-10");
  });

  it("date separator variants も source 名を前置する", () => {
    const entry = normalize(rawEntry("2026.05.10"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases 2026.05.10");
  });

  it("source 名が既に含まれる title は二重に前置しない", () => {
    const entry = normalize(rawEntry("Cline Releases v3.8.0"), releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.title).toBe("Cline Releases v3.8.0");
  });

  it("製品名のない component タグに brand を前置する (CLI/SDK)", () => {
    expect(decorateReleaseTitle("CLI v3.0.31", releaseSource)).toBe("Cline CLI v3.0.31");
    expect(decorateReleaseTitle("sdk/core/v0.0.53", releaseSource)).toBe("Cline sdk/core v0.0.53");
  });

  it("colon 区切りの component タグも brand を前置し colon を除去する", () => {
    const openhands: SourceDefinition = { ...releaseSource, id: "openhands-releases", displayName: "OpenHands Releases" };
    expect(decorateReleaseTitle("cloud: 1.40.0", openhands)).toBe("OpenHands cloud 1.40.0");
    expect(decorateReleaseTitle("cloud-1.37.3", openhands)).toBe("OpenHands cloud-1.37.3");
  });

  it("timestamp 付き nightly は brand + 整形日時にする", () => {
    expect(decorateReleaseTitle("nightly-main-20260624210220-bd662d81f6f5", releaseSource)).toBe(
      "Cline Nightly (2026-06-24 21:02)",
    );
  });

  it("branding 済み title は再実行で変化しない (idempotent)", () => {
    expect(decorateReleaseTitle("Cline CLI v3.0.31", releaseSource)).toBe("Cline CLI v3.0.31");
    expect(decorateReleaseTitle("Cline Nightly (2026-06-24 21:02)", releaseSource)).toBe(
      "Cline Nightly (2026-06-24 21:02)",
    );
  });

  it("既に識別可能な title は変更しない (langchain pkg==ver / 説明文)", () => {
    const langchain: SourceDefinition = { ...releaseSource, id: "langchain-releases", displayName: "LangChain Releases" };
    expect(decorateReleaseTitle("langchain-core==1.4.8", langchain)).toBe("langchain-core==1.4.8");
    expect(decorateReleaseTitle("collab-production: ui: Fix `end_slot_on_hover` API (#59805)", releaseSource)).toBe(
      "collab-production: ui: Fix `end_slot_on_hover` API (#59805)",
    );
  });

  it("github-changelog の見出し文はそのまま保持する", () => {
    const headline = "Copilot code review: Analysis depth and efficiency updates";
    expect(decorateReleaseTitle(headline, changelogSource)).toBe(headline);
  });
});

describe("normalize category override", () => {
  const huggingFaceSource: SourceDefinition = {
    id: "huggingface-blog",
    displayName: "Hugging Face Blog",
    category: "local-llm",
    sourceType: "blog",
    defaultLang: "en",
    autoTags: ["huggingface"],
    feedUrl: "https://huggingface.co/blog/feed.xml",
    collect: async () => [],
    tier: 2,
  };
  const qiitaVscodeSource: SourceDefinition = {
    id: "qiita-vscode",
    displayName: "Qiita VSCode tag",
    category: "vscode",
    sourceType: "blog",
    defaultLang: "ja",
    autoTags: ["qiita", "vscode"],
    feedUrl: "https://example.com/vscode.atom",
    collect: async () => [],
    tier: 2,
  };

  it.each([
    ["Adding MCP Tools to Reachy Mini", "mcp"],
    ["ScarfBench: Benchmarking AI Agents for Enterprise Java Framework Migration", "research"],
    ["Accelerating Transformers Fine-Tuning with NVIDIA NeMo AutoModel", "research"],
    ["Data for Agents", "agent-fw"],
    ["Agentic Resource Discovery: Let agents search", "agent-fw"],
    ["From Hugging Face to Amazon SageMaker Studio in one click", "tech-news"],
    ["Hugging Face Models on Foundry Managed Compute", "tech-news"],
    ["Dell Enterprise Hub is all you need to build AI on premises", "tech-news"],
    ["IBM and Hugging Face Preview Granite 4 Vision: Tiny Multimodal Model for Enterprise Documents", "local-llm"],
    ["Profiling in PyTorch (Part 3): Attention is all you profile", "local-llm"],
    ["Native-speed vLLM transformers modeling backend", "local-llm"],
  ] as const)("Hugging Face の %s を %s に分類する", (title, category) => {
    const entry = normalize(
      {
        externalId: title,
        url: `https://huggingface.co/blog/${encodeURIComponent(title)}`,
        title,
        contentSnippet: "",
        publishedAt: "2026-05-10T00:00:00.000Z",
      },
      huggingFaceSource,
      "2026-05-10T01:00:00.000Z",
    );
    expect(entry.category).toBe(category);
  });

  it("Qiita vscode タグ由来でも Gemini / Antigravity 記事は gemini に再分類する", () => {
    const entry = normalize(
      {
        externalId: "antigravity",
        url: "https://example.com/antigravity",
        title: "Antigravity 2.0 × Gemini 3.5 Flash で変わる次世代の開発体験",
        contentSnippet: "",
        publishedAt: "2026-05-10T00:00:00.000Z",
      },
      qiitaVscodeSource,
      "2026-05-10T01:00:00.000Z",
    );
    expect(entry.category).toBe("gemini");
  });

  it("Qiita vscode タグ由来でも Copilot 記事は copilot に再分類する", () => {
    const entry = normalize(
      {
        externalId: "copilot",
        url: "https://example.com/copilot",
        title: "GitHub Copilot Appはgit worktree派にとても便利",
        contentSnippet: "",
        publishedAt: "2026-05-10T00:00:00.000Z",
      },
      qiitaVscodeSource,
      "2026-05-10T01:00:00.000Z",
    );
    expect(entry.category).toBe("copilot");
  });
});

describe("restampEntryFromSource", () => {
  it("preserves existing AI/cache-derived importance during restamp", () => {
    const entry = normalize(rawEntry("v3.8.0"), releaseSource, "2026-05-10T01:00:00.000Z");
    const restamped = restampEntryFromSource(
      {
        ...entry,
        importance: 3,
        summaryJa: "実要約",
        summaryEn: "Real summary",
      },
      releaseSource,
      "2026-06-10T01:00:00.000Z",
    );
    expect(restamped.importance).toBe(3);
  });
});
