import { describe, expect, it } from "vitest";
import { decorateReleaseTitle, detectLang, normalize, restampEntryFromSource } from "../harness/pipeline/normalize.ts";
import { normalizeTag, normalizeTags } from "../harness/pipeline/tag.ts";
import type { RawEntry, SourceDefinition } from "../harness/types.ts";
import { knowledgeEligibility } from "../web/src/lib/knowledge-eligibility.ts";

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
    const long = "x".repeat(1_000);
    const entry = normalize({ ...rawEntry("Long"), contentSnippet: long }, releaseSource, "2026-05-10T01:00:00.000Z");
    expect(entry.contentSnippet?.length).toBe(900);
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

  it("collapses the 2026-07 taxonomy audit singular/plural fragmentation", () => {
    expect(normalizeTags([
      "llm",
      "llms",
      "coding-agent",
      "coding-agents",
      "llm-agent",
      "llm-agents",
      "ai-model",
      "ai-models",
      "foundation-model",
      "foundation-models",
      "autonomous-agent",
      "autonomous-agents",
      "guardrail",
      "guardrails",
    ])).toEqual([
      "ai-models",
      "autonomous-agents",
      "coding-agent",
      "foundation-models",
      "guardrails",
      "llm",
      "llm-agents",
    ]);
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
    ["LeRobot v0.6.0: Imagine, Evaluate, Improve", "local-llm"],
    ["TRL v1.0: Post-Training Library Built to Move with the Field", "local-llm"],
    ["From the Hugging Face Hub to robot hardware with Strands Agents and LeRobot", "agent-fw"],
    ["LeRobot Worldwide Hackathon: Benchmarking Robotics Agents", "research"],
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

  // github.blog/changelog covers the entire GitHub platform (Projects, Actions,
  // Dependabot, secret scanning, Code Quality, GHES, npm, Enterprise admin
  // settings), not just GitHub Copilot. These are actual titles collected from
  // the live feed (2026-07), verified against the full live+archive corpus
  // (192 unique entries: 107 stay "copilot", 85 move to "tech-news").
  const githubChangelogSource: SourceDefinition = {
    id: "github-changelog",
    displayName: "GitHub Changelog",
    category: "copilot",
    sourceType: "changelog",
    defaultLang: "en",
    autoTags: ["github", "changelog"],
    feedUrl: "https://github.blog/changelog/feed/",
    collect: async () => [],
    tier: 1,
  };

  it.each([
    // keep: GitHub Copilot / model-vendor / agent content
    ["Copilot cloud agent for Linear is now generally available", "copilot"],
    ["GitHub MCP Server supports the next MCP specification", "copilot"],
    ["Gemini 3.6 Flash is now available in GitHub Copilot", "copilot"],
    ["AI credit pools for cost centers in the billing UI", "copilot"],
    ["Cost centers now support AI credit pools", "copilot"],
    ["OpenAI’s GPT-5.6 Sol, Terra, and Luna are now available in GitHub Copilot", "copilot"],
    ["Kimi K2.7 now available for Copilot Business and Enterprise", "copilot"],
    ["GPT-4.1 deprecated", "copilot"],
    ["Grok Code Fast 1 deprecated", "copilot"],
    ["Upcoming deprecation of Opus 4.6 (fast)", "copilot"],
    ["Agentic autofix for code scanning alerts in public preview", "copilot"],
    ["Agent automation controls in GitHub Issues in public preview", "copilot"],
    ["Auto model selection now routes based on your task in VS Code", "copilot"],
    ["Changes to model selection for Free and Student plans", "copilot"],
    ["Evaluation models in auto for individual plans", "copilot"],
    ["AI usage report updates", "copilot"],
    [
      "Enterprise-managed OpenTelemetry export for VS Code and CLI",
      "copilot",
      "Organizations can now mandate where GitHub Copilot sends OpenTelemetry (OTel) data, so telemetry flows to an approved collector without each developer setting OTEL_* environment variables.",
    ],
    // move: generic GitHub platform news, no Copilot/AI signal
    ["Multi-select fields for Projects and Issues in public preview", "tech-news"],
    ["Upcoming GHES change impacting uploading support bundles", "tech-news"],
    ["GitHub Code Quality is now generally available", "tech-news"],
    ["Advanced search for Projects is generally available", "tech-news"],
    ["Repository admins can archive pull requests", "tech-news"],
    ["REST API endpoints for Visual Studio Subscription management", "tech-news"],
    ["Xcode 27 runner image now in public preview", "tech-news"],
    ["Red Hat Enterprise Linux runner images are now in public preview", "tech-news"],
    ["Improvements to secret scanning and public monitoring", "tech-news"],
    ["Dependabot version updates introduce default package cooldown", "tech-news"],
    ["Manage secret scanning custom patterns via REST API", "tech-news"],
    ["Separate SSO and Organizations pages in Settings", "tech-news"],
    ["New pull requests dashboard is now generally available", "tech-news"],
    ["Innersource security advisories are generally available", "tech-news"],
    ["Restrict who can dismiss reviews in rulesets", "tech-news"],
    ["Code scanning shows AI security detections on pull requests", "tech-news"],
    ["CodeQL 2.26.0 adds Kotlin 2.4.0 support and AI prompt injection detection", "tech-news"],
    ["GitHub Models is being fully retired on July 30, 2026", "tech-news"],
    ["Per-user budgets for cost centers in the billing UI", "tech-news"],
    ["Enterprises can now create up to 500 cost centers", "tech-news"],
    ["Staged publishing and new install-time controls for npm", "tech-news"],
    ["Timestamp fields in GitHub Projects", "tech-news"],
  ] as const)("GitHub Changelog の %s を %s に分類する", (title, category, contentSnippet = "") => {
    const entry = normalize(
      {
        externalId: title,
        url: `https://github.blog/changelog/${encodeURIComponent(title)}`,
        title,
        contentSnippet,
        publishedAt: "2026-07-10T00:00:00.000Z",
      },
      githubChangelogSource,
      "2026-07-10T01:00:00.000Z",
    );
    expect(entry.category).toBe(category);
  });

  // developers.googleblog.com is overwhelmingly Gemini/GenAI content, but a
  // handful of posts cover unrelated Google platform features (Google Pay,
  // Sign in with Google, Google Account). Actual titles collected from the
  // live feed (2026-07), verified against the full live+archive corpus
  // (58 unique entries: 6 move to "tech-news", 52 stay "gemini").
  const googleDevelopersSource: SourceDefinition = {
    id: "google-developers",
    displayName: "Google Developers Blog",
    category: "gemini",
    sourceType: "blog",
    defaultLang: "en",
    autoTags: ["google"],
    feedUrl: "https://developers.googleblog.com/feeds/posts/default",
    collect: async () => [],
    tier: 1,
  };

  it.each([
    // keep: Gemini/GenAI content, including an MCP story that happens to
    // mention "Google Pay" (must not be excluded by the payment-topic filter)
    ["Bringing Gemma 4 12B to your Laptop: Unlocking Local, Agentic Workflows with Google AI Edge", "gemini"],
    ["Supercharge your integration workflow with the Google Pay & Wallet Developer MCP server", "gemini"],
    ["Subagents have arrived in Gemini CLI", "gemini"],
    ["Why we built ADK 2.0", "gemini"],
    // move: unrelated Google platform features, no AI/Gemini signal
    ["Enhance Security and Trust: New Session Metadata in Sign in with Google", "tech-news"],
    ["The latest updates to Google Pay", "tech-news"],
    ["Enhancing Android Checkout with Dynamic Callbacks in Google Pay", "tech-news"],
    ["New enhancements for merchant initiated transactions with the Google Pay API", "tech-news"],
    ["Supporting Google Account username change in your app", "tech-news"],
    ["Get ready for Google I/O: Livestream schedule revealed", "tech-news"],
  ] as const)("Google Developers Blog の %s を %s に分類する", (title, category) => {
    const entry = normalize(
      {
        externalId: title,
        url: `https://developers.googleblog.com/${encodeURIComponent(title)}`,
        title,
        contentSnippet: "",
        publishedAt: "2026-07-10T00:00:00.000Z",
      },
      googleDevelopersSource,
      "2026-07-10T01:00:00.000Z",
    );
    expect(entry.category).toBe(category);
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

  it("stamps evergreen per entry and demotes announcement-only source items", () => {
    const evergreenSource: SourceDefinition = {
      ...releaseSource,
      id: "aws-ml-blog",
      sourceType: "blog",
      category: "agent-fw",
      evergreen: true,
    };
    const announcement = normalize(
      {
        ...rawEntry("Introducing Claude Opus 5 on AWS: Anthropic’s most capable Opus model"),
        contentSnippet: "This post covers the newly available model on Amazon Bedrock.",
      },
      evergreenSource,
      "2026-07-30T00:00:00.000Z",
    );
    const tutorial = normalize(
      {
        ...rawEntry("Get started with OpenAI GPT-5.6 Sol, Terra, and Luna on Amazon Bedrock"),
        contentSnippet: "The models are now generally available. Learn how to run inference and reduce cost.",
      },
      evergreenSource,
      "2026-07-30T00:00:00.000Z",
    );
    const announcementBoilerplate = normalize(
      {
        ...rawEntry("Introducing Claude apps gateway for AWS"),
        contentSnippet: "Today, we're announcing the Claude apps gateway for AWS. In this post, we show how to set up and run it.",
      },
      evergreenSource,
      "2026-07-30T00:00:00.000Z",
    );

    expect(announcement.evergreen).toBe(true);
    expect(announcement.knowledgeEligible).toBe(false);
    expect(announcementBoilerplate.knowledgeEligible).toBe(false);
    expect(tutorial.evergreen).toBe(true);
    expect(restampEntryFromSource(
      { ...announcement, knowledgeEligible: true },
      evergreenSource,
      "2026-07-30T01:00:00.000Z",
    ).knowledgeEligible).toBe(false);
  });

  it("uses the same persisted raw context for fresh Knowledge eligibility stamps", () => {
    const evergreenSource: SourceDefinition = {
      ...releaseSource,
      id: "google-cloud-blog",
      sourceType: "blog",
      category: "gemini",
      evergreen: true,
    };
    const raw = {
      ...rawEntry("Bringing Conversational Analytics to your entire data ecosystem"),
      contentSnippet:
        `${"Durable-looking architecture context. ".repeat(9)}The API is now generally available for enterprise teams.`,
    };

    const normalized = normalize(
      raw,
      evergreenSource,
      "2026-07-30T00:00:00.000Z",
    );
    const reproducibleDecision = knowledgeEligibility({
      source: normalized.source,
      title: normalized.title,
      contentSnippet: normalized.contentSnippet,
      evergreen: normalized.evergreen,
    });

    expect(normalized.contentSnippet).toContain("now generally available");
    expect(normalized.knowledgeEligible).toBe(false);
    expect(reproducibleDecision).toEqual({
      eligible: false,
      reason: "availability-context",
    });
  });

  it("preserves a stored exclusion when prior raw context is lossy", () => {
    const evergreenSource: SourceDefinition = {
      ...releaseSource,
      id: "google-cloud-blog",
      sourceType: "blog",
      category: "gemini",
      evergreen: true,
    };
    const prior = normalize(
      {
        ...rawEntry("Future-proofing data integrity"),
        contentSnippet: "The service is now generally available.",
      },
      evergreenSource,
      "2026-07-30T00:00:00.000Z",
    );
    const lossyPrior = {
      ...prior,
      contentSnippet: "A durable-looking explanation without the original availability evidence.",
    };

    expect(lossyPrior.knowledgeEligible).toBe(false);
    expect(
      restampEntryFromSource(
        lossyPrior,
        evergreenSource,
        "2026-07-30T01:00:00.000Z",
      ).knowledgeEligible,
    ).toBe(false);
  });
});
