import { describe, expect, it } from "vitest";
import {
  findBodyGroundingIssues,
  findSummaryGroundingIssues,
  hasSufficientBodySourceGrounding,
  hasSufficientSourceGrounding,
} from "../harness/pipeline/source-grounding.ts";
import {
  hasUsableGroundedBilingualSummary,
  needsSummaryGeneration,
} from "../harness/pipeline/summary-quality.ts";

const cursorStartSource = {
  id: "4194bab0f9a763ba",
  source: "cursor-changelog",
  sourceType: "changelog" as const,
  url: "https://cursor.com/changelog/cursor-start",
  title: "Cursor Start",
  titleJa: "Cursor Start",
  titleEn: "Cursor Start",
  lang: "en" as const,
  contentSnippet:
    "We're introducing Cursor Start, a new ₹649 monthly plan for developers in India, making daily agentic development accessible and payment easy with local pricing and UPI.",
};

const windowsExpansionSource = {
  id: "83d76bf754a9947a",
  source: "the-verge",
  sourceType: "blog" as const,
  url: "https://www.theverge.com/ai-artificial-intelligence/971750/perplexity-personal-computer-windows-ai-agents",
  title: "Perplexity’s Personal Computer turns Windows PCs into AI agents",
  titleJa: "PerplexityのPersonal Computer、Windows PCをAIエージェントに変える",
  titleEn: "Perplexity’s Personal Computer turns Windows PCs into AI agents",
  lang: "en" as const,
  contentSnippet:
    "Perplexity has expanded its agentic Personal Computer tool to Windows, allowing computers running the world's most popular OS to be used as a locally run AI system. Like the Mac version that Perplexity launched in April, Personal Computer for Windows operates as a general-purpose agent.",
};

describe("source grounding contract", () => {
  it("keeps ambiguous title-only input pending but accepts descriptive official titles", () => {
    expect(hasSufficientSourceGrounding({ title: "Cursor Start" })).toBe(false);
    expect(hasSufficientSourceGrounding({
      title: "GitHub Copilot app usage metrics now expand across report rollups",
    })).toBe(true);
    expect(hasSufficientSourceGrounding({
      title: "Cursor Start",
      contentSnippet: "Cursor Start",
    })).toBe(false);
  });

  it("rejects the Cursor Start setup hallucination and accepts a source-grounded summary", () => {
    const contradicted = {
      titleJa: "Cursor Start",
      titleEn: "Cursor Start",
      summaryJa:
        "Cursorに新機能「Cursor Start」が追加され、プロジェクトの初期セットアップや起動フローが改善された。",
      summaryEn:
        "Cursor introduced Cursor Start, a feature streamlining project initialization and onboarding flows.",
    };
    const grounded = {
      titleJa: "インド向け料金プラン「Cursor Start」",
      titleEn: "Cursor Start",
      summaryJa:
        "Cursorはインドの開発者向けに月額₹649のCursor Startプランを開始し、UPIと現地価格に対応した。",
      summaryEn:
        "Cursor launched the Cursor Start plan for developers in India at ₹649 per month with local pricing and UPI payments.",
    };

    expect(findSummaryGroundingIssues(cursorStartSource, contradicted)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "commercial-plan-conflict", field: "summaryJa" }),
        expect.objectContaining({ code: "commercial-plan-conflict", field: "summaryEn" }),
      ]),
    );
    expect(hasUsableGroundedBilingualSummary(cursorStartSource, contradicted)).toBe(false);
    expect(hasUsableGroundedBilingualSummary(cursorStartSource, grounded)).toBe(true);
    expect(needsSummaryGeneration({ ...cursorStartSource, ...contradicted })).toBe(true);
  });

  it("does not treat lowercase us as United States and preserves explicit US anchors", () => {
    const contactUsSource = {
      title: "Team subscription pricing starts at $20 per month",
      contentSnippet:
        "The Team plan costs $20 per month per seat. Contact us for enterprise pricing and deployment support.",
    };
    const faithful = {
      titleJa: "Teamプランは月額20ドル",
      titleEn: "Team plan pricing",
      summaryJa: "Teamプランは1席あたり月額$20で、企業向けの詳細は問い合わせできる。",
      summaryEn: "The Team plan costs $20 per seat each month, with enterprise pricing available on request.",
    };
    expect(findSummaryGroundingIssues(contactUsSource, faithful)).toEqual([]);

    for (
      const region of [
        "United States",
        "U.S.",
        "U.S.A",
        "U.S.A.",
        "USA",
        "米国",
        "アメリカ",
      ]
    ) {
      const source = {
        title: `Team subscription plan pricing for ${region}`,
        contentSnippet: `The Team plan costs $20 per month for developers in ${region}.`,
      };
      expect(
        findSummaryGroundingIssues(source, {
          titleJa: "Teamプランの料金",
          titleEn: "Team plan pricing",
          summaryJa: "Teamプランは米国で1席あたり月額$20で提供される。",
          summaryEn:
            `The Team plan costs $20 per seat each month in ${region} for eligible developers.`,
        }),
        region,
      ).toEqual([]);

      const issues = findSummaryGroundingIssues(source, {
        titleJa: "Teamプランの料金",
        titleEn: "Team plan pricing",
        summaryJa: "Teamプランは1席あたり月額$20で提供される。",
        summaryEn:
          "The Team plan costs $20 per seat each month. Contact us for details.",
      });
      expect(
        issues.some((issue) =>
          issue.code === "commercial-plan-conflict" && issue.field === "summaryEn"
        ),
        region,
      ).toBe(true);
    }
  });

  it("rejects commercial summaries that omit the source region or all pricing details", () => {
    const missingRegion = {
      titleJa: "Cursor Start料金プラン",
      titleEn: "Cursor Start pricing plan",
      summaryJa: "Cursorは月額₹649のCursor Startプランを開始し、UPI決済に対応した。",
      summaryEn: "Cursor launched the ₹649 monthly Cursor Start plan with UPI payments.",
    };
    const missingCommercialDetail = {
      titleJa: "インド向けCursor Startプラン",
      titleEn: "Cursor Start plan for India",
      summaryJa: "Cursorはインドの開発者向けにCursor Startプランを開始した。",
      summaryEn: "Cursor launched the Cursor Start plan for developers in India.",
    };

    expect(findSummaryGroundingIssues(cursorStartSource, missingRegion)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "commercial-plan-conflict", field: "summaryJa" }),
        expect.objectContaining({ code: "commercial-plan-conflict", field: "summaryEn" }),
      ]),
    );
    expect(
      findSummaryGroundingIssues(cursorStartSource, missingCommercialDetail),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "commercial-plan-conflict", field: "summaryJa" }),
        expect.objectContaining({ code: "commercial-plan-conflict", field: "summaryEn" }),
      ]),
    );
  });

  it("rejects setup-topic generated titles for a commercial plan", () => {
    const issues = findSummaryGroundingIssues(cursorStartSource, {
      titleJa: "Cursor Startのプロジェクト初期セットアップ",
      titleEn: "Cursor Start project initialization",
      summaryJa:
        "Cursorはインドの開発者向けに月額₹649のCursor Startプランを開始し、UPI決済に対応した。",
      summaryEn:
        "Cursor launched the ₹649 monthly Cursor Start plan for developers in India with UPI payments.",
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "commercial-plan-conflict", field: "titleJa" }),
        expect.objectContaining({ code: "commercial-plan-conflict", field: "titleEn" }),
      ]),
    );
  });

  it("rejects treating an existing Mac product's Windows expansion as a new product launch", () => {
    const contradicted = {
      titleJa: windowsExpansionSource.titleJa,
      titleEn: windowsExpansionSource.titleEn,
      summaryJa:
        "PerplexityはWindows PC上で自律実行する新機能「Personal Computer」を発表した。",
      summaryEn:
        "Perplexity launched Personal Computer, a new feature that turns Windows PCs into autonomous AI agents.",
    };
    const grounded = {
      titleJa: windowsExpansionSource.titleJa,
      titleEn: windowsExpansionSource.titleEn,
      summaryJa:
        "PerplexityはMac向けに提供していたPersonal ComputerをWindowsへ展開し、PC上でローカルAIエージェントを利用可能にした。",
      summaryEn:
        "Perplexity expanded Personal Computer from Mac to Windows, bringing its locally run AI agent to Windows PCs.",
    };

    expect(findSummaryGroundingIssues(windowsExpansionSource, contradicted)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "platform-expansion-conflict", field: "summaryJa" }),
        expect.objectContaining({ code: "platform-expansion-conflict", field: "summaryEn" }),
      ]),
    );
    expect(hasUsableGroundedBilingualSummary(windowsExpansionSource, contradicted)).toBe(false);
    expect(hasUsableGroundedBilingualSummary(windowsExpansionSource, grounded)).toBe(true);
  });

  it("classifies prior-platform phrases locally and keeps truncated expansion evidence active", () => {
    const contradicted = {
      titleJa: windowsExpansionSource.titleJa,
      titleEn: windowsExpansionSource.titleEn,
      summaryJa:
        "PerplexityはWindows PC向けの新機能Personal Computerを発表した。",
      summaryEn:
        "Perplexity launched Personal Computer as a new feature for Windows PCs.",
    };
    const snippets = [
      "Personal Computer is now available on Windows, after launching on Mac earlier this year.",
      "Personal Computer is now available on Windows, like the Mac version launched in April.",
      "Personal ComputerはMac版に続いてWindowsで提供開始され、ローカルAIエージェントとして動作する。",
      "Perplexity has expanded its Personal Computer tool to Windows, allowing Windows PCs to run a local AI agent.",
    ];

    for (const contentSnippet of snippets) {
      const issues = findSummaryGroundingIssues(
        { ...windowsExpansionSource, contentSnippet },
        contradicted,
      );
      expect(
        issues.some((issue) =>
          issue.code === "platform-expansion-conflict" &&
          issue.field === "summaryEn"
        ),
        contentSnippet,
      ).toBe(true);
    }
  });

  it("does not treat a first availability announcement as an existing-product expansion", () => {
    const iosLaunchSource = {
      title: "Cursor Mobile App for iOS",
      contentSnippet:
        "Cursor for iOS is now available in public beta on all paid plans. Launch and manage always-on agents from anywhere.",
    };
    const iosLaunchSummary = {
      titleJa: "Cursor Mobile App for iOS",
      titleEn: "Cursor Mobile App for iOS",
      summaryJa:
        "CursorはiOS向けモバイルアプリの公開ベータを開始し、外出先からエージェントを操作できるようにした。",
      summaryEn:
        "Cursor launched the public beta of its iOS mobile app, letting developers manage agents from anywhere.",
    };

    expect(findSummaryGroundingIssues(iosLaunchSource, iosLaunchSummary)).toEqual([]);
  });

  it("applies the same material-fact contract to generated bodies", () => {
    const cursorBody = {
      bodyJa:
        "Cursor Startはプロジェクト初期化を支援する新機能で、依存関係の設定やオンボーディングを簡略化する。",
      bodyEn:
        "Cursor Start is a new project initialization feature that streamlines scaffolding and onboarding.",
    };
    const windowsBody = {
      bodyJa:
        "Personal ComputerはMac版に続いてWindowsへ展開され、Windows PCをローカルAIエージェントとして利用できる。",
      bodyEn:
        "Personal Computer expanded from Mac to Windows, bringing Perplexity's locally run AI agent to Windows PCs.",
    };

    expect(findBodyGroundingIssues(cursorStartSource, cursorBody)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "commercial-plan-conflict", field: "bodyJa" }),
        expect.objectContaining({ code: "commercial-plan-conflict", field: "bodyEn" }),
      ]),
    );
    expect(findBodyGroundingIssues(windowsExpansionSource, windowsBody)).toEqual([]);
  });

  it("keeps a bounded official-source sample at zero false positives", () => {
    const samples = [
      {
        source: {
          title: "GitHub Copilot app usage metrics now expand across report rollups",
          contentSnippet:
            "Copilot app usage is now reported across more of the Copilot usage metrics API, including enterprise and organization reports.",
        },
        generated: {
          titleJa: "GitHub Copilotアプリ利用指標の集計範囲を拡大",
          titleEn: "GitHub Copilot app usage metrics now expand across report rollups",
          summaryJa:
            "GitHubはCopilotアプリの利用状況を企業・組織レポートでも集計できるようにし、導入状況を把握しやすくした。",
          summaryEn:
            "GitHub expanded Copilot app usage metrics across enterprise and organization reports, improving adoption visibility.",
        },
      },
      {
        source: {
          title: "In-House LLM Serving at Netflix",
          contentSnippet:
            "Netflix describes the architecture, reliability controls, and cost tradeoffs behind its internal large language model serving platform.",
        },
        generated: {
          titleJa: "Netflixの社内LLM推論基盤",
          titleEn: "In-House LLM Serving at Netflix",
          summaryJa:
            "Netflixは社内LLM推論基盤の構成と信頼性対策を公開し、コストとレイテンシの両立方法を説明した。",
          summaryEn:
            "Netflix detailed its internal LLM serving architecture, reliability controls, and cost-latency tradeoffs.",
        },
      },
      {
        source: cursorStartSource,
        generated: {
          titleJa: "インド向け料金プラン「Cursor Start」",
          titleEn: "Cursor Start",
          summaryJa:
            "Cursorはインド向けに月額₹649のCursor Startプランを提供し、現地価格とUPI決済に対応した。",
          summaryEn:
            "Cursor introduced the ₹649 monthly Cursor Start plan in India with local pricing and UPI support.",
        },
      },
      {
        source: windowsExpansionSource,
        generated: {
          titleJa: windowsExpansionSource.titleJa,
          titleEn: windowsExpansionSource.titleEn,
          summaryJa:
            "PerplexityはMac版Personal ComputerをWindowsへ展開し、Windows PCでローカルAIエージェントを利用可能にした。",
          summaryEn:
            "Perplexity expanded its Mac Personal Computer tool to Windows, enabling locally run AI agents on Windows PCs.",
        },
      },
      {
        source: {
          title:
            "Anthropic starts localizing Claude pricing for India, its biggest market after the US",
          contentSnippet:
            "Claude users in India are starting to see Indian rupee-denominated subscription plans.",
        },
        generated: {
          titleJa: "Anthropic、インドでClaudeの現地価格を導入",
          titleEn:
            "Anthropic starts localizing Claude pricing for India, its biggest market after the US",
          summaryJa:
            "AnthropicはインドのClaude利用者向けにルピー建ての現地価格を導入し、利用障壁の引き下げを進めている。",
          summaryEn:
            "Anthropic is introducing localized rupee-based pricing for Claude in India, lowering barriers in its largest market outside the US.",
        },
      },
      {
        source: {
          title:
            "Get started with OpenAI GPT-5.6 Sol, Terra, and Luna on Amazon Bedrock",
          contentSnippet:
            "The models are generally available on Amazon Bedrock. The guide covers inference, prompt caching to reduce cost, and quota planning.",
        },
        generated: {
          titleJa: "Amazon BedrockでGPT-5.6シリーズを利用開始",
          titleEn:
            "Get started with OpenAI GPT-5.6 Sol, Terra, and Luna on Amazon Bedrock",
          summaryJa:
            "OpenAIのGPT-5.6 Sol、Terra、LunaがAmazon Bedrockで一般提供され、AWS上の推論に利用できるようになった。",
          summaryEn:
            "OpenAI's GPT-5.6 Sol, Terra, and Luna are now generally available on Amazon Bedrock for AWS inference workflows.",
        },
      },
      {
        source: {
          title:
            "Faithful, Not Corrective: Message-Format Effects in Multi-Hop Agent Relays Are Tier-Dependent",
          contentSnippet:
            "The paper evaluates how message format affects multi-hop agent relays and finds tier-dependent differences in faithful error propagation.",
        },
        generated: {
          titleJa: "マルチホップエージェントの階層別メッセージ形式効果",
          titleEn:
            "Faithful, Not Corrective: Message-Format Effects in Multi-Hop Agent Relays Are Tier-Dependent",
          summaryJa:
            "マルチホップエージェントではメッセージ形式の影響が階層ごとに異なり、上流の誤りを忠実に伝える傾向が示された。",
          summaryEn:
            "Message-format effects in multi-hop agent relays vary by tier, with agents tending to propagate upstream errors faithfully.",
        },
      },
      {
        source: {
          title:
            "Bernie Sanders unveils $7 trillion plan to give Americans control of AI industry",
        },
        generated: {
          titleJa: "サンダース氏、7兆ドル規模のAI富基金構想を発表",
          titleEn:
            "Bernie Sanders unveils $7 trillion plan to give Americans control of AI industry",
          summaryJa:
            "バーニー・サンダース上院議員は、大手AI企業の富を米国民へ還元する7兆ドル規模の政策構想を発表した。",
          summaryEn:
            "Bernie Sanders proposed a $7 trillion AI wealth fund intended to give Americans a public stake in the industry's gains.",
        },
      },
    ];

    const rejected = samples.filter(({ source, generated }) =>
      !hasUsableGroundedBilingualSummary(source, generated)
    );
    expect(samples).toHaveLength(8);
    expect(rejected).toEqual([]);
  });
});

describe("body grounding gate", () => {
  const descriptiveTitleOnly = {
    title: "GitHub Copilot app usage metrics now expand across report rollups",
    contentSnippet: "",
  };
  const realExcerptWeakTitle = {
    title: "Ollama v0.33.0",
    contentSnippet:
      "The release notes describe a new scheduler for concurrent model loads, plus fixes for GPU memory reporting on Windows.",
  };

  it("a descriptive title alone grounds a summary but never a body", () => {
    expect(hasSufficientSourceGrounding(descriptiveTitleOnly)).toBe(true);
    expect(hasSufficientBodySourceGrounding(descriptiveTitleOnly)).toBe(false);
  });

  it("a real excerpt grounds a body even when the headline is version-shaped", () => {
    // This is why the gate drops the title disjunct instead of AND-ing the two:
    // 270 live entries look like this and their source text is real.
    expect(hasSufficientSourceGrounding(realExcerptWeakTitle)).toBe(true);
    expect(hasSufficientBodySourceGrounding(realExcerptWeakTitle)).toBe(true);
  });

  it("rejects an empty, fragmentary, or title-echoing excerpt", () => {
    expect(hasSufficientBodySourceGrounding({ title: "Introducing Gemini 3.7 Flash", contentSnippet: "" })).toBe(false);
    expect(hasSufficientBodySourceGrounding({ title: "Some post", contentSnippet: "Read more" })).toBe(false);
    expect(hasSufficientBodySourceGrounding({
      title: "A Tale of Two Flink Autoscalers",
      contentSnippet: "A Tale of Two Flink Autoscalers",
    })).toBe(false);
  });
});
