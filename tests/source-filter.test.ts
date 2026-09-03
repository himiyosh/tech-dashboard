import { describe, expect, it } from "vitest";
import {
  evaluateKeywordFilter,
  isMutableReleaseAliasUrl,
  keywordFilterEntryFromNormalized,
  keywordMatchesHaystack,
  matchesKeywordFilter,
} from "../harness/pipeline/source-filter.ts";
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
  it("drops mutable GitHub release aliases but preserves immutable release tags", () => {
    const releaseSource: SourceDefinition = {
      ...source,
      sourceType: "release",
      includeKeywords: undefined,
      excludeKeywords: undefined,
      keywordFilterScope: undefined,
    };
    for (const alias of [
      "nightly",
      "canary",
      "snapshot",
      "rolling",
      "extension-workflows",
      "extension-cli",
      "collab-staging",
      "collab-production",
    ]) {
      const url = `https://github.com/zed-industries/zed/releases/tag/${alias}`;
      expect(isMutableReleaseAliasUrl(url)).toBe(true);
      expect(
        evaluateKeywordFilter(
          { title: `Zed ${alias}`, url, contentSnippet: "Mutable release content" },
          releaseSource,
        ),
      ).toEqual({
        keep: false,
        reason: "exclude",
        keyword: "mutable-release-alias",
        trusted: true,
      });
    }
    expect(isMutableReleaseAliasUrl("https://github.com/zed-industries/zed/releases/tag/v0.201.4")).toBe(false);
    expect(
      matchesKeywordFilter(
        {
          title: "Zed v0.201.4",
          url: "https://github.com/zed-industries/zed/releases/tag/v0.201.4",
          contentSnippet: "",
        },
        releaseSource,
      ),
    ).toBe(true);
  });

  it("does not apply the mutable release rule to a non-release source", () => {
    expect(
      matchesKeywordFilter(
        {
          title: "Nightly release practices",
          url: "https://github.com/example/project/releases/tag/nightly",
          contentSnippet: "",
        },
        { ...source, includeKeywords: undefined, excludeKeywords: undefined },
      ),
    ).toBe(true);
  });

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

  it("preserves non-title prior entries when missing include is untrustworthy after lossy normalization", () => {
    const nonTitleSource: SourceDefinition = {
      ...source,
      keywordFilterScope: undefined,
      includeKeywords: ["developer tool"],
      excludeKeywords: ["sale"],
    };
    expect(
      evaluateKeywordFilter(
        {
          title: "Neutral headline",
          url: "https://example.com/story",
          contentSnippet: "",
        },
        nonTitleSource,
        { allowLossyMissingInclude: true },
      ),
    ).toEqual({
      keep: true,
      reason: "missing-include-unverified",
      keyword: null,
      trusted: false,
    });
    expect(
      evaluateKeywordFilter(
        {
          title: "Neutral headline",
          url: "https://example.com/story",
          contentSnippet: "",
        },
        source,
        { allowLossyMissingInclude: true },
      ),
    ).toEqual({
      keep: false,
      reason: "missing-include",
      keyword: null,
      trusted: true,
    });
    expect(
      evaluateKeywordFilter(
        {
          title: "Developer tool roundup",
          url: "https://example.com/story",
          contentSnippet: "",
        },
        nonTitleSource,
        { allowLossyMissingInclude: true },
      ),
    ).toEqual({
      keep: true,
      reason: "include",
      keyword: "developer tool",
      trusted: true,
    });
    expect(
      evaluateKeywordFilter(
        {
          title: "Holiday sale for consumer gadgets",
          url: "https://example.com/story",
          contentSnippet: "developer tool",
        },
        nonTitleSource,
        { allowLossyMissingInclude: true },
      ),
    ).toEqual({
      keep: false,
      reason: "exclude",
      keyword: "sale",
      trusted: true,
    });
  });

  it("never reuses generated summaries as prior source-filter input", () => {
    const nonTitleSource: SourceDefinition = {
      ...source,
      keywordFilterScope: undefined,
      includeKeywords: ["llm"],
      excludeKeywords: ["clinical code prediction"],
    };
    const prior = keywordFilterEntryFromNormalized({
      title: "LLM evaluation for structured outputs",
      url: "https://example.com/llm-evaluation",
      summaryJa: "臨床 code prediction の研究を説明します。",
      summaryEn: "This generated summary mentions clinical code prediction.",
      titleJa: "",
      titleEn: "",
    });

    expect(prior.contentSnippet).toBeUndefined();
    expect(
      evaluateKeywordFilter(prior, nonTitleSource, {
        allowLossyMissingInclude: true,
      }),
    ).toEqual({
      keep: true,
      reason: "include",
      keyword: "llm",
      trusted: true,
    });
  });

  it("matches standalone ASCII keywords but not substrings inside alnum words", () => {
    expect(keywordMatchesHaystack("AI coding tools", "ai")).toBe(true);
    expect(keywordMatchesHaystack("AIs for developer tooling", "ai")).toBe(true);
    expect(keywordMatchesHaystack("paid feature rollout", "ai")).toBe(false);
    expect(keywordMatchesHaystack("electric air taxis are stuck", "ai")).toBe(false);
    expect(keywordMatchesHaystack("new trailer breakdown", "ai")).toBe(false);
    expect(keywordMatchesHaystack("OpenAI rolls out new tooling", "openai")).toBe(true);
    expect(keywordMatchesHaystack(
      "TRACER: A Semantic-Aware Framework for Fine-Grained Contamination Detection in Code LLMs",
      "llm",
    )).toBe(true);
    expect(keywordMatchesHaystack("How to use Google’s new information agents", "agent")).toBe(true);
    expect(keywordMatchesHaystack(
      "Prompting language influences diagnostic reasoning and accuracy of large language models",
      "language model",
    )).toBe(true);
    expect(keywordMatchesHaystack(
      "Tabular foundation models for robust calibration of near-infrared chemical sensing data",
      "foundation model",
    )).toBe(true);
    expect(keywordMatchesHaystack("Enterprise policies for AI agents", "policy")).toBe(true);
    expect(keywordMatchesHaystack(
      "Amazon EC2 C9g instances powered by AWS Graviton5 processors",
      "graviton",
    )).toBe(true);
    expect(keywordMatchesHaystack(
      "Fed up with vibe coders, dev sneaks data-nuking prompt injection into their code",
      "prompt injection",
    )).toBe(true);
  });
});

describe("article excerpt provenance (feedSnippet)", () => {
  const snippetScoped: SourceDefinition = {
    ...source,
    id: "provenance-source",
    keywordFilterScope: "title-and-content",
    includeKeywords: ["vscode"],
    excludeKeywords: ["sponsored"],
  };
  const base = {
    id: "id",
    source: "provenance-source",
    sourceType: "blog" as const,
    url: "https://example.com/post",
    title: "Editor update",
    titleJa: "",
    titleEn: "",
    summaryJa: "",
    summaryEn: "",
  };

  it("evaluates filters on the feed text once contentSnippet holds article prose", () => {
    const enriched = {
      ...base,
      contentSnippet: "Long article prose about a sponsored keyboard review with no editor mention.",
      excerptOrigin: "article" as const,
      feedSnippet: "The VSCode editor update ships new features.",
    };
    const decision = evaluateKeywordFilter(keywordFilterEntryFromNormalized(enriched), snippetScoped);
    expect(decision).toEqual({ keep: true, reason: "include", keyword: "vscode", trusted: true });
    // The same prose evaluated as feed text would be excluded: the marker is what protects it.
    const asFeed = { ...enriched, excerptOrigin: undefined, feedSnippet: undefined };
    expect(evaluateKeywordFilter(keywordFilterEntryFromNormalized(asFeed), snippetScoped).keep).toBe(false);
  });

  it("falls back to the title (lossy) for an article-origin entry without feedSnippet", () => {
    const orphan = {
      ...base,
      contentSnippet: "Article prose mentioning vscode extensively.",
      excerptOrigin: "article" as const,
    };
    const filterEntry = keywordFilterEntryFromNormalized(orphan);
    expect(filterEntry.contentSnippet).toBeUndefined();
    expect(evaluateKeywordFilter(filterEntry, snippetScoped).reason).toBe("missing-include");
    expect(evaluateKeywordFilter(filterEntry, snippetScoped, { allowLossyMissingInclude: true })).toEqual({
      keep: true,
      reason: "missing-include-unverified",
      keyword: null,
      trusted: false,
    });
  });

  it("keeps using contentSnippet for feed-origin entries", () => {
    const feedOnly = { ...base, contentSnippet: "Sponsored: a VSCode theme roundup." };
    expect(evaluateKeywordFilter(keywordFilterEntryFromNormalized(feedOnly), snippetScoped).reason).toBe("exclude");
  });
});

describe("Zenn AI Local LLM relevance (LL-412)", () => {
  const zennAi = REGISTRY["zenn-ai"];
  const check = (title: string, contentSnippet = "") =>
    matchesKeywordFilter(
      {
        title,
        url: "https://zenn.dev/example/articles/local-llm",
        contentSnippet,
      },
      zennAi,
    );

  it("requires subject-specific Local LLM evidence in the title", () => {
    expect(zennAi.keywordFilterScope).toBe("title");
    expect(zennAi.includeKeywords).not.toContain("ローカル");
    expect(zennAi.includeKeywords).not.toContain("model");
    expect(
      check(
        "4つのファイルから、AIでグラフ付きWordレポートを生成してみた",
        "ローカルのプロジェクトフォルダを選ぶと、編集可能なレポートを保存できます。",
      ),
    ).toBe(false);
    expect(
      check(
        "検証環境のDBデータをエクスポートしてローカルに持ってくる作業をAIにやらせてみた",
        "VPC内のAWS RDS（PostgreSQL）からローカルPCへデータを取り込む作業を自動化します。",
      ),
    ).toBe(false);
    expect(check("Kaggle Titanicの実行環境をローカルでつくる")).toBe(false);
    expect(check("X ブックマークをAIで整理するローカルOSSを公開しました")).toBe(false);
    expect(check("業務モデルの導入記録")).toBe(false);
    expect(keywordMatchesHaystack("DiffusionGemma", "gemma")).toBe(false);
    expect(check("DiffusionGemmaで拡散推論を実行する")).toBe(true);
    expect(
      check("拡散LLM DiffusionGemmaをModalで動かし、ノイズ除去の途中経過をブラウザで可視化してみた"),
    ).toBe(true);
    expect(check("ローカル 8GB VRAM で動画モデル 3 本走らせて分かった、現実的な棲み分け")).toBe(true);
    expect(check("ローカルLLMを量子化して実行する")).toBe(true);
    expect(check("ローカルAI GatewayにPolicy Engineを実装しました")).toBe(true);
    expect(check("Ollamaでモデルを実行する")).toBe(true);
    expect(check("SLMを端末上で実行する")).toBe(true);
    expect(check("vLLMでローカル推論を実行する")).toBe(true);
    expect(check("GemmaをMLXで量子化する")).toBe(true);
  });
});

describe("Simon Willison Local LLM raw-field filtering (LL-435)", () => {
  const simonw = REGISTRY["simonw-blog"];
  const kimiUrl = "https://simonwillison.net/2026/Jul/27/kimi-k3/#atom-everything";
  const kimiSnippet =
    "moonshotai/Kimi-K3 As promised earlier this month, Moonshot have released the weights for their excellent 2.8 trillion parameter Kimi K3. They're a hefty 1.56TB on Hugging Face.";

  it("keeps the real Kimi K3 source item when generated summaries use generic business wording", () => {
    const raw = keywordFilterEntryFromNormalized({
      title: "moonshotai/Kimi-K3",
      url: kimiUrl,
      contentSnippet: kimiSnippet,
      titleJa: "",
      titleEn: "moonshotai/Kimi-K3",
      summaryJa: "Kimi K3 は startup 向け workflow を含む大規模モデルです。",
      summaryEn: "Kimi K3 supports startup workflows and model serving.",
    });

    expect(raw).toEqual({
      title: "moonshotai/Kimi-K3",
      url: kimiUrl,
      contentSnippet: kimiSnippet,
    });
    expect(
      evaluateKeywordFilter(raw, simonw, {
        allowLossyMissingInclude: true,
      }),
    ).toEqual({
      keep: true,
      reason: "include",
      keyword: "hugging face",
      trusted: true,
    });
  });

  it.each([
    [
      "SaaS is Dead: using a local LLM to build a profitable startup",
      "",
      "saas is dead",
    ],
    [
      "Operating an open model service",
      "A startup billing workflow for hosted model customers.",
      "startup",
    ],
    [
      "Claude Code workflow for a local model",
      "",
      "claude code",
    ],
    [
      "An opinionated guide to which AI to use to do stuff",
      "ChatGPT's two agent modes are Work and Codex.",
      "agent",
    ],
  ])("still drops genuine raw source noise: %s", (title, contentSnippet, keyword) => {
    expect(
      evaluateKeywordFilter(
        {
          title,
          url: "https://simonwillison.net/example/",
          contentSnippet,
        },
        simonw,
      ),
    ).toEqual({
      keep: false,
      reason: "exclude",
      keyword,
      trusted: true,
    });
  });
});

describe("arXiv Research filter (R-017, LL-260)", () => {
  const arxivCl = REGISTRY["arxiv-cs-cl"];

  it("keeps an LLM evaluation paper without reclassifying generated summary wording as source noise", () => {
    expect(
      matchesKeywordFilter(
        {
          title:
            "Faithful by Design: Evaluating and Improving LLM-Generated Clinical Trial Summaries for Multi-Stakeholder Audiences",
          url: "https://arxiv.org/abs/2607.00001",
          contentSnippet:
            "This work evaluates large language model summaries for multiple stakeholders.",
        },
        arxivCl,
      ),
    ).toBe(true);
  });

  it("still drops an explicitly excluded medical paper from the raw source fields", () => {
    expect(
      matchesKeywordFilter(
        {
          title: "Medical diagnosis with large language models",
          url: "https://arxiv.org/abs/2607.00002",
          contentSnippet: "",
        },
        arxivCl,
      ),
    ).toBe(false);
  });

  it("drops clinical prediction work while preserving LLM summary evaluation", () => {
    expect(
      matchesKeywordFilter(
        {
          title: "Graph-Constrained Policy Learning for Extreme Clinical Code Prediction",
          url: "https://arxiv.org/abs/2607.00003",
          contentSnippet: "",
        },
        REGISTRY["arxiv-cs-lg"],
      ),
    ).toBe(false);
    expect(
      matchesKeywordFilter(
        {
          title:
            "Faithful by Design: Evaluating and Improving LLM-Generated Clinical Trial Summaries for Multi-Stakeholder Audiences",
          url: "https://arxiv.org/abs/2607.00001",
          contentSnippet: "",
        },
        arxivCl,
      ),
    ).toBe(true);
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

  it("drops startup cohort marketing from the evergreen knowledge lane", () => {
    expect(check("Meet the 33 cybersecurity startups joining the Gemini Startup Forum")).toBe(false);
    expect(check("Meet the startups building secure AI agents with Gemini")).toBe(true);
  });

  describe("AWS Machine Learning Blog relevance filter", () => {
    const awsMl = REGISTRY["aws-ml-blog"];
    const check = (title: string) =>
      matchesKeywordFilter({ title, url: "", contentSnippet: "" }, awsMl);

    it("drops adjacent product updates without an explicit AI/ML engineering signal", () => {
      expect(check("Introducing Mobile Layout for Amazon Quick dashboards")).toBe(false);
      expect(check("Implement a backup strategy for Amazon Quick Sight BI assets")).toBe(false);
      expect(check("Custom OS installation now available on AWS DeepRacer devices")).toBe(false);
    });

    it("keeps explicit agentic, model, AgentCore, and Claude engineering topics", () => {
      expect(check(
        "Build specialized agent workflows for your business with Amazon Quick and NVIDIA NeMo Agent Toolkit",
      )).toBe(true);
      expect(check(
        "Evolving from legacy BI to agentic AI at Tradeshift with Amazon Quick",
      )).toBe(true);
      expect(check("Structured memory filtering with metadata in AgentCore Memory")).toBe(true);
      expect(check("Introducing Claude apps gateway for AWS")).toBe(true);
      expect(check("Build interactive PDF text extraction from Amazon S3")).toBe(true);
      expect(check("Huntington Bank: Redacting sensitive data from 400M+ documents with AWS")).toBe(true);
      expect(check("Built from the inside out: How AWS Professional Services became a frontier team first")).toBe(true);
      expect(check("Extract Data with On-demand and Batch Pipelines Dynamically")).toBe(true);
    });

    it("uses title scope so generated snippets cannot rescue generic BI entries", () => {
      expect(awsMl.keywordFilterScope).toBe("title");
    });
  });

  describe("Microsoft Research Blog relevance filter (R-017)", () => {
    const msr = REGISTRY["microsoft-research"];
    const check = (title: string) =>
      matchesKeywordFilter({ title, url: "", contentSnippet: "" }, msr);

    it("keeps AI/ML research articles", () => {
      expect(check("Phi-5: pushing the frontier of small language models")).toBe(true);
      expect(check("Evaluating agentic reasoning with a new benchmark suite")).toBe(true);
      expect(check("AI for science: accelerating materials discovery")).toBe(true);
    });

    it("drops non-AI MSR areas and recruiting/podcast posts", () => {
      expect(check("Advances in topological qubit fabrication for quantum computing")).toBe(false);
      expect(check("Microsoft Research Podcast: a conversation on systems biology")).toBe(false);
      expect(check("Apply now: 2027 PhD fellowship program")).toBe(false);
    });

    it("uses title scope so snippets cannot rescue off-topic entries", () => {
      expect(msr.keywordFilterScope).toBe("title");
    });
  });

  describe("Cline monorepo component-tag filter", () => {
    const cline = REGISTRY["cline-releases"];
    const check = (title: string) =>
      matchesKeywordFilter({ title, url: "", contentSnippet: "" }, cline);

    it("drops per-package sdk/* component tags (raw and branded titles)", () => {
      expect(check("sdk/core/v0.0.79")).toBe(false);
      expect(check("Cline sdk/core v0.0.79")).toBe(false);
      expect(check("Cline sdk/agents v0.0.79")).toBe(false);
      expect(check("sdk/llms/v0.0.53")).toBe(false);
    });

    it("keeps the primary Desktop / CLI / top-level SDK releases", () => {
      expect(check("Cline Desktop v0.0.17")).toBe(true);
      expect(check("Cline CLI v3.0.58")).toBe(true);
      expect(check("Cline SDK v0.0.79")).toBe(true);
    });

    it("uses title scope so URLs cannot cause false positives", () => {
      expect(cline.keywordFilterScope).toBe("title");
    });
  });

  describe("MCP Blog source registration", () => {
    it("registers the official standardization-body blog as tier-1 mcp", () => {
      const mcpBlog = REGISTRY["mcp-blog"];
      expect(mcpBlog.category).toBe("mcp");
      expect(mcpBlog.tier).toBe(1);
      expect(mcpBlog.sourceType).toBe("blog");
      expect(mcpBlog.feedUrl).toBe("https://blog.modelcontextprotocol.io/index.xml");
    });
  });

  describe("shared tech news relevance filters (LL-129)", () => {
    const techNews = REGISTRY["the-verge"];
    const hnAi = REGISTRY["hn-ai"];
    const broadTechNewsIds = [
      "apple-newsroom",
      "microsoft-source",
      "google-keyword",
      "meta-newsroom",
      "aws-news",
      "nvidia-blog",
      "techcrunch",
      "the-verge",
      "ars-technica",
    ] as const;
    const check = (source: SourceDefinition, title: string, contentSnippet = "") =>
      matchesKeywordFilter({ title, url: "https://example.com/story", contentSnippet }, source);
    const techNewsKeepCases = [
      ["meta-newsroom", "Introducing Muse Image: Image Generation Built for Your World"],
      ["google-keyword", "DiffusionGemma: 4x faster text generation"],
      ["microsoft-source", "MAI-Image-2.5 launches at No. 3 on Arena text-to-image leaderboard"],
      ["google-keyword", "See what 3 builders are making with Gemma 4"],
      ["ars-technica", "Microsoft discovers new lightweight backdoor that steals cryptocurrency"],
      ["ars-technica", "Dozens of Red Hat packages backdoored through its official NPM channel"],
      ["the-verge", "Microsoft is threatening legal action for disclosing exploits"],
      ["microsoft-source", "Microsoft Research’s Vega lets you prove who you are while protecting your privacy"],
      ["microsoft-source", "Microsoft targets service hiding malware in plain sight"],
      ["ars-technica", "Zero-day exploit completely defeats default Windows 11 BitLocker protections"],
      ["ars-technica", "Patch for Windows Defender 0-day could allow attackers to fill hard disk"],
      ["ars-technica", "For the 2nd time in weeks, Microsoft packages laced with credential stealer"],
      ["ars-technica", "Dashlane explains how attackers managed to download encrypted password vaults"],
      ["aws-news", "Proactively reduce tech debt autonomously with AWS Transform – continuous modernization (preview)"],
      ["aws-news", "Amazon S3 annotations: attach rich, queryable context directly to your objects"],
      ["aws-news", "AWS Interconnect is now generally available, with a new option to simplify last-mile connectivity"],
      ["aws-news", "Announcing managed daemon support for Amazon ECS Managed Instances"],
      ["aws-news", "Announcing Amazon Aurora PostgreSQL serverless database creation in seconds"],
      ["aws-news", "Launching S3 Files, making S3 buckets accessible as file systems"],
      ["aws-news", "Amazon ECS introduces new high-resolution metrics for faster service auto scaling"],
      ["techcrunch", "Iran abused mobile networks’ vulnerabilities to locate US military in the Middle East, report says"],
      ["techcrunch", "Anthropic’s newest ad is creeping people out"],
      ["ars-technica", "Google revamps image search for its 25th anniversary with more images and more AI"],
    ] as const;
    const techNewsGenericKeepCases = [
      ["aws-news", "Amazon EC2 C9g and C9gd instances powered by AWS Graviton5 processors are now available"],
      ["aws-news", "Now available: Amazon EC2 M9g and M9gd instances powered by new AWS Graviton5 processors"],
      ["ars-technica", "Fed up with vibe coders, dev sneaks data-nuking prompt injection into their code"],
      ["aws-news", "Amazon Bedrock introduces new advanced prompt optimization and migration tool"],
    ] as const;
    const techNewsGenericDropCases = [
      [
        "techcrunch",
        "ServiceNow bets $40 million on Indian banking software specialist to expand its financial services push",
        "The investment targets a financial services software company.",
      ],
      [
        "ars-technica",
        "Quantum error correction can constantly recalibrate a processor",
        "This AI platform ships new developer tools for enterprise agents.",
      ],
      [
        "ars-technica",
        "Like a cheat code for your car: We investigate ECU tuning",
        "Developers used AI tooling and coding agents to automate diagnostics.",
      ],
      [
        "google-keyword",
        "Cannes Lions 2026: Strengthen creative campaigns with new tools from YouTube",
        "AI platform updates help developers build model workflows for ads.",
      ],
      [
        "techcrunch",
        "Airbnb-backed WeRoad raises $58M to take its group travel platform to the US",
        "The startup says AI developer agents and model tooling power the platform.",
      ],
    ] as const;
    const actualLowSignalTitleCases = [
      ["google-keyword", "Apply now for the Google for Startups Gemini Startup Forum."],
      [
        "nvidia-blog",
        "GeForce NOW Sets Sail With ‘Path of Exile: Curse of the Allflame’ Joining the Cloud",
      ],
      [
        "aws-news",
        "AWS Weekly Roundup: One-click Lambda setup prompt, OpenAI GPT-5.6 models on Bedrock, and more (July 20, 2026)",
      ],
      ["techcrunch", "Should AI help you get away with killing your spouse?"],
      ["nvidia-blog", "It’s Gonna Be May: 16 Games Hit the Cloud, Including ‘Palworld’"],
      ["ars-technica", "When your vehicle outlives its cloud: What happens next?"],
    ] as const;
    const consumerCloudGamingCase = [
      "the-verge",
      "Logitech’s handheld plans are on ice — don’t expect a G Cloud 2 soon",
    ] as const;
    const cloudGamingBoundaryKeepCases = [
      ["aws-news", "Amazon Bedrock introduces new advanced prompt optimization and migration tool"],
      ["ars-technica", "Zero-day exploit completely defeats default Windows 11 BitLocker protections"],
      ["aws-news", "AWS Interconnect is now generally available, with a new option to simplify last-mile connectivity"],
      ["microsoft-source", "Rethinking cloud operations with agentic observability"],
      ["aws-news", "Scaling cloud infrastructure for AI workloads"],
    ] as const;
    const evidenceBackedLowSignalCases = [
      ["google-keyword", "Here’s how to make study notebooks in the Gemini app."],
      ["google-keyword", "3 ways this coffee shop is growing with Gemini"],
      [
        "meta-newsroom",
        "Launch of Meta’s Small Business Growth Academy Across Asia-Pacific to Boost AI Adoption and Digital Skills",
      ],
      ["google-keyword", "How we’re helping schools prepare for the AI era at ISTE 2026"],
      ["google-keyword", "Our 2025 Annual Report: Local currency pricing, AI training and more"],
      ["google-keyword", "New York City educators and industry leaders come together to build the future with AI"],
      ["google-keyword", "How 5 foundations are bringing bold ideas to education and AI"],
      ["google-keyword", "AI literacy, by 5 leading experts"],
      ["google-keyword", "How universities are preparing students for the AI economy"],
      ["microsoft-source", "AI for good: Announcing the 2026 Imagine Cup World Champion"],
      ["google-keyword", "Google.org provides $2 million to ISM University to advance education and AI across CEE"],
    ] as const;

    it("keeps legitimate AI / developer stories that need explicit named-entity matches", () => {
      const techCrunch = REGISTRY["techcrunch"];
      const arxivSe = REGISTRY["arxiv-cs-se"];
      const arxivLg = REGISTRY["arxiv-cs-lg"];
      expect(check(techNews, "Claude adds new enterprise controls")).toBe(true);
      expect(check(techNews, "Midjourney opens up a new image editing workflow")).toBe(true);
      expect(check(techNews, "OpenAI ships a new coding workflow for developers")).toBe(true);
      expect(check(techCrunch, "How to use Google’s new information agents")).toBe(true);
      expect(check(
        arxivSe,
        "TRACER: A Semantic-Aware Framework for Fine-Grained Contamination Detection in Code LLMs",
      )).toBe(true);
      expect(check(
        arxivLg,
        "Tabular foundation models for robust calibration of near-infrared chemical sensing data",
      )).toBe(true);
    });

    it("keeps high-confidence title-scope stories with the shared relevance vocabulary", () => {
      for (const [sourceId, title] of techNewsKeepCases) {
        expect(check(REGISTRY[sourceId], title), `${sourceId}: ${title}`).toBe(true);
      }
    });

    it("keeps validated broad-feed stories with narrow product-family and security terms", () => {
      for (const [sourceId, title] of techNewsGenericKeepCases) {
        expect(check(REGISTRY[sourceId], title), `${sourceId}: ${title}`).toBe(true);
      }
    });

    it("drops consumer / gaming noise from broad tech-news feeds", () => {
      expect(check(techNews, "Sony’s AI Camera Assistant is exactly as bad as it looks")).toBe(false);
      expect(check(techNews, "Bungie hit with significant layoffs after ending Destiny 2")).toBe(false);
      expect(check(techNews, "GTA VI is a worrying sign for the future of physical games")).toBe(false);
      expect(check(techNews, "Electric air taxis are stuck in the courtroom")).toBe(false);
      expect(check(
        REGISTRY["ars-technica"],
        'Hackers quickly prove that Neo Geo Doom ports are not "impossible"',
      )).toBe(false);
      expect(check(
        REGISTRY["techcrunch"],
        "The founder of Hinge raised $18M to build a new AI dating service, Overtone",
      )).toBe(false);
      expect(check(
        REGISTRY["ars-technica"],
        "The Pentagon's Space Development Agency hasn't moved as fast as anyone would like",
      )).toBe(false);
      expect(check(
        REGISTRY["google-keyword"],
        "5 ways to build a side hustle with Gemini",
      )).toBe(false);
      expect(check(
        REGISTRY["techcrunch"],
        "Adobe camera app’s new feature will critique your photos using AI",
      )).toBe(false);
      expect(check(
        REGISTRY["google-keyword"],
        "We're investing $1 million in Africa's indie game developers.",
      )).toBe(false);
    });

    it("drops generic code/tool/platform/processor titles even when snippets mention AI or developers", () => {
      for (const [sourceId, title, snippet] of techNewsGenericDropCases) {
        expect(check(REGISTRY[sourceId], title, snippet), `${sourceId}: ${title}`).toBe(false);
      }
    });

    it("drops the evidence-backed low-signal business and consumer titles", () => {
      for (const [sourceId, title] of evidenceBackedLowSignalCases) {
        expect(check(REGISTRY[sourceId], title), `${sourceId}: ${title}`).toBe(false);
      }
      expect(check(
        REGISTRY["google-keyword"],
        "Gemini Code Assist adds agentic developer workflows",
      )).toBe(true);
      expect(check(
        REGISTRY["meta-newsroom"],
        "Meta releases an open model toolkit for AI developers",
      )).toBe(true);
    });

    it("drops low-signal titles observed in the live broad-feed corpus", () => {
      for (const [sourceId, title] of actualLowSignalTitleCases) {
        expect(check(REGISTRY[sourceId], title), `${sourceId}: ${title}`).toBe(false);
      }
      expect(check(
        REGISTRY["aws-news"],
        "Amazon Bedrock introduces new advanced prompt optimization and migration tool",
      )).toBe(true);
      expect(check(
        REGISTRY["nvidia-blog"],
        "NVIDIA Open Sources First GPU-Accelerated Medical Physics Simulation Framework",
      )).toBe(true);
    });

    it("drops the actual Logitech G Cloud handheld story without hiding AI cloud, security, or developer infrastructure", () => {
      const [sourceId, title] = consumerCloudGamingCase;
      expect(check(REGISTRY[sourceId], title), `${sourceId}: ${title}`).toBe(false);
      for (const [keepSourceId, keepTitle] of cloudGamingBoundaryKeepCases) {
        expect(check(REGISTRY[keepSourceId], keepTitle), `${keepSourceId}: ${keepTitle}`).toBe(true);
      }
    });

    it("drops DORA awards and site-update posts while keeping research reports", () => {
      const dora = REGISTRY["dora-insights"];
      expect(check(dora, "DevOps Dozen Awards 2025: Voting Is Open!")).toBe(false);
      expect(check(dora, "Quick Check updates: the latest improvements to DORA tools")).toBe(false);
      expect(check(dora, "Accelerate State of DevOps Report 2026")).toBe(true);
      expect(dora.keywordFilterScope).toBe("title");
    });

    it("uses title scope for every broad tech-news source that shares the registry filters", () => {
      for (const sourceId of broadTechNewsIds) {
        expect(REGISTRY[sourceId].keywordFilterScope, `${sourceId} uses title scope`).toBe("title");
      }
    });

    it("does not let snippet-only AI keywords rescue consumer titles on broad tech-news feeds", () => {
      const techCrunch = REGISTRY["techcrunch"];
      expect(check(
        techCrunch,
        "SOND, a sleep tech startup from Bose’s former head of sleep, exits stealth with $7M",
        "The platform uses AI agents and developer tooling to scale enterprise workflows.",
      )).toBe(false);
      expect(check(
        techNews,
        "The QD-OLED gaming monitor that started it all got a big upgrade",
        "This platform adds AI developer agents and model tooling for enterprise workflows.",
      )).toBe(false);
    });

    it("keeps hn-ai product and MCP stories while reclassing the source to tech-news", () => {
      expect(hnAi.category).toBe("tech-news");
      expect(hnAi.keywordFilterScope).toBe("title");
      expect(hnAi.maxEntriesPerRun).toBeGreaterThan(0);
      expect(check(
        hnAi,
        "Show HN: InsForge – Open-source Heroku for coding agents",
        "Open-source platform for coding agents",
      )).toBe(true);
      expect(check(
        hnAi,
        "Show HN: Mcp2cli – One CLI for every API, 96-99% fewer tokens than native MCP",
        "One CLI for every API with MCP compatibility",
      )).toBe(true);
    });
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
