import { describe, expect, it } from "vitest";
import {
  isKnowledgeEligibleEntry,
  knowledgeEligibility,
  type KnowledgeEligibilityEntry,
} from "../web/src/lib/knowledge-eligibility.ts";

const ACTUAL_DROP_FIXTURES: ReadonlyArray<{
  id: string;
  entry: KnowledgeEligibilityEntry;
  reason: "announcement-title" | "availability-context";
}> = [
  {
    id: "301aa7cc9d94e002",
    entry: {
      source: "google-cloud-blog",
      title: "What’s new in Gemini Enterprise Agent Platform",
      contentSnippet: "Since we launched Gemini Enterprise Agent Platform a few months ago, we’ve seen inspiring progress from businesses and builders alike.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "bed450615ddfd03d",
    entry: {
      source: "aws-ml-blog",
      title: "Introducing Claude Opus 5 on AWS: Anthropic’s most capable Opus model",
      contentSnippet: "This post covers Opus 5’s improvements and practical guidance for AI engineers integrating the model into agentic systems and production inference workloads on Amazon Bedrock.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "7ce8f0655e5249f3",
    entry: {
      source: "aws-ml-blog",
      title: "OpenAI GPT-5.6 Sol, Terra, and Luna are now generally available on Amazon Bedrock",
      contentSnippet: "Today, GPT-5.6 Sol, Terra, and Luna from OpenAI are generally available on Amazon Bedrock.",
      evergreen: true,
    },
    reason: "availability-context",
  },
  {
    id: "7b3cb462c9d102ab",
    entry: {
      source: "google-cloud-blog",
      title: "Announcing general availability of SAP Business Data Cloud Connect for BigQuery",
      contentSnippet: "SAP and Google Cloud are announcing that SAP Business Data Cloud Connect for BigQuery is now generally available.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "52a59dad31dc17b8",
    entry: {
      source: "google-cloud-blog",
      title: "Google is a Leader and positioned furthest in Vision and highest in Execution in the 2026 Gartner® Magic Quadrant™ for Conversational AI Platforms",
      contentSnippet: "For the second consecutive year, Google has been named a Leader in the Gartner® Magic Quadrant™ for Conversational AI Platforms.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "5abc0b85ffaee46f",
    entry: {
      source: "google-cloud-blog",
      title: "From query to action: Introducing SQL alerting in Cloud Monitoring Observability Analytics",
      contentSnippet: "Traditional alerting systems often force a compromise between simple log events and rigid metrics.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "07df858350edbc9d",
    entry: {
      source: "google-cloud-blog",
      title: "Securing agentic AI with perimeter guardrails: What's new in VPC Service Controls",
      contentSnippet: "As enterprises scale autonomous AI agents into production, enabling safe innovation requires robust architectural guardrails.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "37803898e498b24d",
    entry: {
      source: "microsoft-foundry",
      title: "Expanding the Reach of Document Translation – New Capabilities Announced at Microsoft Build",
      contentSnippet: "Learn how new Document Translation capabilities in Azure Translator help developers translate images, PDFs, and Office files.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "1fe4d821705368ab",
    entry: {
      source: "aws-ml-blog",
      title: "Introducing Claude apps gateway for AWS",
      contentSnippet: "Today, we're announcing the Claude apps gateway for AWS, a self-hosted control plane. In this post, we show how to set up and run Claude apps gateway for AWS.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "4804d6346be88fc2",
    entry: {
      source: "aws-ml-blog",
      title: "Introducing Grok on Amazon Bedrock",
      contentSnippet: "This post covers what makes Grok 4.3 a fit for agentic workloads, how you access it through Amazon Bedrock, and how to use chat requests.",
      evergreen: true,
    },
    reason: "announcement-title",
  },
  {
    id: "b774ed271b22e41b",
    entry: {
      source: "google-cloud-blog",
      title: "Bringing Conversational Analytics to your entire data ecosystem",
      contentSnippet: "Increasing the adoption of generative AI across the enterprise requires you to do more than deploy a generic chatbot with a custom wrapper. Interacting with business-critical databases demands absolute trust, strict governance, and deep grounding in enterprise semantics. Over the last year, Conversational Analytics (CA) in Google Cloud has moved from isolated experiments to scaled, enterprise-wide deployments. BigQuery Conversational Analytics and the Conversational Analytics API are now generally available, adding to the general availability of Conversational Analytics in Looker last year.",
      evergreen: true,
    },
    reason: "availability-context",
  },
  {
    id: "592d34bdee2e8b6a",
    entry: {
      source: "google-cloud-blog",
      title: "Future-proofing data integrity: Quantum-safe digital signatures in Cloud KMS",
      contentSnippet: "With cryptographically relevant quantum computers (CRQC) on the horizon, transitioning to quantum-safe digital signatures is critical to safeguarding long-term data integrity and authenticity. Organizations are steadily recognizing this urgency. For example, the U.S. government announced an update to the timelines by which departments and agencies must transition to quantum safe digital signatures. To help with the transition, we are announcing the general availability of our quantum-safe digital signatures (ML-DSA, SLH-DSA) and post-quantum key encapsulation (ML-KEM) in Google Cloud Key Management Service (Cloud KMS).",
      evergreen: true,
    },
    reason: "availability-context",
  },
];

const ACTUAL_KEEP_FIXTURES: ReadonlyArray<{
  id: string;
  entry: KnowledgeEligibilityEntry;
  reason: "durable-title" | "durable-snippet" | "eligible";
}> = [
  {
    id: "627841b4f5c80956",
    entry: {
      source: "aws-ml-blog",
      title: "Get started with OpenAI GPT-5.6 Sol, Terra, and Luna on Amazon Bedrock",
      contentSnippet: "OpenAI GPT-5.6 Sol, Terra, and Luna are now generally available on Amazon Bedrock. Learn how to select a model, run inference through the Responses API, reduce cost with prompt caching, and plan for quotas.",
      evergreen: true,
    },
    reason: "durable-title",
  },
  {
    id: "3d5ffbbbf9e829e3",
    entry: {
      source: "google-cloud-blog",
      title: "Bridging the gap between SQL and Python with BigQuery and the %%bqsql magic",
      contentSnippet: "Data scientists and data engineers often find themselves caught between SQL and Python.",
      evergreen: true,
    },
    reason: "eligible",
  },
  {
    id: "252b013dd561ae24",
    entry: {
      source: "google-cloud-blog",
      title: "Level Up Your Column-level Security: Using IAM Data Governance Tags in BigQuery",
      contentSnippet: "Many BigQuery customers rely on policy tags for protecting sensitive information.",
      evergreen: true,
    },
    reason: "eligible",
  },
  {
    id: "1a833b8e9ce333f7",
    entry: {
      source: "google-cloud-blog",
      title: "Scaling Network Analysis for Fraud Prevention with BigQuery Graph",
      contentSnippet: "Operating at this scale means confronting a high-volume fraud problem.",
      evergreen: true,
    },
    reason: "durable-title",
  },
  {
    id: "4c02d3e289738117",
    entry: {
      source: "microsoft-foundry",
      title: "Build smarter document workflows: What’s new in Azure Content Understanding at Build 2026",
      contentSnippet: "Azure Content Understanding ingests documents, audio, images, and video to power grounded AI solutions.",
      evergreen: true,
    },
    reason: "durable-title",
  },
  {
    id: "2abb1db68940e816",
    entry: {
      source: "aws-ml-blog",
      title: "Launching UI for generative AI inference recommendations in Amazon SageMaker AI",
      contentSnippet: "The API gives you programmatic access to recommendations, but it assumes you know which parameters to set and how to configure them.",
      evergreen: true,
    },
    reason: "durable-snippet",
  },
  {
    id: "05443c49aa5fc77c",
    entry: {
      source: "aws-ml-blog",
      title: "Beyond RAG: Task-aware knowledge compression for enterprise AI on AWS",
      contentSnippet: "This post shows how to use task-aware knowledge compression on AWS to pre-compress knowledge bases and route queries.",
      evergreen: true,
    },
    reason: "durable-snippet",
  },
  {
    id: "da8334e0b7763710",
    entry: {
      source: "microsoft-foundry",
      title: "Introducing Agent Optimizer in Foundry Agent Service",
      contentSnippet: "You write your logic, run azd deploy, and your agent is live. But live and production-ready are not the same thing.",
      evergreen: true,
    },
    reason: "durable-snippet",
  },
  {
    id: "75ae9ec89cc4eb11",
    entry: {
      source: "google-cloud-blog",
      title: "Automate your agent development lifecycle using any coding agent",
      contentSnippet: "Welcome to our latest Gemini Enterprise Agent Platform deep dive, a practical walkthrough where we’ll teach you how to build real-world, production-ready agents starting from step 1.",
      evergreen: true,
    },
    reason: "durable-title",
  },
  {
    id: "12add31c8d3b5946",
    entry: {
      source: "google-cloud-blog",
      title: "Detect early and enforce firmly with Google Cloud's enhanced cost controls for AI spend",
      contentSnippet: "Generative AI can make cloud costs difficult to predict. A single five-word prompt can run complex operations and generate significant costs. Traditional metrics like requests per second no longer help you estimate your bill, increasing the risk of unexpected cost spikes. While Google Cloud offers budget alerts, you need proactive guardrails that work out of the box.",
      evergreen: true,
    },
    reason: "durable-title",
  },
];

describe("Knowledge eligibility", () => {
  it.each(ACTUAL_DROP_FIXTURES)(
    "removes announcement-only actual-corpus fixture $id",
    ({ entry, reason }) => {
      expect(knowledgeEligibility(entry)).toEqual({ eligible: false, reason });
    },
  );

  it.each(ACTUAL_KEEP_FIXTURES)(
    "keeps durable actual-corpus fixture $id",
    ({ entry, reason }) => {
      expect(knowledgeEligibility(entry)).toEqual({ eligible: true, reason });
    },
  );

  it("uses ASCII token boundaries for GA without matching gap", () => {
    expect(isKnowledgeEligibleEntry({
      source: "google-cloud-blog",
      title: "Model GA on Example Cloud",
      evergreen: true,
    })).toBe(false);
    expect(isKnowledgeEligibleEntry({
      source: "google-cloud-blog",
      title: "Bridging the gap between SQL and Python",
      evergreen: true,
    })).toBe(true);
  });

  it("treats only uppercase GA as the availability acronym", () => {
    for (const title of [
      "Understanding the ga particle in Japanese",
      "Ga doping in semiconductors",
      "What ga.js does in analytics",
    ]) {
      expect(isKnowledgeEligibleEntry({
        source: "google-cloud-blog",
        title,
        evergreen: true,
      })).toBe(true);
    }
  });

  it("ignores generated summaries when deciding source acceptance", () => {
    const entry = {
      ...ACTUAL_KEEP_FIXTURES[1]!.entry,
      summaryEn: "This generated summary says generally available.",
    };
    expect(isKnowledgeEligibleEntry(entry)).toBe(true);
  });

  it("does not admit articles from a non-evergreen source", () => {
    expect(knowledgeEligibility({
      source: "techcrunch",
      title: "How to build a durable agent workflow",
      evergreen: false,
    })).toEqual({ eligible: false, reason: "not-evergreen" });
  });

  it("preserves a Publisher exclusion marker in lossy Web/archive records", () => {
    expect(knowledgeEligibility({
      source: "google-cloud-blog",
      title: "Neutralized title after source compaction",
      evergreen: true,
      knowledgeEligible: false,
    })).toEqual({ eligible: false, reason: "stored-exclusion" });
  });

  it("lets narrow raw procedural evidence override a stale stored exclusion", () => {
    expect(knowledgeEligibility({
      source: "aws-ml-blog",
      title: "Introducing Claude apps gateway for AWS",
      contentSnippet: "In this post, we show how to set up and run Claude apps gateway for AWS.",
      evergreen: true,
      knowledgeEligible: false,
    })).toEqual({ eligible: true, reason: "durable-snippet" });
  });

  it("does not let announcement boilerplate override a stored exclusion", () => {
    expect(knowledgeEligibility({
      source: "aws-ml-blog",
      title: "Introducing Claude apps gateway for AWS",
      contentSnippet: "Today, we're announcing the Claude apps gateway for AWS. In this post, we show how to set up and run it.",
      evergreen: true,
      knowledgeEligible: false,
    })).toEqual({ eligible: false, reason: "stored-exclusion" });
  });

  it.each([
    "Example is a Leader in the enterprise agent market",
    "Example remains the Challenger for conversational AI",
    "Example remains a Visionary for cloud orchestration",
  ])("treats analyst-positioning title as announcement-only: %s", (title) => {
    expect(knowledgeEligibility({
      source: "google-cloud-blog",
      title,
      evergreen: true,
    })).toEqual({ eligible: false, reason: "announcement-title" });
  });
});
